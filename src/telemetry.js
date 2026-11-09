import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

const MAX_LINE = 64 * 1024;
const EVENTS = ['thread.started', 'turn.started', 'turn.completed', 'turn.failed',
  'item.started', 'item.updated', 'item.completed', 'error'];
const DIAGNOSTICS = {
  retryMessages: /\bretrying\b|\breconnecting\b|\bretry[- ]after\b/i,
  rateLimitMessages: /\b429\b|rate[_ -]?limit|usage[_ -]?limit|quota[_ -]?exceeded/i,
  networkMessages: /connection refused|dns error|error sending request|network is unreachable|stream disconnected|certificate verify failed/i,
  sqliteBusyMessages: /database is locked|SQLITE_BUSY|SQLITE_LOCKED|database.*\bbusy\b/i,
  resourceMessages: /resource temporarily unavailable|cannot allocate memory|failed to spawn.*thread/i,
  authMessages: /not logged in|authentication.*(?:failed|required)|unauthorized|\b401\b/i,
};
const CLI_NUMBERS = ['elapsedMs', 'spawnMs', 'stdinFlushedMs', 'firstStdoutMs', 'firstStderrMs',
  'threadStartedMs', 'turnStartedMs', 'firstItemMs', 'firstAgentMessageMs', 'turnCompletedMs',
  'turnFailedMs', 'exitMs', 'silentForMs', 'stdoutBytes', 'stderrBytes', 'malformedLines',
  'oversizedLines', 'unknownEvents'];
const STAGES = ['auth', 'prepare', 'cli', 'rateLimitCheck', 'validate', 'cleanup'];
const numeric = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

export function safeCliTelemetry(value) {
  if (!value || typeof value !== 'object') return null;
  const result = Object.fromEntries(CLI_NUMBERS.map(key => [key, numeric(value[key])]));
  result.exitCode = Number.isInteger(value.exitCode) ? value.exitCode : null;
  result.exitSignal = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV'].includes(value.exitSignal) ? value.exitSignal : null;
  result.spawnErrorCode = ['EAGAIN', 'ENOMEM', 'ENOENT', 'EACCES', 'EPERM', 'OTHER'].includes(value.spawnErrorCode) ? value.spawnErrorCode : null;
  result.events = Object.fromEntries(EVENTS.map(key => [key, numeric(value.events?.[key]) ?? 0]));
  result.diagnostics = Object.fromEntries(Object.keys(DIAGNOSTICS).map(key => [key, {
    count: numeric(value.diagnostics?.[key]?.count) ?? 0,
    firstMs: numeric(value.diagnostics?.[key]?.firstMs), lastMs: numeric(value.diagnostics?.[key]?.lastMs),
  }]));
  return result;
}

/** Only timings, fixed event labels and numeric counters leave this parser. */
export class CliTelemetry {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.started = now();
    this.ended = null;
    this.lastActivity = null;
    this.data = { stdoutBytes: 0, stderrBytes: 0, malformedLines: 0, oversizedLines: 0,
      unknownEvents: 0, events: Object.fromEntries(EVENTS.map(key => [key, 0])), diagnostics: {} };
    this.streams = { stdout: { decoder: new StringDecoder('utf8'), buffer: '', dropping: false },
      stderr: { decoder: new StringDecoder('utf8'), buffer: '', dropping: false } };
  }

  elapsed() { return Math.max(0, (this.ended ?? this.now()) - this.started); }
  mark(key) { if (this.data[key] == null) this.data[key] = this.elapsed(); }
  spawned() { this.mark('spawnMs'); }
  stdinFlushed() { this.mark('stdinFlushedMs'); }
  spawnError(code) {
    this.data.spawnErrorCode = ['EAGAIN', 'ENOMEM', 'ENOENT', 'EACCES', 'EPERM'].includes(code) ? code : 'OTHER';
  }

  feed(chunk, isError = false) {
    const name = isError ? 'stderr' : 'stdout';
    this.data[`${name}Bytes`] += chunk.length;
    this.mark(isError ? 'firstStderrMs' : 'firstStdoutMs');
    this.lastActivity = this.elapsed();
    this.consume(name, this.streams[name].decoder.write(chunk));
  }

  consume(name, text) {
    const stream = this.streams[name];
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline < 0 ? text.length : newline;
      if (!stream.dropping) {
        const part = text.slice(offset, end);
        if (stream.buffer.length + part.length > MAX_LINE) {
          stream.buffer = '';
          stream.dropping = true;
          this.data.oversizedLines++;
        } else stream.buffer += part;
      }
      if (newline < 0) break;
      if (!stream.dropping) this.line(name, stream.buffer);
      stream.buffer = '';
      stream.dropping = false;
      offset = end + 1;
    }
  }

  line(name, line) {
    if (!line.trim()) return;
    if (name === 'stderr') {
      this.diagnostic(line);
      return;
    }
    let event;
    try { event = JSON.parse(line); } catch { this.data.malformedLines++; return; }
    if (!EVENTS.includes(event?.type)) { this.data.unknownEvents++; return; }
    this.data.events[event.type]++;
    if (event.type === 'error' || event.type === 'turn.failed') {
      const message = event.message ?? event.error?.message;
      if (typeof message === 'string') this.diagnostic(message);
    }
    const marker = { 'thread.started': 'threadStartedMs', 'turn.started': 'turnStartedMs',
      'turn.completed': 'turnCompletedMs', 'turn.failed': 'turnFailedMs' }[event.type];
    if (marker) this.mark(marker);
    if (event.type.startsWith('item.')) {
      this.mark('firstItemMs');
      if (event.item?.type === 'agent_message') this.mark('firstAgentMessageMs');
    }
  }

  diagnostic(line) {
    for (const [key, pattern] of Object.entries(DIAGNOSTICS)) {
      if (!pattern.test(line)) continue;
      const record = this.data.diagnostics[key] ??= { count: 0, firstMs: this.elapsed(), lastMs: null };
      record.count++;
      record.lastMs = this.elapsed();
    }
  }

  finish(exitCode, signal = null) {
    if (this.ended !== null) return;
    for (const name of ['stdout', 'stderr']) {
      const stream = this.streams[name];
      this.consume(name, stream.decoder.end());
      if (stream.buffer && !stream.dropping) this.line(name, stream.buffer);
      stream.buffer = '';
    }
    this.mark('exitMs');
    this.data.exitCode = exitCode;
    this.data.exitSignal = signal;
    this.ended = this.now();
  }

  snapshot() {
    return safeCliTelemetry({ ...this.data, elapsedMs: this.elapsed(),
      silentForMs: this.lastActivity === null ? this.elapsed() : this.elapsed() - this.lastActivity });
  }
}

export class GenerationTelemetry {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.started = now();
    this.stage = 'auth';
    this.stageStarted = this.started;
    this.ended = null;
    this.phases = {};
    this.cli = null;
  }
  enter(stage) {
    const now = this.now();
    this.phases[this.stage] = (this.phases[this.stage] ?? 0) + Math.max(0, now - this.stageStarted);
    this.stage = stage;
    this.stageStarted = now;
  }
  finish() { this.enter('finished'); this.ended = this.now(); }
  snapshot() {
    const end = this.ended ?? this.now();
    const phases = Object.fromEntries(STAGES.map(stage => [stage, this.phases[stage] == null ? null
      : numeric(this.phases[stage])]));
    if (STAGES.includes(this.stage)) phases[this.stage] = numeric((this.phases[this.stage] ?? 0) + end - this.stageStarted);
    let cli = null;
    try { cli = safeCliTelemetry(this.cli?.()); } catch { /* Instrumentation cannot fail generation. */ }
    return { version: 1, stage: [...STAGES, 'finished'].includes(this.stage) ? this.stage : 'unknown', elapsedMs: numeric(end - this.started),
      stageElapsedMs: numeric(end - this.stageStarted), phasesMs: phases, cli };
  }
}

export function distribution(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, p50: null, p95: null, max: null, mean: null };
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, min: sorted[0], p50: percentile(.5), p95: percentile(.95),
    max: sorted.at(-1), mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
}

export function safeGenerationTelemetry(value) {
  if (value?.version !== 1) return null;
  return { version: 1, stage: [...STAGES, 'finished'].includes(value.stage) ? value.stage : 'unknown',
    elapsedMs: numeric(value.elapsedMs), stageElapsedMs: numeric(value.stageElapsedMs),
    phasesMs: Object.fromEntries(STAGES.map(key => [key, numeric(value.phasesMs?.[key])])),
    cli: safeCliTelemetry(value.cli) };
}

const ERROR_CODES = ['TIMEOUT', 'INTERRUPTED', 'CLI_UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'OUTPUT_TOO_LARGE',
  'AUTH_REQUIRED', 'AUTH_CHECK_FAILED', 'RATE_LIMIT', 'MODEL_UNAVAILABLE', 'CLI_CONFIG_ERROR',
  'SCHEMA_REJECTED', 'NETWORK_ERROR', 'INVALID_OUTPUT', 'EMPTY_LETTER', 'CODEX_FAILED'];
const KINDS = ['cover-letter', 'question-answer', 'code-solution', 'vacancy-relevance', 'market-extraction', 'market-coverage', 'selector-repair'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RUN_KEY = new RegExp(`^relevance-(${UUID})-(\\d+)$`);
const MARKET_KEY = new RegExp(`^market-(${UUID})-extract-(\\d+)-attempt-(\\d+)$`);
function runContext(job) {
  const relevance = RUN_KEY.exec(job.idempotencyKey);
  if (relevance) return { runId: relevance[1], batchIndex: Number(relevance[2]), runKind: 'vacancy-relevance', attempt: 0 };
  const market = MARKET_KEY.exec(job.idempotencyKey);
  return market ? { runId: market[1], batchIndex: Number(market[2]), runKind: 'market-extraction', attempt: Number(market[3]) } : null;
}
const iso = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function jobRunId(job) { return runContext(job)?.runId ?? null; }

export function jobDiagnostic(job, { telemetry = job.telemetry, resourceUsage = job.resourceUsage, now = Date.now() } = {}) {
  const context = runContext(job);
  const started = Date.parse(job.startedAt), created = Date.parse(job.createdAt), completed = Date.parse(job.completedAt);
  return {
    id: job.id, runId: context?.runId ?? null, batchIndex: context?.batchIndex ?? null,
    runKind: context?.runKind ?? null, attempt: context?.attempt ?? null,
    kind: KINDS.includes(job.kind) ? job.kind : job.kind == null ? 'cover-letter' : 'other',
    model: typeof job.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(job.model) ? job.model : null,
    reasoningEffort: ['low', 'medium', 'high', 'xhigh'].includes(job.reasoningEffort) ? job.reasoningEffort : null,
    cliVersion: typeof job.cliVersion === 'string' ? /\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/.exec(job.cliVersion)?.[0] ?? null : null,
    promptVersion: typeof job.promptVersion === 'string' && /^[a-z]+(?:-[a-z]+)*-v\d+$/.test(job.promptVersion) ? job.promptVersion : null,
    timeoutMs: numeric(job.timeoutMs),
    status: ['queued', 'running', 'done', 'failed'].includes(job.status) ? job.status : 'unknown',
    vacancyCount: numeric(job.vacancyCount),
    evaluatedVacancies: job.kind === 'vacancy-relevance' && job.status === 'done' && Array.isArray(job.result?.items) ? job.result.items.length : null,
    extractedVacancies: job.kind === 'market-extraction' && job.status === 'done' && Array.isArray(job.result?.items) ? job.result.items.length : null,
    createdAt: iso(job.createdAt), startedAt: iso(job.startedAt), completedAt: iso(job.completedAt),
    queueElapsedMs: Number.isFinite(started) ? numeric(started - created) : numeric(now - created),
    executionElapsedMs: Number.isFinite(started) ? numeric((Number.isFinite(completed) ? completed : now) - started) : null,
    errorCode: job.error ? ERROR_CODES.includes(job.error.code) ? job.error.code : 'OTHER' : null,
    timings: Object.fromEntries(['queueMs', 'executionMs', 'cliMs', 'totalMs', 'runningSaveMs']
      .map(key => [key, numeric(job.timings?.[key])])),
    usage: job.usage ? Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens']
      .map(key => [key, numeric(job.usage[key])])) : null,
    telemetry: safeGenerationTelemetry(telemetry),
    resourceUsage: resourceUsage ? { currentBytes: numeric(resourceUsage.currentBytes), peakBytes: numeric(resourceUsage.peakBytes) } : null,
    admission: job.admission ? Object.fromEntries(['capacity', 'budgetBytes', 'availableBytes', 'perJobBytes',
      'maxConcurrentAnalysis', 'maxConcurrentRelevance', 'activeReservations'].map(key => [key, numeric(job.admission[key])])) : null,
  };
}

export function diagnosticSummary(jobs, now = Date.now()) {
  const states = { queued: 0, running: 0, done: 0, failed: 0 };
  const errors = {};
  for (const job of jobs) {
    if (Object.hasOwn(states, job.status)) states[job.status]++;
    if (job.errorCode) errors[job.errorCode] = (errors[job.errorCode] ?? 0) + 1;
  }
  const terminal = jobs.filter(job => ['done', 'failed'].includes(job.status));
  const created = jobs.map(job => Date.parse(job.createdAt)).filter(Number.isFinite);
  const completed = terminal.map(job => Date.parse(job.completedAt)).filter(Number.isFinite);
  const recent = terminal.filter(job => {
    const age = now - Date.parse(job.completedAt);
    return age >= 0 && age < 60_000;
  });
  const reportedUsage = { jobsWithUsage: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  for (const job of jobs) {
    if (!job.usage) continue;
    reportedUsage.jobsWithUsage++;
    for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens']) reportedUsage[key] += job.usage[key] ?? 0;
  }
  return { totalJobs: jobs.length, states, errors, reportedUsage,
    spanMs: created.length ? numeric((terminal.length === jobs.length && completed.length
      ? completed.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : now)
      - created.reduce((minimum, value) => Math.min(minimum, value), Infinity)) : null,
    evaluatedVacancies: jobs.reduce((sum, job) => sum + (job.evaluatedVacancies ?? 0), 0),
    extractedVacancies: jobs.reduce((sum, job) => sum + (job.extractedVacancies ?? 0), 0),
    completedLastMinute: recent.length,
    successfulLastMinute: recent.filter(job => job.status === 'done').length,
    failedLastMinute: recent.filter(job => job.status === 'failed').length,
    activeAgesMs: distribution(jobs.filter(job => job.status === 'running').map(job => job.executionElapsedMs)),
    queuedAgesMs: distribution(jobs.filter(job => job.status === 'queued').map(job => job.queueElapsedMs)),
    instrumentedJobs: jobs.filter(job => job.telemetry).length,
    latencyMs: Object.fromEntries(['queueMs', 'executionMs', 'cliMs', 'totalMs', 'runningSaveMs']
      .map(key => [key, distribution(terminal.map(job => job.timings[key]))])),
    phasesMs: Object.fromEntries(STAGES.map(key => [key, distribution(terminal.map(job => job.telemetry?.phasesMs[key]))])),
  };
}
