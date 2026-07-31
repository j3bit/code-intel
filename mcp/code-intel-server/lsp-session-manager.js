import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  envWithExtraPathDirs,
  executableOnPath,
  findLspCommand,
  languageConfigForFile,
  runtimeFallbackUsed
} from './capabilities.js';
import {
  lspFrame,
  lspParams,
  lspUnavailable,
  readLspMessagesFromBuffer
} from './lsp.js';
import { LspDiagnosticsBroker } from './lsp-diagnostics.js';
import { resolveRepoRelativeFile } from './repo.js';
import { PLUGIN_VERSION, splitCommandLine } from './settings.js';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_NOTIFICATIONS = 200;

class LspSessionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LspSessionError';
    this.retryable = options.retryable === true;
    this.lspError = options.lspError || null;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function sessionDescriptor(commandLine, languageRuntime, args, baseEnv) {
  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const commandParts = splitCommandLine(commandLine);
  if (!commandParts.length) {
    throw new LspSessionError('LSP command candidate is empty');
  }
  const pathSettings = { path: { extraDirs: args.settingsPathExtraDirs || [] } };
  const executable = executableOnPath(commandParts[0], repoRoot, pathSettings).path || commandParts[0];
  const argv = [executable, ...commandParts.slice(1)];
  const initializationOptions = args.initializationOptions || null;
  const key = JSON.stringify(stableValue({
    repoRoot,
    argv,
    language: languageRuntime.language,
    initializationOptions
  }));
  return {
    key,
    repoRoot,
    argv,
    language: languageRuntime.language,
    initializationOptions,
    env: envWithExtraPathDirs(baseEnv, args.settingsPathExtraDirs, repoRoot)
  };
}

class LspSession {
  constructor(descriptor, manager) {
    this.descriptor = descriptor;
    this.manager = manager;
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.protocolErrors = [];
    this.stderr = Buffer.alloc(0);
    this.pending = new Map();
    this.notifications = [];
    this.diagnostics = new LspDiagnosticsBroker();
    this.openDocuments = new Map();
    this.nextRequestId = 1;
    this.initializeResult = null;
    this.startPromise = null;
    this.closed = false;
    this.closing = false;
    this.idleTimer = null;
  }

  async start(timeoutMs) {
    const [command, ...args] = this.descriptor.argv;
    this.process = spawn(command, args, {
      cwd: this.descriptor.repoRoot,
      env: this.descriptor.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process.stdout.on('data', (chunk) => this.onData(chunk));
    this.process.stderr.on('data', (chunk) => {
      this.stderr = Buffer.concat([this.stderr, chunk]);
      if (this.stderr.length > MAX_STDERR_BYTES) {
        this.stderr = this.stderr.subarray(-MAX_STDERR_BYTES);
      }
    });
    this.process.on('error', (error) => {
      this.fail(new LspSessionError(error.message, { retryable: true }));
    });
    this.process.on('exit', (code, signal) => {
      if (this.closing) return;
      const suffix = signal ? `signal ${signal}` : `code ${code}`;
      this.fail(new LspSessionError(`LSP process exited with ${suffix}`, { retryable: true }));
    });

    const initialize = await this.sendRequest('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.descriptor.repoRoot).href,
      workspaceFolders: [{
        uri: pathToFileURL(this.descriptor.repoRoot).href,
        name: path.basename(this.descriptor.repoRoot)
      }],
      capabilities: {
        textDocument: {
          documentSymbol: {},
          definition: {},
          references: {},
          rename: { prepareSupport: true },
          diagnostic: {}
        }
      },
      initializationOptions: this.descriptor.initializationOptions,
      clientInfo: { name: 'code-intel', version: PLUGIN_VERSION }
    }, timeoutMs);
    if (initialize.error) {
      throw new LspSessionError('LSP initialize failed', { lspError: initialize.error });
    }
    this.initializeResult = initialize.result || {};
    this.sendNotification('initialized', {});
    this.touch();
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const errorCount = this.protocolErrors.length;
    for (const message of readLspMessagesFromBuffer(this)) {
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
        this.touch();
      } else if (message.method) {
        if (message.method === 'textDocument/publishDiagnostics') {
          this.diagnostics.publish(message.params);
        }
        this.notifications.push(message);
        if (this.notifications.length > MAX_NOTIFICATIONS) {
          this.notifications.shift();
        }
      }
    }
    if (this.protocolErrors.length > errorCount) {
      this.fail(new LspSessionError('LSP server returned invalid JSON-RPC', { retryable: true }));
    }
  }

  send(message) {
    if (!this.process || this.closed || !this.process.stdin.writable) {
      throw new LspSessionError('LSP process is not writable', { retryable: true });
    }
    this.process.stdin.write(lspFrame(message));
  }

  sendNotification(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
    this.touch();
  }

  sendRequest(method, params, timeoutMs) {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspSessionError(`timed out waiting for LSP response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
        this.touch();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  ensureDocument(uri, text, language) {
    const current = this.openDocuments.get(uri);
    if (!current) {
      const document = { version: 1, text };
      this.openDocuments.set(uri, document);
      this.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: language, version: document.version, text }
      });
      return document.version;
    }
    if (current.text !== text) {
      current.version += 1;
      current.text = text;
      this.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: current.version },
        contentChanges: [{ text }]
      });
    }
    return current.version;
  }

  async requestForFile(method, filePath, args) {
    const uri = pathToFileURL(filePath).href;
    const text = fs.readFileSync(filePath, 'utf8');
    const documentVersion = this.ensureDocument(uri, text, this.descriptor.language);
    const response = await this.sendRequest(method, lspParams(method, uri, args), args.timeoutMs || 10000);
    return { response, documentVersion };
  }

  async diagnosticsForFile(filePath, args) {
    const uri = pathToFileURL(filePath).href;
    const text = fs.readFileSync(filePath, 'utf8');
    const documentVersion = this.ensureDocument(uri, text, this.descriptor.language);
    if (this.initializeResult?.capabilities?.diagnosticProvider) {
      const response = await this.sendRequest(
        'textDocument/diagnostic',
        lspParams('textDocument/diagnostic', uri, args),
        args.timeoutMs || 10000
      );
      return {
        response,
        documentVersion,
        transport: 'pull',
        collectedAt: new Date().toISOString(),
        stale: false
      };
    }
    const settleMs = Math.min(
      args.timeoutMs || 10000,
      args.diagnosticSettleMs ?? 750
    );
    clearTimeout(this.idleTimer);
    const published = await this.diagnostics.waitFor(uri, documentVersion, settleMs);
    this.touch();
    if (!published) {
      const latest = this.diagnostics.latest(uri);
      return {
        response: null,
        documentVersion,
        transport: 'push',
        collectedAt: latest?.collectedAt || null,
        stale: Boolean(
          latest &&
          latest.version !== null &&
          latest.version < documentVersion
        ),
        diagnosticsTimedOut: true
      };
    }
    return {
      response: {
        result: { kind: 'full', items: published.diagnostics }
      },
      documentVersion,
      transport: 'push',
      collectedAt: published.collectedAt,
      stale: published.version !== null && published.version < documentVersion
    };
  }

  touch() {
    if (!this.manager.idleTimeoutMs || this.closed || this.closing) return;
    clearTimeout(this.idleTimer);
    if (this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      void this.manager.closeIdleSession(this);
    }, this.manager.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.diagnostics.abort(error);
    this.manager.remove(this);
  }

  waitForExit(timeoutMs) {
    if (!this.process || this.process.exitCode !== null || this.process.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.process.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.process.once('exit', onExit);
    });
  }

  async close(timeoutMs = 3000) {
    if (this.closed || this.closing) return;
    this.closing = true;
    clearTimeout(this.idleTimer);
    for (const uri of this.openDocuments.keys()) {
      try {
        this.send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
      } catch {}
      this.diagnostics.clear(uri);
    }
    this.openDocuments.clear();
    this.diagnostics.clearAll();
    try {
      await this.sendRequest('shutdown', null, timeoutMs);
      this.send({ jsonrpc: '2.0', method: 'exit', params: null });
      this.process.stdin.end();
    } catch {
      this.process?.kill();
    }
    let exited = await this.waitForExit(Math.min(timeoutMs, 1000));
    if (!exited) {
      this.process?.kill();
      exited = await this.waitForExit(1000);
    }
    if (!exited) {
      this.process?.kill('SIGKILL');
      await this.waitForExit(1000);
    }
    this.closed = true;
    this.manager.remove(this);
  }

  stderrSummary() {
    return this.stderr.toString('utf8').trim().slice(0, 1000);
  }
}

export class LspSessionManager {
  constructor(options = {}) {
    const configuredIdleTimeout = Number(
      options.idleTimeoutMs ?? process.env.CODE_INTEL_LSP_IDLE_TIMEOUT_MS
    );
    this.idleTimeoutMs = Number.isFinite(configuredIdleTimeout) && configuredIdleTimeout >= 0
      ? configuredIdleTimeout
      : DEFAULT_IDLE_TIMEOUT_MS;
    this.env = options.env || process.env;
    this.sessions = new Map();
  }

  remove(session) {
    if (this.sessions.get(session.descriptor.key) === session) {
      this.sessions.delete(session.descriptor.key);
    }
  }

  async getSession(descriptor, timeoutMs) {
    const existing = this.sessions.get(descriptor.key);
    if (existing && !existing.closed && !existing.closing) {
      await existing.startPromise;
      existing.touch();
      return { session: existing, reused: true };
    }
    const session = new LspSession(descriptor, this);
    this.sessions.set(descriptor.key, session);
    session.startPromise = session.start(timeoutMs);
    try {
      await session.startPromise;
      return { session, reused: false };
    } catch (error) {
      this.remove(session);
      await session.close().catch(() => {});
      throw error;
    }
  }

  async run(commandLine, languageRuntime, args, operation) {
    const resolved = resolveRepoRelativeFile(args.repoRoot || process.cwd(), args.file);
    if (!resolved.ok) {
      throw new LspSessionError(resolved.reason);
    }
    if (!fs.existsSync(resolved.filePath)) {
      throw new LspSessionError(`file not found: ${args.file}`);
    }
    const descriptor = sessionDescriptor(commandLine, languageRuntime, args, this.env);
    let restarted = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let session;
      try {
        const acquired = await this.getSession(descriptor, args.timeoutMs || 10000);
        session = acquired.session;
        const result = await operation(session, resolved.filePath);
        return {
          ...result,
          initializeResult: session.initializeResult,
          stderrSummary: session.stderrSummary(),
          sessionReused: acquired.reused,
          restarted
        };
      } catch (error) {
        if (session) {
          session.process?.kill();
          session.fail(error);
        }
        if (!error.retryable || attempt > 0) throw error;
        restarted = true;
      }
    }
    throw new LspSessionError('LSP request failed after restart');
  }

  request(commandLine, languageRuntime, method, args) {
    return this.run(
      commandLine,
      languageRuntime,
      args,
      (session, filePath) => session.requestForFile(method, filePath, args)
    );
  }

  diagnosticsForFile(commandLine, languageRuntime, args) {
    return this.run(
      commandLine,
      languageRuntime,
      args,
      (session, filePath) => session.diagnosticsForFile(filePath, args)
    );
  }

  async closeIdleSession(session) {
    if (this.sessions.get(session.descriptor.key) !== session) return;
    await session.close();
  }

  async shutdownAll() {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => session.close()));
  }
}

export async function lspToolWithSession(manager, method, args = {}) {
  const { language, config, command, settings } = findLspCommand(args, args.settingsOverride || null);
  if (!config) return lspUnavailable(method, args, 'unsupported language or file extension', { settings });
  const languageRuntime = { language, ...config };
  if (!command) return lspUnavailable(method, { ...args, language }, 'LSP command missing', { settings });
  try {
    const requestArgs = {
      ...args,
      settings: { astGrep: settings.astGrep, path: settings.path },
      settingsPathExtraDirs: settings.path.extraDirs
    };
    const result = method === 'textDocument/diagnostic'
      ? await manager.diagnosticsForFile(command, languageRuntime, requestArgs)
      : await manager.request(command, languageRuntime, method, requestArgs);
    if (result.diagnosticsTimedOut) {
      return lspUnavailable(
        method,
        { ...args, language },
        'timed out waiting for push diagnostics',
        {
          command,
          transport: result.transport,
          documentVersion: result.documentVersion,
          collectedAt: result.collectedAt,
          stale: result.stale,
          settings
        }
      );
    }
    if (result.response?.error) {
      return {
        status: 'error',
        method,
        language,
        command,
        error: result.response.error,
        stderrSummary: result.stderrSummary,
        fallbackUsed: runtimeFallbackUsed(config, settings, args.repoRoot || process.cwd()),
        fallbackReason: 'LSP server returned an error',
        sessionReused: result.sessionReused,
        restarted: result.restarted,
        transport: result.transport,
        documentVersion: result.documentVersion,
        collectedAt: result.collectedAt,
        stale: result.stale
      };
    }
    if (result.response && Object.prototype.hasOwnProperty.call(result.response, 'result')) {
      return {
        status: 'ok',
        method,
        language,
        command,
        serverInfo: result.initializeResult?.serverInfo || null,
        serverCapabilities: result.initializeResult?.capabilities || {},
        lspState: 'methodVerified',
        methodVerified: method.split('/').pop(),
        result: result.response.result,
        documentVersion: result.documentVersion,
        sessionReused: result.sessionReused,
        restarted: result.restarted,
        transport: result.transport,
        collectedAt: result.collectedAt,
        stale: result.stale,
        previewOnly: method === 'textDocument/rename' ? true : undefined,
        mutated: method === 'textDocument/rename' ? false : undefined,
        degradedCapability: null,
        fallbackUsed: null,
        fallbackReason: null
      };
    }
    return lspUnavailable(method, { ...args, language }, 'LSP server did not return a response for the requested method', {
      command,
      stderrSummary: result.stderrSummary
    });
  } catch (error) {
    return lspUnavailable(
      method,
      { ...args, language },
      error.lspError ? 'LSP initialize failed' : error.message,
      {
        command,
        error: error.lspError || { message: error.message },
        settings
      }
    );
  }
}

export async function lspDiagnosticsForFileWithSession(manager, repoRoot, file, settings, timeoutMs) {
  const resolved = languageConfigForFile(path.resolve(repoRoot, file), settings);
  if (!resolved.config) {
    return {
      file,
      status: 'unavailable',
      language: null,
      fallbackReason: 'unsupported language or file extension'
    };
  }
  const result = await lspToolWithSession(manager, 'textDocument/diagnostic', {
    repoRoot,
    file,
    language: resolved.language,
    timeoutMs,
    settingsOverride: settings
  });
  return {
    file,
    language: resolved.language,
    status: result.status,
    method: result.method || 'textDocument/diagnostic',
    result: result.result || null,
    fallbackUsed: result.fallbackUsed || null,
    fallbackReason: result.fallbackReason || null,
    stderrSummary: result.stderrSummary || '',
    transport: result.transport || null,
    documentVersion: result.documentVersion || null,
    collectedAt: result.collectedAt || null,
    stale: result.stale ?? null
  };
}
