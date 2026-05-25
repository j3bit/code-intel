import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLUGIN_VERSION, loadSettings, splitCommandLine } from './settings.js';
import { resolveRepoRelativeFile } from './repo.js';
import {
  envWithExtraPathDirs,
  findLspCommand,
  languageConfigForFile,
  languageConfigForLanguage,
  runtimeFallbackUsed
} from './capabilities.js';

export function lspUnavailable(method, args = {}, reason = 'no LSP server command detected', extra = {}) {
  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const settings = extra.settings || loadSettings(repoRoot);
  const resolved = args.language
    ? languageConfigForLanguage(args.language, settings)
    : args.file
      ? languageConfigForFile(path.resolve(repoRoot, args.file), settings)
      : { language: null, config: null };
  return {
    status: 'unavailable',
    method,
    language: resolved.language || args.language || null,
    command: null,
    stderrSummary: '',
    degradedCapability: method,
    fallbackUsed: runtimeFallbackUsed(resolved.config, settings, repoRoot),
    fallbackReason: reason,
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'settings'))
  };
}

export function lspFrame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

export function parseLspFrames(stdout = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''), 'utf8');
  const messages = [];
  let offset = 0;
  while (offset < data.length) {
    const remaining = data.toString('utf8', offset);
    const headerStart = remaining.search(/Content-Length:/i);
    if (headerStart < 0) break;
    offset += headerStart;
    const headerEnd = data.indexOf('\r\n\r\n', offset);
    if (headerEnd < 0) break;
    const header = data.toString('utf8', offset, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      offset = headerEnd + 4;
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (data.length < bodyEnd) break;
    const body = data.toString('utf8', bodyStart, bodyEnd);
    try { messages.push(JSON.parse(body)); } catch {}
    offset = bodyEnd;
  }
  return messages;
}

export function readLspMessagesFromBuffer(state) {
  const messages = [];
  while (state.buffer.length) {
    const headerStart = state.buffer.toString('utf8', 0, Math.min(state.buffer.length, 128)).search(/Content-Length:/i);
    if (headerStart > 0) state.buffer = state.buffer.subarray(headerStart);
    const headerEnd = state.buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = state.buffer.toString('utf8', 0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      state.buffer = state.buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (state.buffer.length < bodyEnd) break;
    const body = state.buffer.toString('utf8', bodyStart, bodyEnd);
    state.buffer = state.buffer.subarray(bodyEnd);
    try { messages.push(JSON.parse(body)); } catch {}
  }
  return messages;
}

export function waitForLspMessage(state, predicate, timeoutMs) {
  const existing = state.messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for LSP response'));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      state.process.stdout.off('data', onData);
      state.process.off('exit', onExit);
      state.process.off('error', onError);
    }
    function inspect(chunk) {
      if (chunk) state.buffer = Buffer.concat([state.buffer, chunk]);
      for (const message of readLspMessagesFromBuffer(state)) {
        state.messages.push(message);
        if (predicate(message)) {
          cleanup();
          resolve(message);
          return;
        }
      }
    }
    function onData(chunk) { inspect(chunk); }
    function onExit(code) {
      cleanup();
      reject(new Error(`LSP process exited before response: ${code}`));
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    state.process.stdout.on('data', onData);
    state.process.on('exit', onExit);
    state.process.on('error', onError);
    inspect();
  });
}

export function lspParams(method, uri, args = {}) {
  const textDocument = { uri };
  const position = args.position || { line: 0, character: 0 };
  switch (method) {
    case 'textDocument/diagnostic':
      return { textDocument, previousResultId: null };
    case 'textDocument/documentSymbol':
      return { textDocument };
    case 'textDocument/definition':
      return { textDocument, position };
    case 'textDocument/references':
      return { textDocument, position, context: { includeDeclaration: true } };
    case 'textDocument/prepareRename':
      return { textDocument, position };
    case 'textDocument/rename':
      return { textDocument, position, newName: args.newName || args.symbol || 'renamedSymbol' };
    default:
      return { textDocument, position };
  }
}

export async function runLspRequestAsync(commandLine, languageRuntime, method, args = {}) {
  const resolved = resolveRepoRelativeFile(args.repoRoot || process.cwd(), args.file);
  if (!resolved.ok) return lspUnavailable(method, { ...args, language: languageRuntime.language }, resolved.reason);
  const { repoRoot, filePath } = resolved;
  if (!fs.existsSync(filePath)) return lspUnavailable(method, { ...args, language: languageRuntime.language }, `file not found: ${args.file}`);
  const commandParts = splitCommandLine(commandLine);
  if (!commandParts.length) return lspUnavailable(method, { ...args, language: languageRuntime.language }, 'LSP command candidate is empty');

  const uri = pathToFileURL(filePath).href;
  const text = fs.readFileSync(filePath, 'utf8');
  const timeoutMs = args.timeoutMs || 10000;
  const child = spawn(commandParts[0], commandParts.slice(1), { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { process: child, buffer: Buffer.alloc(0), messages: [], stderr: Buffer.alloc(0) };
  child.stderr.on('data', (chunk) => { state.stderr = Buffer.concat([state.stderr, chunk]); });

  function write(message) { child.stdin.write(lspFrame(message)); }

  try {
    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: pathToFileURL(repoRoot).href,
        workspaceFolders: [{ uri: pathToFileURL(repoRoot).href, name: path.basename(repoRoot) }],
        capabilities: {
          textDocument: {
            documentSymbol: {},
            definition: {},
            references: {},
            rename: { prepareSupport: true },
            diagnostic: {}
          }
        },
        clientInfo: { name: 'code-intel', version: PLUGIN_VERSION }
      }
    });
    const initialize = await waitForLspMessage(state, (message) => message.id === 1, timeoutMs);
    if (initialize?.error) throw Object.assign(new Error('LSP initialize failed'), { lspError: initialize.error });

    write({ jsonrpc: '2.0', method: 'initialized', params: {} });
    write({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: languageRuntime.language, version: 1, text } } });
    write({ jsonrpc: '2.0', id: 2, method, params: lspParams(method, uri, args) });
    const response = await waitForLspMessage(state, (message) => message.id === 2, timeoutMs);

    write({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: null });
    await waitForLspMessage(state, (message) => message.id === 3, Math.min(timeoutMs, 3000)).catch(() => null);
    write({ jsonrpc: '2.0', method: 'exit', params: null });
    child.stdin.end();

    if (response?.error) {
      return {
        status: 'error',
        method,
        language: languageRuntime.language,
        command: commandLine,
        error: response.error,
        stderrSummary: state.stderr.toString('utf8').trim().slice(0, 1000),
        fallbackUsed: runtimeFallbackUsed(languageRuntime, args.settings || null, args.repoRoot || process.cwd()),
        fallbackReason: 'LSP server returned an error'
      };
    }
    if (response && Object.prototype.hasOwnProperty.call(response, 'result')) {
      const methodCapability = method.split('/').pop();
      return {
        status: 'ok',
        method,
        language: languageRuntime.language,
        command: commandLine,
        serverInfo: initialize?.result?.serverInfo || null,
        lspState: 'methodVerified',
        methodVerified: methodCapability,
        result: response.result,
        previewOnly: method === 'textDocument/rename' ? true : undefined,
        mutated: method === 'textDocument/rename' ? false : undefined,
        degradedCapability: null,
        fallbackUsed: null,
        fallbackReason: null
      };
    }
    return lspUnavailable(method, { ...args, language: languageRuntime.language }, 'LSP server did not return a response for the requested method', {
      command: commandLine,
      stderrSummary: state.stderr.toString('utf8').trim().slice(0, 1000),
      parsedMessages: state.messages.length
    });
  } catch (error) {
    child.kill();
    return lspUnavailable(method, { ...args, language: languageRuntime.language }, error.lspError ? 'LSP initialize failed' : 'LSP server did not return a response for the requested method', {
      command: commandLine,
      error: error.lspError || { message: error.message },
      stderrSummary: state.stderr.toString('utf8').trim().slice(0, 1000),
      parsedMessages: state.messages.length
    });
  }
}

export function runLspRequest(commandLine, languageRuntime, method, args = {}) {
  const workerArgs = {
    ...args,
    repoRoot: args.repoRoot ? path.resolve(args.repoRoot) : undefined
  };
  const worker = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--run-lsp-request-json'], {
    cwd: workerArgs.repoRoot || process.cwd(),
    input: JSON.stringify({ commandLine, languageRuntime, method, args: workerArgs }),
    encoding: 'utf8',
    timeout: (workerArgs.timeoutMs || 10000) + 5000,
    maxBuffer: 10 * 1024 * 1024,
    env: envWithExtraPathDirs(process.env, workerArgs.settingsPathExtraDirs, workerArgs.repoRoot || process.cwd())
  });
  if (worker.status === 0 && worker.stdout) {
    try { return JSON.parse(worker.stdout); } catch {}
  }
  return lspUnavailable(method, { ...args, language: languageRuntime.language }, 'LSP server did not return a response for the requested method', {
    command: commandLine,
    statusCode: worker.status,
    stderrSummary: (worker.stderr || worker.error?.message || '').trim().slice(0, 1000)
  });
}

export function lspTool(method, args = {}) {
  const { language, config, command, settings } = findLspCommand(args);
  if (!config) return lspUnavailable(method, args, 'unsupported language or file extension', { settings });
  const languageRuntime = { language, ...config };
  if (!command) return lspUnavailable(method, { ...args, language }, 'LSP command missing', { settings });
  return runLspRequest(command, languageRuntime, method, { ...args, settings: { astGrep: settings.astGrep, path: settings.path }, settingsPathExtraDirs: settings.path.extraDirs });
}

export function lspDiagnosticsForFile(repoRoot, file, settings, timeoutMs) {
  const resolved = languageConfigForFile(path.resolve(repoRoot, file), settings);
  if (!resolved.config) {
    return { file, status: 'unavailable', language: null, fallbackReason: 'unsupported language or file extension' };
  }
  const result = lspTool('textDocument/diagnostic', { repoRoot, file, language: resolved.language, timeoutMs });
  return {
    file,
    language: resolved.language,
    status: result.status,
    method: result.method || 'textDocument/diagnostic',
    result: result.result || null,
    fallbackUsed: result.fallbackUsed || null,
    fallbackReason: result.fallbackReason || null,
    stderrSummary: result.stderrSummary || ''
  };
}

export async function runLspWorkerCli() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { commandLine, languageRuntime, method, args } = JSON.parse(input || '{}');
  const result = await runLspRequestAsync(commandLine, languageRuntime, method, args || {});
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--run-lsp-request-json')) {
  runLspWorkerCli().then(() => process.exit(0), (error) => {
    process.stdout.write(JSON.stringify({ status: 'unavailable', fallbackReason: error.message }));
    process.exit(1);
  });
}
