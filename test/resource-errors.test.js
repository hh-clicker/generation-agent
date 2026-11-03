import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexRunner } from '../src/codex.js';
import { readConfig } from '../src/config.js';
import { validateInput } from '../src/contract.js';

const input = validateInput({ resumeText: 'Java', vacancyText: 'Java' });
for (const diagnostic of [
  'failed to spawn thread: Resource temporarily unavailable (os error 11)',
  'Cannot allocate memory (os error 12)',
]) {
  test(`resource exhaustion is classified safely: ${diagnostic}`, async () => {
    const runner = new CodexRunner(readConfig({}), async (_command, args) => {
      if (args.includes('login')) return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT', failure: null };
      return { exitCode: 1, stdout: '', stderr: diagnostic + ' private-marker', failure: null, durationMs: 1 };
    }, null);
    const output = await runner.run({ ...readConfig({}), kind: 'cover-letter', input }, new AbortController().signal);
    assert.equal(output.error.code, 'RESOURCE_EXHAUSTED');
    assert.doesNotMatch(JSON.stringify(output), /private-marker|os error/);
  });
}

test('runner forwards its PID observer to the real generation execution', async () => {
  let pid;
  const runner = new CodexRunner(readConfig({}), async (_command, args, options) => {
    if (args.includes('login')) return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT', failure: null };
    options.onSpawn(42);
    return { exitCode: null, stdout: '', stderr: '', failure: 'RESOURCE_EXHAUSTED', durationMs: 1 };
  }, null);
  const output = await runner.run({ ...readConfig({}), kind: 'cover-letter', input }, new AbortController().signal,
    value => { pid = value; });
  assert.equal(pid, 42);
  assert.equal(output.error.code, 'RESOURCE_EXHAUSTED');
});
