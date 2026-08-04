import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PLUGIN_VERSION,
  expandHome,
  loadSettings,
  splitCommandLine
} from './settings.js';
import { walkFiles } from './repo.js';

const CAPABILITY_REPORTS_DIR = path.join(os.tmpdir(), 'code-intel-capability-reports-v1');
const CAPABILITY_REPORT_TTL_MS = 60 * 60 * 1000;
const MAX_SUMMARY_LANGUAGES = 20;

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

export function configuredLspCandidates(config) {
  const candidates = [];
  if (config?.lsp?.command) {
    candidates.push({
      command: config.lsp.command,
      args: config.lsp.args || [],
      commandLine: [config.lsp.command, ...(config.lsp.args || [])].join(' '),
      source: 'structured'
    });
  }
  for (const commandLine of config?.lsp?.commands || []) {
    const [command, ...args] = splitCommandLine(commandLine);
    candidates.push({ command, args, commandLine, source: 'commands' });
  }
  return candidates;
}

export function commandAvailable(candidate, baseDir = process.cwd(), settings = null) {
  const descriptor = typeof candidate === 'string'
    ? (() => {
        const [command, ...args] = splitCommandLine(candidate);
        return { command, args, commandLine: candidate, source: 'commands' };
      })()
    : candidate;
  const command = descriptor?.command;
  if (!command) {
    return {
      ...descriptor,
      commandLine: descriptor?.commandLine || '',
      available: false,
      reason: 'no command candidate declared'
    };
  }
  const result = executableOnPath(command, baseDir, settings);
  return {
    ...descriptor,
    commandLine: descriptor.commandLine || [command, ...(descriptor.args || [])].join(' '),
    executable: command,
    executablePath: result.path || null,
    available: result.available,
    reason: result.available
      ? 'executable found; LSP method readiness requires initialize/method smoke'
      : result.reason
  };
}

export function expectedLspCapabilities(config) {
  return config?.lsp?.expectedCapabilities || config?.lsp?.capabilities || [];
}

export function advertisedLspCapabilities(capabilities = {}) {
  const advertised = [];
  if (capabilities.definitionProvider) advertised.push('definition');
  if (capabilities.referencesProvider) advertised.push('references');
  if (capabilities.renameProvider) advertised.push('rename');
  if (capabilities.renameProvider?.prepareProvider) advertised.push('prepareRename');
  if (capabilities.diagnosticProvider) advertised.push('diagnostics');
  if (capabilities.documentSymbolProvider) advertised.push('symbols');
  if (capabilities.hoverProvider) advertised.push('hover');
  if (capabilities.completionProvider) advertised.push('completion');
  if (capabilities.semanticTokensProvider?.full) advertised.push('semanticTokens');
  if (capabilities.documentFormattingProvider) advertised.push('formatting');
  return advertised;
}

export function lspCapabilityForMethod(method) {
  return {
    'textDocument/definition': 'definition',
    'textDocument/references': 'references',
    'textDocument/prepareRename': 'prepareRename',
    'textDocument/rename': 'rename',
    'textDocument/diagnostic': 'diagnostics',
    'textDocument/documentSymbol': 'symbols',
    'textDocument/hover': 'hover',
    'textDocument/completion': 'completion',
    'textDocument/semanticTokens/full': 'semanticTokens',
    'textDocument/formatting': 'formatting'
  }[method] || method.split('/').pop();
}

export function lspMethodAdvertised(capabilities = {}, method) {
  switch (method) {
    case 'textDocument/hover':
      return Boolean(capabilities.hoverProvider);
    case 'textDocument/completion':
      return Boolean(capabilities.completionProvider);
    case 'textDocument/semanticTokens/full':
      return Boolean(capabilities.semanticTokensProvider?.full);
    case 'textDocument/formatting':
      return Boolean(capabilities.documentFormattingProvider);
    default:
      return null;
  }
}

function globRegex(glob) {
  let expression = glob.startsWith('/') ? '^' : '(?:^|/)';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      expression += '.*';
      index += 1;
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`);
}

function shebangInterpreter(file) {
  let firstLine = '';
  try {
    const fileDescriptor = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(512);
      const bytes = fs.readSync(fileDescriptor, buffer, 0, buffer.length, 0);
      firstLine = buffer.toString('utf8', 0, bytes).split(/\r?\n/, 1)[0];
    } finally {
      fs.closeSync(fileDescriptor);
    }
  } catch {
    return null;
  }
  if (!firstLine.startsWith('#!')) return null;
  const tokens = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  let interpreter = path.basename(tokens[0]);
  if (interpreter === 'env') {
    interpreter = tokens.slice(1).find((token) => !token.startsWith('-')) || '';
  }
  return path.basename(interpreter);
}

function languageMatchCandidates(file, settings) {
  const basename = path.basename(file);
  const normalizedFile = file.split(path.sep).join('/');
  const ext = path.extname(file).toLowerCase();
  const interpreter = Object.values(settings.languages).some(
    (config) => config.shebangs?.length
  )
    ? shebangInterpreter(file)
    : null;
  const matches = [];
  for (const [language, config] of Object.entries(settings.languages)) {
    const precedence = Number(config.precedence || 0);
    const rules = [];
    if ((config.filenames || []).includes(basename)) {
      rules.push({ kind: 'filename', detail: basename, rank: 4 });
    }
    for (const glob of config.globs || []) {
      if (globRegex(glob).test(normalizedFile) || globRegex(glob).test(basename)) {
        rules.push({ kind: 'glob', detail: glob, rank: 3 });
      }
    }
    if (ext && (config.extensions || []).includes(ext)) {
      rules.push({ kind: 'extension', detail: ext, rank: 2 });
    }
    if (interpreter && (config.shebangs || []).includes(interpreter)) {
      rules.push({ kind: 'shebang', detail: interpreter, rank: 1 });
    }
    for (const rule of rules) {
      matches.push({
        language,
        config,
        precedence,
        score: precedence * 10 + rule.rank,
        matcher: rule.kind,
        matched: rule.detail,
        reason: `${rule.kind} ${JSON.stringify(rule.detail)}; precedence ${precedence}`
      });
    }
  }
  return matches.sort((left, right) =>
    right.score - left.score ||
    left.language.localeCompare(right.language) ||
    left.matcher.localeCompare(right.matcher)
  );
}

export function languageMatchForFile(file, settings = loadSettings()) {
  const candidates = languageMatchCandidates(file, settings);
  const selected = candidates[0] || null;
  return {
    language: selected?.language || null,
    config: selected?.config || null,
    reason: selected?.reason || 'no filename, glob, extension, or shebang rule matched',
    matcher: selected?.matcher || null,
    matched: selected?.matched || null,
    precedence: selected?.precedence ?? null,
    candidates: candidates.map(({ config, ...candidate }) => candidate)
  };
}

export function languageForFile(file, settings = loadSettings()) {
  return languageMatchForFile(file, settings).language;
}

export function languageConfigForFile(file, settings = loadSettings()) {
  const match = languageMatchForFile(file, settings);
  return {
    language: match.language,
    config: match.config,
    match
  };
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
    const { language, config, match } = languageConfigForFile(file, settings);
    if (language && config) {
      languages[language] ??= {
        files: 0,
        extensions: config.extensions || [],
        examples: [],
        routeEvidence: []
      };
      languages[language].files += 1;
      if (languages[language].examples.length < 5) languages[language].examples.push(rel);
      if (languages[language].routeEvidence.length < 5) {
        languages[language].routeEvidence.push({
          file: rel,
          matcher: match.matcher,
          matched: match.matched,
          precedence: match.precedence,
          reason: match.reason
        });
      }
    } else {
      const ext = path.extname(file).toLowerCase() || '[no extension]';
      unsupported[ext] = (unsupported[ext] || 0) + 1;
    }
  }
  return { totalFiles: files.length, languages, unsupportedExtensions: unsupported };
}

export function astGrepLanguageProbe(
  repoRoot,
  languageId,
  sampleFile,
  settings,
  astExecutable = null
) {
  if (!sampleFile) {
    return {
      status: 'skipped',
      reason: 'no sample file detected for language',
      languageId
    };
  }
  const executable = astExecutable ||
    detectExecutableFromSettings(
      settings.astGrep.command,
      ['--version'],
      repoRoot,
      settings
    ).resolvedCommand;
  if (!executable) {
    return {
      status: 'skipped',
      reason: 'ast-grep executable unavailable',
      languageId,
      file: sampleFile
    };
  }
  const args = ['run'];
  if (settings.astGrep.configPath) {
    args.push('--config', settings.astGrep.configPath);
  }
  args.push(
    '--lang',
    languageId,
    '--pattern',
    '$A',
    '--json',
    path.resolve(repoRoot, sampleFile)
  );
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  const base = {
    file: sampleFile,
    languageId,
    executable: settings.astGrep.command,
    resolvedCommand: executable,
    configPath: settings.astGrep.configPath || null
  };
  if (result.status === 0) {
    return { status: 'passed', ...base };
  }
  return {
    status: 'failed',
    ...base,
    stderrSummary: (result.stderr || result.error?.message || '').trim().slice(0, 500)
  };
}

export function discoverCapabilities(repoRoot = process.cwd()) {
  const settings = loadSettings(repoRoot);
  const ast = detectExecutableFromSettings(settings.astGrep.command, ['--version'], repoRoot, settings);
  const inventory = languageInventory(repoRoot, settings);
  const languages = {};
  for (const [language, config] of Object.entries(settings.languages)) {
    const present = inventory.languages[language]?.files || 0;
    const astGrepProbe = ast.available
      ? astGrepLanguageProbe(
          repoRoot,
          config.astGrep.languageId,
          inventory.languages[language]?.examples?.[0],
          settings,
          ast.resolvedCommand
        )
      : {
          status: 'skipped',
          reason: 'ast-grep executable unavailable',
          languageId: config.astGrep.languageId
        };
    const lspCommands = configuredLspCandidates(config)
      .map((candidate) => commandAvailable(candidate, repoRoot, settings));
    const lspAvailable = lspCommands.find((candidate) => candidate.available)?.commandLine || null;
    languages[language] = {
      presentFiles: present,
      extensions: config.extensions || [],
      filenames: config.filenames || [],
      globs: config.globs || [],
      shebangs: config.shebangs || [],
      precedence: Number(config.precedence || 0),
      routeEvidence: inventory.languages[language]?.routeEvidence || [],
      astGrep: astGrepProbe.status === 'passed'
        ? 'available'
        : astGrepProbe.status === 'failed'
          ? 'unavailable'
          : 'unprobed',
      astGrepLanguageId: config.astGrep.languageId,
      astGrepProbe,
      lsp: lspAvailable ? 'commandDetected' : 'missing',
      lspState: lspAvailable ? 'commandDetected' : 'missing',
      methodVerified: [],
      methodUnsupported: [],
      lspCommand: lspAvailable,
      lspCommands,
      languageId: config.lsp.languageId || language,
      expectedCapabilities: expectedLspCapabilities(config),
      advertisedCapabilities: [],
      verifiedCapabilities: [],
      unsupportedCapabilities: [],
      capabilities: expectedLspCapabilities(config),
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

function cleanupExpiredCapabilityReports(now = Date.now()) {
  if (!fs.existsSync(CAPABILITY_REPORTS_DIR)) return;
  for (const entry of fs.readdirSync(CAPABILITY_REPORTS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const reportPath = path.join(CAPABILITY_REPORTS_DIR, entry);
    try {
      if (fs.statSync(reportPath).mtimeMs + CAPABILITY_REPORT_TTL_MS <= now) {
        fs.rmSync(reportPath, { force: true });
      }
    } catch {
      fs.rmSync(reportPath, { force: true });
    }
  }
}

function writeCapabilityReport(discovery) {
  fs.mkdirSync(CAPABILITY_REPORTS_DIR, { recursive: true, mode: 0o700 });
  cleanupExpiredCapabilityReports();
  const reportPath = path.join(CAPABILITY_REPORTS_DIR, `${crypto.randomUUID()}.json`);
  const content = JSON.stringify(discovery, null, 2) + '\n';
  fs.writeFileSync(reportPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return {
    path: reportPath,
    bytes: Buffer.byteLength(content, 'utf8'),
    expiresAt: new Date(Date.now() + CAPABILITY_REPORT_TTL_MS).toISOString()
  };
}

function summarizeCapabilities(discovery, report) {
  const detectedLanguages = Object.entries(discovery.languages)
    .filter(([, info]) => info.presentFiles > 0)
    .sort((left, right) =>
      right[1].presentFiles - left[1].presentFiles || left[0].localeCompare(right[0])
    )
    .map(([language, info]) => ({
      language,
      presentFiles: info.presentFiles,
      astGrep: info.astGrep,
      lsp: info.lsp
    }));
  const languages = detectedLanguages.slice(0, MAX_SUMMARY_LANGUAGES);
  return {
    status: discovery.status,
    mode: 'summary',
    pluginVersion: discovery.pluginVersion,
    settingsVersion: discovery.settingsVersion,
    generatedAt: discovery.generatedAt,
    repoRoot: discovery.repoRoot,
    inventorySummary: {
      totalFiles: discovery.inventory.totalFiles,
      detectedLanguages: detectedLanguages.length,
      unsupportedExtensions: Object.keys(discovery.inventory.unsupportedExtensions).length
    },
    totalItems: detectedLanguages.length,
    returnedItems: languages.length,
    truncated: detectedLanguages.length > languages.length,
    languages,
    tools: {
      astGrep: {
        command: discovery.tools.astGrep.command,
        available: discovery.tools.astGrep.available,
        configPath: discovery.tools.astGrep.configPath
      }
    },
    detailReportPath: report.path,
    detailReportBytes: report.bytes,
    detailReportExpiresAt: report.expiresAt,
    fallbackPolicy: discovery.fallbackPolicy
  };
}

export function discoverCapabilitiesForTool(args = {}) {
  const discovery = discoverCapabilities(args.repoRoot || process.cwd());
  if (args.mode === 'full') return { ...discovery, mode: 'full' };
  return summarizeCapabilities(discovery, writeCapabilityReport(discovery));
}

export function resolveCapabilityRoute(args = {}) {
  const repoRoot = args.repoRoot || process.cwd();
  const discovery = discoverCapabilities(repoRoot);
  const settings = loadSettings(repoRoot);
  const intent = args.intent || 'structural';
  const fileMatch = args.file
    ? languageMatchForFile(path.resolve(repoRoot, args.file), settings)
    : null;
  const language = args.language || fileMatch?.language || null;
  const info = language ? discovery.languages[language] : null;
  const base = {
    intent,
    language,
    repoRoot: path.resolve(repoRoot),
    languageMatch: args.language
      ? { matcher: 'explicit', matched: args.language, reason: 'explicit language argument' }
      : fileMatch
        ? {
            matcher: fileMatch.matcher,
            matched: fileMatch.matched,
            precedence: fileMatch.precedence,
            reason: fileMatch.reason,
            candidates: fileMatch.candidates
          }
        : null
  };
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

export function findLspCommand(args = {}, settingsOverride = null) {
  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const settings = settingsOverride || loadSettings(repoRoot);
  const resolved = args.language
    ? languageConfigForLanguage(args.language, settings)
    : args.file
      ? languageConfigForFile(path.resolve(repoRoot, args.file), settings)
      : { language: null, config: null };
  if (!resolved.config) {
    return {
      language: resolved.language,
      config: null,
      command: null,
      candidate: null,
      candidates: [],
      settings
    };
  }
  const candidates = configuredLspCandidates(resolved.config)
    .map((candidate) => commandAvailable(candidate, repoRoot, settings));
  const available = candidates.find((candidate) => candidate.available) || null;
  return {
    language: resolved.language,
    config: resolved.config,
    command: available?.commandLine || null,
    candidate: available,
    candidates,
    settings
  };
}
