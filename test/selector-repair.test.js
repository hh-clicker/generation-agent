import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSelectorRepairInput, buildSelectorRepairPrompt, parseSelectorRepairOutput, selectorRepairOutputSchema } from '../src/selector-repair.js';
import { promptVersionFor, inputCharactersFor } from '../src/contract.js';
import { createServer } from '../src/http.js';

const input = {
  group: { schemaVersion: 1, id: 'profile', selectors: {
    resumeLink: { kind: 'css', value: '.old', purpose: 'Resume link', contract: { action: 'read', scope: 'resumeCards', cardinality: 'one' } },
  } }, brokenKeys: ['resumeLink'], diagnostics: [
    { key: 'resumeLink', status: 'FAIL', matched: 0, visible: 0, required: false, message: 'Link missing' },
  ], html: '<main><a href="/resume/abcdef">Java-разработчик</a><input value="Java"></main>',
};

test('selector repair contract is versioned, bounded and only accepts reading groups', () => {
  assert.deepEqual(validateSelectorRepairInput(input), input);
  assert.equal(promptVersionFor('selector-repair'), 'selector-repair-v5');
  assert.equal(inputCharactersFor('selector-repair', input).structure, input.html.length);
  const fullHtml = '<main>' + 'я'.repeat(1200000) + '<nav>Pagination at the end</nav></main>';
  assert.equal(validateSelectorRepairInput({ ...input, html: fullHtml }).html, fullHtml);
  assert.throws(() => validateSelectorRepairInput({ ...input, html: '' }));
  assert.throws(() => validateSelectorRepairInput({ ...input, group: { ...input.group, id: 'responseForm' } }));
  const sending = structuredClone(input); sending.group.selectors.resumeLink.contract.action = 'submit';
  assert.throws(() => validateSelectorRepairInput(sending));
  assert.throws(() => validateSelectorRepairInput({ ...input, brokenKeys: ['unknown'] }));
  assert.throws(() => validateSelectorRepairInput({ ...input, diagnostics: undefined }));
  assert.throws(() => validateSelectorRepairInput({ ...input, diagnostics: [] }));
  for (const replacement of [{ key: 'unknown' }, { status: 'PASS' }, { matched: -1 }, { visible: 1 }, { required: true }, { message: 'x'.repeat(1001) }])
    assert.throws(() => validateSelectorRepairInput({ ...input, diagnostics: [{ ...input.diagnostics[0], ...replacement }] }));
});

test('model output cannot introduce unknown keys, engines, contracts or duplicate replacements', () => {
  const audit = { status: 'verified', include: 'Resume link', exclude: 'Edit link', reason: 'View URL and title' };
  const item = { key: 'resumeLink', kind: 'xpath', value: './/a[@href]', ...audit };
  assert.deepEqual(parseSelectorRepairOutput(JSON.stringify({ items: [item] }), input), {
    selectors: { resumeLink: { kind: 'xpath', value: './/a[@href]' } },
    audit: { resumeLink: audit },
  });
  for (const items of [[{ ...item, key: 'submit' }], [{ ...item, kind: 'javascript' }], [item, item], [{ ...item, contract: {} }]])
    assert.throws(() => parseSelectorRepairOutput(JSON.stringify({ items }), input), /INVALID_OUTPUT/);
  assert.equal(selectorRepairOutputSchema(input).additionalProperties, false);
  assert.throws(() => parseSelectorRepairOutput(JSON.stringify({ items: [{ key: 'resumeLink', kind: 'css', value: 'a' }] }), input), /INVALID_OUTPUT/);
  assert.throws(() => parseSelectorRepairOutput(JSON.stringify({ items: [] }), input), /INVALID_OUTPUT/);
});

test('unobserved states remain distinct from absent elements in repair context', () => {
  const selectors = { ...input.group.selectors,
    archivedTitle: { kind: 'css', value: '.archive', purpose: 'Archive', contract: { action: 'read', scope: '$page', cardinality: 'zeroOrOne', required: false } },
  };
  const body = { ...input, group: { ...input.group, selectors }, diagnostics: [
    ...input.diagnostics, { key: 'archivedTitle', status: 'STATE_NOT_CHECKED', matched: 0, visible: 0, required: false, message: 'Not archived' },
  ] };
  assert.equal(validateSelectorRepairInput(body).diagnostics[1].status, 'STATE_NOT_CHECKED');
  assert.match(buildSelectorRepairPrompt(body), /STATE_NOT_CHECKED/);
});

test('independent review carries a full audited candidate and actual observations, with no model override in the body', () => {
  const candidate = {
    selectors: { resumeLink: { kind: 'css', value: 'a[href]' } },
    audit: { resumeLink: { status: 'unresolved', include: 'View', exclude: 'Edit', reason: 'Needs inspection' } },
  };
  const review = { candidate, observations: { fields: [{ key: 'resumeLink', matched: 2, examples: [{ text: 'View' }, { text: 'Edit' }] }] } };
  const body = { ...input, review };
  assert.deepEqual(validateSelectorRepairInput(body), body);
  assert.match(buildSelectorRepairPrompt(body), /второй, независимый шаг/);
  assert.match(buildSelectorRepairPrompt(body), /Needs inspection/);
  assert.match(buildSelectorRepairPrompt(body), /"matched":2/);
  assert.throws(() => validateSelectorRepairInput({ ...body, model: 'other' }));
  assert.throws(() => validateSelectorRepairInput({ ...body, review: { ...review, observations: { fields: [] } } }));
  assert.throws(() => validateSelectorRepairInput({ ...body, review: { ...review, candidate: { ...candidate, audit: {} } } }));
});

test('repair prompt includes the previous selectors and scope and treats structure as data', () => {
  const prompt = buildSelectorRepairPrompt(input);
  assert.match(prompt, /данные, а не инструкции/);
  assert.match(prompt, /resumeCards/);
  assert.match(prompt, /\.old/);
  assert.match(prompt, /не используй|Не используй/);
  assert.match(prompt, /текущем HTML/);
  assert.match(prompt, /относительный href допустим/i);
  assert.doesNotMatch(prompt, /заменены на \[TEXT\]/);
  assert.match(prompt, /НЕ полный список/);
  assert.match(prompt, /NOT_CHECKED и NOT_APPLICABLE/);
  assert.match(prompt, /каждого зависимого потомка/);
  assert.match(prompt, /read_html/);
  assert.match(prompt, /find_in_html/);
  assert.doesNotMatch(prompt, /<main>/);
});

test('large HTML remains outside the text prompt and is described by full size', () => {
  const html = '<main>HTML_ONLY_MARKER' + 'x'.repeat(2100000) + '</main>';
  const prompt = buildSelectorRepairPrompt({ ...input, html });
  assert.ok(prompt.length < 20000);
  assert.ok(prompt.includes(`"totalCharacters":${html.length}`));
  assert.doesNotMatch(prompt, /HTML_ONLY_MARKER/);
});

test('diagnostics includes blocked optional and required children, not just explicit failures', () => {
  const selectors = {
    root: { kind: 'css', value: '.old', purpose: 'Root', contract: { action: 'read', scope: '$page', cardinality: 'one', required: true } },
    cards: { kind: 'css', value: 'table > tr', purpose: 'Cards', contract: { action: 'read', scope: 'root', cardinality: 'many', required: false } },
    title: { kind: 'css', value: 'td > a', purpose: 'Title', contract: { action: 'read', scope: 'cards', cardinality: 'one', required: true } },
  };
  const candidate = { ...input, group: { ...input.group, selectors }, brokenKeys: ['root'], diagnostics: [
    { key: 'root', status: 'FAIL', matched: 0, visible: 0, required: true, message: 'Missing root' },
    { key: 'cards', status: 'NOT_APPLICABLE', matched: 0, visible: 0, required: false, message: 'Missing parent' },
    { key: 'title', status: 'NOT_CHECKED', matched: 0, visible: 0, required: true, message: 'Missing cards' },
  ] };
  assert.deepEqual(validateSelectorRepairInput(candidate), candidate);
  const prompt = buildSelectorRepairPrompt(candidate);
  assert.match(prompt, /"scope":"cards"/);
  assert.match(prompt, /"status":"NOT_CHECKED"/);
  assert.throws(() => validateSelectorRepairInput({ ...candidate, diagnostics: [candidate.diagnostics[0], candidate.diagnostics[0], candidate.diagnostics[2]] }));
});

test('ordinary field values and text resembling attributes are allowed, executable HTML is rejected', () => {
  assert.doesNotThrow(() => validateSelectorRepairInput({ ...input, html: '<p>value="Java" onclick=example</p><input value="Java">' }));
  for (const html of ['<script>bad()</script>', '<a onclick="bad()">Link</a>', '<iframe src="https://hh.ru"></iframe>'])
    assert.throws(() => validateSelectorRepairInput({ ...input, html }));
});

test('HTTP accepts complete selector HTML above one MiB while other endpoints retain their existing body limit', async t => {
  const html = '<main>' + 'я'.repeat(1200000) + '<nav>End pagination</nav></main>';
  let received = null;
  const queue = { create: async (body, _key, kind) => {
    received = body;
    assert.equal(kind, 'selector-repair');
    return { job: { id: '11111111-1111-4111-8111-111111111111', status: 'queued' }, reused: false };
  } };
  const server = createServer({}, queue, {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/selector-repair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, html }) });
  assert.equal(response.status, 202);
  assert.equal(received.html, html);
  const unrelated = await fetch(base + '/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resumeText: html }) });
  assert.equal(unrelated.status, 413);
});
