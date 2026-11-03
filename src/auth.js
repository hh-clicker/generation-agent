import { spawn } from 'node:child_process';
import readline from 'node:readline';

const AUTH_CONFIG = ['-c', 'cli_auth_credentials_store="file"'];
const CLIENT_INFO = { name: 'hh_clicker', title: 'HH Clicker', version: '0.1.0' };
const START_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 15000;

function publicState(state) {
  const result = { status: state.status };
  if (state.verificationUrl) result.verificationUrl = state.verificationUrl;
  if (state.userCode) result.userCode = state.userCode;
  if (state.message) result.message = state.message;
  return result;
}

/** A minimal JSONL client for the stable account methods of `codex app-server`. */
export class CodexAppServer {
  constructor(codexBin, spawnProcess = spawn) {
    this.codexBin = codexBin;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.lines = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notification = null;
  }

  async start(timeoutMs = START_TIMEOUT_MS) {
    if (this.child) return;
    const child = this.spawnProcess(this.codexBin, [...AUTH_CONFIG, 'app-server'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.once('error', () => this.failAll(new Error('CODEX_UNAVAILABLE')));
    child.once('close', () => this.failAll(new Error('CODEX_APP_SERVER_STOPPED')));
    child.stderr.resume(); // Never expose raw CLI diagnostics through the local HTTP API.
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on('line', line => this.receive(line));
    await this.request('initialize', { clientInfo: CLIENT_INFO }, timeoutMs);
    this.send({ method: 'initialized', params: {} });
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CODEX_APP_SERVER_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const message = { method, id };
        if (params !== undefined) message.params = params;
        this.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  send(message) {
    if (!this.child?.stdin.writable) throw new Error('CODEX_APP_SERVER_STOPPED');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (Number.isSafeInteger(message?.id)) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        // Classify privately; never propagate credentials or raw server diagnostics.
        const text = JSON.stringify(message.error);
        const auth = /\b401\b|unauthorized|not logged in|authentication.*(?:failed|required)|refresh[_ .-]?token.*(?:failed|expired|revoked|reused)|token.*(?:expired|revoked|invalid)/i.test(text);
        request.reject(new Error(auth ? 'AUTH_REQUIRED' : 'AUTH_CHECK_FAILED'));
      }
      else request.resolve(message.result);
      return;
    }
    if (typeof message?.method === 'string') this.notification?.(message);
  }

  failAll(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.lines?.close();
    this.lines = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
    this.failAll(new Error('CODEX_APP_SERVER_STOPPED'));
  }
}

/** Owns at most one device-code login and exposes only non-secret presentation data. */
export class CodexAuthManager {
  constructor(config, createClient = () => new CodexAppServer(config.codexBin), authenticationChanged = async () => {}) {
    this.createClient = createClient;
    this.authenticationChanged = authenticationChanged;
    this.client = null;
    this.loginId = null;
    this.state = { status: 'idle' };
  }

  status() { return publicState(this.state); }

  async startLogin() {
    if (this.state.status === 'starting' || this.state.status === 'pending') return this.status();
    await this.closeClient();
    const client = this.createClient();
    this.client = client;
    this.state = { status: 'starting' };
    try {
      client.notification = message => this.onNotification(message);
      await client.start();
      const result = await client.request('account/login/start', { type: 'chatgptDeviceCode' });
      if (result?.type !== 'chatgptDeviceCode' || typeof result.loginId !== 'string'
        || typeof result.verificationUrl !== 'string' || typeof result.userCode !== 'string') {
        throw new Error('INVALID_LOGIN_RESPONSE');
      }
      this.loginId = result.loginId;
      this.state = {
        status: 'pending',
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
      };
      return this.status();
    } catch {
      this.state = { status: 'failed', message: 'Не удалось начать авторизацию Codex.' };
      await this.closeClient();
      return this.status();
    }
  }

  async cancelLogin() {
    if (this.client && this.loginId && this.state.status === 'pending') {
      await this.client.request('account/login/cancel', { loginId: this.loginId }).catch(() => {});
    }
    this.state = { status: 'idle' };
    await this.closeClient();
    return this.status();
  }

  async logout() {
    await this.cancelLogin();
    const client = this.createClient();
    try {
      await client.start();
      await client.request('account/logout');
      await this.authenticationChanged(false);
      this.state = { status: 'signed_out' };
    } catch {
      this.state = { status: 'failed', message: 'Не удалось выйти из Codex.' };
    } finally {
      client.close();
    }
    return this.status();
  }

  async stop() {
    this.state = { status: 'idle' };
    await this.closeClient();
  }

  async onNotification(message) {
    if (message.method !== 'account/login/completed' || message.params?.loginId !== this.loginId) return;
    const client = this.client;
    try {
      if (message.params.success) await this.authenticationChanged(true);
      if (this.client !== client) return;
      this.state = message.params.success
        ? { status: 'succeeded', message: 'Авторизация Codex завершена.' }
        : { status: 'failed', message: 'Авторизация Codex не завершена.' };
    } catch {
      if (this.client !== client) return;
      this.state = { status: 'failed', message: 'Не удалось сохранить состояние авторизации Codex.' };
    }
    await this.closeClient();
  }

  async closeClient() {
    const client = this.client;
    this.client = null;
    this.loginId = null;
    client?.close();
  }
}
