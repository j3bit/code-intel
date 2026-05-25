import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expandHome, loadSettings } from './settings.js';
import { detectExecutableFromSettings, languageConfigForLanguage } from './capabilities.js';
import { resolveRepoRelativePaths } from './repo.js';

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
  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((item) => ({
    file: item.file || item.path || item.filePath || null,
    range: item.range || item.metaVariables?.single?.range || null,
    match: item.text || item.lines || item.match || item.source || null,
    language: item.language || language,
    confidence: 'ast-grep'
  }));
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
  const ast = detectExecutableFromSettings(settings.astGrep.command, ['--version'], repoRoot, settings);
  if (!ast.available) return astUnavailable(language || 'unknown', `${settings.astGrep.command} executable was not found on PATH`, settings);
  const lang = config?.astGrep.languageId || language;
  if (!lang) return { status: 'needs_language', error: 'language is required when path inference is not provided', results: [], fallback: settings.fallback, configPath: settings.astGrep.configPath || null };
  const cmdArgs = ['run'];
  if (settings.astGrep.configPath) cmdArgs.push('--config', expandHome(settings.astGrep.configPath));
  cmdArgs.push('--pattern', pattern, '--lang', lang, '--json', repoRoot);
  const result = spawnSync(ast.resolvedCommand || settings.astGrep.command, cmdArgs, { cwd: repoRoot, encoding: 'utf8', timeout: args.timeoutMs || 10000, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0 && !result.stdout) {
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
  let results = [];
  try { results = normalizeAstGrepJson(result.stdout, lang).slice(0, args.maxResults || 100); }
  catch (error) { return { status: 'error', error: `failed to parse ast-grep JSON: ${error.message}`, raw: result.stdout.slice(0, 1000), fallback: settings.fallback, configPath: settings.astGrep.configPath || null }; }
  return {
    status: 'ok',
    executable: settings.astGrep.command,
    configPath: settings.astGrep.configPath || null,
    resolvedCommand: ast.resolvedCommand,
    language: resolvedLanguage || language || lang,
    astGrepLanguageId: lang,
    patternSummary: pattern.slice(0, 120),
    results,
    fallback: results.length ? [] : settings.fallback,
    fallbackReason: results.length ? null : 'ast-grep returned no matches; text supplement may be useful'
  };
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
  return {
    status: 'ok',
    previewOnly: true,
    mutated: false,
    mode: 'match-only',
    replacementSummary: String(replacement).slice(0, 120),
    manualEditRequired: true,
    note: 'Match-only preview: replacement templates are not expanded by this MVP tool. Apply edits through normal Codex file editing after reviewing candidates.',
    patchCandidates: search.results.map((r) => ({ file: r.file, range: r.range, before: r.match, replacementTemplate: replacement, confidence: r.confidence, mode: 'match-only' })),
    fallback: search.fallback,
    fallbackReason: search.fallbackReason
  };
}
