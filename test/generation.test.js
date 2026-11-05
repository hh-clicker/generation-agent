import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import {
  buildCodeSolutionPrompt, buildPrompt, buildQuestionPrompt, buildVacancyRelevancePrompt,
  parseCodeSolutionOutput, parseOutput, parseQuestionOutput, parseVacancyRelevanceOutput,
  validateCodeSolutionInput, validateInput, validateQuestionInput, validateVacancyRelevanceInput,
} from '../src/contract.js';
import { CodexRunner as Runner, generationArgs, parseEvents, runProcess } from '../src/codex.js';
class CodexRunner extends Runner { constructor(config, execute) { super(config, execute, null); } }
import { GenerationQueue } from '../src/queue.js';
import { checkLocalRequest, createServer } from '../src/http.js';

const input = validateInput({ resumeText: 'Разрабатывал сервисы на Java.', vacancyText: 'Нужен Java-разработчик.' });
const config = readConfig({});
const success = { result: { letter: 'Здравствуйте! Хочу обсудить вашу вакансию.', warnings: [] }, error: null, usage: null, cliMs: 42 };
const questionInput = validateQuestionInput({ question: 'Сколько будет 2 + 2?', answers: ['3', '4', '5'], title: 'Арифметика', taskNumber: 1, taskCount: 10 });
const questionSuccess = { result: { answerNumber: 2, answer: '4', explanation: 'Сумма равна четырём.', confidence: 'high' }, error: null, usage: null, cliMs: 21 };
const codeInput = validateCodeSolutionInput({
  title: 'Сумма двух чисел', statement: 'Верните сумму a и b.', language: 'go',
  code: 'package main\n', taskNumber: 2, taskCount: 3,
});
const codeSuccess = {
  result: { code: 'package main\n\nfunc sum(a, b int) int { return a + b }', explanation: 'Складываем аргументы.', warnings: [] },
  error: null, usage: null, cliMs: 23,
};
const relevanceInput = validateVacancyRelevanceInput({
  resumeText: 'PHP-разработчик, Laravel, SQL.',
  vacancies: [
    { hhId: '1', title: 'PHP-разработчик', company: 'Web', salary: '250 000 ₽', normalizedSalary: { from: 200000, to: 250000, currency: 'RUR', gross: false, mode: 'MONTH', frequency: 'MONTHLY' }, location: 'Москва', address: 'Пресненская набережная', workFormats: ['REMOTE', 'HYBRID'], employmentForm: 'FULL', workScheduleByDays: ['FIVE_ON_TWO_OFF'], experience: '3–6 лет', internship: false, temporary: false, professionalRoles: ['Программист, разработчик'], plainText: 'Разработка PHP-сервисов на Laravel.' },
    { hhId: '2', title: 'Парковщик', company: 'Parking', salary: '', normalizedSalary: null, location: 'Москва', address: '', workFormats: [], employmentForm: '', workScheduleByDays: [], experience: '', internship: null, temporary: null, professionalRoles: [] },
  ],
});
const relevanceSuccess = { result: { items: [
  { hhId: '1', category: 'TARGET', confidence: 'high', reason: 'Явная PHP-разработка.' },
] }, error: null, usage: null, cliMs: 25 };

async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'generation-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('explicit defaults and validation reject unusable settings and input', () => {
  assert.equal(config.model, 'gpt-6-luna');
  assert.equal(config.reasoningEffort, 'low');
  assert.throws(() => readConfig({ CODEX_REASONING_EFFORT: 'auto' }));
  assert.throws(() => readConfig({ CODEX_TIMEOUT_MS: 'NaN' }));
  for (const body of [null, [], {}, { ...input, vacancyText: ' ' }, { ...input, maxLength: 1 }, { ...input, command: 'x' }]) {
    assert.throws(() => validateInput(body));
  }
  assert.ok(buildPrompt(input).includes(JSON.stringify(input)));
});

test('only validated letter JSON is accepted, never raw stdout or a partial schema', () => {
  assert.deepEqual(parseOutput(JSON.stringify(success.result), 1500), success.result);
  for (const raw of ['raw answer', '{}', '{"letter":"x"}', '{"letter":"", "warnings":[]}',
    '{"letter":"x", "warnings":"no"}', '{"letter":"x", "warnings":[], "extra":1}']) {
    assert.throws(() => parseOutput(raw, 1500));
  }
  assert.throws(() => parseOutput(JSON.stringify({ letter: 'a'.repeat(1501), warnings: [] }), 1500));
});

test('question contract validates one-choice input and derives answer text from the request', () => {
  assert.ok(buildQuestionPrompt(questionInput).includes(JSON.stringify(questionInput)));
  assert.deepEqual(parseQuestionOutput('{"answerNumber":2,"explanation":"Проверка.","confidence":"high"}', questionInput),
    { answerNumber: 2, answer: '4', explanation: 'Проверка.', confidence: 'high' });
  for (const body of [{}, { question: 'Q', answers: ['one'] }, { question: 'Q', answers: ['one', ' '] },
    { question: 'Q', answers: ['one', 'two'], taskNumber: 3, taskCount: 2 }, { question: 'Q', answers: ['one', 'two'], extra: true }]) {
    assert.throws(() => validateQuestionInput(body));
  }
  for (const raw of ['{}', '{"answerNumber":0,"explanation":"x","confidence":"high"}',
    '{"answerNumber":2,"answer":"forged","explanation":"x","confidence":"high"}',
    '{"answerNumber":2,"explanation":"x","confidence":"certain"}']) assert.throws(() => parseQuestionOutput(raw, questionInput));
});

test('code solution contract validates editor input and accepts only structured output', () => {
  assert.ok(buildCodeSolutionPrompt(codeInput).includes(JSON.stringify(codeInput)));
  assert.match(buildCodeSolutionPrompt(codeInput), /полный код/);
  assert.deepEqual(parseCodeSolutionOutput(JSON.stringify(codeSuccess.result)), codeSuccess.result);
  for (const body of [{}, { ...codeInput, statement: ' ' }, { ...codeInput, language: '' },
    { ...codeInput, taskNumber: 4, taskCount: 3 }, { ...codeInput, xsrfToken: 'secret' }]) {
    assert.throws(() => validateCodeSolutionInput(body));
  }
  for (const raw of ['{}', '{"code":"","explanation":"x","warnings":[]}',
    '{"code":"ok","explanation":"x","warnings":"none"}',
    '{"code":"ok","explanation":"x","warnings":[],"extra":true}']) {
    assert.throws(() => parseCodeSolutionOutput(raw));
  }
});

test('vacancy relevance contract accepts partial results but rejects foreign and duplicate IDs', () => {
  assert.match(buildVacancyRelevancePrompt(relevanceInput), /TARGET/);
  assert.match(buildVacancyRelevancePrompt(relevanceInput), /professionalRoles/);
  assert.match(buildVacancyRelevancePrompt(relevanceInput), /не служат чек-листом навыков резюме/);
  assert.match(buildVacancyRelevancePrompt(relevanceInput), /Для мультитрека/);
  assert.match(buildVacancyRelevancePrompt(relevanceInput), /Java и Kotlin backend обычно одна целевая специализация/);
  assert.match(buildVacancyRelevancePrompt(relevanceInput), /основная разработка на 1С, Oracle PL\/SQL/);
  assert.match(buildVacancyRelevancePrompt(relevanceInput), /лишь эпизодической Java — не TARGET/);
  assert.match(buildVacancyRelevancePrompt(relevanceInput), /Не путай альтернативы с вакансией/);
  assert.doesNotMatch(buildVacancyRelevancePrompt(relevanceInput), /TARGET допустим только при явном совпадении/);
  assert.doesNotMatch(buildVacancyRelevancePrompt(relevanceInput), /Для PHP-профиля|Для PHP-разработчика/);
  assert.deepEqual(relevanceInput.vacancies[0].workFormats, ['REMOTE', 'HYBRID']);
  assert.equal(relevanceInput.vacancies[0].normalizedSalary.from, 200000);
  assert.equal(relevanceInput.vacancies[0].plainText, 'Разработка PHP-сервисов на Laravel.');
  assert.equal(relevanceInput.vacancies[1].plainText, '');
  assert.match(buildVacancyRelevancePrompt(relevanceInput), /Если plainText непустой/);
  assert.deepEqual(parseVacancyRelevanceOutput(JSON.stringify(relevanceSuccess.result), relevanceInput), relevanceSuccess.result);
  for (const body of [{}, { ...relevanceInput, vacancies: [] },
    { ...relevanceInput, vacancies: [...relevanceInput.vacancies, relevanceInput.vacancies[0]] },
    { ...relevanceInput, vacancies: [{ ...relevanceInput.vacancies[0], extra: true }] },
    { ...relevanceInput, vacancies: [{ ...relevanceInput.vacancies[0], workFormats: 'REMOTE' }] },
    { ...relevanceInput, vacancies: [{ ...relevanceInput.vacancies[0], normalizedSalary: { from: -1 } }] },
    { ...relevanceInput, vacancies: [{ ...relevanceInput.vacancies[0], plainText: 'a'.repeat(100001) }] }]) {
    assert.throws(() => validateVacancyRelevanceInput(body));
  }
  for (const raw of ['{"items":[]}',
    '{"items":[{"hhId":"foreign","category":"TARGET","confidence":"high","reason":"x"}]}',
    '{"items":[{"hhId":"1","category":"TARGET","confidence":"high","reason":"x"},{"hhId":"1","category":"NOISE","confidence":"low","reason":"y"}]}',
    '{"items":[{"hhId":"1","category":"MAYBE","confidence":"high","reason":"x"}]}']) {
    assert.throws(() => parseVacancyRelevanceOutput(raw, relevanceInput));
  }
});

test('body-only prompt reserves greetings and closing for the application template', () => {
  const prompt = buildPrompt(input);
  assert.match(prompt, /только основную часть/);
  assert.match(prompt, /Не пиши про формат работы/);
  assert.match(prompt, /без точности до месяцев/);
  assert.match(prompt, /Отсутствие технологии в резюме не означает отсутствие опыта/);
});

test('usage is parsed from events, unknown usage is null rather than zero', () => {
  const event = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } });
  assert.deepEqual(parseEvents(event + '\n' + event).usage, { inputTokens: 200, cachedInputTokens: 40, outputTokens: 60 });
  assert.equal(parseEvents('noise\n{"type":"turn.started"}').usage, null);
  assert.equal(parseEvents('{"type":"turn.failed"}').failed, true);
});

test('CLI receives explicit model/reasoning, stdin prompt and restricted tools', () => {
  const args = generationArgs({ model: config.model, reasoningEffort: 'medium' }, '/tmp/example');
  assert.ok(args.includes('gpt-6-luna'));
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('read-only'));
  assert.equal(args.at(-1), '-');
  assert.equal(args.some(arg => arg.includes(input.resumeText)), false);
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});

test('exec isolation flags follow the subcommand, while approval stays on the root command', () => {
  const args = generationArgs({ model: config.model, reasoningEffort: 'low' }, '/tmp/example');
  const execIndex = args.indexOf('exec');
  assert.ok(execIndex > 0);
  for (const flag of ['--ignore-user-config', '--ignore-rules']) {
    assert.ok(args.indexOf(flag) > execIndex, `${flag} must be an exec option`);
    assert.equal(args.filter(arg => arg === flag).length, 1);
  }
  const approvalIndex = args.indexOf('--ask-for-approval');
  assert.ok(approvalIndex >= 0 && approvalIndex < execIndex);
  assert.equal(args[approvalIndex + 1], 'never');
});

test('runner uses final file, extracts timings, and removes temporary output', async () => {
  let answerPath;
  const runner = new CodexRunner(config, async (_command, args, options) => {
    if (args.includes('login')) return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT', failure: null };
    assert.ok(options.input.includes(input.resumeText));
    answerPath = args[args.indexOf('-o') + 1];
    await writeFile(answerPath, JSON.stringify(success.result));
    return { exitCode: 0, stdout: '{"type":"turn.completed","usage":{"input_tokens":30,"cached_input_tokens":0,"output_tokens":10}}', stderr: '', failure: null, durationMs: 42 };
  });
  const output = await runner.run({ ...config, input }, new AbortController().signal);
  assert.deepEqual(output.result, success.result);
  assert.equal(output.cliMs, 42);
  assert.equal(output.usage.inputTokens, 30);
  await assert.rejects(readFile(answerPath));
});

test('runner selects the question prompt and schema for question jobs', async () => {
  const runner = new CodexRunner(config, async (_command, args, options) => {
    if (args.includes('login')) return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT', failure: null };
    assert.ok(options.input.includes(questionInput.question));
    const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
    assert.equal(schema.properties.answerNumber.maximum, 3);
    await writeFile(args[args.indexOf('-o') + 1], JSON.stringify({ answerNumber: 2, explanation: 'Сумма равна четырём.', confidence: 'high' }));
    return { exitCode: 0, stdout: '', stderr: '', failure: null, durationMs: 21 };
  });
  const output = await runner.run({ ...config, kind: 'question-answer', input: questionInput }, new AbortController().signal);
  assert.deepEqual(output.result, questionSuccess.result);
});

test('runner selects the code solution prompt and schema for practical tasks', async () => {
  const runner = new CodexRunner(config, async (_command, args, options) => {
    if (args.includes('login')) return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT', failure: null };
    assert.ok(options.input.includes(codeInput.statement));
    const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
    assert.deepEqual(schema.required, ['code', 'explanation', 'warnings']);
    await writeFile(args[args.indexOf('-o') + 1], JSON.stringify(codeSuccess.result));
    return { exitCode: 0, stdout: '', stderr: '', failure: null, durationMs: 23 };
  });
  const output = await runner.run({ ...config, kind: 'code-solution', input: codeInput }, new AbortController().signal);
  assert.deepEqual(output.result, codeSuccess.result);
});

test('runner selects the vacancy relevance prompt and constrained ID schema', async () => {
  const runner = new CodexRunner(config, async (_command, args, options) => {
    if (args.includes('login')) return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT', failure: null };
    assert.ok(options.input.includes(relevanceInput.resumeText));
    const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
    assert.deepEqual(schema.properties.items.items.properties.hhId.enum, ['1', '2']);
    await writeFile(args[args.indexOf('-o') + 1], JSON.stringify(relevanceSuccess.result));
    return { exitCode: 0, stdout: '', stderr: '', failure: null, durationMs: 25 };
  });
  const output = await runner.run({ ...config, kind: 'vacancy-relevance', input: relevanceInput }, new AbortController().signal);
  assert.deepEqual(output.result, relevanceSuccess.result);
});

test('auth failure never invokes generation or exposes raw CLI diagnostics', async () => {
  let calls = 0;
  const runner = new CodexRunner(config, async () => {
    calls++;
    return { exitCode: 1, stdout: '', stderr: 'Not logged in private-diagnostic', failure: null };
  });
  const output = await runner.run({ ...config, input }, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(output.error.code, 'AUTH_REQUIRED');
  assert.doesNotMatch(JSON.stringify(output), /private-diagnostic/);
});

test('queue deduplicates concurrent admissions, persists results and removes inputs', async t => {
  const dataDir = await temporary(t);
  const queue = new GenerationQueue({ ...config, dataDir }, { version: 'test', run: async () => success });
  await queue.initialize();
  const [first, second] = await Promise.all([queue.create(input, 'same-key'), queue.create(input, 'same-key')]);
  assert.equal(first.job.id, second.job.id);
  assert.equal(second.reused, true);
  await assert.rejects(queue.create({ ...input, instructions: 'Different' }, 'same-key'), { code: 'KEY_CONFLICT' });
  await queue.tick();
  const completed = queue.find(first.job.id);
  assert.equal(completed.status, 'done');
  assert.deepEqual(completed.result, success.result);
  assert.equal(completed.timings.cliMs, 42);
  assert.ok(completed.timings.executionMs >= 0);
  assert.equal('input' in completed, false);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, first.job.id + '.json'), 'utf8')).input, null);
  const recovered = new GenerationQueue({ ...config, dataDir }, {});
  await recovered.initialize();
  assert.deepEqual(recovered.find(first.job.id), completed);
});

test('interrupted jobs fail on restart, queued jobs remain queued; no automatic model call', async t => {
  const dataDir = await temporary(t);
  const queue = new GenerationQueue({ ...config, dataDir }, {});
  await queue.initialize();
  const first = await queue.create(input);
  const second = await queue.create(input);
  await queue.save({ ...queue.jobs.get(first.job.id), status: 'running' });
  const recovered = new GenerationQueue({ ...config, dataDir }, {});
  await recovered.initialize();
  assert.equal(recovered.find(first.job.id).error.code, 'INTERRUPTED');
  assert.equal(recovered.jobs.get(first.job.id).input, null);
  assert.equal(recovered.find(second.job.id).status, 'queued');
});

test('worker is sequential, admission is bounded and shutdown aborts active generation', async t => {
  const dataDir = await temporary(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const queue = new GenerationQueue({ ...config, dataDir, maxPending: 1 }, { version: 'test', run: async (_job, signal) => {
    calls++; entered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { ...success, result: null, error: { code: 'INTERRUPTED', message: 'Stopped' } };
  } });
  await queue.initialize();
  const created = await queue.create(input);
  const tick = queue.tick();
  await started;
  await queue.tick();
  await assert.rejects(queue.create(input), { code: 'QUEUE_FULL' });
  await queue.stop();
  await tick;
  assert.equal(calls, 1);
  assert.equal(queue.find(created.job.id).status, 'failed');
});

test('web origins and DNS-rebinding hosts are rejected without an API token', () => {
  checkLocalRequest({ headers: { host: '127.0.0.1:17374' } });
  checkLocalRequest({ headers: { host: 'host.docker.internal:17374' } });
  checkLocalRequest({ headers: { host: 'generation-agent:17374' } });
  for (const headers of [{ host: 'evil.test' }, { host: 'localhost', origin: 'https://example.test' },
    { host: 'localhost', 'sec-fetch-site': 'cross-site' }]) assert.throws(() => checkLocalRequest({ headers }));
});

test('HTTP contract supports Postman create/poll and rejects non-JSON requests', async t => {
  const dataDir = await temporary(t);
  const runner = { version: 'test', run: async () => success, authStatus: async () => ({ authenticated: false, method: null }) };
  const authManager = {
    status: () => ({ status: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }),
    startLogin: async () => ({ status: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }),
    cancelLogin: async () => ({ status: 'idle' }),
    logout: async () => ({ status: 'signed_out' }),
  };
  const queue = new GenerationQueue({ ...config, dataDir }, runner);
  await queue.initialize();
  const server = createServer(config, queue, runner, authManager);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 202);
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  const job = await response.json();
  await queue.tick();
  assert.equal((await (await fetch(base + job.url)).json()).status, 'done');
  assert.equal((await (await fetch(base + '/auth/login/start', { method: 'POST' })).json()).userCode, 'ABCD-1234');
  assert.equal((await (await fetch(base + '/auth/login')).json()).status, 'pending');
  assert.equal((await (await fetch(base + '/auth/login/cancel', { method: 'POST' })).json()).status, 'idle');
  assert.equal((await (await fetch(base + '/auth/logout', { method: 'POST' })).json()).status, 'signed_out');
  assert.equal((await fetch(base + '/generations', { method: 'POST', body: 'not json' })).status, 415);
});

test('HTTP question contract shares the queue but cannot be polled through cover-letter routes', async t => {
  const dataDir = await temporary(t);
  const runner = { version: 'test', run: async job => job.kind === 'question-answer' ? questionSuccess : success,
    authStatus: async () => ({ authenticated: true, method: 'chatgpt' }) };
  const queue = new GenerationQueue({ ...config, dataDir }, runner);
  await queue.initialize();
  const server = createServer(config, queue, runner);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/questions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(questionInput) });
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal(job.kind, 'question-answer');
  assert.equal(job.url, `/questions/${job.id}`);
  assert.equal((await fetch(base + `/generations/${job.id}`)).status, 404);
  await queue.tick();
  const completed = await (await fetch(base + job.url)).json();
  assert.deepEqual(completed.result, questionSuccess.result);
});

test('HTTP code solution contract uses a separate route and queue kind', async t => {
  const dataDir = await temporary(t);
  const runner = { version: 'test', run: async job => job.kind === 'code-solution' ? codeSuccess : success,
    authStatus: async () => ({ authenticated: true, method: 'chatgpt' }) };
  const queue = new GenerationQueue({ ...config, dataDir }, runner);
  await queue.initialize();
  const server = createServer(config, queue, runner);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/code-solutions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(codeInput),
  });
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal(job.kind, 'code-solution');
  assert.equal(job.url, `/code-solutions/${job.id}`);
  assert.equal((await fetch(base + `/questions/${job.id}`)).status, 404);
  await queue.tick();
  assert.deepEqual((await (await fetch(base + job.url)).json()).result, codeSuccess.result);
});

test('HTTP vacancy relevance contract uses a separate route and queue kind', async t => {
  const dataDir = await temporary(t);
  const runner = { version: 'test', run: async job => job.kind === 'vacancy-relevance' ? relevanceSuccess : success,
    authStatus: async () => ({ authenticated: true, method: 'chatgpt' }) };
  const queue = new GenerationQueue({ ...config, dataDir }, runner);
  await queue.initialize();
  const server = createServer(config, queue, runner);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/vacancy-relevance', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(relevanceInput),
  });
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal(job.kind, 'vacancy-relevance');
  assert.equal(job.url, `/vacancy-relevance/${job.id}`);
  assert.equal((await fetch(base + `/generations/${job.id}`)).status, 404);
  await queue.tick();
  assert.deepEqual((await (await fetch(base + job.url)).json()).result, relevanceSuccess.result);
});

test('process timeout terminates a local fake worker, never invokes Codex', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 1000 });
  assert.equal(result.failure, 'TIMEOUT');
  assert.ok(result.durationMs >= 900);
});
