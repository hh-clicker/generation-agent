import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexRunner as Runner } from '../src/codex.js';
class CodexRunner extends Runner { constructor(config, execute) { super(config, execute, null); } }
import { CodexAuthManager } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { validateInput } from '../src/contract.js';

const credentialsPresent = { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT', failure: null };
const rejected = { exitCode: 1, stdout: '', stderr: '401 Unauthorized private-diagnostic', failure: null, durationMs: 1 };
const job = { ...readConfig({}), input: validateInput({ resumeText: 'Разработчик сервисов.', vacancyText: 'Нужен разработчик.' }) };
const signal = () => new AbortController().signal;

test('generation rejection overrides local credentials, blocks retries, survives restart and clears on new login', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'auth-rejection-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { ...readConfig({}), dataDir };
  let executions = 0;
  const execute = async (_command, args) => {
    executions++;
    return args.includes('login') ? credentialsPresent : rejected;
  };
  const runner = new CodexRunner(config, execute);
  await runner.initializeAuthState();
  assert.equal((await runner.authStatus()).authenticated, true);
  const result = await runner.run(job, signal());
  assert.equal(result.error.code, 'AUTH_REQUIRED');
  assert.doesNotMatch(JSON.stringify(result), /private-diagnostic/);
  const callsAfterFailure = executions;
  assert.equal((await runner.authStatus()).authenticated, false);
  assert.equal((await runner.run(job, signal())).error.code, 'AUTH_REQUIRED');
  assert.equal(executions, callsAfterFailure);

  const restarted = new CodexRunner(config, execute);
  await restarted.initializeAuthState();
  assert.equal((await restarted.authStatus()).authenticated, false);
  assert.equal(executions, callsAfterFailure);
  await restarted.authenticationChanged(true);
  assert.equal((await restarted.authStatus()).authenticated, true);
  const restartedAfterLogin = new CodexRunner(config, execute);
  await restartedAfterLogin.initializeAuthState();
  assert.equal((await restartedAfterLogin.authStatus()).authenticated, true);
});

test('a failure from an old generation cannot reject a newer login', async () => {
  let finishExecution;
  let executionStarted;
  const started = new Promise(resolve => { executionStarted = resolve; });
  const runner = new CodexRunner(readConfig({}), async (_command, args) => {
    if (args.includes('login')) return credentialsPresent;
    executionStarted();
    return new Promise(resolve => { finishExecution = resolve; });
  });
  const pending = runner.run(job, signal());
  await started;
  await runner.authenticationChanged(true);
  finishExecution(rejected);
  assert.equal((await pending).error.code, 'AUTH_REQUIRED');
  assert.equal((await runner.authStatus()).authenticated, true);
});

test('an in-flight local credential check cannot restore green status after rejection', async () => {
  let finishCheck;
  const runner = new CodexRunner(readConfig({}), async () => new Promise(resolve => { finishCheck = resolve; }));
  const pending = runner.authStatus();
  await runner.setAuthRejected(true);
  finishCheck(credentialsPresent);
  assert.equal((await pending).authenticated, false);
});

test('rate limits do not invalidate credentials', async () => {
  const runner = new CodexRunner(readConfig({}), async (_command, args) => args.includes('login')
    ? credentialsPresent : { ...rejected, stderr: '429 Too many requests' });
  assert.equal((await runner.run(job, signal())).error.code, 'RATE_LIMIT');
  assert.equal((await runner.authStatus()).authenticated, true);
});

test('only successful matching device login clears rejection; logout rejects again', async () => {
  const changes = [];
  let client;
  const manager = new CodexAuthManager(readConfig({}), () => {
    client = {
      notification: null, start: async () => {}, close: () => {},
      request: async method => method === 'account/login/start'
        ? { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }
        : {},
    };
    return client;
  }, async authenticated => { changes.push(authenticated); });
  await manager.startLogin();
  await client.notification({ method: 'account/login/completed', params: { loginId: 'other', success: true } });
  assert.deepEqual(changes, []);
  await manager.cancelLogin();
  assert.deepEqual(changes, []);
  await manager.startLogin();
  await client.notification({ method: 'account/login/completed', params: { loginId: 'login-1', success: false } });
  assert.deepEqual(changes, []);
  await manager.startLogin();
  await client.notification({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } });
  assert.deepEqual(changes, [true]);
  assert.equal(manager.status().status, 'succeeded');
  await manager.logout();
  assert.deepEqual(changes, [true, false]);
});
