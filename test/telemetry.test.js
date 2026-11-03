import test from 'node:test';
import assert from 'node:assert/strict';
import { CliTelemetry, GenerationTelemetry, diagnosticSummary, distribution, jobDiagnostic } from '../src/telemetry.js';

test('streaming events survive chunk and UTF-8 boundaries and expose no content or thread IDs', () => {
  let time = 0;
  const telemetry = new CliTelemetry(() => time);
  time = 5; telemetry.spawned();
  time = 7; telemetry.stdinFlushed();
  const event = Buffer.from('{"type":"thread.started","thread_id":"private-thread"}\n');
  time = 10; telemetry.feed(event.subarray(0, 17));
  time = 12; telemetry.feed(event.subarray(17));
  time = 20; telemetry.feed(Buffer.from('{"type":"turn.started"}\n'));
  const message = Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"секрет private-text"}}\n');
  const split = message.indexOf(Buffer.from('секрет')) + 1;
  time = 25; telemetry.feed(message.subarray(0, split));
  time = 30; telemetry.feed(message.subarray(split));
  time = 40; telemetry.feed(Buffer.from('{"type":"turn.completed","usage":{"input_tokens":123}}'));
  time = 50; telemetry.finish(0);
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.spawnMs, 5);
  assert.equal(snapshot.stdinFlushedMs, 7);
  assert.equal(snapshot.threadStartedMs, 12);
  assert.equal(snapshot.turnStartedMs, 20);
  assert.equal(snapshot.firstAgentMessageMs, 30);
  assert.equal(snapshot.events['turn.completed'], 1);
  assert.equal(snapshot.malformedLines, 0);
  assert.equal(snapshot.exitMs, 50);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|секрет|thread_id|input_tokens/);
  time = 500;
  assert.equal(telemetry.snapshot().elapsedMs, 50);
});

test('diagnostic counters are bounded labels, and live silence is measurable', () => {
  let time = 0;
  const telemetry = new CliTelemetry(() => time);
  time = 10;
  telemetry.feed(Buffer.from('Reconnecting 1/5: HTTP 429 Bearer private-token\n'), true);
  time = 20;
  telemetry.feed(Buffer.from('database is locked /private/path\n'), true);
  time = 30;
  telemetry.feed(Buffer.from('{"type":"error","message":"retrying HTTP 429 private-response"}\n'));
  time = 60;
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.silentForMs, 30);
  assert.equal(snapshot.diagnostics.retryMessages.count, 2);
  assert.equal(snapshot.diagnostics.rateLimitMessages.count, 2);
  assert.equal(snapshot.diagnostics.sqliteBusyMessages.firstMs, 20);
  assert.equal(snapshot.events.error, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|Bearer|Reconnecting|database is locked/);
});

test('malformed and oversized lines recover without growing an unbounded buffer', () => {
  const telemetry = new CliTelemetry(() => 0);
  telemetry.feed(Buffer.from('not json\n'));
  telemetry.feed(Buffer.from('x'.repeat(100_000)));
  telemetry.feed(Buffer.from('x'.repeat(100_000) + '\n{"type":"turn.started"}\n{"type":"private-kind"}\n'));
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.malformedLines, 1);
  assert.equal(snapshot.oversizedLines, 1);
  assert.equal(snapshot.unknownEvents, 1);
  assert.equal(snapshot.events['turn.started'], 1);
  assert.ok(telemetry.streams.stdout.buffer.length <= 64 * 1024);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-kind/);
});

test('runner phase timers remain live and separate auth, CLI and cleanup', () => {
  let time = 0;
  const telemetry = new GenerationTelemetry(() => time);
  time = 100;
  assert.equal(telemetry.snapshot().phasesMs.auth, 100);
  telemetry.enter('prepare');
  time = 120; telemetry.enter('cli');
  time = 1120;
  assert.equal(telemetry.snapshot().stageElapsedMs, 1000);
  telemetry.enter('validate');
  time = 1140; telemetry.enter('cleanup');
  time = 1150; telemetry.finish();
  assert.deepEqual(telemetry.snapshot().phasesMs, { auth: 100, prepare: 20, cli: 1000,
    rateLimitCheck: null, validate: 20, cleanup: 10 });
});

test('percentiles do not count missing instrumentation as zero', () => {
  assert.deepEqual(distribution([null, undefined, -1, NaN]),
    { count: 0, min: null, p50: null, p95: null, max: null, mean: null });
  assert.deepEqual(distribution([10, 20, 30, 100]), { count: 4, min: 10, p50: 20, p95: 100, max: 100, mean: 40 });
});

test('diagnostic records whitelist fields and summaries separate completed and active jobs', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');
  const raw = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'vacancy-relevance', status: 'done',
    idempotencyKey: 'relevance-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-2', vacancyCount: 10,
    createdAt: new Date(now - 2000).toISOString(), startedAt: new Date(now - 1500).toISOString(),
    completedAt: new Date(now - 500).toISOString(), timings: { queueMs: 500, executionMs: 1000, cliMs: 900, totalMs: 1500 },
    input: { resumeText: 'private-input' }, result: { items: [{ reason: 'private-answer' }] },
    telemetry: { version: 1, stage: 'finished', phasesMs: { cli: 900 }, private: 'private-field',
      cli: { events: { 'turn.completed': 1, 'private-kind': 1 }, stderr: 'private-stderr' } } };
  const record = jobDiagnostic(raw, { now });
  assert.equal(record.batchIndex, 2);
  assert.equal(record.evaluatedVacancies, 1);
  assert.equal(record.runId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.doesNotMatch(JSON.stringify(record), /private|resumeText|"reason":|idempotencyKey/);
  const active = jobDiagnostic({ ...raw, status: 'running', completedAt: null, telemetry: null,
    timings: { queueMs: 500 } }, { now });
  const summary = diagnosticSummary([record, active], now);
  assert.equal(summary.instrumentedJobs, 1);
  assert.equal(summary.phasesMs.cli.count, 1);
  assert.equal(summary.phasesMs.cli.p95, 900);
  assert.equal(summary.activeAgesMs.max, 1500);
  assert.equal(summary.evaluatedVacancies, 1);
  assert.equal(summary.completedLastMinute, 1);
});


test('market run keys expose only numeric batch/attempt context and extraction counts', () => {
  const record = jobDiagnostic({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'market-extraction', status: 'done',
    idempotencyKey: 'market-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-extract-12-attempt-3',
    result: { items: [{ facts: [{ evidence: 'private evidence' }] }] } });
  assert.equal(record.runId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(record.batchIndex, 12);
  assert.equal(record.attempt, 3);
  assert.equal(record.runKind, 'market-extraction');
  assert.equal(record.extractedVacancies, 1);
  assert.equal(record.evaluatedVacancies, null);
  assert.equal(diagnosticSummary([record]).extractedVacancies, 1);
  assert.doesNotMatch(JSON.stringify(record), /private|evidence|idempotencyKey/);
});
