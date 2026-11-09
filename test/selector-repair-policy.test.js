import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { GenerationQueue } from '../src/queue.js';
import { generationArgs } from '../src/codex.js';
import { validateInput } from '../src/contract.js';

test('selector repair alone uses Sol medium, in both stage jobs and their CLI arguments', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'selector-policy-'));
  const config = { ...readConfig({}), dataDir };
  const queue = new GenerationQueue(config, {});
  await queue.initialize();
  t.after(async () => { await queue.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const input = { group: { selectors: {} }, html: '<main>Snapshot</main>' };
  for (const [key, body] of [['repair-first', input], ['repair-review', { ...input, review: {} }]]) {
    const { job } = await queue.create(body, key, 'selector-repair');
    const stored = queue.jobs.get(job.id);
    assert.equal(stored.model, 'gpt-6-sol');
    assert.equal(stored.reasoningEffort, 'medium');
    const args = generationArgs(stored, dataDir);
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-sol');
    assert.ok(args.includes('model_reasoning_effort="medium"'));
  }
  const { job } = await queue.create(validateInput({ resumeText: 'Java', vacancyText: 'Backend' }), 'letter');
  assert.equal(queue.jobs.get(job.id).model, 'gpt-6-luna');
  assert.equal(queue.jobs.get(job.id).reasoningEffort, 'low');
  // The global policy is irrelevant for selector idempotency; its dedicated policy is relevant.
  config.model = 'another-default';
  assert.equal((await queue.create(input, 'repair-first', 'selector-repair')).reused, true);
  config.selectorRepairReasoningEffort = 'high';
  await assert.rejects(queue.create(input, 'repair-first', 'selector-repair'), error => error.status === 409);
});

test('dedicated selector settings are validated without changing ordinary settings', () => {
  const config = readConfig({ CODEX_SELECTOR_REPAIR_MODEL: 'gpt-6-sol', CODEX_SELECTOR_REPAIR_REASONING_EFFORT: 'medium' });
  assert.equal(config.model, 'gpt-6-luna');
  assert.equal(config.reasoningEffort, 'low');
  assert.equal(config.selectorRepairModel, 'gpt-6-sol');
  for (const env of [{ CODEX_SELECTOR_REPAIR_MODEL: 'bad model' }, { CODEX_SELECTOR_REPAIR_REASONING_EFFORT: 'invalid' }])
    assert.throws(() => readConfig(env));
});
