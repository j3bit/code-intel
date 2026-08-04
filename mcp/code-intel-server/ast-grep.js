import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expandHome, loadSettings } from './settings.js';
import { detectExecutableFromSettings, languageConfigForLanguage } from './capabilities.js';
import { resolveRepoRelativePaths } from './repo.js';

const SEARCH_RESULTS_DIR = path.join(os.tmpdir(), 'code-intel-ast-results-v1');
const SEARCH_RESULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const MAX_RESPONSE_BYTES = 24 * 1024;
const MAX_SNIPPET_BYTES = 2048;

export function astUnavailable(language, reason = 'ast-grep executable was not found on PATH', settings = null) {
  return {
    status: 'unavailable',
    language,
    results: [],
    executable: settings?.astGrep?.command || 'ast-grep',
    configPath: settings?.astGrep?.configPath || null,
    fallback: settings?.fallback || ['rg', 'grep'],
    fallbackReason: reason,
    commandPolicy: 'this plugin does not call sg'
  };
}

export function normalizeAstGrepJson(stdout, language = null) {
  if (!stdout.trim()) return [];
  let rows;
  try {
    const parsed = JSON.parse(stdout);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? parsed : [parsed];
    });
  }
  return rows.map((item) => normalizeAstGrepItem(item, language));
}

function normalizeAstGrepItem(item, language = null) {
  const rawMatch = item.text || item.lines || item.match || item.source || null;
  const snippet = boundedUtf8(rawMatch, MAX_SNIPPET_BYTES);
  const normalized = {
    file: item.file || item.path || item.filePath || null,
    range: item.range || item.metaVariables?.single?.range || null,
    match: snippet.text,
    language: item.language || language,
    confidence: 'ast-grep'
  };
  if (snippet.truncated) {
    normalized.matchBytes = snippet.originalBytes;
    normalized.matchTruncated = true;
  }
  return normalized;
}

function boundedUtf8(value, maxBytes) {
  if (value === null || value === undefined) {
    return { text: null, originalBytes: 0, truncated: false };
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return { text, originalBytes: buffer.length, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: buffer.subarray(0, end).toString('utf8'),
    originalBytes: buffer.length,
    truncated: true
  };
}

function boundedPageSize(value) {
  const parsed = Number(value ?? DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(Math.floor(parsed), MAX_PAGE_SIZE));
}

function resultSetFiles(id) {
  return {
    data: path.join(SEARCH_RESULTS_DIR, `${id}.jsonl`),
    metadata: path.join(SEARCH_RESULTS_DIR, `${id}.json`)
  };
}

function removeResultSet(id) {
  const files = resultSetFiles(id);
  fs.rmSync(files.data, { force: true });
  fs.rmSync(files.metadata, { force: true });
}

function cleanupExpiredResultSets(now = Date.now()) {
  if (!fs.existsSync(SEARCH_RESULTS_DIR)) return;
  for (const entry of fs.readdirSync(SEARCH_RESULTS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(SEARCH_RESULTS_DIR, entry), 'utf8'));
      if (Date.parse(metadata.expiresAt) <= now) removeResultSet(id);
    } catch {
      removeResultSet(id);
    }
  }
}

function encodeCursor(id, offset) {
  return Buffer.from(JSON.stringify({ version: 1, id, offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512) {
    throw new Error('cursor must be a non-empty opaque string');
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cursor is invalid or expired');
  }
  if (
    decoded?.version !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id || '') ||
    !Number.isInteger(decoded.offset) ||
    decoded.offset < 0
  ) {
    throw new Error('cursor is invalid or expired');
  }
  return decoded;
}

function visitJsonLines(file, visitor) {
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let carry = Buffer.alloc(0);
  let position = 0;
  let stopped = false;
  const visitLine = (lineBuffer) => {
    const line = lineBuffer.toString('utf8').trim();
    if (!line) return true;
    const parsed = JSON.parse(line);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (visitor(row) === false) return false;
    }
    return true;
  };
  try {
    while (!stopped) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length
        ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      let newline = data.indexOf(0x0a, lineStart);
      while (newline >= 0) {
        if (!visitLine(data.subarray(lineStart, newline))) {
          stopped = true;
          break;
        }
        lineStart = newline + 1;
        newline = data.indexOf(0x0a, lineStart);
      }
      carry = stopped ? Buffer.alloc(0) : Buffer.from(data.subarray(lineStart));
    }
    if (!stopped && carry.length) visitLine(carry);
  } finally {
    fs.closeSync(fd);
  }
}

function collectResultPage(file, language, offset, pageSize, countAll = false) {
  const results = [];
  let seen = 0;
  visitJsonLines(file, (item) => {
    if (seen >= offset && results.length < pageSize) {
      results.push(normalizeAstGrepItem(item, language));
    }
    seen += 1;
    return countAll || seen < offset + pageSize;
  });
  return { results, seen };
}

function withResponseBytes(value) {
  const sized = { ...value, responseBytes: 0 };
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const bytes = Buffer.byteLength(JSON.stringify(sized), 'utf8');
    if (bytes === sized.responseBytes) return sized;
    sized.responseBytes = bytes;
  }
  return sized;
}

function fitResponseRows(rows, build) {
  let limited = rows;
  while (true) {
    const value = withResponseBytes(build(limited, limited.length < rows.length));
    if (value.responseBytes <= MAX_RESPONSE_BYTES || limited.length <= 1) return value;
    limited = limited.slice(0, -1);
  }
}

function pagedSearchResult(metadata, offset, pageSize, results, fallback) {
  return fitResponseRows(results, (limited, pageLimitedByBytes) => {
    const nextOffset = offset + limited.length;
    const nextCursor = nextOffset < metadata.totalItems
      ? encodeCursor(metadata.id, nextOffset)
      : null;
    return {
      status: 'ok',
      complete: true,
      resultSetId: metadata.id,
      generatedAt: metadata.generatedAt,
      expiresAt: metadata.expiresAt,
      executable: metadata.executable,
      configPath: metadata.configPath,
      resolvedCommand: metadata.resolvedCommand,
      language: metadata.language,
      astGrepLanguageId: metadata.astGrepLanguageId,
      patternSummary: metadata.pattern.slice(0, 120),
      pageOffset: offset,
      pageSize,
      pageComplete: nextCursor === null,
      pageLimitedByBytes,
      responseByteLimit: MAX_RESPONSE_BYTES,
      snippetByteLimit: MAX_SNIPPET_BYTES,
      totalItems: metadata.totalItems,
      returnedItems: limited.length,
      truncated: metadata.totalItems > limited.length,
      nextCursor,
      results: limited,
      fallback: metadata.totalItems ? [] : fallback,
      fallbackReason: metadata.totalItems ? null : 'ast-grep returned no matches; text supplement may be useful'
    };
  });
}

function pageFromCursor(args, repoRoot, language, astGrepLanguageId, fallback) {
  const { id, offset } = decodeCursor(args.cursor);
  const files = resultSetFiles(id);
  if (!fs.existsSync(files.metadata) || !fs.existsSync(files.data)) {
    throw new Error('cursor is invalid or expired');
  }
  const metadata = JSON.parse(fs.readFileSync(files.metadata, 'utf8'));
  if (Date.parse(metadata.expiresAt) <= Date.now()) {
    removeResultSet(id);
    throw new Error('cursor is invalid or expired');
  }
  if (
    metadata.repoRoot !== repoRoot ||
    metadata.language !== language ||
    metadata.astGrepLanguageId !== astGrepLanguageId ||
    metadata.pattern !== args.pattern
  ) {
    throw new Error('cursor does not match this search request');
  }
  if (offset > metadata.totalItems) throw new Error('cursor offset is outside the result set');
  const pageSize = boundedPageSize(args.pageSize ?? args.maxResults);
  const page = collectResultPage(files.data, astGrepLanguageId, offset, pageSize);
  return pagedSearchResult(metadata, offset, pageSize, page.results, fallback);
}

function normalizeAstGrepScanJson(stdout) {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((item) => ({
    file: item.file || item.path || item.filePath || null,
    range: item.range || item.labels?.[0]?.range || null,
    message: item.message || item.note || item.text || null,
    ruleId: item.ruleId || item.id || item.rule || null,
    severity: item.severity || null,
    confidence: 'ast-grep-scan'
  }));
}

function resolveAstGrepConfigPath(settings, repoRoot) {
  if (!settings.astGrep.configPath) return null;
  const expanded = expandHome(settings.astGrep.configPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
}

export function astGrepSearch(args = {}) {
  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const settings = loadSettings(repoRoot);
  const pattern = args.pattern;
  const language = args.language;
  if (!pattern) return { status: 'error', error: 'pattern is required', results: [], fallback: settings.fallback, configPath: settings.astGrep.configPath || null };
  const { language: resolvedLanguage, config } = language ? languageConfigForLanguage(language, settings) : { language: null, config: null };
  if (language && !config) return astUnavailable(language, `unsupported language: ${language}`, settings);
  const lang = config?.astGrep.languageId || language;
  if (!lang) return { status: 'needs_language', error: 'language is required when path inference is not provided', results: [], fallback: settings.fallback, configPath: settings.astGrep.configPath || null };
  if (args.cursor) {
    try {
      return pageFromCursor(args, repoRoot, resolvedLanguage || language || lang, lang, settings.fallback);
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
        results: [],
        fallback: settings.fallback,
        fallbackReason: 'paged ast-grep result set is unavailable; rerun the search without a cursor'
      };
    }
  }
  const ast = detectExecutableFromSettings(settings.astGrep.command, ['--version'], repoRoot, settings);
  if (!ast.available) return astUnavailable(language || 'unknown', `${settings.astGrep.command} executable was not found on PATH`, settings);
  const cmdArgs = ['run'];
  if (settings.astGrep.configPath) cmdArgs.push('--config', expandHome(settings.astGrep.configPath));
  cmdArgs.push('--pattern', pattern, '--lang', lang, '--json=stream', repoRoot);
  fs.mkdirSync(SEARCH_RESULTS_DIR, { recursive: true, mode: 0o700 });
  cleanupExpiredResultSets();
  const id = crypto.randomUUID();
  const files = resultSetFiles(id);
  const outputFd = fs.openSync(files.data, 'wx', 0o600);
  let result;
  try {
    result = spawnSync(ast.resolvedCommand || settings.astGrep.command, cmdArgs, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: args.timeoutMs || 10000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', outputFd, 'pipe']
    });
  } finally {
    fs.closeSync(outputFd);
  }
  if (result.status !== 0 || result.error) {
    removeResultSet(id);
    return {
      status: 'error',
      executable: settings.astGrep.command,
      configPath: settings.astGrep.configPath || null,
      resolvedCommand: ast.resolvedCommand,
      language: resolvedLanguage || language || lang,
      astGrepLanguageId: lang,
      patternSummary: pattern.slice(0, 120),
      stderrSummary: (result.stderr || result.error?.message || '').trim().slice(0, 1000),
      fallback: settings.fallback,
      fallbackReason: 'ast-grep failed; revise pattern or use text fallback',
      commandPolicy: 'this plugin does not call sg'
    };
  }
  const pageSize = boundedPageSize(args.pageSize ?? args.maxResults);
  let firstPage;
  try {
    firstPage = collectResultPage(files.data, lang, 0, pageSize, true);
  } catch (error) {
    removeResultSet(id);
    return {
      status: 'error',
      error: `failed to parse ast-grep JSON stream: ${error.message}`,
      results: [],
      fallback: settings.fallback,
      configPath: settings.astGrep.configPath || null
    };
  }
  const generatedAt = new Date();
  const metadata = {
    version: 1,
    id,
    repoRoot,
    language: resolvedLanguage || language || lang,
    astGrepLanguageId: lang,
    pattern,
    executable: settings.astGrep.command,
    configPath: settings.astGrep.configPath || null,
    resolvedCommand: ast.resolvedCommand,
    totalItems: firstPage.seen,
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + SEARCH_RESULT_TTL_MS).toISOString()
  };
  fs.writeFileSync(files.metadata, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return pagedSearchResult(metadata, 0, pageSize, firstPage.results, settings.fallback);
}

export function astGrepScan(args = {}) {
  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const settings = loadSettings(repoRoot);
  const configPath = resolveAstGrepConfigPath(settings, repoRoot);
  if (!configPath) return astUnavailable('scan', 'ast-grep configPath is required for ast_grep_scan', settings);
  const ast = detectExecutableFromSettings(settings.astGrep.command, ['--version'], repoRoot, settings);
  if (!ast.available) return astUnavailable('scan', `${settings.astGrep.command} executable was not found on PATH`, settings);
  const requestedPaths = Array.isArray(args.paths) && args.paths.length ? args.paths : [];
  const safePaths = resolveRepoRelativePaths(repoRoot, requestedPaths);
  if (!safePaths.ok) return astUnavailable('scan', safePaths.reason, settings);
  const scanTargets = safePaths.paths.length ? safePaths.paths : ['.'];
  const cmdArgs = ['scan', '--config', configPath, '--json', ...scanTargets];
  const result = spawnSync(ast.resolvedCommand || settings.astGrep.command, cmdArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: args.timeoutMs || 10000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0 && !result.stdout) {
    return {
      status: 'error',
      executable: settings.astGrep.command,
      configPath,
      resolvedCommand: ast.resolvedCommand,
      stderrSummary: (result.stderr || result.error?.message || '').trim().slice(0, 1000),
      results: [],
      fallback: settings.fallback,
      fallbackReason: 'ast-grep scan failed; inspect sgconfig rules or use text fallback',
      commandPolicy: 'this plugin does not call sg'
    };
  }
  let results = [];
  try { results = normalizeAstGrepScanJson(result.stdout).slice(0, args.maxResults || 100); }
  catch (error) { return { status: 'error', error: `failed to parse ast-grep scan JSON: ${error.message}`, raw: result.stdout.slice(0, 1000), results: [], fallback: settings.fallback, configPath }; }
  return {
    status: 'ok',
    executable: settings.astGrep.command,
    configPath,
    resolvedCommand: ast.resolvedCommand,
    scanned: scanTargets,
    results,
    fallback: results.length ? [] : settings.fallback,
    fallbackReason: results.length ? null : 'ast-grep scan returned no findings'
  };
}

export function astGrepReplacePreview(args = {}) {
  const search = astGrepSearch(args);
  if (search.status !== 'ok') return { ...search, previewOnly: true, mutated: false };
  const replacement = args.replacement ?? '';
  const replacementSnippet = boundedUtf8(String(replacement), MAX_SNIPPET_BYTES);
  const candidates = search.results.map((result) => ({
    file: result.file,
    range: result.range,
    before: result.match,
    beforeBytes: result.matchBytes,
    beforeTruncated: result.matchTruncated,
    confidence: result.confidence,
    mode: 'match-only'
  }));
  return fitResponseRows(candidates, (limited, locallyLimitedByBytes) => {
    const nextOffset = search.pageOffset + limited.length;
    const nextCursor = nextOffset < search.totalItems
      ? encodeCursor(search.resultSetId, nextOffset)
      : null;
    return {
      status: 'ok',
      previewOnly: true,
      mutated: false,
      mode: 'match-only',
      replacementTemplate: replacementSnippet.text,
      replacementBytes: replacementSnippet.originalBytes,
      replacementTruncated: replacementSnippet.truncated,
      manualEditRequired: true,
      note: 'Match-only preview: replacement templates are not expanded by this MVP tool. Apply edits through normal Codex file editing after reviewing candidates.',
      patchCandidates: limited,
      complete: search.complete,
      resultSetId: search.resultSetId,
      generatedAt: search.generatedAt,
      expiresAt: search.expiresAt,
      pageOffset: search.pageOffset,
      pageSize: search.pageSize,
      pageComplete: nextCursor === null,
      pageLimitedByBytes: search.pageLimitedByBytes || locallyLimitedByBytes,
      responseByteLimit: MAX_RESPONSE_BYTES,
      snippetByteLimit: MAX_SNIPPET_BYTES,
      totalItems: search.totalItems,
      returnedItems: limited.length,
      truncated: search.totalItems > limited.length,
      nextCursor,
      fallback: search.fallback,
      fallbackReason: search.fallbackReason
    };
  });
}
