import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { snapshotTool, snapshotToolDefinitions, serveSnapshot } from '../src/selector-html-reader.js';

test('range reading reconstructs the full snapshot without dropping Unicode or tail content', () => {
  const html = '<main>' + 'Я🙂'.repeat(14000) + '<nav>End of file</nav></main>';
  let offset = 0, result = '';
  do {
    const part = snapshotTool(html, 'read_html', { offset });
    assert.equal(part.totalCharacters, html.length);
    result += part.html;
    offset = part.nextOffset;
  } while (offset !== null);
  assert.equal(result, html);
});

test('literal search reaches the end of a multi-million-character file and paginates all matches', () => {
  const html = 'x'.repeat(2100000) + Array.from({ length: 43 }, () => '<a[href]>').join('') + 'END';
  let offset = 0, positions = [];
  do {
    const found = snapshotTool(html, 'find_in_html', { text: '<a[href]>', offset });
    positions.push(...found.matches.map(item => item.offset));
    offset = found.nextOffset;
  } while (offset !== null);
  assert.equal(positions.length, 43);
  assert.equal(new Set(positions).size, 43);
  assert.equal(positions[0], 2100000);
  const end = snapshotTool(html, 'find_in_html', { text: 'END' }).matches[0];
  assert.equal(snapshotTool(html, 'read_html', { offset: end.offset }).html, 'END');
});

test('tools cannot change files, choose another path, execute commands or evaluate selectors', () => {
  for (const [name, args] of [
    ['read_html', { path: '/etc/passwd' }], ['read_html', { offset: -1 }], ['read_html', { offset: 4 }],
    ['read_html', { length: 0 }], ['read_html', { length: 12001 }], ['find_in_html', { text: '' }],
    ['find_in_html', { text: 'x', url: 'https://hh.ru' }], ['write_file', {}], ['shell', { command: 'pwd' }],
  ]) assert.throws(() => snapshotTool('abc', name, args));
  assert.deepEqual(snapshotToolDefinitions.map(tool => tool.name), ['read_html', 'find_in_html']);
  assert.ok(snapshotToolDefinitions.every(tool => tool.annotations.readOnlyHint && !tool.annotations.openWorldHint));
});

test('MCP stdio serves only the bound snapshot and exposes no file resources or generic tools', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hh-snapshot-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'page.html');
  await writeFile(file, 'ONLY_SNAPSHOT');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_html', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_html', arguments: { path: '/etc/passwd' } } },
    { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'file:///etc/passwd' } },
  ];
  let output = '';
  const sink = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  await serveSnapshot(file, Readable.from(requests.map(value => JSON.stringify(value) + '\n')), sink);
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 5);
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.equal(JSON.parse(replies[2].result.content[0].text).html, 'ONLY_SNAPSHOT');
  assert.equal(replies[3].result.isError, true);
  assert.equal(replies[4].error.code, -32601);
  assert.doesNotMatch(output, /root:|file:\/\/\/etc\/passwd/);
});
