import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GenerationQueue } from '../src/queue.js';
import { readConfig } from '../src/config.js';
import { GenerationResources } from '../src/resources.js';
import { validateInput, validateVacancyRelevanceInput } from '../src/contract.js';

const relevance = validateVacancyRelevanceInput({ resumeText: 'Java', vacancies: [{ hhId: '1', title: 'Java' }] });
const letter = validateInput({ resumeText: 'Java', vacancyText: 'Java' });
const market = { vacancies: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Java', text: 'Java' }] };
const success = { result: { items: [] }, error: null, usage: null, cliMs: 1 };

function within(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Barrier timed out')), 3000);
  })]).finally(() => clearTimeout(timer));
}

async function createQueue(t, runner, resources = null) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hh-parallel-queue-'));
  const queue = new GenerationQueue({ ...readConfig({}), dataDir }, { version: 'test', run: runner }, resources);
  await queue.initialize();
  t.after(async () => { await queue.stop(); await rm(dataDir, { recursive: true, force: true }); });
  return queue;
}

test('an explicit 50-job ceiling is independent of the ordinary 20-job queue limit', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const resources = new GenerationResources(readConfig({ GENERATION_MAX_CONCURRENT_RELEVANCE: '50' }), { memory: () => ({
    totalBytes: 32 * 1024 ** 3, availableBytes: 28 * 1024 ** 3, agentBytes: 32 * 1024 ** 2, source: 'test',
  }) });
  const queue = await createQueue(t, async () => {
    if (++calls === 50) entered.resolve();
    await release.promise;
    return success;
  }, resources);
  const jobs = [];
  for (let index = 0; index < 50; index++) jobs.push((await queue.create(relevance, `batch-${index}`, 'vacancy-relevance')).job);
  const tick = queue.tick();
  try {
    await within(entered.promise);
    assert.equal(queue.status().running, 50);
    assert.equal(queue.status().runningRelevance, 50);
    await queue.tick();
    assert.equal(calls, 50);
  } finally { release.resolve(); await tick; }
  assert.ok(jobs.every(job => queue.find(job.id).status === 'done'));
});

test('letters remain sequential while relevance uses independent concurrent executions', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let regular = 0, regularPeak = 0, relevanceRunning = 0, relevancePeak = 0, calls = 0;
  const queue = await createQueue(t, async job => {
    const parallel = job.kind === 'vacancy-relevance';
    if (parallel) relevancePeak = Math.max(relevancePeak, ++relevanceRunning);
    else regularPeak = Math.max(regularPeak, ++regular);
    if (++calls === 3) entered.resolve();
    await release.promise;
    if (parallel) relevanceRunning--; else regular--;
    return success;
  });
  await queue.create(letter);
  const secondLetter = (await queue.create(letter)).job;
  await queue.create(relevance, 'first', 'vacancy-relevance');
  await queue.create(relevance, 'second', 'vacancy-relevance');
  const tick = queue.tick();
  try {
    await within(entered.promise);
    assert.equal(regularPeak, 1);
    assert.equal(relevancePeak, 2);
    assert.equal(queue.find(secondLetter.id).status, 'queued');
  } finally { release.resolve(); await tick; }
  await queue.tick();
  assert.equal(queue.find(secondLetter.id).status, 'done');
  assert.equal(regularPeak, 1);
});

test('shutdown aborts and awaits every relevance execution', async t => {
  const entered = Promise.withResolvers();
  let calls = 0, aborted = 0;
  const queue = await createQueue(t, async (_job, signal) => {
    if (++calls === 12) entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted++;
    return { ...success, result: null, error: { code: 'INTERRUPTED', message: 'Stopped' } };
  });
  const jobs = [];
  for (let index = 0; index < 12; index++) jobs.push((await queue.create(relevance, `stop-${index}`, 'vacancy-relevance')).job);
  const tick = queue.tick();
  try { await within(entered.promise); }
  finally { await queue.stop(); await tick; }
  assert.equal(aborted, 12);
  assert.ok(jobs.every(job => queue.find(job.id).status === 'failed'));
});

test('parallel admission with the same key executes the model only once', async t => {
  let calls = 0;
  const queue = await createQueue(t, async () => { calls++; return success; });
  const submitted = await Promise.all(Array.from({ length: 25 }, () => queue.create(relevance, 'same-key', 'vacancy-relevance')));
  assert.equal(new Set(submitted.map(item => item.job.id)).size, 1);
  await queue.tick();
  assert.equal(calls, 1);
});

test('memory admission keeps excess jobs queued without starving a later letter', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const order = [];
  const resources = new GenerationResources(readConfig({ GENERATION_MAX_CONCURRENT_ANALYSIS: '10' }), { memory: () => ({
    totalBytes: 4 * 1024 ** 3, availableBytes: 3500 * 1024 ** 2, agentBytes: 32 * 1024 ** 2, source: 'test',
  }) });
  const queue = await createQueue(t, async job => {
    order.push(job.kind);
    if (order.length === 7) entered.resolve();
    await release.promise;
    return success;
  }, resources);
  for (let index = 0; index < 10; index++) await queue.create(relevance, `limited-${index}`, 'vacancy-relevance');
  await queue.create(letter);
  const tick = queue.tick();
  try {
    await within(entered.promise);
    assert.equal(order.filter(kind => kind === 'cover-letter').length, 1);
    assert.equal(queue.status().runningRelevance, 6);
    assert.equal(queue.status().queuedRelevance, 4);
    assert.equal(queue.status().resources.activeReservations, 7);
  } finally { release.resolve(); await tick; }
  await queue.tick();
  assert.equal(order.length, 11);
  assert.equal(queue.status().queuedRelevance, 0);
  assert.equal(queue.status().resources.activeReservations, 0);
});

test('a later letter wins the only available memory slot before older relevance jobs', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const resources = new GenerationResources(readConfig({}), { memory: () => ({
    totalBytes: 1024 ** 3, availableBytes: 900 * 1024 ** 2, agentBytes: 32 * 1024 ** 2, source: 'test',
  }) });
  const queue = await createQueue(t, async job => {
    entered.resolve(job.kind);
    await release.promise;
    return success;
  }, resources);
  for (let index = 0; index < 3; index++) await queue.create(relevance, `older-${index}`, 'vacancy-relevance');
  const submittedLetter = (await queue.create(letter)).job;
  const tick = queue.tick();
  try {
    assert.equal(await within(entered.promise), 'cover-letter');
    assert.equal(queue.status().resources.capacity, 1);
    assert.equal(queue.status().resources.activeReservations, 1);
    assert.equal(queue.status().runningRelevance, 0);
    assert.equal(queue.status().queuedRelevance, 3);
  } finally { release.resolve(); await tick; }
  assert.equal(queue.find(submittedLetter.id).status, 'done');
});

test('the default four-job ceiling dispatches remaining relevance in later waves', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0, running = 0, peak = 0;
  const resources = new GenerationResources(readConfig({}), { memory: () => ({
    totalBytes: 32 * 1024 ** 3, availableBytes: 28 * 1024 ** 3, agentBytes: 32 * 1024 ** 2, source: 'test',
  }) });
  const queue = await createQueue(t, async () => {
    peak = Math.max(peak, ++running);
    if (++calls === 4) entered.resolve();
    await release.promise;
    running--;
    return success;
  }, resources);
  for (let index = 0; index < 11; index++) await queue.create(relevance, `capped-${index}`, 'vacancy-relevance');
  const tick = queue.tick();
  try {
    await within(entered.promise);
    assert.equal(queue.status().runningRelevance, 4);
    assert.equal(queue.status().queuedRelevance, 7);
    assert.equal(queue.status().resources.waitingReason, 'CONCURRENCY_LIMIT');
    await queue.tick();
    assert.equal(calls, 4);
  } finally { release.resolve(); await tick; }
  await queue.tick();
  await queue.tick();
  assert.equal(calls, 11);
  assert.equal(peak, 4);
  assert.equal(queue.status().queuedRelevance, 0);
  assert.equal(queue.status().resources.activeReservations, 0);
});

test('market and relevance run in parallel under one four-job ceiling with a separate sequential letter lane', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const kinds = [];
  const resources = new GenerationResources(readConfig({}), { memory: () => ({
    totalBytes: 32 * 1024 ** 3, availableBytes: 28 * 1024 ** 3, agentBytes: 32 * 1024 ** 2, source: 'test',
  }) });
  const queue = await createQueue(t, async job => {
    kinds.push(job.kind);
    if (kinds.length === 5) entered.resolve();
    await release.promise;
    return success;
  }, resources);
  await queue.create(market, 'market-1', 'market-extraction');
  await queue.create(relevance, 'relevance-1', 'vacancy-relevance');
  await queue.create(market, 'market-2', 'market-extraction');
  await queue.create(relevance, 'relevance-2', 'vacancy-relevance');
  await queue.create(market, 'market-3', 'market-extraction');
  await queue.create(letter, 'letter-1');
  const secondLetter = (await queue.create(letter, 'letter-2')).job;
  const tick = queue.tick();
  try {
    await within(entered.promise);
    assert.equal(queue.status().runningAnalysis, 4);
    assert.equal(queue.status().queuedAnalysis, 1);
    assert.equal(kinds.filter(kind => kind === 'market-extraction').length, 2);
    assert.equal(kinds.filter(kind => kind === 'vacancy-relevance').length, 2);
    assert.equal(kinds.filter(kind => kind === 'cover-letter').length, 1);
    assert.equal(queue.find(secondLetter.id).status, 'queued');
    assert.equal(queue.status().resources.maxConcurrentAnalysis, 4);
  } finally { release.resolve(); await tick; }
  await queue.tick();
  assert.equal(queue.status().queued, 0);
});
