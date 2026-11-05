import http from 'node:http';
import {
  RequestError, validateCodeSolutionInput, validateInput, validateQuestionInput, validateVacancyRelevanceInput,
  validateMarketExtractionInput, validateMarketCoverageInput,
} from './contract.js';

function respond(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

export function checkLocalRequest(req) {
  // Loopback binding alone does not protect an unauthenticated local API from websites.
  if (!/^(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal|generation-agent)(:\d{1,5})?$/.test(req.headers.host ?? '')) throw new RequestError(403, 'LOCAL_ONLY', 'Разрешены только localhost и локальная сеть Docker.');
  if (req.headers.origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none')) {
    throw new RequestError(403, 'BROWSER_ORIGIN_DENIED', 'Запросы со страниц браузера запрещены. Используйте Postman Desktop или curl.');
  }
}

async function readBody(req) {
  if (!(req.headers['content-type'] ?? '').toLowerCase().match(/^application\/json(?:\s*;|$)/)) throw new RequestError(415, 'JSON_REQUIRED', 'Content-Type должен быть application/json.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new RequestError(413, 'BODY_TOO_LARGE', 'Размер запроса больше 1 МиБ.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'INVALID_JSON', 'Не удалось разобрать JSON.'); }
}

export function createServer(config, queue, runner, authManager = null) {
  const server = http.createServer(async (req, res) => {
    try {
      checkLocalRequest(req);
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        const state = queue.status();
        return respond(res, state.ok ? 200 : 503, {
          ...state, cliVersion: runner.version, model: config.model, reasoningEffort: config.reasoningEffort,
          timeoutMs: config.timeoutMs, maxPending: config.maxPending, retentionDays: config.retentionDays,
        });
      }
      if (req.method === 'GET' && url.pathname === '/auth/status') {
        return respond(res, 200, runner.authSnapshot ? runner.authSnapshot() : await runner.authStatus());
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        const runId = url.searchParams.get('runId');
        if (runId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) {
          throw new RequestError(400, 'INVALID_ID', 'Некорректный ID запуска.');
        }
        return respond(res, 200, queue.metrics(runId));
      }
      if (req.method === 'POST' && url.pathname === '/auth/status/refresh') {
        await runner.authStatus(undefined, true);
        return respond(res, 200, runner.authSnapshot ? runner.authSnapshot() : await runner.authStatus());
      }
      if (req.method === 'POST' && url.pathname === '/auth/login/start' && authManager) {
        return respond(res, 200, await authManager.startLogin());
      }
      if (req.method === 'GET' && url.pathname === '/auth/login' && authManager) {
        return respond(res, 200, authManager.status());
      }
      if (req.method === 'POST' && url.pathname === '/auth/login/cancel' && authManager) {
        return respond(res, 200, await authManager.cancelLogin());
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout' && authManager) {
        return respond(res, 200, await authManager.logout());
      }
      if (req.method === 'POST' && url.pathname === '/generations') {
        const input = validateInput(await readBody(req));
        const { job, reused } = await queue.create(input, req.headers['idempotency-key']);
        return respond(res, reused ? 200 : 202, { ...job, reused, url: `/generations/${job.id}` });
      }
      if (req.method === 'POST' && url.pathname === '/questions') {
        const input = validateQuestionInput(await readBody(req));
        const { job, reused } = await queue.create(input, req.headers['idempotency-key'], 'question-answer');
        return respond(res, reused ? 200 : 202, { ...job, reused, url: `/questions/${job.id}` });
      }
      if (req.method === 'POST' && url.pathname === '/code-solutions') {
        const input = validateCodeSolutionInput(await readBody(req));
        const { job, reused } = await queue.create(input, req.headers['idempotency-key'], 'code-solution');
        return respond(res, reused ? 200 : 202, { ...job, reused, url: `/code-solutions/${job.id}` });
      }
      if (req.method === 'POST' && url.pathname === '/vacancy-relevance') {
        const input = validateVacancyRelevanceInput(await readBody(req));
        const { job, reused } = await queue.create(input, req.headers['idempotency-key'], 'vacancy-relevance');
        return respond(res, reused ? 200 : 202, { ...job, reused, url: `/vacancy-relevance/${job.id}` });
      }
      if (req.method === 'POST' && url.pathname === '/market-extraction') {
        const input = validateMarketExtractionInput(await readBody(req));
        const { job, reused } = await queue.create(input, req.headers['idempotency-key'], 'market-extraction');
        return respond(res, reused ? 200 : 202, { ...job, reused, url: `/market-extraction/${job.id}` });
      }
      if (req.method === 'POST' && url.pathname === '/market-coverage') {
        const input = validateMarketCoverageInput(await readBody(req));
        const { job, reused } = await queue.create(input, req.headers['idempotency-key'], 'market-coverage');
        return respond(res, reused ? 200 : 202, { ...job, reused, url: `/market-coverage/${job.id}` });
      }
      const match = url.pathname.match(/^\/generations\/([^/]+)$/);
      if (req.method === 'GET' && match) return respond(res, 200, queue.find(match[1], 'cover-letter'));
      const questionMatch = url.pathname.match(/^\/questions\/([^/]+)$/);
      if (req.method === 'GET' && questionMatch) return respond(res, 200, queue.find(questionMatch[1], 'question-answer'));
      const codeSolutionMatch = url.pathname.match(/^\/code-solutions\/([^/]+)$/);
      if (req.method === 'GET' && codeSolutionMatch) return respond(res, 200, queue.find(codeSolutionMatch[1], 'code-solution'));
      const vacancyRelevanceMatch = url.pathname.match(/^\/vacancy-relevance\/([^/]+)$/);
      if (req.method === 'GET' && vacancyRelevanceMatch) return respond(res, 200, queue.find(vacancyRelevanceMatch[1], 'vacancy-relevance'));
      const marketExtractionMatch = url.pathname.match(/^\/market-extraction\/([^/]+)$/);
      if (req.method === 'GET' && marketExtractionMatch) return respond(res, 200, queue.find(marketExtractionMatch[1], 'market-extraction'));
      const marketCoverageMatch = url.pathname.match(/^\/market-coverage\/([^/]+)$/);
      if (req.method === 'GET' && marketCoverageMatch) return respond(res, 200, queue.find(marketCoverageMatch[1], 'market-coverage'));
      throw new RequestError(404, 'NOT_FOUND', 'Ручка не найдена.');
    } catch (error) {
      if (!res.destroyed && !res.headersSent) respond(res, error instanceof RequestError ? error.status : 500, {
        error: error instanceof RequestError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервиса.' },
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
