import { isAnalysis } from './analysis.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { RequestError, inputCharactersFor, promptVersionFor, publicJob } from './contract.js';
import { safeFailure } from './codex.js';
import { performance } from 'node:perf_hooks';
import { diagnosticSummary, jobDiagnostic, jobRunId, safeGenerationTelemetry } from './telemetry.js';

const terminal = job => ['done', 'failed'].includes(job.status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class GenerationQueue {
  constructor(config, runner, resources = null) {
    this.config = config; this.runner = runner; this.jobs = new Map();
    this.resources = resources;
    this.liveTelemetry = new Map();
    this.serial = Promise.resolve(); this.active = new Map(); this.dispatching = false;
    this.stopping = false; this.storageFailed = false;
  }

  async initialize() {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.config.dataDir)) {
      if (!file.endsWith('.json') || !uuid.test(file.slice(0, -5))) continue;
      const job = JSON.parse(await readFile(path.join(this.config.dataDir, file), 'utf8'));
      if (job.id !== file.slice(0, -5) || !['queued', 'running', 'done', 'failed'].includes(job.status)) throw new Error('Invalid task storage');
      this.jobs.set(job.id, job);
      if (job.status === 'running') {
        await this.save({ ...job, status: 'failed', input: null, completedAt: new Date().toISOString(), error: safeFailure('INTERRUPTED') });
      }
    }
    await this.prune();
  }

  async save(job) {
    const destination = path.join(this.config.dataDir, `${job.id}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
    await rename(temporary, destination);
    this.jobs.set(job.id, job);
  }

  create(input, key, kind = 'cover-letter') {
    // Serialize admissions so two concurrent requests with one key cannot launch twice.
    const operation = this.serial.then(async () => {
      if (this.stopping || this.storageFailed) throw new RequestError(503, 'UNAVAILABLE', 'Сервис останавливается или хранилище недоступно.');
      if (key !== undefined && (typeof key !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(key))) throw new RequestError(400, 'INVALID_KEY', 'Некорректный Idempotency-Key.');
      const promptVersion = promptVersionFor(kind);
      const model = kind === 'selector-repair' ? this.config.selectorRepairModel ?? 'gpt-6-sol' : this.config.model;
      const reasoningEffort = kind === 'selector-repair' ? this.config.selectorRepairReasoningEffort ?? 'medium' : this.config.reasoningEffort;
      const fingerprint = createHash('sha256').update(JSON.stringify({ kind, input, model, reasoning: reasoningEffort, promptVersion })).digest('hex');
      if (key) {
        const previous = [...this.jobs.values()].find(job => job.idempotencyKey === key);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new RequestError(409, 'KEY_CONFLICT', 'Этот Idempotency-Key уже использован с другим текстом или настройками.');
          return { job: publicJob(previous), reused: true };
        }
      }
      const regularPending = [...this.jobs.values()].filter(job => !terminal(job) && !isAnalysis(job.kind)).length;
      if (!isAnalysis(kind) && regularPending >= this.config.maxPending) {
        throw new RequestError(429, 'QUEUE_FULL', 'Очередь заполнена. Дождитесь завершения задач.');
      }
      const job = {
        id: randomUUID(), status: 'queued', createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
        model, reasoningEffort, timeoutMs: this.config.timeoutMs,
        kind, cliVersion: null, promptVersion,
        vacancyCount: ['vacancy-relevance', 'market-extraction'].includes(kind) ? input.vacancies.length : null,
        inputCharacters: inputCharactersFor(kind, input),
        timings: { queueMs: null, executionMs: null, cliMs: null, totalMs: null },
        usage: null, result: null, error: null, input, idempotencyKey: key ?? null, fingerprint,
      };
      await this.save(job);
      return { job: publicJob(job), reused: false };
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  find(id, kind = null) {
    if (!uuid.test(id)) throw new RequestError(400, 'INVALID_ID', 'Некорректный ID генерации.');
    const job = this.jobs.get(id);
    if (!job) throw new RequestError(404, 'NOT_FOUND', 'Генерация не найдена или срок хранения истёк.');
    const actualKind = job.kind ?? 'cover-letter';
    if (kind !== null && actualKind !== kind) throw new RequestError(404, 'NOT_FOUND', 'Задание не найдено или срок хранения истёк.');
    const visible = publicJob(job);
    if (job.status === 'running') {
      try {
        const snapshot = this.liveTelemetry.get(job.id)?.();
        if (snapshot) visible.telemetry = safeGenerationTelemetry(snapshot);
      } catch { /* Diagnostics cannot fail normal polling. */ }
    }
    return visible;
  }

  status() {
    return {
      ok: !this.stopping && !this.storageFailed,
      running: [...this.jobs.values()].filter(job => job.status === 'running').length,
      queued: [...this.jobs.values()].filter(job => job.status === 'queued').length,
      runningAnalysis: [...this.jobs.values()].filter(job => job.status === 'running' && isAnalysis(job.kind)).length,
      queuedAnalysis: [...this.jobs.values()].filter(job => job.status === 'queued' && isAnalysis(job.kind)).length,
      runningRelevance: [...this.jobs.values()].filter(job => job.status === 'running' && job.kind === 'vacancy-relevance').length,
      queuedRelevance: [...this.jobs.values()].filter(job => job.status === 'queued' && job.kind === 'vacancy-relevance').length,
      ...(this.resources ? { resources: this.resources.status() } : {}),
    };
  }

  async tick() {
    if (this.dispatching || this.stopping || this.storageFailed) return;
    this.dispatching = true;
    const started = [];
    try {
      await this.prune();
      await this.resources?.refresh();
      let regularBusy = [...this.active.values()].some(entry => !isAnalysis(entry.kind));
      const queued = [...this.jobs.values()].filter(job => job.status === 'queued')
        .sort((a, b) => Number(isAnalysis(a.kind)) - Number(isAnalysis(b.kind))
          || a.createdAt.localeCompare(b.createdAt));
      for (const job of queued) {
        if (this.stopping || this.storageFailed) break;
        if (this.active.has(job.id)) continue;
        if (!isAnalysis(job.kind)) {
          if (regularBusy) continue;
        }
        if (this.resources && !this.resources.reserve(job.id, job.kind)) continue;
        if (!isAnalysis(job.kind)) regularBusy = true;
        const entry = { kind: job.kind, controller: new AbortController(), promise: null };
        // Reserve synchronously: another tick may see the queued file while save(running) awaits I/O.
        this.active.set(job.id, entry);
        entry.promise = this.work(job, entry.controller.signal).then(output => {
          entry.successful = !!output && !output.error;
        }).catch(() => {
          // An uncertain execution/storage failure must never replay a model call.
          this.storageFailed = true;
          console.error('Generation storage/worker failure; processing stopped. Restart after checking storage.');
        }).finally(() => {
          this.resources?.release(job.id, entry.successful === true);
          this.liveTelemetry.delete(job.id);
          this.active.delete(job.id);
        });
        started.push(entry.promise);
      }
    } catch {
      this.storageFailed = true;
      console.error('Generation storage/worker failure; processing stopped. Restart after checking storage.');
    } finally {
      this.dispatching = false;
    }
    await Promise.all(started);
  }

  async work(job, signal) {
    if (!job || signal.aborted || this.stopping) return;
    const started = Date.now();
    const running = {
      ...job, status: 'running', startedAt: new Date(started).toISOString(), cliVersion: this.runner.version,
      timings: { ...job.timings, queueMs: Math.max(0, started - Date.parse(job.createdAt)) },
      admission: this.resources?.status() ?? null,
    };
    const saveStarted = performance.now();
    await this.save(running);
    running.timings.runningSaveMs = Math.round(performance.now() - saveStarted);
    const output = signal.aborted
      ? { result: null, error: safeFailure('INTERRUPTED'), usage: null, cliMs: null }
      : await this.runner.run(running, signal, pid => this.resources?.attach(job.id, pid),
        getter => { if (typeof getter === 'function') this.liveTelemetry.set(job.id, getter); });
    const ended = Date.now();
    const terminalJob = {
      ...running, input: null, status: output.error ? 'failed' : 'done', completedAt: new Date(ended).toISOString(),
      result: output.result, error: output.error, usage: output.usage,
      timings: { ...running.timings, executionMs: Math.max(0, ended - started), cliMs: output.cliMs, totalMs: Math.max(0, ended - Date.parse(job.createdAt)) },
      telemetry: safeGenerationTelemetry(output.telemetry), resourceUsage: this.resources?.jobStatus?.(job.id) ?? null,
    };
    await this.save(terminalJob);
    const failure = output.error ? `${output.error.code}${output.error.reason ? `/${output.error.reason}` : ''}` : 'done';
    console.info(`Generation ${job.id}: ${failure}, diagnostics=${output.result?.diagnostics?.length ?? 0}, ${ended - started} ms`);
    console.info('GenerationMetrics ' + JSON.stringify(jobDiagnostic(terminalJob)));
    return output;
  }

  metrics(runId = null) {
    const now = Date.now();
    const selected = [...this.jobs.values()].filter(job => runId === null || jobRunId(job) === runId);
    const records = selected.map(job => {
      let telemetry = job.telemetry;
      if (job.status === 'running') {
        try { telemetry = this.liveTelemetry.get(job.id)?.() ?? telemetry; } catch { /* Best effort. */ }
      }
      return jobDiagnostic(job, { telemetry, now, resourceUsage: this.resources?.jobStatus?.(job.id) ?? job.resourceUsage });
    });
    const active = records.filter(job => ['queued', 'running'].includes(job.status));
    const terminal = records.filter(job => !['queued', 'running'].includes(job.status))
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
    const details = [...active, ...terminal].slice(0, 200);
    return { version: 1, capturedAt: new Date(now).toISOString(), runId, queue: this.status(),
      summary: diagnosticSummary(records, now), detailsLimit: 200, truncated: details.length < records.length, jobs: details };
  }

  async prune() {
    const cutoff = Date.now() - this.config.retentionDays * 86400000;
    for (const job of this.jobs.values()) {
      if (!terminal(job) || Date.parse(job.completedAt) >= cutoff) continue;
      // Exact internal UUID-named task file, not user input or a recursive directory delete.
      await unlink(path.join(this.config.dataDir, `${job.id}.json`));
      this.jobs.delete(job.id);
    }
  }

  async stop() {
    this.stopping = true;
    const active = [...this.active.values()];
    active.forEach(entry => entry.controller.abort());
    await Promise.allSettled(active.map(entry => entry.promise));
    await this.serial;
  }
}
