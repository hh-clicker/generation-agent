import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexRunner, runProcess } from '../src/codex.js';
import { readConfig } from '../src/config.js';
import { validateVacancyRelevanceInput, validateInput } from '../src/contract.js';
import { GenerationQueue } from '../src/queue.js';
import { createServer } from '../src/http.js';

const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const input = validateVacancyRelevanceInput({ resumeText: 'private-resume', vacancies: [{ hhId: '1', title: 'private-title' }] });

function within(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Barrier timed out')), 3000);
  })]).finally(() => clearTimeout(timer));
}

test('live metrics, run filtering, persistence and HTTP expose only safe diagnostic data', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hh-metrics-'));
  const config = { ...readConfig({}), dataDir };
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let elapsed = 10;
  const telemetry = () => ({ version: 1, stage: 'cli', elapsedMs: elapsed, stageElapsedMs: elapsed,
    phasesMs: { auth: 1, prepare: 2, cli: elapsed }, private: 'private-telemetry',
    cli: { firstStdoutMs: 3, events: { 'turn.started': 1 }, stderr: 'private-stderr' } });
  const runner = { version: 'test', run: async (_job, _signal, _onSpawn, onTelemetry) => {
    onTelemetry(telemetry);
    started.resolve();
    await release.promise;
    return { result: { items: [{ hhId: '1', category: 'TARGET', confidence: 'high', reason: 'private-answer' }] },
      error: null, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 }, cliMs: 20,
      telemetry: { ...telemetry(), stage: 'finished' } };
  } };
  const queue = new GenerationQueue(config, runner);
  await queue.initialize();
  t.after(async () => { await queue.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const job = (await queue.create(input, `relevance-${runId}-0`, 'vacancy-relevance')).job;
  const tick = queue.tick();
  try {
    await within(started.promise);
    assert.equal(queue.metrics(runId).jobs[0].telemetry.stage, 'cli');
    elapsed = 1000;
    assert.equal(queue.metrics(runId).jobs[0].telemetry.elapsedMs, 1000);
    assert.equal(queue.metrics('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').summary.totalJobs, 0);
    assert.doesNotMatch(JSON.stringify(queue.metrics()), /private|resumeText|idempotencyKey/);
  } finally { release.resolve(); await tick; }
  const persisted = JSON.parse(await readFile(path.join(dataDir, `${job.id}.json`), 'utf8'));
  assert.equal(persisted.telemetry.stage, 'finished');
  assert.doesNotMatch(JSON.stringify(persisted.telemetry), /private/);
  const recovered = new GenerationQueue(config, {});
  await recovered.initialize();
  assert.equal(recovered.metrics(runId).summary.evaluatedVacancies, 1);
  assert.equal(recovered.metrics(runId).summary.phasesMs.cli.p50, 1000);

  const server = createServer(config, recovered, runner);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/metrics?runId=${runId}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await response.text(), /private|resumeText|idempotencyKey/);
  assert.equal((await fetch(`${base}/metrics?runId=invalid`)).status, 400);
});

test('runner metrics include authorization and CLI phases without changing the result', async () => {
  let time = 0, live;
  const config = readConfig({});
  const runner = new CodexRunner(config, async (_command, args, options) => {
    time = 200;
    options.onTelemetry(() => ({ spawnMs: 3, stderr: 'private-output', events: { 'turn.completed': 1 } }));
    await writeFile(args[args.indexOf('-o') + 1], JSON.stringify({ letter: 'Здравствуйте! Хочу обсудить вакансию.', warnings: [] }));
    time = 1200;
    return { exitCode: 0, stdout: '', stderr: '', failure: null, durationMs: 1100 };
  }, null, () => time);
  runner.authStatus = async () => { time = 100; return { authenticated: true }; };
  const output = await runner.run({ ...config, input: validateInput({ resumeText: 'Java', vacancyText: 'Java' }) },
    new AbortController().signal, undefined, getter => { live = getter; });
  assert.equal(output.error, null);
  assert.equal(output.telemetry.phasesMs.auth, 100);
  assert.equal(output.telemetry.phasesMs.cli, 1100);
  assert.equal(output.telemetry.cli.spawnMs, 3);
  assert.equal(live().stage, 'finished');
  assert.doesNotMatch(JSON.stringify(output.telemetry), /private/);
});

test('a failing diagnostics observer cannot fail generation', async () => {
  const config = readConfig({});
  const runner = new CodexRunner(config, async (_command, args) => {
    await writeFile(args[args.indexOf('-o') + 1], JSON.stringify({ letter: 'Здравствуйте! Хочу обсудить вакансию.', warnings: [] }));
    return { exitCode: 0, stdout: '', stderr: '', failure: null, durationMs: 1 };
  }, null);
  runner.authStatus = async () => ({ authenticated: true });
  const output = await runner.run({ ...config, input: validateInput({ resumeText: 'Java', vacancyText: 'Java' }) },
    new AbortController().signal, undefined, () => { throw new Error('private-observer-error'); });
  assert.equal(output.error, null);
  assert.equal(output.telemetry.stage, 'finished');
});

test('process instrumentation observes a synthetic CLI without exposing its raw output', async () => {
  let live;
  const script = "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'private-thread'})+'\\n');"
    + "process.stdout.write(JSON.stringify({type:'turn.completed',private:'private-payload'}));"
    + "process.stderr.write('Reconnecting HTTP 429 private-secret\\n');";
  const output = await runProcess(process.execPath, ['-e', script], { input: 'private-input', timeoutMs: 3000,
    onTelemetry: getter => { live = getter; } });
  assert.equal(output.exitCode, 0);
  assert.equal(output.telemetry.events['thread.started'], 1);
  assert.equal(output.telemetry.events['turn.completed'], 1);
  assert.equal(output.telemetry.diagnostics.retryMessages.count, 1);
  assert.ok(output.telemetry.spawnMs !== null);
  assert.ok(output.telemetry.exitMs >= output.telemetry.spawnMs);
  assert.equal(live().exitCode, 0);
  assert.doesNotMatch(JSON.stringify(output.telemetry), /private/);
});

test('a missing CLI exposes only a safe spawn error code', async () => {
  const output = await runProcess('hh-clicker-no-such-executable-708092', [], { timeoutMs: 3000 });
  assert.equal(output.failure, 'CLI_UNAVAILABLE');
  assert.equal(output.telemetry.spawnErrorCode, 'ENOENT');
  assert.equal(output.telemetry.spawnMs, null);
});
