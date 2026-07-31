#!/usr/bin/env node
import fs from 'node:fs';

let buffer = Buffer.alloc(0);
let sequence = 0;
const traceFile = process.env.CODE_INTEL_LSP_TRACE_FILE || '';
const documents = new Map();

function trace(event, details = {}) {
  if (!traceFile) return;
  fs.appendFileSync(traceFile, `${JSON.stringify({ pid: process.pid, sequence: sequence += 1, event, ...details })}\n`);
}

function frame(message) {
  trace('send', {
    id: message.id ?? null,
    method: message.method || null,
    errorCode: message.error?.code ?? null
  });
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
    return [
      {
        name: 'Calculator',
        kind: 5,
        range: range(0, 0, 4, 1),
        selectionRange: range(0, 13, 0, 23),
        children: [
          {
            name: 'add',
            kind: 6,
            range: range(1, 2, 3, 3),
            selectionRange: range(1, 2, 1, 5)
          }
        ]
      },
      {
        name: 'add',
        kind: 12,
        range: range(6, 0, 8, 1),
        selectionRange: range(6, 16, 6, 19)
      },
      {
        name: 'total',
        kind: 13,
        range: range(10, 0, 10, 24),
        selectionRange: range(10, 6, 10, 11)
      }
    ];
  }
  if (method === 'textDocument/definition') {
    return [{ uri: params.textDocument.uri, range: range(6, 16, 6, 19) }];
  }
  if (method === 'textDocument/references') {
    return [
      { uri: params.textDocument.uri, range: range(6, 16, 6, 19) },
      { uri: params.textDocument.uri, range: range(10, 14, 10, 17) }
    ];
  }
  if (method === 'textDocument/prepareRename') {
    return { range: range(10, 14, 10, 17), placeholder: 'add' };
  }
  if (method === 'textDocument/rename') {
    return {
      changes: {
        [params.textDocument.uri]: [
          { range: range(6, 16, 6, 19), newText: params.newName || 'renamed' },
          { range: range(10, 14, 10, 17), newText: params.newName || 'renamed' }
        ]
      }
    };
  }
  if (method === 'textDocument/diagnostic') return { kind: 'full', items: [fixtureDiagnostic()] };
  if (method === 'shutdown') return null;
  return null;
}

function fixtureDiagnostic() {
  return {
    range: range(11, 0, 11, 19),
    severity: 2,
    code: 'fixture-warning',
    source: 'code-intel-fixture',
    message: 'fixture diagnostic'
  };
}

function range(startLine, startCharacter, endLine, endCharacter) {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

function updateDocumentState(message) {
  const textDocument = message.params?.textDocument;
  if (message.method === 'textDocument/didOpen') {
    documents.set(textDocument.uri, { version: textDocument.version, text: textDocument.text });
    trace('document-open', { uri: textDocument.uri, version: textDocument.version, openDocuments: documents.size });
  }
  if (message.method === 'textDocument/didChange') {
    const current = documents.get(textDocument.uri) || {};
    const latestChange = message.params?.contentChanges?.at(-1);
    documents.set(textDocument.uri, {
      version: textDocument.version,
      text: latestChange?.text ?? current.text ?? ''
    });
    trace('document-change', { uri: textDocument.uri, version: textDocument.version, openDocuments: documents.size });
  }
  if (message.method === 'textDocument/didClose') {
    documents.delete(textDocument.uri);
    trace('document-close', { uri: textDocument.uri, openDocuments: documents.size });
  }
}

function handle(message) {
  trace('receive', {
    id: message.id ?? null,
    method: message.method || null,
    version: message.params?.textDocument?.version ?? null
  });
  if (message.method === process.env.CODE_INTEL_FAKE_CRASH_ON_METHOD) {
    trace('process-crash', { method: message.method, exitCode: 86 });
    process.exit(86);
  }
  updateDocumentState(message);
  if (message.method === 'textDocument/didOpen' && process.env.CODE_INTEL_FAKE_PUSH_DIAGNOSTICS === '1') {
    frame({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: message.params.textDocument.uri,
        version: message.params.textDocument.version,
        diagnostics: [fixtureDiagnostic()]
      }
    });
  }
  if (message.id !== undefined) {
    if (message.method === 'textDocument/diagnostic' && process.env.CODE_INTEL_FAKE_PULL_DIAGNOSTICS === 'unsupported') {
      frame({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    } else {
      frame({ jsonrpc: '2.0', id: message.id, result: resultFor(message.method, message.params || {}) });
    }
  }
  if (message.method === 'exit') {
    trace('process-exit');
    process.exit(0);
  }
}

trace('process-start');
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (const message of parseMessages()) handle(message);
});

process.stdin.on('end', () => {
  trace('process-end');
  process.exit(0);
});
