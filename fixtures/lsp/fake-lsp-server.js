#!/usr/bin/env node
let buffer = Buffer.alloc(0);

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

function resultFor(method, params) {
  if (method === 'initialize') {
    return {
      capabilities: {
        documentSymbolProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: { prepareProvider: true },
        diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false }
      },
      serverInfo: { name: 'code-intel-fake-lsp', version: '1.0.0' }
    };
  }
  if (method === 'textDocument/documentSymbol') {
    return [{ name: 'add', kind: 12, range: range(0, 0, 0, 3), selectionRange: range(0, 0, 0, 3) }];
  }
  if (method === 'textDocument/definition') return [{ uri: params.textDocument.uri, range: range(0, 0, 0, 3) }];
  if (method === 'textDocument/references') return [{ uri: params.textDocument.uri, range: range(4, 14, 4, 17) }];
  if (method === 'textDocument/prepareRename') return { range: range(0, 0, 0, 3), placeholder: 'add' };
  if (method === 'textDocument/rename') {
    return { changes: { [params.textDocument.uri]: [{ range: range(0, 0, 0, 3), newText: params.newName || 'renamed' }] } };
  }
  if (method === 'textDocument/diagnostic') return { kind: 'full', items: [] };
  if (method === 'shutdown') return null;
  return null;
}

function range(startLine, startCharacter, endLine, endCharacter) {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (const message of parseMessages()) {
    if (message.id !== undefined) frame({ jsonrpc: '2.0', id: message.id, result: resultFor(message.method, message.params || {}) });
    if (message.method === 'exit') process.exit(0);
  }
});

process.stdin.on('end', () => process.exit(0));
