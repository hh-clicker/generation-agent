import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMarketExtractionInput, buildMarketExtractionPrompt, parseMarketExtractionOutput,
  validateMarketCoverageInput, buildMarketCoveragePrompt, parseMarketCoverageOutput,
  promptVersionFor,
} from '../src/contract.js';

const id = '123e4567-e89b-12d3-a456-426614174000';
const requirementId = '123e4567-e89b-12d3-a456-426614174001';

test('market extraction keeps cited facts and records rejected facts without failing the batch', () => {
  const input = validateMarketExtractionInput({ vacancies: [{ id, title: 'Java-разработчик', text: 'Требуется опыт с Kubernetes.' }] });
  assert.ok(buildMarketExtractionPrompt(input).includes('Kubernetes'));
  const result = { items: [{ id, facts: [{ name: 'Kubernetes', kind: 'TECHNOLOGY', evidence: 'Kubernetes' }] }] };
  assert.deepEqual(parseMarketExtractionOutput(JSON.stringify(result), input), { ...result, diagnostics: [] });
  const rejected = parseMarketExtractionOutput(JSON.stringify({ items: [{ id, facts: [
    result.items[0].facts[0], { ...result.items[0].facts[0], evidence: 'Docker' },
  ] }] }), input);
  assert.equal(rejected.items[0].facts.length, 1);
  assert.deepEqual(rejected.diagnostics, [{ id, reason: 'EVIDENCE_NOT_IN_SOURCE', name: 'Kubernetes', evidence: 'Docker' }]);
  assert.throws(() => validateMarketExtractionInput({ vacancies: [{ id, title: 'x', text: '' }] }));
  assert.equal(promptVersionFor('market-extraction'), 'market-extraction-v6');
  const synonym = parseMarketExtractionOutput(JSON.stringify({ items: [{ id, facts: [{
    name: 'k8s', kind: 'TECHNOLOGY', evidence: 'Kubernetes',
  }] }] }), input);
  assert.equal(synonym.items[0].facts.length, 0);
  assert.equal(synonym.diagnostics[0].reason, 'TERM_NOT_IN_EVIDENCE');
  const inflected = parseMarketExtractionOutput(JSON.stringify({ items: [{ id, facts: [{
    name: 'микросервисной архитектуры', kind: 'SKILL', evidence: 'Опыт микросервисной архитектуры',
  }] }] }), validateMarketExtractionInput({ vacancies: [{ id, title: 'Java', text: 'Опыт микросервисной архитектуры' }] }));
  assert.equal(inflected.items[0].facts[0].name, 'микросервисной архитектуры');
  assert.equal(parseMarketExtractionOutput('not json', input).diagnostics[0].reason, 'INVALID_JSON');
});

test('market extraction keeps more than fifty facts and a shared-prefix expression verbatim', () => {
  const names = Array.from({ length: 51 }, (_, index) => `Term${index}`);
  const expression = 'Spring Boot / Cloud / Security';
  const input = validateMarketExtractionInput({ vacancies: [{
    id, title: 'Java-разработчик', text: `${names.join(' ')}. ${expression}`,
  }] });
  const facts = [
    ...names.map(name => ({ name, kind: 'TECHNOLOGY', evidence: name })),
    { name: expression, kind: 'TECHNOLOGY', evidence: expression },
  ];
  const result = parseMarketExtractionOutput(JSON.stringify({ items: [{ id, facts }] }), input);
  assert.equal(result.items[0].facts.length, 52);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(buildMarketExtractionPrompt(input).includes(expression));
});

test('market coverage requires a cited resume passage, not a fabricated percentage', () => {
  const input = validateMarketCoverageInput({ resumeText: 'Работал с Kubernetes.', requirements: [{ id: requirementId, name: 'kubernetes' }] });
  assert.ok(buildMarketCoveragePrompt(input).includes('Не вычисляй общий процент'));
  const result = { items: [{ id: requirementId, status: 'EXPLICIT', evidence: 'Kubernetes' }] };
  assert.deepEqual(parseMarketCoverageOutput(JSON.stringify(result), input), { ...result, diagnostics: [] });
  const rejected = parseMarketCoverageOutput(JSON.stringify({ items: [{ ...result.items[0], evidence: 'Docker' }] }), input);
  assert.deepEqual(rejected.items, [{ id: requirementId, status: 'UNVERIFIED', evidence: '' }]);
  assert.equal(rejected.diagnostics[0].reason, 'EVIDENCE_NOT_IN_RESUME');
  assert.equal(promptVersionFor('market-coverage'), 'market-coverage-v3');
});
