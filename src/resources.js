import { isAnalysis } from './analysis.js';
import { totalmem, freemem } from 'node:os';
import { readFile } from 'node:fs/promises';

const MiB = 1024 * 1024;

export function systemMemory({ hostTotal = totalmem(), constrained = process.constrainedMemory?.() ?? 0,
  available = process.availableMemory?.() ?? freemem(), agentBytes = process.memoryUsage.rss() } = {}) {
  const totalBytes = constrained > 0 ? Math.min(hostTotal, constrained) : hostTotal;
  return {
    totalBytes,
    availableBytes: Math.min(totalBytes, available),
    agentBytes,
    source: constrained > 0 && constrained < hostTotal ? 'container' : 'os',
  };
}

// Docker uses Linux on all supported host platforms. Native non-Linux runs keep
// the configured estimate instead of inventing per-process measurements.
export async function processTreeMemory(pid, platform = process.platform, read = readFile) {
  if (platform !== 'linux') return null;
  const visited = new Set();
  const pending = [pid];
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!Number.isSafeInteger(current) || current < 1 || visited.has(current)) continue;
    visited.add(current);
    const [status, children] = await Promise.all([
      read(`/proc/${current}/status`, 'utf8').catch(() => ''),
      read(`/proc/${current}/task/${current}/children`, 'utf8').catch(() => ''),
    ]);
    for (const match of status.matchAll(/^Vm(?:RSS|Swap):\s+(\d+)\s+kB$/gm)) bytes += Number(match[1]) * 1024;
    pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
  }
  return bytes;
}

export class GenerationResources {
  constructor(config, { memory = systemMemory, measure = processTreeMemory } = {}) {
    this.percent = config.memoryPercent;
    this.maxAnalysis = config.maxConcurrentAnalysis ?? config.maxConcurrentRelevance;
    this.initialBytes = config.jobMemoryMiB * MiB;
    this.memory = memory;
    this.measure = measure;
    this.jobs = new Map();
    this.snapshot = null;
    this.observedPeak = 0;
    this.completedPeak = 0;
  }

  async refresh() {
    await Promise.all([...this.jobs.entries()].map(async ([id, entry]) => {
      if (!entry.pid) return;
      let measured;
      try { measured = await this.measure(entry.pid); }
      catch { return; }
      if (this.jobs.get(id) !== entry || measured === null || !Number.isFinite(measured) || measured < 0) return;
      entry.current = measured;
      entry.peak = Math.max(entry.peak, measured);
      this.observedPeak = Math.max(this.observedPeak, measured);
    }));
    try { this.snapshot = this.memory(); }
    catch { this.snapshot = null; }
  }

  perJobBytes() {
    // Never lower the estimate from a partly started process. Only completed
    // successful executions may calibrate the initial estimate downwards.
    const calibrated = this.completedPeak > 0 ? Math.ceil(this.completedPeak * 1.5) : this.initialBytes;
    return Math.max(64 * MiB, calibrated, Math.ceil(this.observedPeak * 1.5));
  }

  capacity() {
    const memory = this.snapshot;
    if (!memory || !Number.isFinite(memory.totalBytes) || memory.totalBytes <= 0
      || !Number.isFinite(memory.availableBytes) || memory.availableBytes < 0
      || !Number.isFinite(memory.agentBytes) || memory.agentBytes < 0) {
      return { budgetBytes: 0, perJobBytes: this.perJobBytes(), capacity: 0, availableSlots: 0, availableAnalysisSlots: 0, availableRelevanceSlots: 0,
        waitingReason: 'MEMORY_UNKNOWN' };
    }
    const perJobBytes = this.perJobBytes();
    const budgetBytes = Math.floor(memory.totalBytes * this.percent / 100);
    const serviceBytes = Math.max(64 * MiB, memory.agentBytes) + 64 * MiB;
    const capacity = Math.max(0, Math.floor((budgetBytes - serviceBytes) / perJobBytes));
    // Keep room for the rest of the system, and reserve memory for jobs that
    // were admitted but have not reached their full measured footprint yet.
    const systemReserve = Math.max(128 * MiB, Math.floor(memory.totalBytes / 10));
    const outstanding = [...this.jobs.values()].reduce((sum, job) => sum + Math.max(0, perJobBytes - job.current), 0);
    const freeSlots = Math.max(0, Math.floor((memory.availableBytes - systemReserve - outstanding) / perJobBytes));
    const availableSlots = Math.max(0, Math.min(capacity - this.jobs.size, freeSlots));
    const reserveInteractive = this.jobs.size > 0 && capacity > 1
      && ![...this.jobs.values()].some(entry => !isAnalysis(entry.kind));
    const activeAnalysis = [...this.jobs.values()].filter(entry => isAnalysis(entry.kind)).length;
    const availableAnalysisSlots = Math.max(0, Math.min(availableSlots - (reserveInteractive ? 1 : 0),
      this.maxAnalysis - activeAnalysis));
    return { budgetBytes, perJobBytes, capacity, availableSlots, availableAnalysisSlots, availableRelevanceSlots: availableAnalysisSlots,
      waitingReason: capacity === 0 ? 'BUDGET_BELOW_SINGLE_JOB' : availableSlots === 0 ? 'MEMORY_PRESSURE'
        : activeAnalysis >= this.maxAnalysis ? 'CONCURRENCY_LIMIT'
          : availableAnalysisSlots === 0 ? 'INTERACTIVE_RESERVE' : null };
  }

  reserve(id, kind) {
    if (this.jobs.has(id)) return false;
    const state = this.capacity();
    if (state.availableSlots < 1) return false;
    // Leave one slot for interactive work when the machine can afford it.
    // On a one-slot machine analysis may still run, with ordinary work first
    // at the next scheduling opportunity.
    if (isAnalysis(kind) && state.availableAnalysisSlots < 1) return false;
    this.jobs.set(id, { kind, pid: null, current: 0, peak: 0 });
    return true;
  }

  attach(id, pid) {
    const entry = this.jobs.get(id);
    if (entry && Number.isSafeInteger(pid) && pid > 0) entry.pid = pid;
  }

  release(id, successful = false) {
    const entry = this.jobs.get(id);
    if (successful && entry) this.completedPeak = Math.max(this.completedPeak, entry.peak);
    this.jobs.delete(id);
  }

  jobStatus(id) {
    const entry = this.jobs.get(id);
    return entry ? { currentBytes: entry.current, peakBytes: entry.peak } : null;
  }

  status() {
    return { ...this.capacity(), totalBytes: this.snapshot?.totalBytes ?? null,
      availableBytes: this.snapshot?.availableBytes ?? null, memoryPercent: this.percent,
      maxConcurrentAnalysis: this.maxAnalysis, maxConcurrentRelevance: this.maxAnalysis,
      observedPeakPerJobBytes: this.observedPeak, calibrated: this.completedPeak > 0,
      source: this.snapshot?.source ?? 'unknown', activeReservations: this.jobs.size };
  }
}
