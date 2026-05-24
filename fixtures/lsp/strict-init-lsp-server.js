#!/usr/bin/env node
let buffer = Buffer.alloc(0);
let initialized = false;
let initializeResponseSent = false;
let violated = false;

function frame(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function parseMessages() {
  const messages = [];
  while (buffer.length) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.toString('utf8', 0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = Buffer.alloc(0);
      break;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) break;
    const body = buffer.toString('utf8', start, start + length);
    buffer = buffer.subarray(start + length);
    messages.push(JSON.parse(body));
  }
  return messages;
}

function range(startLine, startCharacter, endLine, endCharacter) {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

function rejectPremature(message) {
  violated = true;
  if (message.id !== undefined) {
    frame({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'ServerNotInitialized' } });
  }
}

function handle(message) {
  if (message.method === 'initialize') {
    setTimeout(() => {
      initializeResponseSent = true;
      frame({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          capabilities: {
            documentSymbolProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: { prepareProvider: true },
            diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false }
          },
          serverInfo: { name: 'code-intel-strict-init-lsp', version: '1.0.0' }
        }
      });
    }, 50);
    return;
  }
  if (!initializeResponseSent) {
    rejectPremature(message);
    return;
  }
  if (message.method === 'initialized') {
    initialized = true;
    return;
  }
  if (!initialized && message.method !== 'shutdown' && message.method !== 'exit') {
    rejectPremature(message);
    return;
  }
  if (message.method === 'textDocument/didOpen') return;
  if (message.method === 'textDocument/documentSymbol') {
    frame({ jsonrpc: '2.0', id: message.id, result: [{ name: 'add', kind: 12, range: range(0, 0, 0, 3), selectionRange: range(0, 0, 0, 3) }] });
    return;
  }
  if (message.method === 'shutdown') {
    frame({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'exit') process.exit(violated ? 2 : 0);
  if (message.id !== undefined) frame({ jsonrpc: '2.0', id: message.id, result: null });
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (const message of parseMessages()) handle(message);
});

process.stdin.on('end', () => process.exit(violated ? 2 : 0));
