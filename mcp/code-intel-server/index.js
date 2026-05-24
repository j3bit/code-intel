#!/usr/bin/env node
import { callTool, tools } from './core.js';

function json(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(arg);
  }
  return out;
}

const cli = parseArgs(process.argv.slice(2));
if (cli['list-tools']) {
  json({ tools });
  process.exit(0);
}
if (cli['call-tool']) {
  const args = cli.args ? JSON.parse(cli.args) : {};
  json(await callTool(cli['call-tool'], args));
  process.exit(0);
}

const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
}

function result(id, value) { return { jsonrpc: '2.0', id, result: value }; }
function error(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handle(msg) {
  if (msg.method === 'initialize') {
    return result(msg.id, {
      protocolVersion: negotiateProtocolVersion(msg.params?.protocolVersion),
      capabilities: { tools: {} },
      serverInfo: { name: 'code-intel', version: '0.1.0' }
    });
  }
  if (msg.method === 'notifications/initialized') return null;
  if (msg.method === 'tools/list') return result(msg.id, { tools });
  if (msg.method === 'tools/call') {
    try {
      const value = await callTool(msg.params?.name, msg.params?.arguments || {});
      return result(msg.id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value });
    } catch (err) {
      return error(msg.id, -32000, err.message);
    }
  }
  return error(msg.id, -32601, `method not found: ${msg.method}`);
}

let buffer = Buffer.alloc(0);
let framedMode = null;

function sendMessage(response) {
  if (!response) return;
  const payload = JSON.stringify(response);
  if (framedMode) process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
  else process.stdout.write(payload + '\n');
}

async function processJsonLine(line) {
  if (!line.trim()) return;
  try { sendMessage(await handle(JSON.parse(line))); }
  catch (err) { sendMessage(error(null, -32700, err.message)); }
}

async function processBuffer() {
  while (buffer.length) {
    if (framedMode === null) {
      const text = buffer.toString('utf8', 0, Math.min(buffer.length, 32));
      if (/^Content-Length:/i.test(text)) framedMode = true;
      else {
        const headerPrefix = 'Content-Length:';
        if (headerPrefix.toLowerCase().startsWith(text.toLowerCase())) return;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        framedMode = false;
      }
    }
    if (framedMode) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buffer.toString('utf8', 0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        sendMessage(error(null, -32700, 'missing Content-Length header'));
        buffer = Buffer.alloc(0);
        return;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.toString('utf8', start, start + length);
      buffer = buffer.subarray(start + length);
      try { sendMessage(await handle(JSON.parse(body))); }
      catch (err) { sendMessage(error(null, -32700, err.message)); }
    } else {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.toString('utf8', 0, newline);
      buffer = buffer.subarray(newline + 1);
      await processJsonLine(line);
    }
  }
}

process.stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  await processBuffer();
});
process.stdin.on('end', async () => {
  if (buffer.length && framedMode !== true) await processJsonLine(buffer.toString('utf8'));
});
