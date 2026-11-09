import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

// Transport pages only: every character remains addressable; nothing is discarded.
const PAGE_CHARACTERS = 12000;
const FIND_MATCHES = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new Error('INVALID_ARGUMENTS'); };

export const snapshotToolDefinitions = [
  {
    name: 'read_html', description: 'Read a range of the complete immutable HTML snapshot. Offsets are zero-based UTF-16 character positions. Follow nextOffset to continue; no part of the file is omitted.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      offset: { type: 'integer', minimum: 0, default: 0 }, length: { type: 'integer', minimum: 1, maximum: PAGE_CHARACTERS, default: PAGE_CHARACTERS },
    } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'find_in_html', description: 'Find a literal, case-sensitive string in the complete immutable HTML snapshot. Returns positions and surrounding HTML. Follow nextOffset for further matches; this is not a CSS or XPath evaluator.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      text: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 0, default: 0 },
    } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** Pure string operations; requests cannot supply a file path, URL, command or selector. */
export function snapshotTool(html, name, args = {}) {
  if (!object(args)) invalid();
  const offset = args.offset ?? 0;
  if (!integer(offset) || offset > html.length) invalid();
  if (name === 'read_html') {
    if (Object.keys(args).some(key => !['offset', 'length'].includes(key))) invalid();
    const length = args.length ?? PAGE_CHARACTERS;
    if (!integer(length) || length < 1 || length > PAGE_CHARACTERS) invalid();
    const end = Math.min(html.length, offset + length);
    return { totalCharacters: html.length, offset, end, nextOffset: end < html.length ? end : null, html: html.slice(offset, end) };
  }
  if (name === 'find_in_html') {
    if (Object.keys(args).some(key => !['text', 'offset'].includes(key)) || typeof args.text !== 'string' || !args.text.length) invalid();
    const matches = [];
    let cursor = offset;
    while (matches.length < FIND_MATCHES) {
      const found = html.indexOf(args.text, cursor);
      if (found < 0) break;
      const start = Math.max(0, found - 120), end = Math.min(html.length, found + args.text.length + 120);
      // A long search string must not turn one search response into an unbounded tool result.
      matches.push({ offset: found, contextOffset: start, html: html.slice(start, Math.min(end, start + 480)) });
      cursor = found + 1;
    }
    return { totalCharacters: html.length, matches, nextOffset: matches.length === FIND_MATCHES && html.indexOf(args.text, cursor) >= 0 ? cursor : null };
  }
  throw new Error('UNKNOWN_TOOL');
}

/** Minimal stdio MCP server bound to exactly one snapshot before accepting requests. */
export async function serveSnapshot(file, input = process.stdin, output = process.stdout) {
  const html = await readFile(file, 'utf8');
  const lines = createInterface({ input, crlfDelay: Infinity });
  const send = response => output.write(JSON.stringify(response) + '\n');
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
    if (!object(request) || request.jsonrpc !== '2.0') {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); continue;
    }
    if (!Object.hasOwn(request, 'id')) continue;
    const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'initialize') {
      const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
      reply({ protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name: 'selector-html', version: '1.0.0' } });
    } else if (request.method === 'ping') reply({});
    else if (request.method === 'tools/list') reply({ tools: snapshotToolDefinitions });
    else if (request.method === 'tools/call') {
      try {
        const value = snapshotTool(html, request.params?.name, request.params?.arguments ?? {});
        reply({ content: [{ type: 'text', text: JSON.stringify(value) }] });
      } catch {
        reply({ isError: true, content: [{ type: 'text', text: 'Unknown tool or invalid arguments. Only read_html and find_in_html are available for the fixed snapshot.' }] });
      }
    } else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveSnapshot(process.argv[2]).catch(() => { process.stderr.write('HTML snapshot reader failed.\n'); process.exitCode = 1; });
}
