import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_VERSION, expandHome, firstToken, loadSettings } from './settings.js';
import { walkFiles } from './repo.js';

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

export function resolveExtraDir(dir, repoRoot = process.cwd()) {
  const expanded = expandHome(dir);
  if (!expanded) return expanded;
  return path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
}

export function executableCandidates(command, baseDir = process.cwd(), settings = null) {
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
  const extraDirs = (settings?.path?.extraDirs || []).map((dir) => resolveExtraDir(dir, baseDir));
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

export function detectExecutableFromSettings(command, args = ['--version'], baseDir = process.cwd(), settings = null) {
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

export function envWithExtraPathDirs(env = process.env, extraDirs = [], repoRoot = process.cwd()) {
  const dirs = (extraDirs || []).map((dir) => resolveExtraDir(dir, repoRoot)).filter(Boolean);
  if (!dirs.length) return env;
  return { ...env, PATH: [...dirs, env.PATH || ''].filter(Boolean).join(path.delimiter) };
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
  const repoRoot = args.repoRoot || process.cwd();
  const discovery = discoverCapabilities(repoRoot);
  const settings = loadSettings(repoRoot);
  const intent = args.intent || 'structural';
  const language = args.language || (args.file ? languageConfigForFile(path.resolve(repoRoot, args.file), settings).language : null);
  const info = language ? discovery.languages[language] : null;
  const base = { intent, language, repoRoot: path.resolve(repoRoot) };
  if (!info) {
    return { ...base, status: 'fallback', route: ['rg', 'grep'], fallbackReason: 'unsupported language or missing language hint' };
  }
  if (intent === 'semantic' || intent === 'diagnostics' || intent === 'rename' || intent === 'audit') {
    if (info.lsp === 'commandDetected') {
      return { ...base, status: 'try-lsp', route: ['lsp', 'ast-grep', 'rg', 'grep'], capabilityState: info.lspState, fallbackReason: 'LSP command detected; method readiness must be verified by the LSP tool response' };
    }
    if (info.astGrep === 'available') return { ...base, status: 'try-ast-grep', route: ['ast-grep', 'rg', 'grep'], fallbackReason: 'LSP command missing' };
    return { ...base, status: 'fallback', route: ['rg', 'grep'], fallbackReason: 'LSP and ast-grep unavailable' };
  }
  if (info.astGrep === 'available') return { ...base, status: 'try-ast-grep', route: ['ast-grep', 'rg', 'grep'], fallbackReason: null };
  return { ...base, status: 'fallback', route: ['rg', 'grep'], fallbackReason: 'ast-grep unavailable or unsupported' };
}

export function runtimeFallbackUsed(config, settings = null, baseDir = process.cwd()) {
  if (config?.astGrep?.languageId && detectExecutableFromSettings(settings?.astGrep?.command || 'ast-grep', ['--version'], baseDir, settings).available) {
    return 'ast-grep or rg/grep';
  }
  return 'rg/grep';
}

export function findLspCommand(args = {}) {
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
