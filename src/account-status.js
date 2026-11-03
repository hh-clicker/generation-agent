import { CodexAppServer } from './auth.js';

export function rateLimitWindow(value) {
  if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100
      || !Number.isSafeInteger(value.windowDurationMins) || value.windowDurationMins <= 0
      || !Number.isSafeInteger(value.resetsAt) || value.resetsAt < 0) return null;
  return { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt };
}

/** No model call. Return only whitelisted presentation data. */
export async function checkAccount(codexBin, createClient = () => new CodexAppServer(codexBin)) {
  const client = createClient();
  try {
    await client.start(3000);
    const response = await client.request('account/read', { refreshToken: true }, 4000);
    if (!response?.account) throw new Error('AUTH_REQUIRED');
    const method = response.account.type === 'chatgpt' ? 'chatgpt' : 'api_key';
    let limits = null;
    if (method === 'chatgpt') {
      const result = await client.request('account/rateLimits/read', undefined, 4000);
      const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
      if (bucket) limits = { primary: rateLimitWindow(bucket.primary), secondary: rateLimitWindow(bucket.secondary) };
    }
    return { authenticated: true, method, limits, error: null };
  } finally { client.close(); }
}
