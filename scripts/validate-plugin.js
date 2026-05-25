#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tools, callTool, loadSettings, validateSettings, splitCommandLine } from '../mcp/code-intel-server/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_TOOLS = ['capability_discover','capability_route','ast_grep_search','ast_grep_scan','ast_grep_replace_preview','post_edit_audit','lsp_diagnostics','lsp_symbols','lsp_goto_definition','lsp_find_references','lsp_prepare_rename','lsp_rename_preview'];
const SKILLS = ['code-intel','init-code-intel','code-intel-doctor','code-intel-refactor'];
const REFS = ['routing-policy.md','settings-contract.md','fallback-policy.md','mcp-tool-contract.md','hook-contract.md'];
const results = [];
function check(name, ok, evidence = '') { results.push({ name, ok: Boolean(ok), evidence: String(evidence) }); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function run(cmd, args, opts = {}) { return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024, ...opts }); }
function rel(file) { return path.relative(ROOT, file); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function validateSkillFrontmatter(relPath) {
  const body = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const lines = body.split(/\r?\n/);
  if (lines[0] !== '---') return 'missing opening frontmatter delimiter';
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end < 0) return 'missing closing frontmatter delimiter';
  const data = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) return `invalid frontmatter line ${index + 1}: ${line}`;
    const [, key, value] = match;
    const trimmed = value.trim();
    const quoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"));
    if (!quoted && /:\s/.test(trimmed)) {
      return `unquoted colon-space in ${key} on line ${index + 1}`;
    }
    data[key] = trimmed;
  }
  if (!data.name || !data.description) return 'missing required name or description';
  return '';
}
function mcpFrame(message) {
  const body = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}
function initializeFrame() {
  return mcpFrame({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' }
  });
}
function unsupportedInitializeFrame() {
  return mcpFrame({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2099-99-99' }
  });
}
function framedInitializeOk(result) {
  const stdout = result.stdout || '';
  return result.status === 0 && stdout.includes('Content-Length:') && stdout.includes('code-intel');
}
function framedEvidence(result) {
  return result.stdout || result.stderr || result.error?.message || '';
}
function mcpManifestServer() {
  return readJson('.mcp.json').mcpServers?.['code-intel'];
}
function resolvedManifestCwd(server, manifestDir = ROOT) {
  if (!server?.cwd) return manifestDir;
  return path.isAbsolute(server.cwd) ? server.cwd : path.resolve(manifestDir, server.cwd);
}
function finish() {
  const failed = results.filter((r) => !r.ok);
  const report = { status: failed.length ? 'failed' : 'passed', total: results.length, passed: results.length - failed.length, failed: failed.length, results };
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.evidence ? ` — ${r.evidence}` : ''}`);
    console.log(`\n${report.status}: ${report.passed}/${report.total} checks passed`);
  }
  process.exit(failed.length ? 1 : 0);
}

// Plugin structure validation
check('plugin manifest exists', exists('.codex-plugin/plugin.json'), '.codex-plugin/plugin.json');
const manifest = readJson('.codex-plugin/plugin.json');
check('manifest required fields', ['name','version','description','skills','interface'].every((k) => manifest[k]), Object.keys(manifest).join(', '));
check('manifest name is code-intel', manifest.name === 'code-intel', manifest.name);
check('mcp server manifest exists', exists('.mcp.json'), '.mcp.json');
check('hook manifest declared when hooks are shipped', manifest.hooks === './hooks/hooks.json' && exists('hooks/hooks.json'), manifest.hooks || '(missing)');
for (const skill of SKILLS) check(`skill ${skill} exists`, exists(`skills/${skill}/SKILL.md`), `skills/${skill}/SKILL.md`);
for (const skill of SKILLS) {
  const relPath = `skills/${skill}/SKILL.md`;
  const error = exists(relPath) ? validateSkillFrontmatter(relPath) : 'missing file';
  check(`skill ${skill} frontmatter parseable`, !error, error || relPath);
}
for (const ref of REFS) check(`reference ${ref} exists`, exists(`references/${ref}`), `references/${ref}`);
check('settings schema exists', exists('settings/schema.json'), 'settings/schema.json');
check('default settings exists', exists('settings/defaults.json'), 'settings/defaults.json');
let defaultSettings;
try {
  defaultSettings = readJson('settings/defaults.json');
  validateSettings(defaultSettings);
  check('default settings validate against settings/schema.json', true, 'settings/defaults.json');
} catch (error) {
  check('default settings validate against settings/schema.json', false, error.message);
  finish();
}
check('default settings include python language', Boolean(defaultSettings.languages?.python?.lsp?.commands?.length), JSON.stringify(defaultSettings.languages?.python || {}));
check('default settings include typescript language', Boolean(defaultSettings.languages?.typescript?.lsp?.commands?.length), JSON.stringify(defaultSettings.languages?.typescript || {}));
check('default settings command policy uses ast-grep', defaultSettings.astGrep?.command === 'ast-grep', defaultSettings.astGrep?.command);
const settingsMergeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-settings-merge-'));
try {
  const userSettingsPath = path.join(settingsMergeRoot, 'user-settings.json');
  const projectRoot = path.join(settingsMergeRoot, 'repo');
  const projectSettingsDir = path.join(projectRoot, '.code-intel');
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  writeJson(userSettingsPath, {
    version: 1,
    path: { extraDirs: [path.join(settingsMergeRoot, 'user-bin')] },
    astGrep: { configPath: path.join(settingsMergeRoot, 'user-sgconfig.yml') },
    languages: {
      python: { lsp: { commands: ['user-pyright --stdio'] } },
      systemverilog: {
        extensions: ['.sv', '.svh'],
        astGrep: { languageId: 'systemverilog' },
        lsp: { commands: ['slangd'], capabilities: ['definition', 'diagnostics', 'symbols'] }
      }
    }
  });
  writeJson(path.join(projectSettingsDir, 'settings.json'), {
    version: 1,
    languages: {
      python: { lsp: { commands: ['project-pyright --stdio'] } }
    }
  });
  const merged = loadSettings(projectRoot, { userSettingsPath });
  check('settings merge uses user scope custom language', Boolean(merged.languages.systemverilog), JSON.stringify(merged.languages.systemverilog || {}));
  check('settings merge lets project override user LSP command', merged.languages.python.lsp.commands[0] === 'project-pyright --stdio', JSON.stringify(merged.languages.python.lsp.commands));
  check('settings merge preserves default python extensions', merged.languages.python.extensions.includes('.py'), JSON.stringify(merged.languages.python));
  check('settings merge records source paths', merged.sources.user === userSettingsPath && merged.sources.project.endsWith('.code-intel/settings.json'), JSON.stringify(merged.sources));
} finally {
  fs.rmSync(settingsMergeRoot, { recursive: true, force: true });
}
const malformedSettingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-malformed-settings-'));
try {
  const userSettingsPath = path.join(malformedSettingsRoot, 'user-settings.json');
  const projectRoot = path.join(malformedSettingsRoot, 'repo');
  fs.mkdirSync(projectRoot, { recursive: true });
  writeJson(userSettingsPath, []);
  try {
    loadSettings(projectRoot, { userSettingsPath });
    check('settings rejects non-object user settings root', false, 'non-object user settings root was accepted');
  } catch (error) {
    check(
      'settings rejects non-object user settings root',
      /settings schema|user settings root|expected object/.test(error.message),
      error.message
    );
  }
} finally {
  fs.rmSync(malformedSettingsRoot, { recursive: true, force: true });
}
if (!process.env.CODE_INTEL_EXPECT_VALIDATION_FAILURE) {
  const malformedDefaultSettingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-bad-settings-'));
  try {
    const badSettingsPath = path.join(malformedDefaultSettingsRoot, 'bad-settings.json');
    writeJson(badSettingsPath, { version: 1, astGrep: { command: 'sg' } });
    const badSettingsRun = run('node', ['scripts/validate-plugin.js', '--json'], {
      env: {
        ...process.env,
        CODE_INTEL_DEFAULT_SETTINGS_PATH: badSettingsPath,
        CODE_INTEL_USER_SETTINGS_PATH: path.join(malformedDefaultSettingsRoot, 'missing-user-settings.json'),
        CODE_INTEL_PROJECT_SETTINGS_PATH: path.join(malformedDefaultSettingsRoot, 'missing-project-settings.json'),
        CODE_INTEL_EXPECT_VALIDATION_FAILURE: '1'
      }
    });
    const badSettingsEvidence = `${badSettingsRun.stdout}\n${badSettingsRun.stderr}`;
    check(
      'settings schema validation rejects malformed settings',
      badSettingsRun.status !== 0 && badSettingsEvidence.includes('settings schema'),
      badSettingsEvidence.slice(0, 500)
    );
  } finally {
    fs.rmSync(malformedDefaultSettingsRoot, { recursive: true, force: true });
  }
}
const settingsExpansionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-settings-expansion-'));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
try {
  const fakeHome = path.join(settingsExpansionRoot, 'home');
  const userSettingsPath = path.join(settingsExpansionRoot, 'user-settings.json');
  const projectRoot = path.join(settingsExpansionRoot, 'repo');
  fs.mkdirSync(projectRoot, { recursive: true });
  process.env.HOME = fakeHome;
  writeJson(userSettingsPath, {
    version: 1,
    path: { extraDirs: ['~/code-intel-bin'] },
    astGrep: { configPath: '~/.codex/code-intel/sgconfig.yml' }
  });
  const expanded = loadSettings(projectRoot, { userSettingsPath });
  check(
    'settings expands home in ast-grep config path',
    expanded.astGrep.configPath === path.join(fakeHome, '.codex', 'code-intel', 'sgconfig.yml'),
    expanded.astGrep.configPath
  );
  check(
    'settings expands home in path extraDirs',
    expanded.path.extraDirs[0] === path.join(fakeHome, 'code-intel-bin'),
    JSON.stringify(expanded.path.extraDirs)
  );
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(settingsExpansionRoot, { recursive: true, force: true });
}
const settingsHomeFallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-settings-home-fallback-'));
try {
  const fakeUserProfile = path.join(settingsHomeFallbackRoot, 'profile');
  const maliciousCwd = path.join(settingsHomeFallbackRoot, 'cwd');
  const projectRoot = path.join(settingsHomeFallbackRoot, 'repo');
  const profileSettingsPath = path.join(fakeUserProfile, '.codex', 'code-intel', 'settings.json');
  const cwdSettingsPath = path.join(maliciousCwd, '.codex', 'code-intel', 'settings.json');
  const childScriptPath = path.join(settingsHomeFallbackRoot, 'check-home-fallback.mjs');
  fs.mkdirSync(path.dirname(profileSettingsPath), { recursive: true });
  fs.mkdirSync(path.dirname(cwdSettingsPath), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  writeJson(profileSettingsPath, {
    version: 1,
    path: { extraDirs: ['~/code-intel-bin'] },
    astGrep: { command: 'profile-ast-grep' }
  });
  writeJson(cwdSettingsPath, {
    version: 1,
    astGrep: { command: 'cwd-relative-ast-grep' }
  });
  fs.writeFileSync(childScriptPath, [
    `import { loadSettings } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'mcp/code-intel-server/core.js')).href)};`,
    'const settings = loadSettings(process.argv[2]);',
    'console.log(JSON.stringify({ command: settings.astGrep.command, extraDir: settings.path.extraDirs[0], sources: settings.sources }));'
  ].join('\n'));
  const childEnv = { ...process.env, USERPROFILE: fakeUserProfile };
  delete childEnv.HOME;
  delete childEnv.CODE_INTEL_DEFAULT_SETTINGS_PATH;
  delete childEnv.CODE_INTEL_USER_SETTINGS_PATH;
  delete childEnv.CODE_INTEL_PROJECT_SETTINGS_PATH;
  const fallbackRun = run('node', [childScriptPath, projectRoot], { cwd: maliciousCwd, env: childEnv });
  let fallbackOutput = null;
  try {
    fallbackOutput = JSON.parse(fallbackRun.stdout || '{}');
  } catch {
    fallbackOutput = null;
  }
  check(
    'settings uses USERPROFILE for default user settings when HOME is unset',
    fallbackRun.status === 0 && fallbackOutput?.command === 'profile-ast-grep',
    fallbackRun.stderr || fallbackRun.stdout
  );
  check(
    'settings does not read cwd-relative .codex as user settings when HOME is unset',
    fallbackRun.status === 0 && fallbackOutput?.sources?.user === profileSettingsPath,
    JSON.stringify(fallbackOutput)
  );
  check(
    'settings expands home with USERPROFILE when HOME is unset',
    fallbackRun.status === 0 && fallbackOutput?.extraDir === path.join(fakeUserProfile, 'code-intel-bin'),
    JSON.stringify(fallbackOutput)
  );
} finally {
  fs.rmSync(settingsHomeFallbackRoot, { recursive: true, force: true });
}
check('scripts executable or documented', ['scripts/init-code-intel.js','scripts/doctor-code-intel.js','scripts/validate-plugin.js'].every((f) => fs.statSync(path.join(ROOT, f)).mode & 0o111), 'init/doctor/validate executable');

// MCP contract validation
const list = run('node', ['mcp/code-intel-server/index.js', '--list-tools']);
check('MCP server list-tools starts', list.status === 0, list.stderr || list.stdout.slice(0, 200));
const framedInit = run(process.execPath, ['mcp/code-intel-server/index.js'], { input: initializeFrame() });
check('MCP framed initialize works', framedInitializeOk(framedInit), framedEvidence(framedInit));
const mcpServer = mcpManifestServer();
check('MCP manifest declares code-intel server', Boolean(mcpServer?.command && Array.isArray(mcpServer.args)), JSON.stringify(mcpServer || {}));
if (mcpServer?.command && Array.isArray(mcpServer.args)) {
  const manifestText = JSON.stringify(mcpServer);
  check('MCP manifest avoids checkout-specific absolute paths', !manifestText.includes('/Dev/codex-plugins/code-intel/'), manifestText);
  check('MCP manifest uses plugin-relative cwd', mcpServer.cwd === '.', JSON.stringify(mcpServer));
  const manifestInit = spawnSync(mcpServer.command, mcpServer.args, {
    cwd: resolvedManifestCwd(mcpServer),
    input: initializeFrame(),
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 10 * 1024 * 1024
  });
  check('MCP manifest starts with plugin-relative cwd', framedInitializeOk(manifestInit), framedEvidence(manifestInit));
}
const unsupportedFramedInit = run(process.execPath, ['mcp/code-intel-server/index.js'], { input: unsupportedInitializeFrame() });
check(
  'MCP initialize does not echo unsupported protocol versions',
  unsupportedFramedInit.status === 0 &&
    unsupportedFramedInit.stdout.includes('Content-Length:') &&
    unsupportedFramedInit.stdout.includes('"protocolVersion":"2024-11-05"') &&
    !unsupportedFramedInit.stdout.includes('2099-99-99'),
  framedEvidence(unsupportedFramedInit)
);
let listed = [];
try { listed = JSON.parse(list.stdout).tools.map((t) => t.name); } catch {}
check('tool list includes expected tools', EXPECTED_TOOLS.every((t) => listed.includes(t)), listed.join(', '));

// MCP server architecture validation
const requiredServerModules = [
  'settings.js',
  'repo.js',
  'capabilities.js',
  'ast-grep.js',
  'lsp.js',
  'audit.js',
  'audit-result.js',
  'tools.js'
];
for (const moduleFile of requiredServerModules) {
  check(`server boundary module exists: ${moduleFile}`, exists(path.join('mcp/code-intel-server', moduleFile)), moduleFile);
}
const coreSource = fs.readFileSync(path.join(ROOT, 'mcp/code-intel-server/core.js'), 'utf8');
const coreLineCount = coreSource.split(/\r?\n/).length;
check('core.js stays facade-sized', coreLineCount <= 260, `${coreLineCount} lines`);
const forbiddenCorePatterns = [
  [/function\s+postEditAudit\b/, 'post-edit audit use case belongs in audit.js'],
  [/function\s+gitChangedFiles\b/, 'git changed-file driver belongs in repo.js'],
  [/spawnSync\(['"]git['"]/, 'git subprocess calls belong in repo.js'],
  [/textDocument\/diagnostic[\s\S]+astGrepScan/, 'audit orchestration belongs in audit.js'],
  [/function\s+normalizeAstGrepJson\b/, 'ast-grep normalization belongs in ast-grep.js'],
  [/function\s+lspFrame\b/, 'LSP protocol framing belongs in lsp.js']
];
for (const [pattern, reason] of forbiddenCorePatterns) {
  check(`core.js boundary: ${reason}`, !pattern.test(coreSource), reason);
}

for (const tool of tools) check(`tool ${tool.name} schema`, Boolean(tool.name && tool.description && tool.inputSchema && tool.outputSchema), tool.description);
const discover = callTool('capability_discover', { repoRoot: ROOT });
check('capability_discover works', Boolean(discover.repoRoot && discover.settingsVersion === 1 && discover.tools?.astGrep?.command === 'ast-grep'), JSON.stringify({ repoRoot: discover.repoRoot, settingsVersion: discover.settingsVersion, astGrep: discover.tools?.astGrep?.command }));
const routeSemantic = callTool('capability_route', { repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'), file: 'src/math.ts', intent: 'semantic' });
check(
  'capability_route exposes semantic route decision',
  ['try-lsp', 'try-ast-grep', 'fallback'].includes(routeSemantic.status) &&
    routeSemantic.language === 'typescript' &&
    Array.isArray(routeSemantic.route) &&
    routeSemantic.route.length > 0,
  JSON.stringify(routeSemantic)
);
const routeAudit = callTool('capability_route', { repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'), file: 'src/math.ts', intent: 'audit' });
check(
  'capability_route exposes audit route decision',
  ['try-lsp', 'try-ast-grep', 'fallback'].includes(routeAudit.status) &&
    routeAudit.intent === 'audit' &&
    Array.isArray(routeAudit.route),
  JSON.stringify(routeAudit)
);
const windowsPathParts = splitCommandLine(String.raw`C:\Tools\pyright-langserver.cmd --stdio`);
check(
  'splitCommandLine preserves unquoted Windows path backslashes',
  windowsPathParts[0] === String.raw`C:\Tools\pyright-langserver.cmd` && windowsPathParts[1] === '--stdio',
  JSON.stringify(windowsPathParts)
);
const quotedWindowsPathParts = splitCommandLine(String.raw`"C:\Program Files\Pyright\pyright-langserver.cmd" --stdio`);
check(
  'splitCommandLine preserves quoted Windows path backslashes and spaces',
  quotedWindowsPathParts[0] === String.raw`C:\Program Files\Pyright\pyright-langserver.cmd` && quotedWindowsPathParts[1] === '--stdio',
  JSON.stringify(quotedWindowsPathParts)
);
const missingAst = callTool('ast_grep_search', { repoRoot: ROOT, language: 'definitely-unsupported', pattern: 'class $A' });
check('ast-grep unsupported language reports unavailable cleanly', missingAst.status === 'unavailable' && missingAst.fallbackReason.includes('unsupported'), JSON.stringify(missingAst));
const missingLsp = callTool('lsp_find_references', { repoRoot: ROOT, language: 'json', file: 'package.json', position: { line: 0, character: 0 } });
check('LSP tool reports unavailable cleanly when no server declared', missingLsp.status === 'unavailable' && missingLsp.fallbackReason, JSON.stringify(missingLsp));
const emptyToolPathRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-empty-path-'));
try {
  const emptyToolPath = path.join(emptyToolPathRoot, 'bin');
  fs.mkdirSync(emptyToolPath, { recursive: true });
  const noAstEnv = { ...process.env, PATH: emptyToolPath };
  const noAstLspFallbackRun = run(process.execPath, ['mcp/code-intel-server/index.js', '--call-tool', 'lsp_symbols', '--args', JSON.stringify({ repoRoot: ROOT, language: 'json', file: 'package.json' })], {
    env: noAstEnv
  });
  try {
    const noAstLspFallback = JSON.parse(noAstLspFallbackRun.stdout || '{}');
    check(
      'LSP unavailable fallback omits ast-grep when executable is missing',
      noAstLspFallback.status === 'unavailable' &&
        noAstLspFallback.fallbackUsed === 'rg/grep' &&
        noAstLspFallback.fallbackReason === 'LSP command missing',
      noAstLspFallbackRun.stdout.slice(0, 500) || noAstLspFallbackRun.stderr.slice(0, 500)
    );
  } catch (error) {
    check('LSP unavailable fallback omits ast-grep when executable is missing', false, error.message);
  }
  const noAstPath = run(process.execPath, ['mcp/code-intel-server/index.js', '--call-tool', 'ast_grep_search', '--args', JSON.stringify({ repoRoot: ROOT, language: 'typescript', pattern: 'class $A' })], { env: noAstEnv });
  try {
    const noAst = JSON.parse(noAstPath.stdout || '{}');
    check('missing ast-grep PATH simulation reports explicit fallback', noAst.status === 'unavailable' && noAst.fallbackReason.includes('ast-grep executable was not found') && noAst.commandPolicy.includes('sg'), noAstPath.stdout.slice(0, 500) || noAstPath.stderr.slice(0, 500));
  } catch (error) {
    check('missing ast-grep PATH simulation reports explicit fallback', false, error.message);
  }
} finally {
  fs.rmSync(emptyToolPathRoot, { recursive: true, force: true });
}
let missingScanConfig;
const originalScanUserSettingsPath = process.env.CODE_INTEL_USER_SETTINGS_PATH;
const originalScanProjectSettingsPath = process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
try {
  process.env.CODE_INTEL_USER_SETTINGS_PATH = path.join(os.tmpdir(), 'code-intel-missing-user-settings.json');
  process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = path.join(os.tmpdir(), 'code-intel-missing-project-settings.json');
  try { missingScanConfig = callTool('ast_grep_scan', { repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic') }); }
  catch (error) { missingScanConfig = { status: 'error', fallbackReason: error.message, fallback: [] }; }
} finally {
  if (originalScanUserSettingsPath === undefined) delete process.env.CODE_INTEL_USER_SETTINGS_PATH;
  else process.env.CODE_INTEL_USER_SETTINGS_PATH = originalScanUserSettingsPath;
  if (originalScanProjectSettingsPath === undefined) delete process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
  else process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = originalScanProjectSettingsPath;
}
check(
  'ast_grep_scan reports missing configPath cleanly',
  missingScanConfig.status === 'unavailable' &&
    /configPath/.test(missingScanConfig.fallbackReason || '') &&
    Array.isArray(missingScanConfig.fallback),
  JSON.stringify(missingScanConfig)
);
const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-scan-'));
try {
  fs.mkdirSync(path.join(scanRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(scanRoot, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(scanRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(scanRoot, 'src', 'main.ts'), 'console.log("scan-me");\n');
  fs.writeFileSync(path.join(scanRoot, 'rules', 'no-console.yml'), [
    'id: local.no-console',
    'message: console.log found',
    'severity: warning',
    'language: TypeScript',
    'rule:',
    '  pattern: console.log($$$ARGS)',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(scanRoot, 'sgconfig.yml'), [
    'ruleDirs:',
    '  - rules',
    ''
  ].join('\n'));
  const fakeScanAstGrep = path.join(scanRoot, 'bin', 'ast-grep');
  fs.writeFileSync(fakeScanAstGrep, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "ast-grep fake-scan"
    exit 0
  fi
done
printf '%s\n' '[{"file":"src/main.ts","ruleId":"local.no-console","message":"console.log found","severity":"warning"}]'
`);
  fs.chmodSync(fakeScanAstGrep, 0o755);
  fs.mkdirSync(path.join(scanRoot, '.code-intel'), { recursive: true });
  const scanSettingsPath = path.join(scanRoot, '.code-intel', 'settings.json');
  writeJson(scanSettingsPath, {
    version: 1,
    path: { extraDirs: ['./bin'] },
    astGrep: { command: 'ast-grep', configPath: './sgconfig.yml' }
  });
  let scanResult;
  let unsafeScanResult;
  let traversalScanResult;
  const originalConfiguredScanUserSettingsPath = process.env.CODE_INTEL_USER_SETTINGS_PATH;
  const originalConfiguredScanProjectSettingsPath = process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
  try {
    process.env.CODE_INTEL_USER_SETTINGS_PATH = path.join(scanRoot, 'missing-user-settings.json');
    process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = scanSettingsPath;
    try { scanResult = callTool('ast_grep_scan', { repoRoot: scanRoot, paths: ['src/main.ts'], maxResults: 5 }); }
    catch (error) { scanResult = { status: 'error', fallbackReason: error.message, results: [] }; }
    try { unsafeScanResult = callTool('ast_grep_scan', { repoRoot: scanRoot, paths: [path.join(scanRoot, 'src', 'main.ts')] }); }
    catch (error) { unsafeScanResult = { status: 'error', fallbackReason: error.message, results: [] }; }
    try { traversalScanResult = callTool('ast_grep_scan', { repoRoot: scanRoot, paths: ['../outside.ts'] }); }
    catch (error) { traversalScanResult = { status: 'error', fallbackReason: error.message, results: [] }; }
  } finally {
    if (originalConfiguredScanUserSettingsPath === undefined) delete process.env.CODE_INTEL_USER_SETTINGS_PATH;
    else process.env.CODE_INTEL_USER_SETTINGS_PATH = originalConfiguredScanUserSettingsPath;
    if (originalConfiguredScanProjectSettingsPath === undefined) delete process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
    else process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = originalConfiguredScanProjectSettingsPath;
  }
  const scanOk = scanResult.status === 'ok' &&
    scanResult.configPath === path.join(scanRoot, 'sgconfig.yml') &&
    scanResult.resolvedCommand === fakeScanAstGrep &&
    scanResult.results.some((row) => row.ruleId === 'local.no-console' && row.file && row.file.endsWith('src/main.ts'));
  check('ast_grep_scan executes configured rule scan when available', scanOk, JSON.stringify(scanResult).slice(0, 1000));
  check(
    'ast_grep_scan rejects unsafe paths before scanning',
    unsafeScanResult.status === 'unavailable' &&
      /repo-relative|escapes repo root|outside repo root/.test(unsafeScanResult.fallbackReason || '') &&
      traversalScanResult.status === 'unavailable' &&
      /repo-relative|escapes repo root|outside repo root/.test(traversalScanResult.fallbackReason || '') &&
      Array.isArray(unsafeScanResult.fallback),
    JSON.stringify({ absolute: unsafeScanResult, traversal: traversalScanResult }).slice(0, 1000)
  );
} finally {
  fs.rmSync(scanRoot, { recursive: true, force: true });
}
const extraPathAstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-extra-path-ast-'));
try {
  const emptyPathDir = path.join(extraPathAstRoot, 'empty-path');
  const extraAstDir = path.join(extraPathAstRoot, 'extra-bin');
  const astSettingsPath = path.join(extraPathAstRoot, 'settings.json');
  fs.mkdirSync(emptyPathDir, { recursive: true });
  fs.mkdirSync(extraAstDir, { recursive: true });
  const fakeAstGrep = path.join(extraAstDir, 'ast-grep');
  fs.writeFileSync(fakeAstGrep, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "ast-grep fake-extra-dir"
    exit 0
  fi
done
printf '%s\n' '[{"file":"extra.py","text":"fake match","language":"Python"}]'
`);
  fs.chmodSync(fakeAstGrep, 0o755);
  writeJson(astSettingsPath, {
    version: 1,
    path: { extraDirs: [extraAstDir] },
    astGrep: { command: 'ast-grep' }
  });
  const extraAstEnv = { ...process.env, PATH: emptyPathDir, CODE_INTEL_PROJECT_SETTINGS_PATH: astSettingsPath };
  const extraAstDiscoveryProbe = run(process.execPath, ['mcp/code-intel-server/index.js', '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: path.join(ROOT, 'fixtures/repos/python-basic') })], {
    env: extraAstEnv
  });
  const extraAstDiscovery = JSON.parse(extraAstDiscoveryProbe.stdout || '{}');
  check(
    'ast-grep discovery consults settings path extraDirs',
    extraAstDiscovery.tools?.astGrep?.available === true &&
      extraAstDiscovery.tools.astGrep.command === 'ast-grep' &&
      extraAstDiscovery.tools.astGrep.resolvedCommand === fakeAstGrep,
    extraAstDiscoveryProbe.stdout.slice(0, 800) || extraAstDiscoveryProbe.stderr.slice(0, 800)
  );
  const extraAstSearchProbe = run(process.execPath, ['mcp/code-intel-server/index.js', '--call-tool', 'ast_grep_search', '--args', JSON.stringify({ repoRoot: path.join(ROOT, 'fixtures/repos/python-basic'), language: 'python', pattern: 'Greeter()', maxResults: 5 })], {
    env: extraAstEnv
  });
  const extraAstSearch = JSON.parse(extraAstSearchProbe.stdout || '{}');
  check(
    'ast-grep search executes command from settings path extraDirs',
    extraAstSearch.status === 'ok' &&
      extraAstSearch.executable === 'ast-grep' &&
      extraAstSearch.resolvedCommand === fakeAstGrep &&
      extraAstSearch.results?.length === 1,
    extraAstSearchProbe.stdout.slice(0, 800) || extraAstSearchProbe.stderr.slice(0, 800)
  );
  const extraAstFallbackProbe = run(process.execPath, ['mcp/code-intel-server/index.js', '--call-tool', 'lsp_symbols', '--args', JSON.stringify({ repoRoot: ROOT, language: 'json', file: 'package.json' })], {
    env: extraAstEnv
  });
  const extraAstFallback = JSON.parse(extraAstFallbackProbe.stdout || '{}');
  check(
    'LSP fallback detection consults ast-grep settings path extraDirs',
    extraAstFallback.status === 'unavailable' &&
      extraAstFallback.fallbackUsed === 'ast-grep or rg/grep',
    extraAstFallbackProbe.stdout.slice(0, 800) || extraAstFallbackProbe.stderr.slice(0, 800)
  );
} catch (error) {
  check('ast-grep discovery consults settings path extraDirs', false, error.message);
  check('ast-grep search executes command from settings path extraDirs', false, error.message);
  check('LSP fallback detection consults ast-grep settings path extraDirs', false, error.message);
} finally {
  fs.rmSync(extraPathAstRoot, { recursive: true, force: true });
}
const relativeExtraPathAstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-relative-extra-path-ast-'));
try {
  const outsideCwd = path.join(relativeExtraPathAstRoot, 'outside-cwd');
  const targetRepo = path.join(relativeExtraPathAstRoot, 'repo');
  const repoBin = path.join(targetRepo, 'bin');
  const projectSettingsDir = path.join(targetRepo, '.code-intel');
  fs.mkdirSync(outsideCwd, { recursive: true });
  fs.mkdirSync(repoBin, { recursive: true });
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  fs.writeFileSync(path.join(targetRepo, 'extra.py'), 'print("extra")\n');
  const fakeAstGrep = path.join(repoBin, 'ast-grep');
  fs.writeFileSync(fakeAstGrep, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "ast-grep fake-relative-extra-dir"
    exit 0
  fi
done
printf '%s\n' '[{"file":"extra.py","text":"fake relative match","language":"Python"}]'
`);
  fs.chmodSync(fakeAstGrep, 0o755);
  writeJson(path.join(projectSettingsDir, 'settings.json'), {
    version: 1,
    path: { extraDirs: ['./bin'] },
    astGrep: { command: 'ast-grep' }
  });
  const relativeAstEnv = {
    ...process.env,
    PATH: path.join(relativeExtraPathAstRoot, 'empty-path'),
    CODE_INTEL_USER_SETTINGS_PATH: path.join(relativeExtraPathAstRoot, 'missing-user-settings.json')
  };
  fs.mkdirSync(relativeAstEnv.PATH, { recursive: true });
  const relativeAstDiscoveryProbe = run(process.execPath, [path.join(ROOT, 'mcp/code-intel-server/index.js'), '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: targetRepo })], {
    cwd: outsideCwd,
    env: relativeAstEnv
  });
  const relativeAstDiscovery = JSON.parse(relativeAstDiscoveryProbe.stdout || '{}');
  check(
    'ast-grep discovery resolves relative extraDirs from repoRoot',
    relativeAstDiscovery.tools?.astGrep?.available === true &&
      relativeAstDiscovery.tools.astGrep.resolvedCommand === fakeAstGrep,
    relativeAstDiscoveryProbe.stdout.slice(0, 800) || relativeAstDiscoveryProbe.stderr.slice(0, 800)
  );
  const relativeAstSearchProbe = run(process.execPath, [path.join(ROOT, 'mcp/code-intel-server/index.js'), '--call-tool', 'ast_grep_search', '--args', JSON.stringify({ repoRoot: targetRepo, language: 'python', pattern: 'print($A)', maxResults: 5 })], {
    cwd: outsideCwd,
    env: relativeAstEnv
  });
  const relativeAstSearch = JSON.parse(relativeAstSearchProbe.stdout || '{}');
  check(
    'ast-grep search executes relative extraDirs command from repoRoot',
    relativeAstSearch.status === 'ok' &&
      relativeAstSearch.resolvedCommand === fakeAstGrep &&
      relativeAstSearch.results?.length === 1,
    relativeAstSearchProbe.stdout.slice(0, 800) || relativeAstSearchProbe.stderr.slice(0, 800)
  );
} catch (error) {
  check('ast-grep discovery resolves relative extraDirs from repoRoot', false, error.message);
  check('ast-grep search executes relative extraDirs command from repoRoot', false, error.message);
} finally {
  fs.rmSync(relativeExtraPathAstRoot, { recursive: true, force: true });
}
const fakeLspRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-fake-lsp-'));
try {
  const fakeBinDir = path.join(fakeLspRoot, 'bin');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const fakeNoVersionLsp = path.join(fakeBinDir, 'fake-no-version-lsp');
  fs.writeFileSync(fakeNoVersionLsp, `#!/usr/bin/env node
if (process.argv.slice(2).includes('--version')) {
  console.error('fake-no-version-lsp: --version is intentionally unsupported');
  process.exit(7);
}
await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'fixtures/lsp/fake-lsp-server.js')).href)});
`);
  fs.chmodSync(fakeNoVersionLsp, 0o755);
  const fakeSettingsPath = path.join(fakeLspRoot, 'settings.json');
  const fakeLspEnv = {
    ...process.env,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ''}`,
    CODE_INTEL_DEFAULT_SETTINGS_PATH: fakeSettingsPath,
    CODE_INTEL_USER_SETTINGS_PATH: path.join(fakeLspRoot, 'missing-user-settings.json'),
    CODE_INTEL_PROJECT_SETTINGS_PATH: path.join(fakeLspRoot, 'missing-project-settings.json')
  };
  writeJson(fakeSettingsPath, {
    version: 1,
    path: { extraDirs: [fakeBinDir] },
    astGrep: { command: 'ast-grep', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      typescript: {
        extensions: ['.ts'],
        astGrep: { languageId: 'typescript' },
        lsp: { commands: ['fake-no-version-lsp --stdio'], capabilities: ['definition', 'references', 'rename', 'diagnostics', 'symbols'] }
      }
    }
  });
  const pathEscapeProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'lsp_symbols', '--args', JSON.stringify({ repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'), language: 'typescript', file: '../python-basic/example.py' })], {
    env: fakeLspEnv
  });
  const absolutePathProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'lsp_symbols', '--args', JSON.stringify({ repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'), language: 'typescript', file: path.join(ROOT, 'fixtures/repos/typescript-basic/src/math.ts') })], {
    env: fakeLspEnv
  });
  const pathEscapeOutput = JSON.parse(pathEscapeProbe.stdout || '{}');
  const absolutePathOutput = JSON.parse(absolutePathProbe.stdout || '{}');
  check('LSP rejects repo path traversal before reading files', pathEscapeOutput.status === 'unavailable' && /escapes repo root|outside repo root/.test(pathEscapeOutput.fallbackReason || ''), pathEscapeProbe.stdout.slice(0, 500) || pathEscapeProbe.stderr.slice(0, 500));
  check('LSP rejects absolute file paths before reading files', absolutePathOutput.status === 'unavailable' && /repo-relative/.test(absolutePathOutput.fallbackReason || ''), absolutePathProbe.stdout.slice(0, 500) || absolutePathProbe.stderr.slice(0, 500));
  const lspDiscoveryProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic') })], {
    env: fakeLspEnv
  });
  const lspDiscovery = JSON.parse(lspDiscoveryProbe.stdout || '{}');
  check(
    'LSP executable detection does not require --version support',
    lspDiscovery.languages?.typescript?.lsp === 'commandDetected' && lspDiscovery.languages.typescript.lspCommand === 'fake-no-version-lsp --stdio',
    lspDiscoveryProbe.stdout.slice(0, 800) || lspDiscoveryProbe.stderr.slice(0, 800)
  );
  const lspProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'lsp_symbols', '--args', JSON.stringify({ repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'), file: 'src/math.ts' })], {
    env: fakeLspEnv
  });
  const lspOutput = JSON.parse(lspProbe.stdout || '{}');
  check('LSP tools execute real JSON-RPC operation when server is available', lspProbe.status === 0 && lspOutput.status === 'ok' && lspOutput.method === 'textDocument/documentSymbol' && lspOutput.lspState === 'methodVerified' && Array.isArray(lspOutput.result), lspProbe.stdout.slice(0, 500) || lspProbe.stderr.slice(0, 500));
} catch (error) {
  check('LSP tools execute real JSON-RPC operation when server is available', false, error.message);
} finally {
  fs.rmSync(fakeLspRoot, { recursive: true, force: true });
}
const extraPathLspRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-extra-path-lsp-'));
try {
  const targetRepo = path.join(extraPathLspRoot, 'repo');
  const extraBinDir = path.join(extraPathLspRoot, 'extra-bin');
  fs.mkdirSync(path.join(targetRepo, 'src'), { recursive: true });
  fs.mkdirSync(extraBinDir, { recursive: true });
  fs.writeFileSync(path.join(targetRepo, 'src', 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

  const extraLsp = path.join(extraBinDir, 'fake-extra-path-lsp');
  fs.writeFileSync(extraLsp, `#!/usr/bin/env node
await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'fixtures/lsp/fake-lsp-server.js')).href)});
`);
  fs.chmodSync(extraLsp, 0o755);

  const extraSettingsPath = path.join(extraPathLspRoot, 'settings.json');
  writeJson(extraSettingsPath, {
    version: 1,
    path: { extraDirs: [extraBinDir] },
    astGrep: { command: 'ast-grep', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      typescript: {
        extensions: ['.ts'],
        astGrep: { languageId: 'typescript' },
        lsp: { commands: ['fake-extra-path-lsp --stdio'], capabilities: ['symbols'] }
      }
    }
  });
  const extraEnv = {
    ...process.env,
    CODE_INTEL_DEFAULT_SETTINGS_PATH: extraSettingsPath,
    CODE_INTEL_USER_SETTINGS_PATH: path.join(extraPathLspRoot, 'missing-user-settings.json'),
    CODE_INTEL_PROJECT_SETTINGS_PATH: path.join(extraPathLspRoot, 'missing-project-settings.json')
  };
  const extraDiscoveryProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: targetRepo })], {
    env: extraEnv
  });
  const extraDiscovery = JSON.parse(extraDiscoveryProbe.stdout || '{}');
  check(
    'LSP executable detection consults settings path extraDirs',
    extraDiscovery.languages?.typescript?.lsp === 'commandDetected' &&
      extraDiscovery.languages.typescript.lspCommands?.[0]?.executablePath === extraLsp,
    extraDiscoveryProbe.stdout.slice(0, 800) || extraDiscoveryProbe.stderr.slice(0, 800)
  );

  const extraLspProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'lsp_symbols', '--args', JSON.stringify({ repoRoot: targetRepo, file: 'src/math.ts' })], {
    env: extraEnv
  });
  const extraLspOutput = JSON.parse(extraLspProbe.stdout || '{}');
  check(
    'LSP tools execute commands found through settings path extraDirs',
    extraLspProbe.status === 0 && extraLspOutput.status === 'ok' && extraLspOutput.lspState === 'methodVerified' && extraLspOutput.language === 'typescript',
    extraLspProbe.stdout.slice(0, 800) || extraLspProbe.stderr.slice(0, 800)
  );
} catch (error) {
  check('LSP executable detection consults settings path extraDirs', false, error.message);
  check('LSP tools execute commands found through settings path extraDirs', false, error.message);
} finally {
  fs.rmSync(extraPathLspRoot, { recursive: true, force: true });
}
const relativeLspRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-relative-lsp-'));
try {
  const targetRepo = path.join(relativeLspRoot, 'repo');
  const localBin = path.join(targetRepo, 'node_modules', '.bin');
  fs.mkdirSync(path.join(targetRepo, 'src'), { recursive: true });
  fs.mkdirSync(localBin, { recursive: true });
  fs.writeFileSync(path.join(targetRepo, 'src', 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

  const localLsp = path.join(localBin, 'fake-relative-lsp');
  fs.writeFileSync(localLsp, `#!/usr/bin/env node
await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'fixtures/lsp/fake-lsp-server.js')).href)});
`);
  fs.chmodSync(localLsp, 0o755);

  const relativeSettingsPath = path.join(relativeLspRoot, 'settings.json');
  writeJson(relativeSettingsPath, {
    version: 1,
    path: { extraDirs: [] },
    astGrep: { command: 'ast-grep', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      typescript: {
        extensions: ['.ts'],
        astGrep: { languageId: 'typescript' },
        lsp: { commands: ['./node_modules/.bin/fake-relative-lsp --stdio'], capabilities: ['symbols'] }
      }
    }
  });

  const relativeEnv = {
    ...process.env,
    CODE_INTEL_DEFAULT_SETTINGS_PATH: relativeSettingsPath,
    CODE_INTEL_USER_SETTINGS_PATH: path.join(relativeLspRoot, 'missing-user-settings.json'),
    CODE_INTEL_PROJECT_SETTINGS_PATH: path.join(relativeLspRoot, 'missing-project-settings.json')
  };
  const relativeDiscoveryProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: targetRepo })], {
    env: relativeEnv
  });
  const relativeDiscovery = JSON.parse(relativeDiscoveryProbe.stdout || '{}');
  check(
    'LSP executable detection resolves relative commands from repoRoot',
    relativeDiscovery.languages?.typescript?.lsp === 'commandDetected' &&
      relativeDiscovery.languages.typescript.lspCommand === './node_modules/.bin/fake-relative-lsp --stdio',
    relativeDiscoveryProbe.stdout.slice(0, 800) || relativeDiscoveryProbe.stderr.slice(0, 800)
  );

  const relativeLspProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'lsp_symbols', '--args', JSON.stringify({ repoRoot: targetRepo, file: 'src/math.ts' })], {
    env: relativeEnv
  });
  const relativeLspOutput = JSON.parse(relativeLspProbe.stdout || '{}');
  check(
    'LSP tools execute repo-relative command candidates from repoRoot',
    relativeLspProbe.status === 0 && relativeLspOutput.status === 'ok' && relativeLspOutput.lspState === 'methodVerified',
    relativeLspProbe.stdout.slice(0, 800) || relativeLspProbe.stderr.slice(0, 800)
  );
} catch (error) {
  check('LSP executable detection resolves relative commands from repoRoot', false, error.message);
  check('LSP tools execute repo-relative command candidates from repoRoot', false, error.message);
} finally {
  fs.rmSync(relativeLspRoot, { recursive: true, force: true });
}
const relativeExtraPathLspRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-relative-extra-path-lsp-'));
try {
  const outsideCwd = path.join(relativeExtraPathLspRoot, 'outside-cwd');
  const targetRepo = path.join(relativeExtraPathLspRoot, 'repo');
  const repoBin = path.join(targetRepo, 'bin');
  const projectSettingsDir = path.join(targetRepo, '.code-intel');
  fs.mkdirSync(outsideCwd, { recursive: true });
  fs.mkdirSync(path.join(targetRepo, 'src'), { recursive: true });
  fs.mkdirSync(repoBin, { recursive: true });
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  fs.writeFileSync(path.join(targetRepo, 'src', 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

  const localLsp = path.join(repoBin, 'fake-local-lsp');
  fs.writeFileSync(localLsp, `#!/usr/bin/env node
await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'fixtures/lsp/fake-lsp-server.js')).href)});
`);
  fs.chmodSync(localLsp, 0o755);

  writeJson(path.join(projectSettingsDir, 'settings.json'), {
    version: 1,
    path: { extraDirs: ['./bin'] },
    astGrep: { command: 'ast-grep', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      typescript: {
        extensions: ['.ts'],
        astGrep: { languageId: 'typescript' },
        lsp: { commands: ['fake-local-lsp --stdio'], capabilities: ['symbols'] }
      }
    }
  });

  const relativeExtraEnv = {
    ...process.env,
    CODE_INTEL_USER_SETTINGS_PATH: path.join(relativeExtraPathLspRoot, 'missing-user-settings.json')
  };
  const relativeExtraDiscoveryProbe = run(process.execPath, [path.join(ROOT, 'mcp/code-intel-server/index.js'), '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: targetRepo })], {
    cwd: outsideCwd,
    env: relativeExtraEnv
  });
  const relativeExtraDiscovery = JSON.parse(relativeExtraDiscoveryProbe.stdout || '{}');
  check(
    'LSP executable detection resolves relative extraDirs from repoRoot',
    relativeExtraDiscovery.languages?.typescript?.lsp === 'commandDetected' &&
      relativeExtraDiscovery.languages.typescript.lspCommands?.[0]?.executablePath === localLsp,
    relativeExtraDiscoveryProbe.stdout.slice(0, 800) || relativeExtraDiscoveryProbe.stderr.slice(0, 800)
  );

  const relativeExtraLspProbe = run(process.execPath, [path.join(ROOT, 'mcp/code-intel-server/index.js'), '--call-tool', 'lsp_symbols', '--args', JSON.stringify({ repoRoot: targetRepo, file: 'src/math.ts' })], {
    cwd: outsideCwd,
    env: relativeExtraEnv
  });
  const relativeExtraLspOutput = JSON.parse(relativeExtraLspProbe.stdout || '{}');
  check(
    'LSP tools execute relative extraDirs command from repoRoot',
    relativeExtraLspProbe.status === 0 && relativeExtraLspOutput.status === 'ok' && relativeExtraLspOutput.lspState === 'methodVerified',
    relativeExtraLspProbe.stdout.slice(0, 800) || relativeExtraLspProbe.stderr.slice(0, 800)
  );
} catch (error) {
  check('LSP executable detection resolves relative extraDirs from repoRoot', false, error.message);
  check('LSP tools execute relative extraDirs command from repoRoot', false, error.message);
} finally {
  fs.rmSync(relativeExtraPathLspRoot, { recursive: true, force: true });
}
const strictLspRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-strict-lsp-'));
try {
  const strictSettingsPath = path.join(strictLspRoot, 'settings.json');
  writeJson(strictSettingsPath, {
    version: 1,
    path: { extraDirs: [] },
    astGrep: { command: 'ast-grep', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      typescript: {
        extensions: ['.ts'],
        astGrep: { languageId: 'typescript' },
        lsp: { commands: [`node "${path.join(ROOT, 'fixtures/lsp/strict-init-lsp-server.js')}"`], capabilities: ['definition', 'references', 'rename', 'diagnostics', 'symbols'] }
      }
    }
  });
  const strictProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'lsp_symbols', '--args', JSON.stringify({ repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'), file: 'src/math.ts', timeoutMs: 5000 })], {
    env: {
      ...process.env,
      CODE_INTEL_DEFAULT_SETTINGS_PATH: strictSettingsPath,
      CODE_INTEL_USER_SETTINGS_PATH: path.join(strictLspRoot, 'missing-user-settings.json'),
      CODE_INTEL_PROJECT_SETTINGS_PATH: path.join(strictLspRoot, 'missing-project-settings.json')
    }
  });
  const strictOutput = JSON.parse(strictProbe.stdout || '{}');
  check(
    'LSP client waits for initialize before sending follow-up messages',
    strictProbe.status === 0 && strictOutput.status === 'ok' && strictOutput.serverInfo?.name === 'code-intel-strict-init-lsp' && Array.isArray(strictOutput.result),
    strictProbe.stdout.slice(0, 800) || strictProbe.stderr.slice(0, 800)
  );
} catch (error) {
  check('LSP client waits for initialize before sending follow-up messages', false, error.message);
} finally {
  fs.rmSync(strictLspRoot, { recursive: true, force: true });
}
const previewBefore = fs.readFileSync(path.join(ROOT, 'fixtures/repos/typescript-basic/src/math.ts'), 'utf8');
const previewResult = callTool('ast_grep_replace_preview', { repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'), language: 'typescript', pattern: 'add($A, $B)', replacement: 'sum($A, $B)', maxResults: 5 });
const previewAfter = fs.readFileSync(path.join(ROOT, 'fixtures/repos/typescript-basic/src/math.ts'), 'utf8');
check('preview tools do not mutate files', previewBefore === previewAfter, 'typescript fixture unchanged');
const previewUnavailable = previewResult.status === 'unavailable';
const previewOk = previewResult.status === 'ok';
check(
  'replace preview degrades cleanly when ast-grep is unavailable',
  previewUnavailable
    ? previewResult.previewOnly === true &&
      previewResult.mutated === false &&
      Array.isArray(previewResult.fallback) &&
      previewResult.fallback.includes('rg') &&
      /ast-grep executable was not found/.test(previewResult.fallbackReason || '')
    : true,
  JSON.stringify(previewResult).slice(0, 800)
);
check(
  'replace preview is honest match-only unless substitution is proven',
  previewUnavailable ||
    (previewOk &&
      previewResult.previewOnly === true &&
      previewResult.mutated === false &&
      previewResult.mode === 'match-only' &&
      previewResult.manualEditRequired === true &&
      (previewResult.patchCandidates || []).every((candidate) =>
        !Object.prototype.hasOwnProperty.call(candidate, 'after') &&
        candidate.replacementTemplate
      )),
  JSON.stringify(previewResult).slice(0, 800)
);
check(
  'ast-grep result rows include language evidence when preview is available',
  previewUnavailable ||
    (previewResult.patchCandidates || []).every((candidate) => candidate.confidence === 'ast-grep'),
  JSON.stringify(previewResult).slice(0, 500)
);
let auditResult;
try {
  auditResult = callTool('post_edit_audit', {
    repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'),
    files: ['src/math.ts'],
    timeoutMs: 5000
  });
} catch (error) {
  auditResult = { status: 'error', diagnostics: [], astGrepScan: null, fallbackReason: error.message };
}
check(
  'post_edit_audit returns per-file diagnostic evidence or fallback',
  auditResult.status === 'ok' &&
    auditResult.files.includes('src/math.ts') &&
    Array.isArray(auditResult.diagnostics) &&
    auditResult.diagnostics.some((row) => row.file === 'src/math.ts' && ['ok', 'unavailable', 'error'].includes(row.status)),
  JSON.stringify(auditResult).slice(0, 1000)
);
check(
  'post_edit_audit reports AST scan availability separately',
  auditResult.status === 'ok' &&
    auditResult.astGrepScan &&
    ['ok', 'unavailable', 'error'].includes(auditResult.astGrepScan.status),
  JSON.stringify(auditResult.astGrepScan).slice(0, 1000)
);
const auditGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-audit-git-'));
try {
  fs.mkdirSync(path.join(auditGitRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(auditGitRoot, 'src', 'changed.ts'), 'export const value: number = 1;\n');
  run('git', ['init'], { cwd: auditGitRoot });
  run('git', ['config', 'user.email', 'code-intel@example.invalid'], { cwd: auditGitRoot });
  run('git', ['config', 'user.name', 'Code Intel'], { cwd: auditGitRoot });
  run('git', ['add', 'src/changed.ts'], { cwd: auditGitRoot });
  run('git', ['commit', '-m', 'seed'], { cwd: auditGitRoot });
  fs.writeFileSync(path.join(auditGitRoot, 'src', 'changed.ts'), 'export const value: number = 2;\n');
  const auditSettingsPath = path.join(auditGitRoot, 'settings.json');
  writeJson(auditSettingsPath, {
    version: 1,
    path: { extraDirs: [] },
    astGrep: { command: 'missing-ast-grep-for-audit', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      typescript: {
        extensions: ['.ts'],
        astGrep: { languageId: 'typescript' },
        lsp: { commands: [], capabilities: ['diagnostics'] }
      }
    }
  });
  run('git', ['add', 'settings.json'], { cwd: auditGitRoot });
  run('git', ['commit', '-m', 'settings'], { cwd: auditGitRoot });
  const originalAuditDefaultSettingsPath = process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH;
  const originalAuditUserSettingsPath = process.env.CODE_INTEL_USER_SETTINGS_PATH;
  const originalAuditProjectSettingsPath = process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
  let gitAudit;
  try {
    process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH = auditSettingsPath;
    process.env.CODE_INTEL_USER_SETTINGS_PATH = path.join(auditGitRoot, 'missing-user-settings.json');
    process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = path.join(auditGitRoot, 'missing-project-settings.json');
    try { gitAudit = callTool('post_edit_audit', { repoRoot: auditGitRoot, timeoutMs: 1000 }); }
    catch (error) { gitAudit = { status: 'error', files: [], diagnostics: [], astGrepScan: null, fallbackReason: error.message }; }
  } finally {
    if (originalAuditDefaultSettingsPath === undefined) delete process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH;
    else process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH = originalAuditDefaultSettingsPath;
    if (originalAuditUserSettingsPath === undefined) delete process.env.CODE_INTEL_USER_SETTINGS_PATH;
    else process.env.CODE_INTEL_USER_SETTINGS_PATH = originalAuditUserSettingsPath;
    if (originalAuditProjectSettingsPath === undefined) delete process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
    else process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = originalAuditProjectSettingsPath;
  }
  check(
    'post_edit_audit discovers git changed files with isolated settings',
    gitAudit.status === 'ok' &&
      gitAudit.fileSource === 'git diff' &&
      gitAudit.files.includes('src/changed.ts') &&
      gitAudit.diagnostics.some((row) => row.file === 'src/changed.ts' && row.status === 'unavailable' && row.fallbackReason === 'LSP command missing') &&
      gitAudit.astGrepScan?.status === 'unavailable' &&
      /configPath/.test(gitAudit.astGrepScan.fallbackReason || ''),
    JSON.stringify(gitAudit).slice(0, 1000)
  );
} finally {
  fs.rmSync(auditGitRoot, { recursive: true, force: true });
}
const auditUntrackedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-audit-untracked-'));
try {
  fs.mkdirSync(path.join(auditUntrackedRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(auditUntrackedRoot, 'README.md'), '# seed\n');
  run('git', ['init'], { cwd: auditUntrackedRoot });
  run('git', ['config', 'user.email', 'code-intel@example.invalid'], { cwd: auditUntrackedRoot });
  run('git', ['config', 'user.name', 'Code Intel'], { cwd: auditUntrackedRoot });
  run('git', ['add', 'README.md'], { cwd: auditUntrackedRoot });
  run('git', ['commit', '-m', 'seed'], { cwd: auditUntrackedRoot });
  const auditSettingsPath = path.join(auditUntrackedRoot, 'settings.json');
  writeJson(auditSettingsPath, {
    version: 1,
    path: { extraDirs: [] },
    astGrep: { command: 'missing-ast-grep-for-audit', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      typescript: {
        extensions: ['.ts'],
        astGrep: { languageId: 'typescript' },
        lsp: { commands: [], capabilities: ['diagnostics'] }
      }
    }
  });
  run('git', ['add', 'settings.json'], { cwd: auditUntrackedRoot });
  run('git', ['commit', '-m', 'settings'], { cwd: auditUntrackedRoot });
  fs.writeFileSync(path.join(auditUntrackedRoot, 'src', 'new.ts'), 'export const value = 1;\n');
  const originalAuditDefaultSettingsPath = process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH;
  const originalAuditUserSettingsPath = process.env.CODE_INTEL_USER_SETTINGS_PATH;
  const originalAuditProjectSettingsPath = process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
  let untrackedAudit;
  try {
    process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH = auditSettingsPath;
    process.env.CODE_INTEL_USER_SETTINGS_PATH = path.join(auditUntrackedRoot, 'missing-user-settings.json');
    process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = path.join(auditUntrackedRoot, 'missing-project-settings.json');
    try { untrackedAudit = callTool('post_edit_audit', { repoRoot: auditUntrackedRoot, timeoutMs: 1000 }); }
    catch (error) { untrackedAudit = { status: 'error', files: [], diagnostics: [], astGrepScan: null, fallbackReason: error.message }; }
  } finally {
    if (originalAuditDefaultSettingsPath === undefined) delete process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH;
    else process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH = originalAuditDefaultSettingsPath;
    if (originalAuditUserSettingsPath === undefined) delete process.env.CODE_INTEL_USER_SETTINGS_PATH;
    else process.env.CODE_INTEL_USER_SETTINGS_PATH = originalAuditUserSettingsPath;
    if (originalAuditProjectSettingsPath === undefined) delete process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
    else process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = originalAuditProjectSettingsPath;
  }
  check(
    'post_edit_audit includes untracked git files',
    untrackedAudit.status === 'ok' &&
      untrackedAudit.files.includes('src/new.ts') &&
      untrackedAudit.diagnostics.some((row) => row.file === 'src/new.ts'),
    JSON.stringify(untrackedAudit).slice(0, 1000)
  );
} finally {
  fs.rmSync(auditUntrackedRoot, { recursive: true, force: true });
}
function writeNoScanAuditSettings(root, markerFile) {
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeAstGrep = path.join(binDir, 'ast-grep');
  fs.writeFileSync(fakeAstGrep, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "ast-grep fake-audit"
    exit 0
  fi
done
echo "called" > ${JSON.stringify(markerFile)}
printf '%s\n' '[]'
`);
  fs.chmodSync(fakeAstGrep, 0o755);
  const settingsPath = path.join(root, 'settings.json');
  writeJson(settingsPath, {
    version: 1,
    path: { extraDirs: [binDir] },
    astGrep: { command: 'ast-grep', configPath: './sgconfig.yml' },
    fallback: ['rg', 'grep'],
    languages: {}
  });
  fs.writeFileSync(path.join(root, 'sgconfig.yml'), 'ruleDirs: []\n');
  return settingsPath;
}
const auditNoChangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-audit-no-change-'));
try {
  fs.writeFileSync(path.join(auditNoChangeRoot, 'README.md'), '# seed\n');
  run('git', ['init'], { cwd: auditNoChangeRoot });
  run('git', ['config', 'user.email', 'code-intel@example.invalid'], { cwd: auditNoChangeRoot });
  run('git', ['config', 'user.name', 'Code Intel'], { cwd: auditNoChangeRoot });
  run('git', ['add', 'README.md'], { cwd: auditNoChangeRoot });
  run('git', ['commit', '-m', 'seed'], { cwd: auditNoChangeRoot });
  const markerFile = path.join(auditNoChangeRoot, 'ast-grep-called');
  const settingsPath = writeNoScanAuditSettings(auditNoChangeRoot, markerFile);
  run('git', ['add', 'bin/ast-grep', 'settings.json', 'sgconfig.yml'], { cwd: auditNoChangeRoot });
  run('git', ['commit', '-m', 'settings'], { cwd: auditNoChangeRoot });
  const originalAuditDefaultSettingsPath = process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH;
  const originalAuditUserSettingsPath = process.env.CODE_INTEL_USER_SETTINGS_PATH;
  const originalAuditProjectSettingsPath = process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
  let noChangeAudit;
  try {
    process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH = settingsPath;
    process.env.CODE_INTEL_USER_SETTINGS_PATH = path.join(auditNoChangeRoot, 'missing-user-settings.json');
    process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = path.join(auditNoChangeRoot, 'missing-project-settings.json');
    try { noChangeAudit = callTool('post_edit_audit', { repoRoot: auditNoChangeRoot, timeoutMs: 1000 }); }
    catch (error) { noChangeAudit = { status: 'error', files: [], diagnostics: [], astGrepScan: null, fallbackReason: error.message }; }
  } finally {
    if (originalAuditDefaultSettingsPath === undefined) delete process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH;
    else process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH = originalAuditDefaultSettingsPath;
    if (originalAuditUserSettingsPath === undefined) delete process.env.CODE_INTEL_USER_SETTINGS_PATH;
    else process.env.CODE_INTEL_USER_SETTINGS_PATH = originalAuditUserSettingsPath;
    if (originalAuditProjectSettingsPath === undefined) delete process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
    else process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = originalAuditProjectSettingsPath;
  }
  check(
    'post_edit_audit skips ast-grep scan when git has no changed files',
    noChangeAudit.status === 'ok' &&
      noChangeAudit.files.length === 0 &&
      noChangeAudit.astGrepScan?.status === 'unavailable' &&
      /no changed files/.test(noChangeAudit.astGrepScan.fallbackReason || '') &&
      !fs.existsSync(markerFile),
    JSON.stringify(noChangeAudit).slice(0, 1000)
  );
} finally {
  fs.rmSync(auditNoChangeRoot, { recursive: true, force: true });
}
const auditNonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-audit-non-git-'));
try {
  fs.writeFileSync(path.join(auditNonGitRoot, 'README.md'), '# seed\n');
  const markerFile = path.join(auditNonGitRoot, 'ast-grep-called');
  const settingsPath = writeNoScanAuditSettings(auditNonGitRoot, markerFile);
  const originalAuditDefaultSettingsPath = process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH;
  const originalAuditUserSettingsPath = process.env.CODE_INTEL_USER_SETTINGS_PATH;
  const originalAuditProjectSettingsPath = process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
  let nonGitAudit;
  try {
    process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH = settingsPath;
    process.env.CODE_INTEL_USER_SETTINGS_PATH = path.join(auditNonGitRoot, 'missing-user-settings.json');
    process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = path.join(auditNonGitRoot, 'missing-project-settings.json');
    try { nonGitAudit = callTool('post_edit_audit', { repoRoot: auditNonGitRoot, timeoutMs: 1000 }); }
    catch (error) { nonGitAudit = { status: 'error', files: [], diagnostics: [], astGrepScan: null, fallbackReason: error.message }; }
  } finally {
    if (originalAuditDefaultSettingsPath === undefined) delete process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH;
    else process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH = originalAuditDefaultSettingsPath;
    if (originalAuditUserSettingsPath === undefined) delete process.env.CODE_INTEL_USER_SETTINGS_PATH;
    else process.env.CODE_INTEL_USER_SETTINGS_PATH = originalAuditUserSettingsPath;
    if (originalAuditProjectSettingsPath === undefined) delete process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
    else process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = originalAuditProjectSettingsPath;
  }
  check(
    'post_edit_audit skips ast-grep scan when git discovery fails',
    nonGitAudit.status === 'ok' &&
      nonGitAudit.files.length === 0 &&
      nonGitAudit.astGrepScan?.status === 'unavailable' &&
      /git diff failed/.test(nonGitAudit.astGrepScan.fallbackReason || '') &&
      !fs.existsSync(markerFile),
    JSON.stringify(nonGitAudit).slice(0, 1000)
  );
} finally {
  fs.rmSync(auditNonGitRoot, { recursive: true, force: true });
}

// Init workflow validation
const initTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-fixtures-'));
try {
  for (const fixture of ['typescript-basic','python-basic','mixed-no-lsp','unsupported-language']) {
    const sourceFixtureRoot = path.join(ROOT, 'fixtures/repos', fixture);
    const fixtureRoot = path.join(initTmpRoot, fixture);
    fs.cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: (src) => !src.includes(`${path.sep}docs${path.sep}code-intel`) });
    const first = run('node', ['scripts/init-code-intel.js', '--repo', fixtureRoot, '--json']);
    const second = run('node', ['scripts/init-code-intel.js', '--repo', fixtureRoot, '--json']);
    check(`init ${fixture} succeeds twice`, first.status === 0 && second.status === 0, (first.stderr || second.stderr || '').slice(0, 300));
    for (const report of ['capability-report.md','routing-profile.json','validation-report.md']) check(`init ${fixture} writes ${report}`, fs.existsSync(path.join(fixtureRoot, 'docs/code-intel', report)), report);
    const profile = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'docs/code-intel/routing-profile.json'), 'utf8'));
    check(`init ${fixture} records settings version`, Boolean(profile.settingsVersion), String(profile.settingsVersion));
    check(`init ${fixture} records settings sources`, Boolean(profile.settingsSources), JSON.stringify(profile.settingsSources));
    const retiredProfileVersionField = ['ad', 'apter', 'Reg', 'istryVersion'].join('');
    check(`init ${fixture} omits retired capability version`, !Object.hasOwn(profile, retiredProfileVersionField), JSON.stringify({ [retiredProfileVersionField]: profile[retiredProfileVersionField] }));
    check(`init ${fixture} records ast-grep command`, profile.tools.astGrep.command === 'ast-grep', profile.tools.astGrep.command);
    check(`init ${fixture} records per-language ast-grep smoke`, Object.values(profile.languages || {}).every((language) => language.astGrepSmoke && ['passed','skipped','failed'].includes(language.astGrepSmoke.status)), JSON.stringify(profile.languages));
    check(`init ${fixture} records optional LSP initialize smoke`, Object.values(profile.languages || {}).every((language) => language.lspInitializeSmoke && ['passed','skipped','failed'].includes(language.lspInitializeSmoke.status)), JSON.stringify(profile.languages));
    check(`init ${fixture} fallback explicit`, Boolean(profile.commandPolicy && profile.tools.astGrep.note), profile.commandPolicy);
  }
} finally {
  fs.rmSync(initTmpRoot, { recursive: true, force: true });
}
const initAstSettingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-init-ast-settings-'));
try {
  const emptyPathDir = path.join(initAstSettingsRoot, 'empty-path');
  const extraAstDir = path.join(initAstSettingsRoot, 'extra-bin');
  const repoRoot = path.join(initAstSettingsRoot, 'repo');
  const projectSettingsDir = path.join(repoRoot, '.code-intel');
  fs.mkdirSync(emptyPathDir, { recursive: true });
  fs.mkdirSync(extraAstDir, { recursive: true });
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'fixtures/repos/python-basic'), repoRoot, { recursive: true });
  const fakeAstGrep = path.join(extraAstDir, 'ast-grep');
  fs.writeFileSync(fakeAstGrep, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "ast-grep fake-init-extra-dir"
    exit 0
  fi
done
printf '%s\n' '[{"file":"example.py","text":"fake init smoke","language":"Python"}]'
`);
  fs.chmodSync(fakeAstGrep, 0o755);
  writeJson(path.join(projectSettingsDir, 'settings.json'), {
    version: 1,
    path: { extraDirs: [extraAstDir] },
    astGrep: { command: 'ast-grep' }
  });
  const initRun = run(process.execPath, ['scripts/init-code-intel.js', '--repo', repoRoot, '--json'], {
    env: { ...process.env, PATH: emptyPathDir }
  });
  const profile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/code-intel/routing-profile.json'), 'utf8'));
  check(
    'init ast-grep smoke uses effective settings command path',
    initRun.status === 0 &&
      profile.tools?.astGrep?.resolvedCommand === fakeAstGrep &&
      profile.languages?.python?.astGrepSmoke?.status === 'passed' &&
      profile.languages.python.astGrepSmoke.resolvedCommand === fakeAstGrep,
    initRun.stderr || JSON.stringify(profile.languages?.python?.astGrepSmoke || {})
  );
} catch (error) {
  check('init ast-grep smoke uses effective settings command path', false, error.message);
} finally {
  fs.rmSync(initAstSettingsRoot, { recursive: true, force: true });
}
const freshDoctorTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-fresh-doctor-'));
try {
  fs.cpSync(path.join(ROOT, 'fixtures/repos/typescript-basic'), freshDoctorTmpRoot, { recursive: true });
  const initRun = run('node', ['scripts/init-code-intel.js', '--repo', freshDoctorTmpRoot, '--json']);
  const doctorRun = run('node', ['scripts/doctor-code-intel.js', '--repo', freshDoctorTmpRoot, '--json']);
  const doctor = JSON.parse(doctorRun.stdout || '{}');
  const reasons = (doctor.findings || []).map((finding) => finding.reason);
  check('fresh init then doctor does not report generated report inventory mismatch', initRun.status === 0 && doctorRun.status === 0 && !reasons.includes('language inventory major mismatch'), reasons.join(' | '));

  const profilePath = path.join(freshDoctorTmpRoot, 'docs/code-intel/routing-profile.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  profile.settingsSources = { project: profile.settingsSources.project, user: profile.settingsSources.user, default: profile.settingsSources.default };
  writeJson(profilePath, profile);
  const reorderedRun = run('node', ['scripts/doctor-code-intel.js', '--repo', freshDoctorTmpRoot, '--json']);
  const reorderedDoctor = JSON.parse(reorderedRun.stdout || '{}');
  const reorderedReasons = (reorderedDoctor.findings || []).map((finding) => finding.reason);
  check('doctor treats reordered settings sources as equivalent', reorderedRun.status === 0 && !reorderedReasons.includes('settings source differs'), reorderedReasons.join(' | '));

  profile.settingsSources = { ...profile.settingsSources, default: 'stale-settings-source' };
  writeJson(profilePath, profile);
  const changedRun = run('node', ['scripts/doctor-code-intel.js', '--repo', freshDoctorTmpRoot, '--json']);
  const changedDoctor = JSON.parse(changedRun.stdout || '{}');
  const changedReasons = (changedDoctor.findings || []).map((finding) => finding.reason);
  check('doctor detects changed settings source', changedRun.status === 0 && changedReasons.includes('settings source differs'), changedReasons.join(' | '));
} finally {
  fs.rmSync(freshDoctorTmpRoot, { recursive: true, force: true });
}
const staleTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-stale-profile-'));
try {
  fs.cpSync(path.join(ROOT, 'fixtures/repos/typescript-basic'), staleTmpRoot, { recursive: true });
  const staleDocs = path.join(staleTmpRoot, 'docs/code-intel');
  fs.mkdirSync(staleDocs, { recursive: true });
  writeJson(path.join(staleDocs, 'routing-profile.json'), {
    repoRoot: staleTmpRoot,
    generatedAt: '2020-01-01T00:00:00.000Z',
    pluginVersion: '0.0.0-stale',
    settingsVersion: 0,
    settingsSources: { default: 'stale', user: null, project: null },
    tools: { astGrep: { command: 'ast-grep', available: true } },
    languages: {},
    inventory: { totalFiles: 0, languages: {} }
  });
  const doctorRun = run('node', ['scripts/doctor-code-intel.js', '--repo', staleTmpRoot, '--json']);
  const doctor = JSON.parse(doctorRun.stdout || '{}');
  const reasons = (doctor.findings || []).map((finding) => finding.reason).join(' | ');
  check('doctor detects stale routing profile version and inventory mismatch', reasons.includes('plugin version differs') && reasons.includes('settings version differs') && reasons.includes('settings source differs') && reasons.includes('language inventory major mismatch'), reasons);
  fs.writeFileSync(path.join(staleDocs, 'routing-profile.json'), '{bad json');
  const corruptDoctorRun = run('node', ['scripts/doctor-code-intel.js', '--repo', staleTmpRoot, '--json']);
  const corruptDoctor = JSON.parse(corruptDoctorRun.stdout || '{}');
  const corruptReasons = (corruptDoctor.findings || []).map((finding) => finding.reason).join(' | ');
  check('doctor survives malformed routing profile and reports live fallback', corruptDoctorRun.status === 0 && corruptReasons.includes('routing profile unreadable'), corruptReasons || corruptDoctorRun.stderr);
} finally {
  fs.rmSync(staleTmpRoot, { recursive: true, force: true });
}

// Hook validation
const hookManifest = readJson('hooks/hooks.json');
check(
  'hook manifest wires only prompt-time soft hook',
  JSON.stringify(hookManifest.hooks?.UserPromptSubmit || '').includes('${PLUGIN_ROOT}/hooks/user-prompt-submit.js') &&
    !hookManifest.hooks?.PreToolUse &&
    !hookManifest.hooks?.PostToolUse,
  JSON.stringify(hookManifest).slice(0, 500)
);
function parseHookOutput(stdout) {
  if (!stdout.trim()) return { ok: true, empty: true, value: null, evidence: 'empty stdout' };
  try {
    const value = JSON.parse(stdout);
    return { ok: true, empty: false, value, evidence: stdout };
  } catch (error) {
    return { ok: false, empty: false, value: null, evidence: error.message };
  }
}
function validSoftHookOutput(stdout, expected) {
  const parsed = parseHookOutput(stdout);
  if (!parsed.ok || parsed.empty || !parsed.value || Array.isArray(parsed.value)) return { ok: false, evidence: parsed.evidence };
  const allowedTopLevel = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'decision', 'reason', 'hookSpecificOutput']);
  const unknownTopLevel = Object.keys(parsed.value).filter((key) => !allowedTopLevel.has(key));
  const hookSpecificOutput = parsed.value.hookSpecificOutput;
  const ok = unknownTopLevel.length === 0 &&
    hookSpecificOutput &&
    hookSpecificOutput.hookEventName === expected &&
    typeof hookSpecificOutput.additionalContext === 'string' &&
    hookSpecificOutput.additionalContext.includes('code-intel') &&
    hookSpecificOutput.additionalContext.length < 360;
  return { ok, evidence: ok ? hookSpecificOutput.additionalContext : JSON.stringify({ unknownTopLevel, value: parsed.value }).slice(0, 800) };
}
const promptHook = run('node', ['hooks/user-prompt-submit.js'], { input: 'rename symbol and find references' });
const promptHookResult = validSoftHookOutput(promptHook.stdout, 'UserPromptSubmit');
check('UserPromptSubmit emits one short Codex-compatible JSON hint', promptHook.status === 0 && promptHookResult.ok, promptHookResult.evidence || promptHook.stderr);
const ordinaryPromptHook = run('node', ['hooks/user-prompt-submit.js'], { input: 'summarize the README' });
check('UserPromptSubmit stays silent for non-code-intel prompts', ordinaryPromptHook.status === 0 && ordinaryPromptHook.stdout.trim() === '', ordinaryPromptHook.stdout);
check('PreToolUse hook script retired', !exists('hooks/pre-tool-use.js'), 'hooks/pre-tool-use.js');
check('PostToolUse hook script retired', !exists('hooks/post-tool-use.js'), 'hooks/post-tool-use.js');
const splitFrame = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['mcp/code-intel-server/index.js'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const raw = initializeFrame();
  let stdout = '';
  let stderr = '';
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    resolve({ status: 124, stdout, stderr: stderr || 'timed out waiting for split framed initialize response' });
  }, 5000);
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ status: 1, stdout, stderr: error.message });
  });
  child.on('exit', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ status: code ?? 0, stdout, stderr });
  });
  child.stdin.write(raw.subarray(0, 4));
  setTimeout(() => {
    child.stdin.write(raw.subarray(4));
    child.stdin.end();
  }, 50);
});
check(
  'MCP split framed initialize works without parse error',
  framedInitializeOk(splitFrame) && !splitFrame.stdout.toLowerCase().includes('error'),
  framedEvidence(splitFrame)
);

// Behavior scenarios
const behavior = [
  ['route decision', 'capability_route'],
  ['find class or function definition', 'lsp when available, else ast-grep, else rg'],
  ['find references', 'lsp_find_references, then ast_grep_search, then rg'],
  ['rename symbol', 'lsp_prepare_rename and lsp_rename_preview, else preview fallback'],
  ['rewrite structural pattern', 'ast_grep_replace_preview only, then normal edits'],
  ['rule-based AST audit', 'ast_grep_scan'],
  ['edit file then audit', 'post_edit_audit'],
  ['unsupported language fallback', 'rg/grep with reason'],
  ['missing ast-grep fallback', 'rg/grep with reason'],
  ['missing LSP fallback', 'ast-grep or rg/grep with reason']
];
const routingPolicy = [
  fs.readFileSync(path.join(ROOT, 'references/routing-policy.md'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'references/fallback-policy.md'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'references/mcp-tool-contract.md'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'docs/project-direction.md'), 'utf8')
].join('\n');
for (const [name, expectation] of behavior) check(`behavior documented: ${name}`, expectation.split(/,? then |, | and | with /).some((token) => routingPolicy.toLowerCase().includes(token.trim().toLowerCase().split(' ')[0])), expectation);
const mcpToolContract = fs.readFileSync(path.join(ROOT, 'references/mcp-tool-contract.md'), 'utf8');
const undocumentedTools = EXPECTED_TOOLS.filter((tool) => !mcpToolContract.includes(`\`${tool}\``));
check('MCP tool contract documents every expected tool', undocumentedTools.length === 0, undocumentedTools.join(', ') || 'all documented');

// No forbidden command path in executable/config surfaces.
const scanFiles = [];
for (const dir of ['scripts','hooks','settings','mcp']) {
  const stack = [path.join(ROOT, dir)];
  while (stack.length) {
    const item = stack.pop();
    for (const entry of fs.readdirSync(item, { withFileTypes: true })) {
      const full = path.join(item, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else scanFiles.push(full);
    }
  }
}
const commandCallPattern = /(?:spawnSync|spawn|execFile|exec)\s*\(\s*['"]sg['"]|"command"\s*:\s*"sg"/;
const offenders = scanFiles.filter((file) => commandCallPattern.test(fs.readFileSync(file, 'utf8'))).map(rel);
check('no script hook settings or MCP path calls forbidden shorthand command', offenders.length === 0, offenders.join(', ') || 'none');

const retiredTerms = [
  ['ad', 'apter'].join(''),
  ['reg', 'istry'].join(''),
  'CODE_INTEL_' + ['REG', 'ISTRY'].join('') + '_PATH',
  ['ad', 'apters/'].join('')
];
const activeSurfaceFiles = [
  'AGENTS.md',
  'README.md',
  '.codex-plugin/plugin.json',
  'docs/project-direction.md',
  'package.json',
  ...SKILLS.map((skill) => `skills/${skill}/SKILL.md`),
  ...REFS.map((ref) => `references/${ref}`),
  ...scanFiles.map(rel)
];
const retiredHits = [];
for (const file of activeSurfaceFiles) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  for (const term of retiredTerms) {
    if (text.includes(term)) retiredHits.push(`${file}:${term}`);
  }
}
check('active surfaces omit retired settings-era terms', retiredHits.length === 0, retiredHits.join(', ') || 'none');

finish();
