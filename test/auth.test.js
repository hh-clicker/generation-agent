import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAuthManager } from '../src/auth.js';

class FakeClient {
  constructor() {
    this.notification = null;
    this.closed = false;
    this.requests = [];
  }

  async start() {}

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'account/login/start') {
      return {
        type: 'chatgptDeviceCode', loginId: 'login-1',
        verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234',
      };
    }
    return {};
  }

  close() { this.closed = true; }
}

test('device login exposes only the URL and one-time code, then reports success', async () => {
  const client = new FakeClient();
  const manager = new CodexAuthManager({ codexBin: 'codex' }, () => client);
  assert.deepEqual(await manager.startLogin(), {
    status: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234',
  });
  await client.notification({
    method: 'account/login/completed',
    params: { loginId: 'login-1', success: true, error: null },
  });
  assert.deepEqual(manager.status(), { status: 'succeeded', message: 'Авторизация Codex завершена.' });
  assert.equal(client.closed, true);
});

test('logout uses the official account/logout method and leaves a signed-out state', async () => {
  const clients = [];
  const manager = new CodexAuthManager({ codexBin: 'codex' }, () => {
    const client = new FakeClient();
    clients.push(client);
    return client;
  });
  assert.deepEqual(await manager.logout(), { status: 'signed_out' });
  assert.deepEqual(clients[0].requests, [{ method: 'account/logout', params: undefined }]);
  assert.equal(clients[0].closed, true);
});

test('a repeated login click reuses the active device flow', async () => {
  const client = new FakeClient();
  const manager = new CodexAuthManager({ codexBin: 'codex' }, () => client);
  const first = await manager.startLogin();
  const second = await manager.startLogin();
  assert.deepEqual(second, first);
  assert.equal(client.requests.filter(request => request.method === 'account/login/start').length, 1);
});

test('a pending login can be cancelled without deleting the Codex volume', async () => {
  const client = new FakeClient();
  const manager = new CodexAuthManager({ codexBin: 'codex' }, () => client);
  await manager.startLogin();
  assert.deepEqual(await manager.cancelLogin(), { status: 'idle' });
  assert.deepEqual(client.requests.at(-1), {
    method: 'account/login/cancel', params: { loginId: 'login-1' },
  });
});
