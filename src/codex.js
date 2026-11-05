import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { checkAccount } from './account-status.js';
import { CliTelemetry, GenerationTelemetry } from './telemetry.js';
import {
  buildCodeSolutionPrompt, buildPrompt, buildQuestionPrompt, buildVacancyRelevancePrompt,
  codeSolutionOutputSchema, outputSchema, parseCodeSolutionOutput, parseOutput, parseQuestionOutput,
  parseVacancyRelevanceOutput, questionOutputSchema, vacancyRelevanceOutputSchema,
  buildMarketExtractionPrompt, buildMarketCoveragePrompt, marketExtractionOutputSchema,
  marketCoverageOutputSchema, parseMarketExtractionOutput, parseMarketCoverageOutput,
  emptyMarketResult, MarketOutputError,
} from './contract.js';

const AUTH_SUCCESS_CACHE_MS = 5 * 60_000;
const AUTH_FAILURE_CACHE_MS = 10_000;

// No shell interpolation, unbounded logs, or resume text in process arguments.
export function runProcess(command, args, { cwd, input = '', timeoutMs, signal, onSpawn, onTelemetry } = {}) {
  return new Promise(resolve => {
    const started = performance.now();
    const telemetry = new CliTelemetry();
    try { onTelemetry?.(() => telemetry.snapshot()); } catch { /* Diagnostics must not fail execution. */ }
    const child = spawn(command, args, {
      cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', bytes = 0, failure = null, finished = false, killTimer;
    const kill = force => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        else child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch { /* Process already exited. */ }
    };
    const stop = reason => {
      if (failure || finished) return;
      failure = reason;
      kill(false);
      killTimer = setTimeout(() => kill(true), 2000);
    };
    const abort = () => stop('INTERRUPTED');
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    const finish = (exitCode, exitSignal = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      // Also reap descendants when a terminated wrapper exits before its children.
      if (failure) kill(true);
      signal?.removeEventListener('abort', abort);
      telemetry.finish(exitCode, exitSignal);
      resolve({ exitCode, stdout, stderr, failure, durationMs: Math.round(performance.now() - started), telemetry: telemetry.snapshot() });
    };
    const capture = (chunk, isError) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { stop('OUTPUT_TOO_LARGE'); return; }
      telemetry.feed(chunk, isError);
      if (isError) stderr += chunk.toString('utf8');
      else stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => capture(chunk, false));
    child.stderr.on('data', chunk => capture(chunk, true));
    child.stdin.on('error', () => { /* Early exit is handled by close/error. */ });
    child.on('spawn', () => telemetry.spawned());
    child.on('error', error => {
      telemetry.spawnError(error.code);
      failure = ['EAGAIN', 'ENOMEM'].includes(error.code) ? 'RESOURCE_EXHAUSTED' : 'CLI_UNAVAILABLE';
      finish(null);
    });
    child.on('close', finish);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (child.pid) onSpawn?.(child.pid);
    child.stdin.end(input, error => { if (!error) telemetry.stdinFlushed(); });
  });
}

export function parseEvents(stdout) {
  let usage = null, failed = false;
  for (const line of stdout.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'turn.failed' || event.type === 'error') failed = true;
    if (event.type !== 'turn.completed' || !event.usage) continue;
    const values = ['input_tokens', 'cached_input_tokens', 'output_tokens'].map(key => event.usage[key]);
    if (values.some(value => !Number.isSafeInteger(value) || value < 0)) continue;
    usage ??= { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    usage.inputTokens += values[0]; usage.cachedInputTokens += values[1]; usage.outputTokens += values[2];
  }
  return { usage, failed };
}

const errors = {
  TIMEOUT: 'Превышено время генерации. Автоматического повтора не будет.',
  INTERRUPTED: 'Генерация прервана остановкой сервиса. Запустите новый запрос при необходимости.',
  CLI_UNAVAILABLE: 'Не удалось запустить Codex CLI. Проверьте образ контейнера.',
  RESOURCE_EXHAUSTED: 'Не хватает ресурсов для Codex CLI. Проверьте доступную память и лимиты процессов Docker.',
  OUTPUT_TOO_LARGE: 'Codex вернул слишком большой служебный вывод.',
  AUTH_REQUIRED: 'Требуется авторизация Codex. Выполните device login и повторите запрос.',
  AUTH_CHECK_FAILED: 'Не удалось проверить авторизацию Codex.',
  RATE_LIMIT: 'Лимит Codex исчерпан или сервис ограничил запросы. Повторите позже.',
  MODEL_UNAVAILABLE: 'Выбранная модель или reasoning недоступны. Проверьте .env.',
  CLI_CONFIG_ERROR: 'Codex отклонил параметры запуска. Проверьте закреплённую версию CLI и настройки.',
  SCHEMA_REJECTED: 'Codex отклонил JSON-схему ответа. Проверьте совместимость модели и CLI.',
  NETWORK_ERROR: 'Codex не смог подключиться к сервису. Проверьте сеть контейнера.',
  INVALID_OUTPUT: 'Ответ Codex не соответствует ожидаемому формату. Сырой ответ не используется.',
  EMPTY_LETTER: 'Codex не сформировал письмо. Проверьте исходные тексты и пожелания.',
  CODEX_FAILED: 'Codex завершился с ошибкой. Проверьте авторизацию, модель и сетевое подключение.',
};

export function safeFailure(code) { return { code, message: errors[code] ?? errors.CODEX_FAILED }; }

function classify(result) {
  if (result.failure) return result.failure;
  // Only use raw diagnostics for classification in memory; never return or log them.
  const text = result.stderr + '\n' + result.stdout;
  if (/resource temporarily unavailable|cannot allocate memory|os error (?:11|12)\b|failed to spawn.*thread/i.test(result.stderr)) return 'RESOURCE_EXHAUSTED';
  if (/unexpected argument|unrecognized (?:argument|option)|invalid value.*--/i.test(text)) return 'CLI_CONFIG_ERROR';
  if (/invalid.*schema|schema.*(?:not supported|unsupported|invalid)/i.test(text)) return 'SCHEMA_REJECTED';
  if (/rate.limit|usage.limit|quota.exceeded|too many requests|\b429\b/i.test(text)) return 'RATE_LIMIT';
  if (/not logged in|authentication.*(?:failed|required)|unauthorized|refresh.token.*failed|\b401\b/i.test(text)) return 'AUTH_REQUIRED';
  if (/model.*(?:not supported|not found|does not exist|unavailable)|unsupported.*(?:model|reasoning)/i.test(text)) return 'MODEL_UNAVAILABLE';
  if (/connection refused|dns error|error sending request|network is unreachable|certificate verify failed/i.test(text)) return 'NETWORK_ERROR';
  return 'CODEX_FAILED';
}

export function generationArgs(job, dir) {
  return [
    '--ask-for-approval', 'never',
    '-c', 'cli_auth_credentials_store="file"',
    '-c', `model_reasoning_effort=${JSON.stringify(job.reasoningEffort)}`,
    '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
    '-c', 'web_search="disabled"', '-c', 'history.persistence="none"',
    // Isolation flags belong to exec, not the root codex command.
    'exec', '--ignore-user-config', '--ignore-rules',
    '--model', job.model, '--sandbox', 'read-only',
    '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--json',
    '-C', dir, '--output-schema', path.join(dir, 'schema.json'),
    '-o', path.join(dir, 'answer.json'), '-',
  ];
}

export class CodexRunner {
  constructor(config, execute = runProcess, accountCheck = checkAccount, now = () => performance.now()) {
    this.now = now;
    this.config = config; this.execute = execute; this.version = null;
    this.authRejected = false; this.authRevision = 0; this.authStateFile = null;
    this.authStateWrites = Promise.resolve();
    this.accountCheck = accountCheck; this.authCache = null; this.authPending = null;
    this.authCheckedAt = null;
  }

  async initializeAuthState() {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    this.authStateFile = path.join(this.config.dataDir, '.codex-auth-required');
    try {
      await stat(this.authStateFile);
      this.authRejected = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async authenticationChanged(authenticated) {
    // A failure from an older in-flight request must not invalidate a new device login.
    this.authRevision++;
    this.authCache = null;
    await this.setAuthRejected(!authenticated);
    if (authenticated && this.accountCheck) {
      // Let an older probe finish before refreshing the newly issued credentials.
      if (this.authPending) await this.authPending;
      await this.authStatus();
    }
  }

  setAuthRejected(rejected) {
    this.authCache = null;
    this.authRejected = rejected;
    if (!this.authStateFile) return Promise.resolve();
    const operation = this.authStateWrites.then(() => rejected
      ? writeFile(this.authStateFile, 'AUTH_REQUIRED\n', { mode: 0o600 })
      : rm(this.authStateFile, { force: true }));
    this.authStateWrites = operation.catch(() => {});
    return operation;
  }

  async inspectVersion() {
    const result = await this.execute(this.config.codexBin, ['--version'], { timeoutMs: 10000 });
    const match = result.stdout.match(/codex(?:-cli)?\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-.a-zA-Z0-9]*)?)/);
    this.version = !result.failure && result.exitCode === 0 && match ? match[1] : null;
    return this.version;
  }

  authSnapshot() {
    if (this.authRejected) return { authenticated: false, method: null, limits: null, checkedAt: this.authCheckedAt, error: safeFailure('AUTH_REQUIRED') };
    return { ...(this.authCache?.value ?? { authenticated: false, method: null, limits: null, error: safeFailure('AUTH_CHECK_FAILED') }), checkedAt: this.authCheckedAt };
  }

  async rateLimitFailure() {
    const revision = this.authRevision;
    // Best effort only: inability to read limits must not hide the generation's actual error.
    let limits = this.authCache?.value?.limits;
    try {
      const status = await this.accountCheck?.(this.config.codexBin);
      if (status?.authenticated && revision === this.authRevision && !this.authRejected) {
        limits = status.limits;
        this.authCheckedAt = new Date().toISOString();
        this.authCache = { value: status, until: Date.now() + AUTH_SUCCESS_CACHE_MS };
      }
    } catch { /* Keep RATE_LIMIT even if the diagnostic query fails. */ }
    const resets = [limits?.primary, limits?.secondary]
      .filter(window => window?.usedPercent >= 100 && Number.isSafeInteger(window.resetsAt) && window.resetsAt <= 253402300799 && window.resetsAt > Date.now() / 1000)
      .map(window => window.resetsAt);
    const resetsAt = resets.length ? Math.max(...resets) : null;
    return { ...safeFailure('RATE_LIMIT'), resetsAt,
      message: safeFailure('RATE_LIMIT').message + (resetsAt ? ` Сброс ожидается ${new Date(resetsAt * 1000).toISOString()} (UTC).` : ' Время сброса получить не удалось.') };
  }

  async authStatus(signal, forceRefresh = false) {
    if (this.accountCheck) {
      if (this.authRejected) return { authenticated: false, method: null, limits: null, error: safeFailure('AUTH_REQUIRED') };
      if (!forceRefresh && this.authCache && Date.now() < this.authCache.until) return this.authCache.value;
      if (this.authPending) return this.authPending;
      const revision = this.authRevision;
      const operation = (async () => {
        let value;
        try { value = await this.accountCheck(this.config.codexBin); }
        catch (error) {
          const code = error.message === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'AUTH_CHECK_FAILED';
          value = { authenticated: false, method: null, limits: null, error: safeFailure(code) };
          if (code === 'AUTH_REQUIRED' && revision === this.authRevision) await this.setAuthRejected(true);
        }
        if (revision !== this.authRevision || this.authRejected) return { authenticated: false, method: null, limits: null, error: safeFailure(this.authRejected ? 'AUTH_REQUIRED' : 'AUTH_CHECK_FAILED') };
        this.authCheckedAt = new Date().toISOString();
        this.authCache = { value, until: Date.now() + (value.error ? AUTH_FAILURE_CACHE_MS : AUTH_SUCCESS_CACHE_MS) };
        return value;
      })();
      this.authPending = operation;
      try { return await operation; } finally { if (this.authPending === operation) this.authPending = null; }
    }
    if (this.authRejected) return { authenticated: false, method: null, error: safeFailure('AUTH_REQUIRED') };
    const result = await this.execute(this.config.codexBin,
      ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'], { timeoutMs: 10000, signal });
    if (this.authRejected) return { authenticated: false, method: null, error: safeFailure('AUTH_REQUIRED') };
    if (result.failure) return { authenticated: false, method: null, error: safeFailure(result.failure) };
    const message = result.stdout + result.stderr;
    if (result.exitCode !== 0) return { authenticated: false, method: null, error: safeFailure(/not logged in/i.test(message) ? 'AUTH_REQUIRED' : 'AUTH_CHECK_FAILED') };
    return { authenticated: true, method: /chatgpt/i.test(message) ? 'chatgpt' : /api key/i.test(message) ? 'api_key' : 'unknown', error: null };
  }

  async run(job, signal, onSpawn, onTelemetry) {
    let dir, execution = null, failureCode = null;
    let response;
    const finish = value => (response = value);
    const telemetry = new GenerationTelemetry(this.now);
    try { onTelemetry?.(() => telemetry.snapshot()); } catch { /* Diagnostics must not fail execution. */ }
    const authRevision = this.authRevision;
    try {
      const auth = await this.authStatus(signal);
      if (!auth.authenticated) return finish({ result: null, error: auth.error, usage: null, cliMs: null });
      if (signal.aborted) return finish({ result: null, error: safeFailure('INTERRUPTED'), usage: null, cliMs: null });
      telemetry.enter('prepare');
      const question = job.kind === 'question-answer';
      const codeSolution = job.kind === 'code-solution';
      const vacancyRelevance = job.kind === 'vacancy-relevance';
      const marketExtraction = job.kind === 'market-extraction';
      const marketCoverage = job.kind === 'market-coverage';
      dir = await mkdtemp(path.join(tmpdir(), 'hh-generation-'));
      const schema = question
        ? questionOutputSchema(job.input.answers.length)
        : (codeSolution ? codeSolutionOutputSchema()
          : (vacancyRelevance ? vacancyRelevanceOutputSchema(job.input)
            : marketExtraction ? marketExtractionOutputSchema(job.input)
              : marketCoverage ? marketCoverageOutputSchema(job.input) : outputSchema(job.input.maxLength)));
      await writeFile(path.join(dir, 'schema.json'), JSON.stringify(schema), { mode: 0o600 });
      telemetry.enter('cli');
      execution = await this.execute(this.config.codexBin, generationArgs(job, dir), {
        cwd: dir,
        input: question
          ? buildQuestionPrompt(job.input)
          : (codeSolution ? buildCodeSolutionPrompt(job.input)
            : (vacancyRelevance ? buildVacancyRelevancePrompt(job.input)
              : marketExtraction ? buildMarketExtractionPrompt(job.input)
                : marketCoverage ? buildMarketCoveragePrompt(job.input) : buildPrompt(job.input))),
        timeoutMs: job.timeoutMs,
        signal,
        onSpawn,
        onTelemetry: getter => { telemetry.cli = getter; },
      });
      if (!telemetry.cli && execution.telemetry) telemetry.cli = () => execution.telemetry;
      telemetry.enter('validate');
      const events = parseEvents(execution.stdout);
      if (execution.failure || execution.exitCode !== 0 || events.failed) {
        const failure = classify(execution);
        failureCode = failure;
        if (failure === 'AUTH_REQUIRED' && authRevision === this.authRevision) await this.setAuthRejected(true);
        let error;
        if (failure === 'RATE_LIMIT') {
          telemetry.enter('rateLimitCheck');
          error = await this.rateLimitFailure();
        } else error = safeFailure(failure);
        return finish({ result: null, error, usage: events.usage, cliMs: execution.durationMs });
      }
      const output = path.join(dir, 'answer.json');
      // JSON escaping can make a valid 100k-character source file larger on disk.
      if ((await stat(output)).size > 256 * 1024) {
        if (marketExtraction || marketCoverage) throw new MarketOutputError('OUTPUT_TOO_LARGE');
        throw new Error('INVALID_OUTPUT');
      }
      const raw = await readFile(output, 'utf8');
      const result = question
        ? parseQuestionOutput(raw, job.input)
        : (codeSolution ? parseCodeSolutionOutput(raw)
          : (vacancyRelevance ? parseVacancyRelevanceOutput(raw, job.input)
            : marketExtraction ? parseMarketExtractionOutput(raw, job.input)
              : marketCoverage ? parseMarketCoverageOutput(raw, job.input) : parseOutput(raw, job.input.maxLength)));
      return finish({ result, error: null, usage: events.usage, cliMs: execution.durationMs });
    } catch (error) {
      const code = failureCode ?? (['INVALID_OUTPUT', 'EMPTY_LETTER'].includes(error.message) ? error.message : execution ? 'INVALID_OUTPUT' : 'CODEX_FAILED');
      const market = ['market-extraction', 'market-coverage'].includes(job.kind);
      const reason = error instanceof MarketOutputError ? error.reason
        : error.code === 'ENOENT' ? 'OUTPUT_MISSING' : 'OUTPUT_PROCESSING_ERROR';
      if (market && code === 'INVALID_OUTPUT') return finish({
        result: emptyMarketResult(job.kind, job.input, reason), error: null,
        usage: execution ? parseEvents(execution.stdout).usage : null, cliMs: execution?.durationMs ?? null,
      });
      return finish({ result: null, error: safeFailure(code),
        usage: execution ? parseEvents(execution.stdout).usage : null, cliMs: execution?.durationMs ?? null });
    } finally {
      telemetry.enter('cleanup');
      // Only our exact mkdtemp directory, never a supplied path or workspace root.
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      telemetry.finish();
      if (response) response.telemetry = telemetry.snapshot();
    }
  }
}
