#!/usr/bin/env node
import { callTool, tools } from './tools.js';
import { LspSessionManager } from './lsp-session-manager.js';
import { PLUGIN_VERSION } from './settings.js';

const SERVER_INSTRUCTIONS = 'Use Code Intel silently for structural or semantic code work. Prefer verified LSP methods for semantic tasks, ast-grep for structural patterns, and rg/grep when needed. Do not narrate routing or routine fallback; disclose only material loss of coverage or confidence.';

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
const lspSessionManager = new LspSessionManager();
const runtime = { lspSessionManager };

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
}

function result(id, value) { return { jsonrpc: '2.0', id, result: value }; }
function error(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function toolResultSummary(name, value) {
  const status = value?.status || 'ok';
  if (Number.isInteger(value?.totalItems) && Number.isInteger(value?.returnedItems)) {
    const page = `${value.returnedItems}/${value.totalItems} results`;
    return `${name}: ${status}; ${page}${value.nextCursor ? '; more pages available' : ''}`;
  }
  return `${name}: ${status}`;
}

async function handle(msg) {
  if (msg.method === 'initialize') {
    return result(msg.id, {
      protocolVersion: negotiateProtocolVersion(msg.params?.protocolVersion),
      capabilities: { tools: {} },
      serverInfo: { name: 'code-intel', version: PLUGIN_VERSION },
      instructions: SERVER_INSTRUCTIONS
    });
  }
  if (msg.method === 'notifications/initialized') return null;
  if (msg.method === 'tools/list') return result(msg.id, { tools });
  if (msg.method === 'tools/call') {
    try {
      const value = await callTool(msg.params?.name, msg.params?.arguments || {}, runtime);
      return result(msg.id, {
        content: [{ type: 'text', text: toolResultSummary(msg.params?.name, value) }],
        structuredContent: value
      });
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

let processing = Promise.resolve();

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processing = processing.then(processBuffer).catch((err) => {
    sendMessage(error(null, -32603, err.message));
  });
});
process.stdin.on('end', () => {
  processing = processing.then(async () => {
    if (buffer.length && framedMode !== true) await processJsonLine(buffer.toString('utf8'));
    await lspSessionManager.shutdownAll();
  });
});

async function shutdownForSignal(code) {
  await processing.catch(() => {});
  await lspSessionManager.shutdownAll();
  process.exit(code);
}

process.once('SIGINT', () => { void shutdownForSignal(130); });
process.once('SIGTERM', () => { void shutdownForSignal(143); });
