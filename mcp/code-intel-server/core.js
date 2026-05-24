import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_VERSION = '0.1.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SETTINGS_PATH = path.join(ROOT, 'settings', 'defaults.json');
const SETTINGS_SCHEMA_PATH = path.join(ROOT, 'settings', 'schema.json');
const TOOL_NAMES = [
  'capability_discover',
  'ast_grep_search',
  'ast_grep_replace_preview',
  'lsp_diagnostics',
  'lsp_symbols',
  'lsp_goto_definition',
  'lsp_find_references',
  'lsp_prepare_rename',
  'lsp_rename_preview'
];

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

function resolveHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function defaultUserSettingsPath() {
  return path.join(resolveHomeDir(), '.codex', 'code-intel', 'settings.json');
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  const homeDir = resolveHomeDir();
  if (value === '~') return homeDir || value;
  if (value.startsWith('~/')) return homeDir ? path.join(homeDir, value.slice(2)) : value;
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = typeof structuredClone === 'function'
    ? structuredClone(base)
    : JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return null;
  return readJson(file);
}

function settingsSourceError(source, file, message) {
  const error = new Error(`settings schema validation failed: ${source} settings ${message}: ${file}`);
  error.validationErrors = [`${source} settings ${message}: ${file}`];
  return error;
}

function readSettingsOverrideIfExists(file, source) {
  const settings = readJsonIfExists(file);
  if (settings === null) return null;
  if (!isPlainObject(settings)) {
    throw settingsSourceError(source, file, `root expected object but got ${typeOf(settings)}`);
  }
  return settings;
}

function normalizeSettingsPaths(settings) {
  if (typeof settings?.astGrep?.configPath === 'string') {
    settings.astGrep.configPath = expandHome(settings.astGrep.configPath);
  }
  if (Array.isArray(settings?.path?.extraDirs)) {
    settings.path.extraDirs = settings.path.extraDirs.map(expandHome);
  }
  return settings;
}

export function validateAgainstSchema(value, schema, pathLabel = '$') {
  const errors = [];
  function visit(current, currentSchema, label) {
    if (!currentSchema || typeof currentSchema !== 'object') return;
    if (currentSchema.type && !typeMatches(current, currentSchema.type)) {
      errors.push(`${label} expected ${Array.isArray(currentSchema.type) ? currentSchema.type.join(' or ') : currentSchema.type} but got ${typeOf(current)}`);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(currentSchema, 'const') && current !== currentSchema.const) {
      errors.push(`${label} expected ${JSON.stringify(currentSchema.const)}`);
    }
    if (currentSchema.enum && !currentSchema.enum.includes(current)) {
      errors.push(`${label} expected one of ${currentSchema.enum.join(', ')}`);
    }
    if (currentSchema.minLength !== undefined && typeof current === 'string' && current.length < currentSchema.minLength) {
      errors.push(`${label} expected length >= ${currentSchema.minLength}`);
    }
    if (currentSchema.minItems !== undefined && Array.isArray(current) && current.length < currentSchema.minItems) {
      errors.push(`${label} expected at least ${currentSchema.minItems} items`);
    }
    if (currentSchema.not?.const !== undefined && current === currentSchema.not.const) {
      errors.push(`${label} must not be ${JSON.stringify(currentSchema.not.const)}`);
    }
    if (currentSchema.pattern && typeof current === 'string' && !(new RegExp(currentSchema.pattern).test(current))) {
      errors.push(`${label} does not match pattern ${currentSchema.pattern}`);
    }
    if (currentSchema.required && typeof current === 'object' && current !== null) {
      for (const key of currentSchema.required) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) errors.push(`${label}.${key} is required`);
      }
    }
    if (currentSchema.properties && typeof current === 'object' && current !== null && !Array.isArray(current)) {
      for (const [key, propertySchema] of Object.entries(currentSchema.properties)) {
        if (Object.prototype.hasOwnProperty.call(current, key)) visit(current[key], propertySchema, `${label}.${key}`);
      }
    }
    if (currentSchema.items && Array.isArray(current)) {
      current.forEach((item, index) => visit(item, currentSchema.items, `${label}[${index}]`));
    }
    if (currentSchema.additionalProperties === false && isPlainObject(current)) {
      const allowed = new Set(Object.keys(currentSchema.properties || {}));
      for (const key of Object.keys(current)) {
        if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
      }
    }
    if (isPlainObject(currentSchema.additionalProperties) && isPlainObject(current)) {
      const explicit = new Set(Object.keys(currentSchema.properties || {}));
      for (const [key, item] of Object.entries(current)) {
        if (!explicit.has(key)) visit(item, currentSchema.additionalProperties, `${label}.${key}`);
      }
    }
  }
  visit(value, schema, pathLabel);
  return errors;
}

export function validateSettings(settings) {
  const schema = readJson(SETTINGS_SCHEMA_PATH);
  const errors = validateAgainstSchema(settings, schema, '$');
  if (settings?.astGrep?.command === 'sg') errors.push('$.astGrep.command must be ast-grep or another explicit executable, not sg');
  if (errors.length) {
    const error = new Error(`settings schema validation failed: ${errors.slice(0, 8).join('; ')}`);
    error.validationErrors = errors;
    throw error;
  }
  return settings;
}

export function loadSettings(repoRoot = process.cwd(), opts = {}) {
  const defaultPath = opts.defaultSettingsPath || process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH || DEFAULT_SETTINGS_PATH;
  const userPath = opts.userSettingsPath || process.env.CODE_INTEL_USER_SETTINGS_PATH || defaultUserSettingsPath();
  const projectPath = opts.projectSettingsPath || process.env.CODE_INTEL_PROJECT_SETTINGS_PATH || path.join(path.resolve(repoRoot), '.code-intel', 'settings.json');
  const defaults = readJson(defaultPath);
  const expandedUserPath = expandHome(userPath);
  const expandedProjectPath = expandHome(projectPath);
  const user = readSettingsOverrideIfExists(expandedUserPath, 'user');
  const project = readSettingsOverrideIfExists(expandedProjectPath, 'project');
  const merged = validateSettings(normalizeSettingsPaths(deepMerge(deepMerge(defaults, user || {}), project || {})));
  Object.defineProperty(merged, 'sources', {
    enumerable: false,
    value: {
      default: defaultPath,
      user: user ? expandedUserPath : null,
      project: project ? expandedProjectPath : null
    }
  });
  return merged;
}


export function detectExecutable(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 3000 });
  return {
    command,
    available: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim().slice(0, 500),
    stderr: (result.stderr || '').trim().slice(0, 500),
    error: result.error ? String(result.error.message || result.error) : undefined
  };
}

function executableCandidates(command, baseDir = process.cwd(), settings = null) {
  const hasPathSeparator = command.includes('/') || (process.platform === 'win32' && /[\\/]/.test(command));
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const names = process.platform === 'win32' && !path.extname(command)
    ? extensions.map((ext) => `${command}${ext}`)
    : [command];
  if (hasPathSeparator) {
    return names.map((name) => path.isAbsolute(name) ? name : path.resolve(baseDir, name));
  }
  const extraDirs = (settings?.path?.extraDirs || []).map(expandHome);
  const dirs = [...extraDirs, ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)];
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

export function executableOnPath(command, baseDir = process.cwd(), settings = null) {
  if (!command) return { command, available: false, reason: 'no executable declared' };
  for (const candidate of executableCandidates(command, baseDir, settings)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { command, available: true, path: candidate, reason: 'executable found' };
    } catch {}
  }
  return { command, available: false, reason: 'executable not found on PATH' };
}

function detectExecutableFromSettings(command, args = ['--version'], baseDir = process.cwd(), settings = null) {
  const resolution = executableOnPath(command, baseDir, settings);
  if (!resolution.available) {
    return {
      command,
      configuredCommand: command,
      resolvedCommand: null,
      executablePath: null,
      available: false,
      status: null,
      stdout: '',
      stderr: '',
      error: resolution.reason
    };
  }
  const detected = detectExecutable(resolution.path, args);
  return {
    ...detected,
    command,
    configuredCommand: command,
    resolvedCommand: resolution.path,
    executablePath: resolution.path
  };
}

function envWithExtraPathDirs(env = process.env, extraDirs = []) {
  const dirs = (extraDirs || []).map(expandHome).filter(Boolean);
  if (!dirs.length) return env;
  return { ...env, PATH: [...dirs, env.PATH || ''].filter(Boolean).join(path.delimiter) };
}

export function splitCommandLine(commandLine) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const char of String(commandLine || '').trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}


function firstToken(commandLine) {
  return splitCommandLine(commandLine)[0] || '';
}

export function commandAvailable(commandLine, baseDir = process.cwd(), settings = null) {
  const command = firstToken(commandLine);
  if (!command) return { command: commandLine, available: false, reason: 'no command candidate declared' };
  const result = executableOnPath(command, baseDir, settings);
  return {
    command: commandLine,
    executable: command,
    executablePath: result.path || null,
    available: result.available,
    reason: result.available
      ? 'executable found; LSP method readiness requires initialize/method smoke'
      : result.reason
  };
}

export function walkFiles(repoRoot, max = 5000) {
  const out = [];
  const ignored = new Set(['.git', 'node_modules', '.omx', 'dist', 'build', '.next', '.venv', '__pycache__']);
  function walk(dir) {
    if (out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= max || ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  walk(path.resolve(repoRoot));
  return out;
}

function realpathIfExists(target) {
  try { return fs.realpathSync(target); }
  catch { return null; }
}

function insideDir(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveRepoRelativeFile(repoRoot, file) {
  if (!file) return { ok: false, reason: 'file is required for LSP operation' };
  if (path.isAbsolute(file)) return { ok: false, reason: 'file must be repo-relative, not absolute' };
  const resolvedRoot = path.resolve(repoRoot || process.cwd());
  const canonicalRoot = realpathIfExists(resolvedRoot) || resolvedRoot;
  const candidate = path.resolve(canonicalRoot, file);
  if (!insideDir(canonicalRoot, candidate)) {
    return { ok: false, reason: `file escapes repo root: ${file}` };
  }
  const realCandidate = realpathIfExists(candidate);
  if (realCandidate && !insideDir(canonicalRoot, realCandidate)) {
    return { ok: false, reason: `file resolves outside repo root: ${file}` };
  }
  return { ok: true, repoRoot: canonicalRoot, filePath: realCandidate || candidate };
}

export function languageForFile(file, settings = loadSettings()) {
  const ext = path.extname(file).toLowerCase();
  return Object.entries(settings.languages).find(([, language]) => language.extensions.includes(ext))?.[0] || null;
}

export function languageConfigForFile(file, settings = loadSettings()) {
  const language = languageForFile(file, settings);
  return language ? { language, config: settings.languages[language] } : { language: null, config: null };
}

export function languageConfigForLanguage(language, settings = loadSettings()) {
  if (!language) return { language: null, config: null };
  if (settings.languages[language]) return { language, config: settings.languages[language] };
  const found = Object.entries(settings.languages).find(([, config]) => config.astGrep.languageId === language);
  return found ? { language: found[0], config: found[1] } : { language: null, config: null };
}


export function languageInventory(repoRoot, settings = loadSettings(repoRoot)) {
  const files = walkFiles(repoRoot);
  const languages = {};
  const unsupported = {};
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const { language, config } = languageConfigForFile(file, settings);
    if (language && config) {
      languages[language] ??= { files: 0, extensions: config.extensions, examples: [] };
      languages[language].files += 1;
      if (languages[language].examples.length < 5) languages[language].examples.push(rel);
    } else {
      const ext = path.extname(file).toLowerCase() || '[no extension]';
      unsupported[ext] = (unsupported[ext] || 0) + 1;
    }
  }
  return { totalFiles: files.length, languages, unsupportedExtensions: unsupported };
}

export function discoverCapabilities(repoRoot = process.cwd()) {
  const settings = loadSettings(repoRoot);
  const ast = detectExecutableFromSettings(settings.astGrep.command, ['--version'], repoRoot, settings);
  const inventory = languageInventory(repoRoot, settings);
  const languages = {};
  for (const [language, config] of Object.entries(settings.languages)) {
    const present = inventory.languages[language]?.files || 0;
    const lspCommands = config.lsp.commands.map((command) => commandAvailable(command, repoRoot, settings));
    const lspAvailable = lspCommands.find((candidate) => candidate.available)?.command || null;
    languages[language] = {
      presentFiles: present,
      extensions: config.extensions,
      astGrep: ast.available ? 'available' : 'unavailable',
      astGrepLanguageId: config.astGrep.languageId,
      lsp: lspAvailable ? 'commandDetected' : 'missing',
      lspState: lspAvailable ? 'commandDetected' : 'missing',
      methodVerified: [],
      methodUnsupported: [],
      lspCommand: lspAvailable,
      lspCommands,
      capabilities: config.lsp.capabilities,
      fallback: settings.fallback
    };
  }
  return {
    status: 'ok',
    pluginVersion: PLUGIN_VERSION,
    settingsVersion: settings.version,
    settingsSources: settings.sources,
    generatedAt: new Date().toISOString(),
    repoRoot: path.resolve(repoRoot),
    inventory,
    languages,
    tools: {
      astGrep: {
        command: settings.astGrep.command,
        available: ast.available,
        version: ast.stdout || ast.stderr || null,
        configPath: settings.astGrep.configPath || null,
        resolvedCommand: ast.resolvedCommand,
        note: 'Do not use sg alias.'
      }
    },
    fallbackPolicy: ast.available ? 'Use rg/grep when AST or LSP is unsupported or inconclusive.' : 'Fallback reason: ast-grep executable was not found on PATH. Command policy: this plugin does not call sg.'
  };
}

export function resolveCapabilityRoute(args = {}) {
  const discovery = discoverCapabilities(args.repoRoot || process.cwd());
  const settings = loadSettings(args.repoRoot || process.cwd());
  const language = args.language || (args.file ? languageConfigForFile(path.resolve(args.repoRoot || process.cwd(), args.file), settings).language : null);
  const info = language ? discovery.languages[language] : null;
  if (!info) {
    return { status: 'fallback', language, route: ['rg', 'grep'], fallbackReason: 'unsupported language or missing language hint' };
  }
  if (args.intent === 'semantic' || args.intent === 'diagnostics' || args.intent === 'rename') {
    if (info.lsp === 'commandDetected') {
      return { status: 'try-lsp', language, route: ['lsp', 'ast-grep', 'rg', 'grep'], capabilityState: info.lspState, fallbackReason: 'LSP command detected; method readiness must be verified by the LSP tool response' };
    }
    if (info.astGrep === 'available') return { status: 'try-ast-grep', language, route: ['ast-grep', 'rg', 'grep'], fallbackReason: 'LSP command missing' };
    return { status: 'fallback', language, route: ['rg', 'grep'], fallbackReason: 'LSP and ast-grep unavailable' };
  }
  if (info.astGrep === 'available') return { status: 'try-ast-grep', language, route: ['ast-grep', 'rg', 'grep'], fallbackReason: null };
  return { status: 'fallback', language, route: ['rg', 'grep'], fallbackReason: 'ast-grep unavailable or unsupported' };
}

function astUnavailable(language, reason = 'ast-grep executable was not found on PATH', settings = null) {
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

function normalizeAstGrepJson(stdout, language = null) {
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
  const cmdArgs = [];
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

function runtimeFallbackUsed(config, settings = null, baseDir = process.cwd()) {
  if (config?.astGrep?.languageId && detectExecutableFromSettings(settings?.astGrep?.command || 'ast-grep', ['--version'], baseDir, settings).available) {
    return 'ast-grep or rg/grep';
  }
  return 'rg/grep';
}

function lspUnavailable(method, args = {}, reason = 'no LSP server command detected', extra = {}) {
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

function findLspCommand(args = {}) {
  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const settings = loadSettings(repoRoot);
  const resolved = args.language
    ? languageConfigForLanguage(args.language, settings)
    : args.file
      ? languageConfigForFile(path.resolve(repoRoot, args.file), settings)
      : { language: null, config: null };
  if (!resolved.config) return { language: resolved.language, config: null, command: null, settings };
  const available = resolved.config.lsp.commands.map((command) => commandAvailable(command, repoRoot, settings)).find((candidate) => candidate.available);
  return { language: resolved.language, config: resolved.config, command: available?.command || null, settings };
}

function lspFrame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function parseLspFrames(stdout = Buffer.alloc(0)) {
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

function readLspMessagesFromBuffer(state) {
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

function waitForLspMessage(state, predicate, timeoutMs) {
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

function lspParams(method, uri, args = {}) {
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
    env: envWithExtraPathDirs(process.env, workerArgs.settingsPathExtraDirs)
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

export function callTool(name, args = {}) {
  switch (name) {
    case 'capability_discover': return discoverCapabilities(args.repoRoot || process.cwd());
    case 'ast_grep_search': return astGrepSearch(args);
    case 'ast_grep_replace_preview': return astGrepReplacePreview(args);
    case 'lsp_diagnostics': return lspTool('textDocument/diagnostic', args);
    case 'lsp_symbols': return lspTool('textDocument/documentSymbol', args);
    case 'lsp_goto_definition': return lspTool('textDocument/definition', args);
    case 'lsp_find_references': return lspTool('textDocument/references', args);
    case 'lsp_prepare_rename': return lspTool('textDocument/prepareRename', args);
    case 'lsp_rename_preview': return { ...lspTool('textDocument/rename', args), previewOnly: true, mutated: false };
    default: throw new Error(`unknown tool: ${name}`);
  }
}

const commonProps = {
  repoRoot: { type: 'string', description: 'Repository root. Defaults to current working directory.' },
  language: { type: 'string', description: 'Language id such as typescript or python.' },
  file: { type: 'string', description: 'Repo-relative file path for LSP-oriented operations.' },
  position: { type: 'object', description: 'Zero-based LSP position {line, character}.' }
};

export const tools = TOOL_NAMES.map((name) => {
  const base = { name, description: '', inputSchema: { type: 'object', properties: {}, additionalProperties: true }, outputSchema: { type: 'object', properties: { status: { type: 'string' }, fallbackReason: { type: ['string', 'null'] } } } };
  if (name === 'capability_discover') {
    base.description = 'Discover code-intel capabilities, language inventory, ast-grep availability, LSP command candidates, and fallback reasons.';
    base.inputSchema.properties = { repoRoot: commonProps.repoRoot };
  } else if (name === 'ast_grep_search') {
    base.description = 'Run preview/read-only structural search through the ast-grep executable when available.';
    base.inputSchema.required = ['pattern', 'language'];
    base.inputSchema.properties = { repoRoot: commonProps.repoRoot, pattern: { type: 'string' }, language: commonProps.language, maxResults: { type: 'number' } };
  } else if (name === 'ast_grep_replace_preview') {
    base.description = 'Preview structural replacement candidates without mutating files.';
    base.inputSchema.required = ['pattern', 'language', 'replacement'];
    base.inputSchema.properties = { repoRoot: commonProps.repoRoot, pattern: { type: 'string' }, language: commonProps.language, replacement: { type: 'string' }, maxResults: { type: 'number' } };
  } else {
    base.description = `Check or preview LSP operation ${name}; degrades gracefully when no server is available.`;
    base.inputSchema.properties = { repoRoot: commonProps.repoRoot, language: commonProps.language, file: commonProps.file, position: commonProps.position, symbol: { type: 'string' }, newName: { type: 'string' } };
    base.inputSchema.required = ['file'];
    if (['lsp_goto_definition', 'lsp_find_references', 'lsp_prepare_rename', 'lsp_rename_preview'].includes(name)) {
      base.inputSchema.required.push('position');
    }
    if (name === 'lsp_rename_preview') base.inputSchema.required.push('newName');
  }
  return base;
});

async function runLspWorkerCli() {
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
