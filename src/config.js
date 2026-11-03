import path from 'node:path';

export function readConfig(env = process.env) {
  const integer = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const model = env.CODEX_MODEL ?? 'gpt-6-luna';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model)) throw new Error('Invalid CODEX_MODEL');
  const reasoningEffort = env.CODEX_REASONING_EFFORT ?? 'low';
  if (!['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw new Error('Invalid CODEX_REASONING_EFFORT');
  const host = env.GENERATION_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) throw new Error('Invalid GENERATION_HOST');
  const concurrencyKey = env.GENERATION_MAX_CONCURRENT_ANALYSIS !== undefined
    ? 'GENERATION_MAX_CONCURRENT_ANALYSIS' : 'GENERATION_MAX_CONCURRENT_RELEVANCE';
  const maxConcurrentAnalysis = integer(concurrencyKey, 4, 1, 1000);
  return {
    host, model, reasoningEffort,
    port: integer('GENERATION_PORT', 17374, 1, 65535),
    timeoutMs: integer('CODEX_TIMEOUT_MS', 180000, 1000, 900000),
    maxPending: integer('GENERATION_MAX_PENDING', 20, 1, 100),
    maxConcurrentAnalysis,
    maxConcurrentRelevance: maxConcurrentAnalysis, // Compatibility for existing diagnostics/clients.
    memoryPercent: integer('GENERATION_MEMORY_PERCENT', 25, 5, 75),
    jobMemoryMiB: integer('GENERATION_JOB_MEMORY_MIB', 128, 64, 16384),
    retentionDays: integer('GENERATION_RETENTION_DAYS', 7, 1, 30),
    dataDir: path.resolve(env.GENERATION_DATA_DIR ?? '.data'),
    codexBin: 'codex',
  };
}
