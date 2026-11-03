import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAccount, rateLimitWindow } from '../src/account-status.js';
import { CodexRunner } from '../src/codex.js';
import { readConfig } from '../src/config.js';

const window = { usedPercent: 36, windowDurationMins: 300, resetsAt: 1789464317 };
const ready = { authenticated: true, method: 'chatgpt', limits: { primary: window, secondary: null }, error: null };

test('account check refreshes token, reads limits without generation and strips private fields', async () => {
  const calls = []; let closed = false;
  const result = await checkAccount('codex', () => ({
    start: async () => {}, close: () => { closed = true; },
    request: async (method, params) => {
      calls.push([method, params]);
      return method === 'account/read' ? { account: { type: 'chatgpt', email: 'private@example.test' } }
        : { rateLimitsByLimitId: { codex: { primary: { ...window, secret: 'private-token' } } } };
    },
  }));
  assert.deepEqual(calls, [['account/read', { refreshToken: true }], ['account/rateLimits/read', undefined]]);
  assert.deepEqual(result, ready);
  assert.equal(closed, true);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('missing account requires login and always closes process', async () => {
  let closed = false;
  await assert.rejects(checkAccount('codex', () => ({ start: async () => {}, request: async () => ({ account: null }), close: () => { closed = true; } })), /AUTH_REQUIRED/);
  assert.equal(closed, true);
});

test('malformed windows are omitted rather than inventing available limits', () => {
  for (const value of [null, {}, { ...window, usedPercent: NaN }, { ...window, usedPercent: 101 }, { ...window, resetsAt: -1 }, { ...window, windowDurationMins: 0 }]) assert.equal(rateLimitWindow(value), null);
});

test('concurrent consumers share online request and cache; new login invalidates cache', async () => {
  let calls = 0; let finish;
  const runner = new CodexRunner(readConfig({}), undefined, () => {
    calls++; return calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(ready);
  });
  const a = runner.authStatus(); const b = runner.authStatus();
  finish(ready);
  assert.deepEqual(await a, ready); assert.deepEqual(await b, ready);
  assert.deepEqual(await runner.authStatus(), ready); assert.equal(calls, 1);
  await runner.authenticationChanged(true);
  await runner.authStatus();
  assert.equal(calls, 2);
});

test('network failure reports unknown readiness, not logout, and never leaks diagnostics', async () => {
  const runner = new CodexRunner(readConfig({}), undefined, async () => { throw new Error('private-token connection refused'); });
  const result = await runner.authStatus();
  assert.equal(result.error.code, 'AUTH_CHECK_FAILED');
  assert.equal(runner.authRejected, false);
  assert.equal(result.limits, null);
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
});

test('online rejection latches until login; older response cannot restore green', async () => {
  let finish; let calls = 0;
  const runner = new CodexRunner(readConfig({}), undefined, () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(ready));
  const pending = runner.authStatus();
  await runner.authenticationChanged(false); finish(ready);
  assert.equal((await pending).error.code, 'AUTH_REQUIRED');
  assert.equal((await runner.authStatus()).authenticated, false);
  await runner.authenticationChanged(true);
  const retry = runner.authStatus();
  assert.equal((await retry).authenticated, true);
});

test('snapshot reads never launch online checks, even when cache has expired', async () => {
  let calls = 0;
  const runner = new CodexRunner(readConfig({}), undefined, async () => { calls++; return ready; });
  assert.equal(runner.authSnapshot().authenticated, false);
  assert.equal(calls, 0);
  await runner.authStatus();
  const checkedAt = runner.authSnapshot().checkedAt;
  runner.authCache.until = 0;
  for (let i = 0; i < 20; i++) {
    assert.equal(runner.authSnapshot().authenticated, true);
    assert.equal(runner.authSnapshot().checkedAt, checkedAt);
  }
  assert.equal(calls, 1);
  await runner.authStatus();
  assert.equal(calls, 2);
});

test('rate-limit failure includes the latest exhausted window reset, without inventing it on network failure', async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const runner = new CodexRunner(readConfig({}), undefined, async () => ({ ...ready,
    limits: { primary: { ...window, usedPercent: 100, resetsAt: reset }, secondary: null } }));
  const failure = await runner.rateLimitFailure();
  assert.equal(failure.code, 'RATE_LIMIT');
  assert.equal(failure.resetsAt, reset);
  assert.match(failure.message, /UTC/);
  const offline = new CodexRunner(readConfig({}), undefined, async () => { throw new Error('private'); });
  assert.equal((await offline.rateLimitFailure()).resetsAt, null);
});
