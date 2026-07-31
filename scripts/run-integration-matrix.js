#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  executableOnPath,
  lspToolWithSession,
  LspSessionManager,
  splitCommandLine
} from '../mcp/code-intel-server/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MATRIX = path.join(ROOT, 'integrations', 'real-server-matrix.json');
const DEFAULT_OUTPUT = path.join(
  ROOT,
  'artifacts',
  'code-intel-integration-matrix.json'
);

function parseArgs(argv) {
  const args = { matrix: DEFAULT_MATRIX, output: DEFAULT_OUTPUT, only: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--matrix') args.matrix = argv[index += 1];
    else if (value === '--output') args.output = argv[index += 1];
    else if (value === '--only') args.only.push(argv[index += 1]);
    else if (value === '--json') args.json = true;
  }
  return args;
}

function resolveCommand(entry) {
  const override = entry.commandEnv ? process.env[entry.commandEnv] : null;
  if (override) {
    const [command, ...overrideArgs] = splitCommandLine(override);
    return {
      command,
      args: overrideArgs.length ? overrideArgs : entry.args || [],
      source: `env:${entry.commandEnv}`
    };
  }
  return { command: entry.command, args: entry.args || [], source: 'matrix' };
}

function detectedVersion(executablePath, entry) {
  const realPath = (() => {
    try { return fs.realpathSync(executablePath); }
    catch { return executablePath; }
  })();
  if (entry.versionArgs?.length) {
    const probe = spawnSync(executablePath, entry.versionArgs, {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    const output = `${probe.stdout || ''}\n${probe.stderr || ''}`.trim();
    if (probe.status === 0 && output) {
      return { version: output.split(/\r?\n/, 1)[0].slice(0, 300), source: 'command' };
    }
  }
  const versionSegment = realPath.split(path.sep).find((segment) =>
    /^v?\d+\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(segment)
  );
  return {
    version: versionSegment || null,
    source: versionSegment ? 'resolved-path' : 'unavailable'
  };
}

function resultSummary(result) {
  const serialized = JSON.stringify(result?.result ?? null);
  const value = result?.result;
  const itemCount = Array.isArray(value)
    ? value.length
    : Array.isArray(value?.items)
      ? value.items.length
      : Array.isArray(value?.data)
        ? Math.floor(value.data.length / 5)
        : value === null || value === undefined
          ? 0
          : 1;
  return {
    status: result?.status || 'error',
    methodVerified: result?.methodVerified || null,
    advertisedCapabilities: result?.advertisedCapabilities || [],
    verifiedCapabilities: result?.verifiedCapabilities || [],
    unsupportedCapabilities: result?.unsupportedCapabilities || [],
    resultShape: Array.isArray(value)
      ? 'array'
      : value === null
        ? 'null'
        : typeof value,
    itemCount,
    resultHash: createHash('sha256').update(serialized).digest('hex'),
    fallbackReason: result?.fallbackReason || null,
    error: result?.error || null
  };
}

function expectationMet(summary, expectation = {}) {
  if (summary.status !== 'ok') return false;
  if (expectation.resultShape && summary.resultShape !== expectation.resultShape) {
    return false;
  }
  if (expectation.minItems !== undefined && summary.itemCount < expectation.minItems) {
    return false;
  }
  return true;
}

async function runEntry(entry, matrixRoot) {
  const configured = resolveCommand(entry);
  const resolution = executableOnPath(configured.command, matrixRoot, {
    path: { extraDirs: entry.extraDirs || [] }
  });
  const base = {
    id: entry.id,
    language: entry.language,
    corpus: entry.corpus,
    command: [configured.command, ...configured.args].join(' '),
    commandSource: configured.source,
    executablePath: resolution.path || null,
    resolvedExecutablePath: null,
    version: null,
    versionSource: null,
    methods: []
  };
  if (!resolution.available) {
    return {
      ...base,
      status: 'skipped',
      skipReason: resolution.reason
    };
  }

  const version = detectedVersion(resolution.path, entry);
  const manager = new LspSessionManager({
    env: { ...process.env, ...(entry.env || {}) }
  });
  const settings = {
    version: 1,
    path: { extraDirs: entry.extraDirs || [] },
    astGrep: { command: 'ast-grep', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      [entry.language]: {
        extensions: [path.extname(entry.file) || '.txt'],
        astGrep: { languageId: entry.astGrepLanguageId || entry.language },
        lsp: {
          languageId: entry.languageId || entry.language,
          command: configured.command,
          args: configured.args,
          expectedCapabilities: entry.expectedCapabilities || []
        }
      }
    }
  };
  const methods = [];
  try {
    for (const method of entry.methods || []) {
      const result = await lspToolWithSession(manager, method.method, {
        repoRoot: matrixRoot,
        file: entry.file,
        language: entry.language,
        position: method.position || { line: 0, character: 0 },
        timeoutMs: method.timeoutMs || entry.timeoutMs || 10000,
        diagnosticSettleMs: method.diagnosticSettleMs ?? 1000,
        requireAdvertisedCapability: method.requireAdvertisedCapability === true,
        settingsOverride: settings
      });
      const summary = resultSummary(result);
      methods.push({
        name: method.name,
        method: method.method,
        expectation: method.expect || {},
        passed: expectationMet(summary, method.expect),
        ...summary
      });
    }
  } finally {
    await manager.shutdownAll();
  }
  const resolvedExecutablePath = (() => {
    try { return fs.realpathSync(resolution.path); }
    catch { return resolution.path; }
  })();
  return {
    ...base,
    status: methods.every((method) => method.passed) ? 'passed' : 'failed',
    executablePath: resolution.path,
    resolvedExecutablePath,
    version: version.version,
    versionSource: version.source,
    methods
  };
}

export async function runIntegrationMatrix(options = {}) {
  const matrixPath = path.resolve(options.matrix || DEFAULT_MATRIX);
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  const matrixDir = path.dirname(matrixPath);
  const matrixRoot = path.resolve(matrixDir, matrix.repoRoot || '.');
  const selected = (matrix.entries || []).filter((entry) =>
    !options.only?.length || options.only.includes(entry.id)
  );
  const entries = [];
  for (const entry of selected) entries.push(await runEntry(entry, matrixRoot));
  const failed = entries.filter((entry) => entry.status === 'failed').length;
  const passed = entries.filter((entry) => entry.status === 'passed').length;
  const skipped = entries.filter((entry) => entry.status === 'skipped').length;
  return {
    status: failed ? 'failed' : 'passed',
    generatedAt: new Date().toISOString(),
    matrixPath,
    matrixRoot,
    host: {
      platform: process.platform,
      architecture: process.arch,
      release: os.release(),
      node: process.version
    },
    summary: { total: entries.length, passed, failed, skipped },
    entries
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runIntegrationMatrix(args);
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(
      `real-server integration: ${report.status} ` +
      `(${report.summary.passed} passed, ${report.summary.failed} failed, ` +
      `${report.summary.skipped} skipped)\nartifact: ${outputPath}\n`
    );
  }
  process.exitCode = report.status === 'failed' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
