import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationResources, systemMemory, processTreeMemory } from '../src/resources.js';
import { readConfig } from '../src/config.js';

const MiB = 1024 * 1024;
function policy(totalMiB = 4096, availableMiB = 3500, measure = async () => null) {
  const snapshot = { totalBytes: totalMiB * MiB, availableBytes: availableMiB * MiB,
    agentBytes: 32 * MiB, source: 'test' };
  return { snapshot, resources: new GenerationResources(readConfig({ GENERATION_MAX_CONCURRENT_ANALYSIS: '10' }), { memory: () => snapshot, measure }) };
}

test('the effective memory is constrained by the container, not the host RAM', () => {
  const snapshot = systemMemory({ hostTotal: 32 * 1024 * MiB, constrained: 2 * 1024 * MiB,
    available: 8 * 1024 * MiB, agentBytes: 32 * MiB });
  assert.equal(snapshot.totalBytes, 2 * 1024 * MiB);
  assert.equal(snapshot.availableBytes, 2 * 1024 * MiB);
  assert.equal(snapshot.source, 'container');
});

test('larger machines admit more work, without using the CPU count', async () => {
  const small = policy(1024, 900).resources;
  const large = policy(32 * 1024, 28 * 1024).resources;
  await small.refresh();
  await large.refresh();
  assert.equal(small.status().capacity, 1);
  assert.ok(large.status().capacity >= 50);
  assert.equal(large.status().availableRelevanceSlots, 10);
  assert.equal(small.reserve('small', 'vacancy-relevance'), true);
  assert.equal(small.reserve('second', 'vacancy-relevance'), false);
});

test('startup reservations prevent oversubscription before CLI memory becomes visible', async () => {
  const { resources } = policy();
  await resources.refresh();
  for (let index = 0; index < 6; index++) assert.equal(resources.reserve(`job-${index}`, 'vacancy-relevance'), true);
  assert.equal(resources.reserve('overflow', 'vacancy-relevance'), false);
  assert.equal(resources.reserve('letter', 'cover-letter'), true);
  assert.equal(resources.reserve('overflow-letter', 'cover-letter'), false);
  resources.release('job-0');
  assert.equal(resources.reserve('replacement', 'vacancy-relevance'), true);
});

test('a change in available memory pauses admission and later resumes it', async () => {
  const { snapshot, resources } = policy();
  snapshot.availableBytes = 100 * MiB;
  await resources.refresh();
  assert.equal(resources.reserve('job', 'vacancy-relevance'), false);
  assert.equal(resources.status().waitingReason, 'MEMORY_PRESSURE');
  snapshot.availableBytes = 3500 * MiB;
  await resources.refresh();
  assert.equal(resources.reserve('job', 'vacancy-relevance'), true);
});

test('relevance can use the only free slot even when the total budget is larger', async () => {
  const { resources } = policy(4096, 640);
  await resources.refresh();
  assert.ok(resources.status().capacity > 1);
  assert.equal(resources.status().availableSlots, 1);
  assert.equal(resources.reserve('job', 'vacancy-relevance'), true);
});

test('a partly started CLI cannot lower the estimate, but a completed measured job can', async () => {
  const { resources } = policy(4096, 3500, async () => 40 * MiB);
  await resources.refresh();
  assert.equal(resources.reserve('job', 'vacancy-relevance'), true);
  resources.attach('job', 10);
  await resources.refresh();
  assert.equal(resources.status().perJobBytes, 128 * MiB);
  resources.release('job', true);
  assert.equal(resources.status().perJobBytes, 64 * MiB);
  assert.equal(resources.status().calibrated, true);
});

test('a failed job cannot calibrate the estimate downwards', async () => {
  const { resources } = policy(4096, 3500, async () => 40 * MiB);
  await resources.refresh();
  resources.reserve('job', 'vacancy-relevance');
  resources.attach('job', 10);
  await resources.refresh();
  resources.release('job', false);
  assert.equal(resources.status().perJobBytes, 128 * MiB);
  assert.equal(resources.status().calibrated, false);
});

test('an observed higher footprint immediately reduces further admission', async () => {
  const { resources } = policy(4096, 3500, async () => 300 * MiB);
  await resources.refresh();
  resources.reserve('job', 'vacancy-relevance');
  resources.attach('job', 10);
  await resources.refresh();
  assert.equal(resources.status().perJobBytes, 450 * MiB);
  assert.equal(resources.reserve('another', 'vacancy-relevance'), false);
});

test('unavailable measurements preserve the estimate without failing the worker', async () => {
  const { resources } = policy(4096, 3500, async () => { throw new Error('No proc access'); });
  await resources.refresh();
  resources.reserve('job', 'vacancy-relevance');
  resources.attach('job', 10);
  await resources.refresh();
  resources.release('job', true);
  assert.equal(resources.status().calibrated, false);
  assert.equal(resources.status().perJobBytes, 128 * MiB);
});

test('missing OS memory information does not admit work on an invented budget', async () => {
  const resources = new GenerationResources(readConfig({}), { memory: () => { throw new Error('No metrics'); } });
  await resources.refresh();
  assert.equal(resources.reserve('job', 'cover-letter'), false);
  assert.equal(resources.status().waitingReason, 'MEMORY_UNKNOWN');
});

test('Linux measurement includes wrapper, descendants and swapped pages without double visiting', async () => {
  const files = new Map([
    ['/proc/10/status', 'VmRSS:\t20480 kB\nVmSwap:\t1024 kB\n'],
    ['/proc/10/task/10/children', '20 20'],
    ['/proc/20/status', 'VmRSS:\t30720 kB\n'],
    ['/proc/20/task/20/children', '10'],
  ]);
  assert.equal(await processTreeMemory(10, 'linux', async path => files.get(path) ?? ''), 51 * MiB);
  assert.equal(await processTreeMemory(10, 'win32', async () => { throw new Error('Must not read proc'); }), null);
});

test('memory configuration rejects invalid budgets and cold-start estimates', () => {
  for (const value of ['0', '76', 'NaN', '2.5']) assert.throws(() => readConfig({ GENERATION_MEMORY_PERCENT: value }));
  for (const value of ['0', '63', 'NaN']) assert.throws(() => readConfig({ GENERATION_JOB_MEMORY_MIB: value }));
  for (const value of ['0', '1001', 'NaN', '2.5']) assert.throws(() => readConfig({ GENERATION_MAX_CONCURRENT_RELEVANCE: value }));
});

test('ordinary work can use its reserved memory slot while relevance reaches its configured ceiling', async () => {
  const { resources } = policy(32 * 1024, 28 * 1024);
  await resources.refresh();
  for (let index = 0; index < 10; index++) assert.equal(resources.reserve(`job-${index}`, 'vacancy-relevance'), true);
  assert.equal(resources.reserve('extra-relevance', 'vacancy-relevance'), false);
  assert.equal(resources.reserve('letter', 'cover-letter'), true);
  resources.release('job-0');
  assert.equal(resources.reserve('replacement', 'vacancy-relevance'), true);
});


test('the default shared ceiling is four and the new setting overrides the legacy setting', () => {
  assert.equal(readConfig({}).maxConcurrentAnalysis, 4);
  assert.equal(readConfig({ GENERATION_MAX_CONCURRENT_RELEVANCE: '5' }).maxConcurrentAnalysis, 5);
  assert.equal(readConfig({ GENERATION_MAX_CONCURRENT_ANALYSIS: '3', GENERATION_MAX_CONCURRENT_RELEVANCE: '5' }).maxConcurrentAnalysis, 3);
  for (const value of ['0', '1001', 'NaN', '2.5']) assert.throws(() => readConfig({ GENERATION_MAX_CONCURRENT_ANALYSIS: value }));
});

test('relevance and both market task kinds consume one shared limit while letters retain their slot', async () => {
  const resources = new GenerationResources(readConfig({}), { memory: () => ({
    totalBytes: 32 * 1024 * MiB, availableBytes: 28 * 1024 * MiB, agentBytes: 32 * MiB, source: 'test',
  }) });
  await resources.refresh();
  assert.equal(resources.reserve('r1', 'vacancy-relevance'), true);
  assert.equal(resources.reserve('m1', 'market-extraction'), true);
  assert.equal(resources.reserve('m2', 'market-extraction'), true);
  assert.equal(resources.reserve('c1', 'market-coverage'), true);
  assert.equal(resources.reserve('fifth', 'vacancy-relevance'), false);
  assert.equal(resources.status().waitingReason, 'CONCURRENCY_LIMIT');
  assert.equal(resources.status().availableAnalysisSlots, 0);
  assert.equal(resources.reserve('letter', 'cover-letter'), true);
  resources.release('m1');
  assert.equal(resources.reserve('replacement', 'market-extraction'), true);
});
