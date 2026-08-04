#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  tools,
  callTool,
  loadSettings,
  validateSettings,
  splitCommandLine,
  languageMatchForFile,
  lspDiagnosticsForFile,
  postEditAudit,
  LspSessionManager,
  LspDiagnosticsBroker
} from '../mcp/code-intel-server/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_TOOLS = ['capability_discover','capability_route','ast_grep_search','ast_grep_scan','ast_grep_replace_preview','post_edit_audit','lsp_diagnostics','lsp_symbols','lsp_goto_definition','lsp_find_references','lsp_prepare_rename','lsp_rename_preview','lsp_hover','lsp_completion','lsp_semantic_tokens','lsp_formatting_preview'];
const SKILLS = ['code-intel','init-code-intel','code-intel-doctor','code-intel-refactor'];
const REFS = ['routing-policy.md','settings-contract.md','fallback-policy.md','mcp-tool-contract.md','hook-contract.md'];
const results = [];
function check(name, ok, evidence = '') { results.push({ name, ok: Boolean(ok), evidence: String(evidence) }); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function run(cmd, args, opts = {}) { return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024, ...opts }); }
function rel(file) { return path.relative(ROOT, file); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function sameJson(actual, expected) { return JSON.stringify(actual) === JSON.stringify(expected); }
function lspRange(startLine, startCharacter, endLine, endCharacter) {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}
function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function runToolProbe(name, args, env) {
  const processResult = run(process.execPath, ['mcp/code-intel-server/index.js', '--call-tool', name, '--args', JSON.stringify(args)], { env });
  let output = {};
  try { output = JSON.parse(processResult.stdout || '{}'); } catch {}
  return { processResult, output };
}
function isolatedSettingsEnv(root) {
  return {
    ...process.env,
    CODE_INTEL_USER_SETTINGS_PATH: path.join(root, 'missing-user-settings.json'),
    CODE_INTEL_PROJECT_SETTINGS_PATH: path.join(root, 'missing-project-settings.json')
  };
}
async function waitForCondition(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}
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
function parseProtocolFrames(output) {
  const data = Buffer.isBuffer(output) ? output : Buffer.from(String(output || ''), 'utf8');
  const messages = [];
  let offset = 0;
  while (offset < data.length) {
    const headerEnd = data.indexOf('\r\n\r\n', offset);
    if (headerEnd < 0) break;
    const header = data.toString('utf8', offset, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (bodyEnd > data.length) break;
    messages.push(JSON.parse(data.toString('utf8', bodyStart, bodyEnd)));
    offset = bodyEnd;
  }
  return messages;
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
async function finish() {
  const failed = results.filter((r) => !r.ok);
  const report = { status: failed.length ? 'failed' : 'passed', total: results.length, passed: results.length - failed.length, failed: failed.length, results };
  const output = process.argv.includes('--json')
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.evidence ? ` — ${r.evidence}` : ''}`).join('\n')}\n\n${report.status}: ${report.passed}/${report.total} checks passed\n`;
  await new Promise((resolve) => process.stdout.write(output, resolve));
  process.exit(failed.length ? 1 : 0);
}

// Plugin structure validation
check('plugin manifest exists', exists('.codex-plugin/plugin.json'), '.codex-plugin/plugin.json');
const manifest = readJson('.codex-plugin/plugin.json');
check('manifest required fields', ['name','version','description','skills','interface'].every((k) => manifest[k]), Object.keys(manifest).join(', '));
check('manifest name is code-intel', manifest.name === 'code-intel', manifest.name);
check('mcp server manifest exists', exists('.mcp.json'), '.mcp.json');
check(
  'plugin ships no context-injecting hooks',
  !manifest.hooks && !exists('hooks/hooks.json') && !exists('hooks/user-prompt-submit.js'),
  manifest.hooks || 'no hooks'
);
for (const skill of SKILLS) check(`skill ${skill} exists`, exists(`skills/${skill}/SKILL.md`), `skills/${skill}/SKILL.md`);
for (const skill of SKILLS) {
  const relPath = `skills/${skill}/SKILL.md`;
  const error = exists(relPath) ? validateSkillFrontmatter(relPath) : 'missing file';
  check(`skill ${skill} frontmatter parseable`, !error, error || relPath);
  const policyPath = `skills/${skill}/agents/openai.yaml`;
  const policy = exists(policyPath) ? fs.readFileSync(path.join(ROOT, policyPath), 'utf8') : '';
  check(
    `skill ${skill} is explicit-invocation only`,
    /allow_implicit_invocation:\s*false/.test(policy),
    policyPath
  );
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
  await finish();
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
check(
  'scripts executable or documented',
  [
    'scripts/init-code-intel.js',
    'scripts/doctor-code-intel.js',
    'scripts/validate-plugin.js',
    'scripts/run-integration-matrix.js'
  ].every((file) => fs.statSync(path.join(ROOT, file)).mode & 0o111),
  'init/doctor/validate/integration executable'
);

check('real-server integration matrix exists', exists('integrations/real-server-matrix.json'), 'integrations/real-server-matrix.json');
check('integration corpus provenance exists', exists('integrations/corpus/README.md'), 'integrations/corpus/README.md');
const integrationMatrix = readJson('integrations/real-server-matrix.json');
const missingIntegrationCorpus = integrationMatrix.entries
  .map((entry) => entry.file)
  .filter((file) => !exists(file));
check(
  'real-server matrix corpus files exist',
  missingIntegrationCorpus.length === 0,
  missingIntegrationCorpus.join(', ') || `${integrationMatrix.entries.length} entries`
);
const invalidPublicCorpus = integrationMatrix.entries
  .filter((entry) => entry.corpus?.kind === 'public')
  .filter((entry) =>
    !entry.corpus.repository ||
    !entry.corpus.revision ||
    !entry.corpus.sourcePath ||
    !entry.corpus.license ||
    !entry.corpus.licenseFile ||
    !exists(entry.corpus.licenseFile)
  )
  .map((entry) => entry.id);
check(
  'public integration corpus is revision-pinned and licensed',
  invalidPublicCorpus.length === 0,
  invalidPublicCorpus.join(', ') || 'all public corpus entries have provenance and license files'
);
check(
  'package exposes opt-in real-server integration command',
  readJson('package.json').scripts?.['integration:real'] === 'node scripts/run-integration-matrix.js',
  readJson('package.json').scripts?.['integration:real'] || '(missing)'
);

const integrationFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-real-integration-'));
try {
  const fixtureRepoRoot = path.join(ROOT, 'fixtures/repos/typescript-basic');
  const fakeServer = path.join(ROOT, 'fixtures/lsp/fake-lsp-server.js');
  const missingMatrixPath = path.join(integrationFixtureRoot, 'missing.json');
  const missingReportPath = path.join(integrationFixtureRoot, 'missing-report.json');
  writeJson(missingMatrixPath, {
    version: 1,
    repoRoot: fixtureRepoRoot,
    entries: [{
      id: 'missing-server',
      language: 'typescript',
      command: 'code-intel-definitely-missing-lsp',
      file: 'src/math.ts',
      methods: []
    }]
  });
  const missingRun = run(process.execPath, [
    'scripts/run-integration-matrix.js',
    '--matrix', missingMatrixPath,
    '--output', missingReportPath
  ]);
  const missingReport = fs.existsSync(missingReportPath) ? JSON.parse(fs.readFileSync(missingReportPath, 'utf8')) : {};
  check(
    'real-server matrix skips missing executables explicitly',
    missingRun.status === 0 &&
      missingReport.summary?.skipped === 1 &&
      missingReport.entries?.[0]?.status === 'skipped' &&
      Boolean(missingReport.entries?.[0]?.skipReason),
    missingRun.stderr || JSON.stringify(missingReport)
  );

  const passingMatrixPath = path.join(integrationFixtureRoot, 'passing.json');
  const passingReportPath = path.join(integrationFixtureRoot, 'passing-report.json');
  writeJson(passingMatrixPath, {
    version: 1,
    repoRoot: fixtureRepoRoot,
    entries: [{
      id: 'fake-symbols',
      language: 'typescript',
      languageId: 'typescript',
      command: process.execPath,
      args: [fakeServer],
      versionArgs: ['--version'],
      env: { CODE_INTEL_FAKE_LATE_SERVER_REQUEST_ON_EXIT: '1' },
      file: 'src/math.ts',
      corpus: { kind: 'local', path: 'src/math.ts' },
      expectedCapabilities: ['symbols'],
      methods: [{
        name: 'symbols',
        method: 'textDocument/documentSymbol',
        requireAdvertisedCapability: true,
        expect: { resultShape: 'array', minItems: 1 }
      }]
    }]
  });
  const passingRun = run(process.execPath, [
    'scripts/run-integration-matrix.js',
    '--matrix', passingMatrixPath,
    '--output', passingReportPath
  ]);
  const passingReport = fs.existsSync(passingReportPath) ? JSON.parse(fs.readFileSync(passingReportPath, 'utf8')) : {};
  const passingEntry = passingReport.entries?.[0] || {};
  check(
    'real-server matrix records installed server evidence',
    passingRun.status === 0 &&
      passingEntry.status === 'passed' &&
      path.isAbsolute(passingEntry.executablePath || '') &&
      Boolean(passingEntry.version) &&
      passingEntry.methods?.[0]?.passed === true &&
      passingEntry.methods?.[0]?.itemCount >= 1,
    passingRun.stderr || JSON.stringify(passingEntry)
  );

  const failingMatrixPath = path.join(integrationFixtureRoot, 'failing.json');
  const failingReportPath = path.join(integrationFixtureRoot, 'failing-report.json');
  writeJson(failingMatrixPath, {
    version: 1,
    repoRoot: fixtureRepoRoot,
    entries: [{
      id: 'fake-hover-regression',
      language: 'typescript',
      languageId: 'typescript',
      command: process.execPath,
      args: [fakeServer],
      env: { CODE_INTEL_FAKE_DISABLED_CAPABILITIES: 'hover' },
      file: 'src/math.ts',
      expectedCapabilities: ['hover'],
      methods: [{
        name: 'hover',
        method: 'textDocument/hover',
        requireAdvertisedCapability: true,
        expect: { resultShape: 'object' }
      }]
    }]
  });
  const failingRun = run(process.execPath, [
    'scripts/run-integration-matrix.js',
    '--matrix', failingMatrixPath,
    '--output', failingReportPath
  ]);
  const failingReport = fs.existsSync(failingReportPath) ? JSON.parse(fs.readFileSync(failingReportPath, 'utf8')) : {};
  check(
    'real-server matrix fails installed-server protocol regressions',
    failingRun.status !== 0 &&
      failingReport.status === 'failed' &&
      failingReport.entries?.[0]?.status === 'failed' &&
      failingReport.entries?.[0]?.methods?.[0]?.passed === false,
    failingRun.stderr || JSON.stringify(failingReport)
  );
} finally {
  fs.rmSync(integrationFixtureRoot, { recursive: true, force: true });
}

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
  'lsp-diagnostics.js',
  'lsp-session-manager.js',
  'audit.js',
  'audit-result.js',
  'tools.js'
];
for (const moduleFile of requiredServerModules) {
  check(`server boundary module exists: ${moduleFile}`, exists(path.join('mcp/code-intel-server', moduleFile)), moduleFile);
}
const diagnosticsBrokerOracle = new LspDiagnosticsBroker();
diagnosticsBrokerOracle.publish({
  uri: 'file:///fixture.ts',
  version: 2,
  diagnostics: []
});
diagnosticsBrokerOracle.publish({
  uri: 'file:///fixture.ts',
  version: 1,
  diagnostics: [{ message: 'stale' }]
});
check(
  'diagnostics broker does not let older versions replace current cache',
  diagnosticsBrokerOracle.latest('file:///fixture.ts')?.version === 2 &&
    diagnosticsBrokerOracle.latest('file:///fixture.ts')?.diagnostics?.length === 0,
  JSON.stringify(diagnosticsBrokerOracle.latest('file:///fixture.ts'))
);
const coreSource = fs.readFileSync(path.join(ROOT, 'mcp/code-intel-server/core.js'), 'utf8');
const coreLineCount = coreSource.split(/\r?\n/).length;
check('core.js stays facade-sized', coreLineCount <= 260, `${coreLineCount} lines`);
const serverSource = fs.readFileSync(path.join(ROOT, 'mcp/code-intel-server/index.js'), 'utf8');
check(
  'MCP text content does not duplicate the full structured result',
  !serverSource.includes("text: JSON.stringify(value, null, 2)"),
  'return a short text summary beside structuredContent'
);
check(
  'MCP initialize supplies concise silent-routing instructions',
  serverSource.includes('instructions: SERVER_INSTRUCTIONS') &&
    /Do not narrate routing or routine fallback/.test(serverSource),
  'server instructions should route tools without workflow-skill narration'
);
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
let discoverReport = {};
try { discoverReport = JSON.parse(fs.readFileSync(discover.detailReportPath, 'utf8')); } catch {}
check(
  'capability_discover defaults to summary with detailed file report',
  Boolean(
    discover.repoRoot &&
    discover.mode === 'summary' &&
    discover.settingsVersion === 1 &&
    discover.tools?.astGrep?.command === 'ast-grep' &&
    Array.isArray(discover.languages) &&
    !discover.inventory &&
    discover.detailReportBytes > 0 &&
    discoverReport.repoRoot === discover.repoRoot &&
    discoverReport.languages
  ),
  JSON.stringify({ discover, reportKeys: Object.keys(discoverReport) }).slice(0, 2000)
);
if (discover.detailReportPath) fs.rmSync(discover.detailReportPath, { force: true });
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
const pagedAstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-paged-ast-'));
try {
  const pagedAstBin = path.join(pagedAstRoot, 'bin');
  const pagedAstRepo = path.join(pagedAstRoot, 'repo');
  const pagedAstSettings = path.join(pagedAstRoot, 'settings.json');
  fs.mkdirSync(pagedAstBin, { recursive: true });
  fs.mkdirSync(pagedAstRepo, { recursive: true });
  const fakeAstGrep = path.join(pagedAstBin, 'ast-grep');
  fs.writeFileSync(fakeAstGrep, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "ast-grep fake-paged"
    exit 0
  fi
done
printf '%s\n' \
  '{"file":"one.py","text":"call(1)","language":"Python"}' \
  '{"file":"two.py","text":"call(2)","language":"Python"}' \
  '{"file":"three.py","text":"call(3)","language":"Python"}' \
  '{"file":"four.py","text":"call(4)","language":"Python"}' \
  '{"file":"five.py","text":"call(5)","language":"Python"}'
`);
  fs.chmodSync(fakeAstGrep, 0o755);
  writeJson(pagedAstSettings, {
    version: 1,
    path: { extraDirs: [pagedAstBin] },
    astGrep: { command: 'ast-grep' }
  });
  const pagedAstEnv = {
    ...process.env,
    PATH: pagedAstBin,
    CODE_INTEL_USER_SETTINGS_PATH: path.join(pagedAstRoot, 'missing-user-settings.json'),
    CODE_INTEL_PROJECT_SETTINGS_PATH: pagedAstSettings
  };
  const commonArgs = {
    repoRoot: pagedAstRepo,
    language: 'python',
    pattern: 'call($A)',
    pageSize: 2
  };
  const firstProbe = runToolProbe('ast_grep_search', commonArgs, pagedAstEnv);
  const firstPage = firstProbe.output;
  fs.writeFileSync(fakeAstGrep, '#!/bin/sh\nexit 9\n');
  fs.chmodSync(fakeAstGrep, 0o755);
  const secondProbe = runToolProbe('ast_grep_search', { ...commonArgs, cursor: firstPage.nextCursor }, pagedAstEnv);
  const secondPage = secondProbe.output;
  const thirdProbe = runToolProbe('ast_grep_search', { ...commonArgs, cursor: secondPage.nextCursor }, pagedAstEnv);
  const thirdPage = thirdProbe.output;
  const matches = [firstPage, secondPage, thirdPage]
    .flatMap((page) => page.results || [])
    .map((row) => row.match);
  check(
    'ast-grep search preserves every result across stable pages',
    firstProbe.processResult.status === 0 &&
      secondProbe.processResult.status === 0 &&
      thirdProbe.processResult.status === 0 &&
      firstPage.status === 'ok' &&
      firstPage.complete === true &&
      firstPage.totalItems === 5 &&
      firstPage.returnedItems === 2 &&
      typeof firstPage.nextCursor === 'string' &&
      secondPage.resultSetId === firstPage.resultSetId &&
      thirdPage.resultSetId === firstPage.resultSetId &&
      thirdPage.nextCursor === null &&
      thirdPage.pageComplete === true &&
      sameJson(matches, ['call(1)', 'call(2)', 'call(3)', 'call(4)', 'call(5)']),
    JSON.stringify({ firstPage, secondPage, thirdPage }).slice(0, 2000)
  );
} finally {
  fs.rmSync(pagedAstRoot, { recursive: true, force: true });
}
const boundedAstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-bounded-ast-'));
try {
  const boundedAstBin = path.join(boundedAstRoot, 'bin');
  const boundedAstRepo = path.join(boundedAstRoot, 'repo');
  const boundedAstSettings = path.join(boundedAstRoot, 'settings.json');
  const boundedAstRows = path.join(boundedAstRoot, 'rows.jsonl');
  fs.mkdirSync(boundedAstBin, { recursive: true });
  fs.mkdirSync(boundedAstRepo, { recursive: true });
  fs.writeFileSync(
    boundedAstRows,
    Array.from({ length: 30 }, (_, index) => JSON.stringify({
      file: `large-${index + 1}.py`,
      text: `call(${index + 1}) ${'x'.repeat(12000)}`,
      language: 'Python'
    })).join('\n') + '\n'
  );
  const fakeAstGrep = path.join(boundedAstBin, 'ast-grep');
  fs.writeFileSync(fakeAstGrep, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "ast-grep fake-bounded"
    exit 0
  fi
done
/bin/cat "${boundedAstRows}"
`);
  fs.chmodSync(fakeAstGrep, 0o755);
  writeJson(boundedAstSettings, {
    version: 1,
    path: { extraDirs: [boundedAstBin] },
    astGrep: { command: 'ast-grep' }
  });
  const boundedAstEnv = {
    ...process.env,
    PATH: boundedAstBin,
    CODE_INTEL_USER_SETTINGS_PATH: path.join(boundedAstRoot, 'missing-user-settings.json'),
    CODE_INTEL_PROJECT_SETTINGS_PATH: boundedAstSettings
  };
  const defaultProbe = runToolProbe('ast_grep_search', {
    repoRoot: boundedAstRepo,
    language: 'python',
    pattern: 'call($A)'
  }, boundedAstEnv);
  const defaultPage = defaultProbe.output;
  check(
    'ast-grep search defaults to a ten-result page with bounded snippets',
    defaultProbe.processResult.status === 0 &&
      defaultPage.status === 'ok' &&
      defaultPage.pageSize === 10 &&
      defaultPage.returnedItems > 0 &&
      defaultPage.returnedItems <= 10 &&
      defaultPage.results.every((row) =>
        row.matchTruncated === true && Buffer.byteLength(row.match, 'utf8') <= 2048
      ),
    JSON.stringify(defaultPage).slice(0, 2000)
  );
  const wideProbe = runToolProbe('ast_grep_search', {
    repoRoot: boundedAstRepo,
    language: 'python',
    pattern: 'call($A)',
    pageSize: 100
  }, boundedAstEnv);
  const widePage = wideProbe.output;
  check(
    'ast-grep search enforces a 24 KiB response cap before the item cap',
    wideProbe.processResult.status === 0 &&
      widePage.status === 'ok' &&
      widePage.returnedItems > 0 &&
      widePage.returnedItems < 30 &&
      widePage.pageLimitedByBytes === true &&
      typeof widePage.nextCursor === 'string' &&
      widePage.responseByteLimit === 24 * 1024 &&
      widePage.responseBytes === Buffer.byteLength(JSON.stringify(widePage), 'utf8') &&
      widePage.responseBytes <= widePage.responseByteLimit,
    JSON.stringify(widePage).slice(0, 2000)
  );
} finally {
  fs.rmSync(boundedAstRoot, { recursive: true, force: true });
}
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
printf '%s\n' '[{"file":"src/main.ts","ruleId":"local.no-console","message":"console.log found","severity":"warning"},{"file":"src/main.ts","ruleId":"local.second","message":"second finding","severity":"warning"},{"file":"src/main.ts","ruleId":"local.third","message":"third finding","severity":"info"}]'
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
    try { scanResult = callTool('ast_grep_scan', { repoRoot: scanRoot, paths: ['src/main.ts'], maxResults: 2 }); }
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
    scanResult.totalItems === 3 &&
    scanResult.returnedItems === 2 &&
    scanResult.truncated === true &&
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
  const extraAstDiscoveryProbe = run(process.execPath, ['mcp/code-intel-server/index.js', '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: path.join(ROOT, 'fixtures/repos/python-basic'), mode: 'full' })], {
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
  const relativeAstDiscoveryProbe = run(process.execPath, [path.join(ROOT, 'mcp/code-intel-server/index.js'), '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: targetRepo, mode: 'full' })], {
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
const languageRoutingRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'code-intel-language-routing-')
);
try {
  const routingBinDir = path.join(languageRoutingRoot, 'bin');
  const scriptsDir = path.join(languageRoutingRoot, 'scripts');
  fs.mkdirSync(routingBinDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  const routingAstGrep = path.join(routingBinDir, 'ast-grep');
  fs.writeFileSync(routingAstGrep, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "ast-grep routing-fixture"
  exit 0
fi
for arg in "$@"; do
  if [ "$arg" = "broken" ]; then
    echo "failed to load custom language library: incompatible ABI" >&2
    exit 9
  fi
done
echo "[]"
`);
  fs.chmodSync(routingAstGrep, 0o755);
  fs.writeFileSync(path.join(languageRoutingRoot, '.zshrc'), 'autoload -Uz compinit\n');
  fs.writeFileSync(path.join(languageRoutingRoot, '.bashrc'), 'set -o pipefail\n');
  fs.writeFileSync(
    path.join(languageRoutingRoot, 'run-bash'),
    '#!/usr/bin/env bash\nset -eu\n'
  );
  fs.chmodSync(path.join(languageRoutingRoot, 'run-bash'), 0o755);
  fs.writeFileSync(path.join(languageRoutingRoot, 'shared.sh'), 'echo shared\n');
  fs.writeFileSync(path.join(scriptsDir, 'task.sh'), 'echo task\n');
  fs.writeFileSync(path.join(languageRoutingRoot, 'bad.broken'), 'broken syntax\n');
  const languageRoutingSettingsPath = path.join(
    languageRoutingRoot,
    'settings.json'
  );
  writeJson(languageRoutingSettingsPath, {
    version: 1,
    path: { extraDirs: [routingBinDir] },
    astGrep: { command: 'ast-grep', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      bash: {
        extensions: ['.sh'],
        filenames: ['.bashrc'],
        globs: ['scripts/*.sh'],
        shebangs: ['bash'],
        precedence: 10,
        astGrep: { languageId: 'bash' },
        lsp: { commands: [], expectedCapabilities: [] }
      },
      zsh: {
        extensions: ['.sh'],
        filenames: ['.zshrc'],
        globs: ['**/*.zsh'],
        shebangs: ['zsh'],
        precedence: 20,
        astGrep: { languageId: 'zsh' },
        lsp: { commands: [], expectedCapabilities: [] }
      },
      broken: {
        extensions: ['.broken'],
        precedence: 30,
        astGrep: { languageId: 'broken' },
        lsp: { commands: [], expectedCapabilities: [] }
      }
    }
  });
  const languageRoutingSettings = loadSettings(languageRoutingRoot, {
    defaultSettingsPath: languageRoutingSettingsPath,
    userSettingsPath: path.join(languageRoutingRoot, 'missing-user-settings.json'),
    projectSettingsPath: path.join(languageRoutingRoot, 'missing-project-settings.json')
  });
  const zshrcMatch = languageMatchForFile(
    path.join(languageRoutingRoot, '.zshrc'),
    languageRoutingSettings
  );
  const bashrcMatch = languageMatchForFile(
    path.join(languageRoutingRoot, '.bashrc'),
    languageRoutingSettings
  );
  const shebangMatch = languageMatchForFile(
    path.join(languageRoutingRoot, 'run-bash'),
    languageRoutingSettings
  );
  const conflictMatch = languageMatchForFile(
    path.join(languageRoutingRoot, 'shared.sh'),
    languageRoutingSettings
  );
  const globMatch = languageMatchForFile(
    path.join(scriptsDir, 'task.sh'),
    languageRoutingSettings
  );
  check(
    'language routing handles exact filenames globs and shebangs',
    zshrcMatch.language === 'zsh' &&
      zshrcMatch.matcher === 'filename' &&
      bashrcMatch.language === 'bash' &&
      bashrcMatch.matcher === 'filename' &&
      shebangMatch.language === 'bash' &&
      shebangMatch.matcher === 'shebang' &&
      globMatch.candidates.some((candidate) =>
        candidate.language === 'bash' && candidate.matcher === 'glob'
      ),
    JSON.stringify({
      zshrcMatch,
      bashrcMatch,
      shebangMatch,
      globMatch
    })
  );
  check(
    'language routing resolves extension conflicts by explicit precedence',
    conflictMatch.language === 'zsh' &&
      conflictMatch.matcher === 'extension' &&
      conflictMatch.precedence === 20 &&
      conflictMatch.candidates[1]?.language === 'bash' &&
      conflictMatch.reason.includes('precedence 20'),
    JSON.stringify(conflictMatch)
  );
  const languageRoutingEnv = {
    ...isolatedSettingsEnv(languageRoutingRoot),
    PATH: `${routingBinDir}${path.delimiter}${process.env.PATH || ''}`,
    CODE_INTEL_DEFAULT_SETTINGS_PATH: languageRoutingSettingsPath
  };
  const languageRoutingDiscoveryProbe = runToolProbe(
    'capability_discover',
    { repoRoot: languageRoutingRoot, mode: 'full' },
    languageRoutingEnv
  );
  const languageRoutingDiscovery = languageRoutingDiscoveryProbe.output;
  const languageRoutingRouteProbe = runToolProbe(
    'capability_route',
    {
      repoRoot: languageRoutingRoot,
      file: 'shared.sh',
      intent: 'structural'
    },
    languageRoutingEnv
  );
  check(
    'capability route reports the selected language matcher and precedence',
    languageRoutingRouteProbe.output.language === 'zsh' &&
      languageRoutingRouteProbe.output.languageMatch?.matcher === 'extension' &&
      languageRoutingRouteProbe.output.languageMatch?.precedence === 20 &&
      languageRoutingRouteProbe.output.languageMatch?.reason?.includes('precedence 20'),
    languageRoutingRouteProbe.processResult.stdout.slice(0, 2000) ||
      languageRoutingRouteProbe.processResult.stderr.slice(0, 1000)
  );
  check(
    'capability discovery reports routing evidence for shell dotfiles',
    languageRoutingDiscovery.status === 'ok' &&
      languageRoutingDiscovery.languages?.zsh?.routeEvidence?.some((evidence) =>
        evidence.file === '.zshrc' && evidence.matcher === 'filename'
      ) &&
      languageRoutingDiscovery.languages?.bash?.routeEvidence?.some((evidence) =>
        evidence.file === 'run-bash' && evidence.matcher === 'shebang'
      ),
    languageRoutingDiscoveryProbe.processResult.stdout.slice(0, 2500) ||
      languageRoutingDiscoveryProbe.processResult.stderr.slice(0, 1000)
  );
  check(
    'AST capability requires a successful per-language parse smoke',
    languageRoutingDiscovery.languages?.bash?.astGrep === 'available' &&
      languageRoutingDiscovery.languages?.bash?.astGrepProbe?.status === 'passed' &&
      languageRoutingDiscovery.languages?.broken?.astGrep === 'unavailable' &&
      languageRoutingDiscovery.languages?.broken?.astGrepProbe?.status === 'failed' &&
      /incompatible ABI/.test(
        languageRoutingDiscovery.languages?.broken?.astGrepProbe?.stderrSummary || ''
      ),
    JSON.stringify(languageRoutingDiscovery.languages)
  );
  const languageRoutingInit = run(
    'node',
    ['scripts/init-code-intel.js', '--repo', languageRoutingRoot, '--json'],
    { env: languageRoutingEnv }
  );
  const languageRoutingProfile = readJson(
    path.relative(
      ROOT,
      path.join(languageRoutingRoot, 'docs/code-intel/routing-profile.json')
    )
  );
  check(
    'init records failed custom grammar probes instead of availability',
    languageRoutingInit.status === 0 &&
      languageRoutingProfile.languages?.broken?.astGrep === 'unavailable' &&
      languageRoutingProfile.languages?.broken?.astGrepSmoke?.status === 'failed',
    languageRoutingInit.stdout.slice(0, 1500) ||
      languageRoutingInit.stderr.slice(0, 1500)
  );
  const languageRoutingDoctor = run(
    'node',
    ['scripts/doctor-code-intel.js', '--repo', languageRoutingRoot, '--json'],
    { env: languageRoutingEnv }
  );
  const languageRoutingDoctorReport = JSON.parse(
    languageRoutingDoctor.stdout || '{}'
  );
  check(
    'doctor reports a failed custom grammar probe with text fallback',
    languageRoutingDoctor.status === 0 &&
      languageRoutingDoctorReport.findings?.some((finding) =>
        finding.capability === 'broken AST' &&
        /incompatible ABI/.test(finding.reason) &&
        sameJson(finding.fallback, ['rg', 'grep'])
      ),
    languageRoutingDoctor.stdout.slice(0, 2500) ||
      languageRoutingDoctor.stderr.slice(0, 1000)
  );
} finally {
  fs.rmSync(languageRoutingRoot, { recursive: true, force: true });
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
  const fakeTracePath = path.join(fakeLspRoot, 'lsp-trace.jsonl');
  const fakeLspEnv = {
    ...process.env,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ''}`,
    CODE_INTEL_DEFAULT_SETTINGS_PATH: fakeSettingsPath,
    CODE_INTEL_USER_SETTINGS_PATH: path.join(fakeLspRoot, 'missing-user-settings.json'),
    CODE_INTEL_PROJECT_SETTINGS_PATH: path.join(fakeLspRoot, 'missing-project-settings.json'),
    CODE_INTEL_LSP_TRACE_FILE: fakeTracePath
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
  const lspDiscoveryProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'), mode: 'full' })], {
    env: fakeLspEnv
  });
  const lspDiscovery = JSON.parse(lspDiscoveryProbe.stdout || '{}');
  check(
    'LSP executable detection does not require --version support',
    lspDiscovery.languages?.typescript?.lsp === 'commandDetected' && lspDiscovery.languages.typescript.lspCommand === 'fake-no-version-lsp --stdio',
    lspDiscoveryProbe.stdout.slice(0, 800) || lspDiscoveryProbe.stderr.slice(0, 800)
  );
  const badRuntimeLsp = path.join(fakeBinDir, 'bad-runtime-lsp');
  fs.writeFileSync(badRuntimeLsp, '#!/bin/sh\nexit 72\n');
  fs.chmodSync(badRuntimeLsp, 0o755);
  const structuredSettingsPath = path.join(fakeLspRoot, 'structured-settings.json');
  const structuredTracePath = path.join(fakeLspRoot, 'structured-settings-trace.jsonl');
  const structuredInitializationOptions = {
    tsserver: { path: '/fixture/node_modules/typescript/lib' }
  };
  const structuredServerSettings = {
    typescript: { preferences: { quotePreference: 'single' } }
  };
  writeJson(structuredSettingsPath, {
    version: 1,
    path: { extraDirs: [fakeBinDir] },
    astGrep: { command: 'ast-grep', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      typescript: {
        extensions: ['.ts'],
        astGrep: { languageId: 'typescript' },
        lsp: {
          languageId: 'typescriptreact',
          command: 'bad-runtime-lsp',
          args: ['--stdio'],
          commands: ['fake-no-version-lsp --stdio'],
          initializationOptions: structuredInitializationOptions,
          settings: structuredServerSettings,
          expectedCapabilities: ['symbols', 'rename', 'prepareRename', 'hover']
        }
      }
    }
  });
  const structuredEnv = {
    ...fakeLspEnv,
    CODE_INTEL_DEFAULT_SETTINGS_PATH: structuredSettingsPath,
    CODE_INTEL_LSP_TRACE_FILE: structuredTracePath,
    CODE_INTEL_FAKE_PREPARE_RENAME: 'unsupported'
  };
  const structuredDiscoveryProbe = runToolProbe('capability_discover', {
    repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'),
    mode: 'full'
  }, structuredEnv);
  const structuredInfo = structuredDiscoveryProbe.output.languages?.typescript;
  check(
    'settings accept structured LSP command and preserve legacy candidates',
    structuredDiscoveryProbe.output.status === 'ok' &&
      structuredInfo?.languageId === 'typescriptreact' &&
      structuredInfo?.expectedCapabilities?.includes('hover') &&
      structuredInfo?.lspCommands?.[0]?.source === 'structured' &&
      structuredInfo?.lspCommands?.[1]?.source === 'commands',
    structuredDiscoveryProbe.processResult.stdout.slice(0, 1200) ||
      structuredDiscoveryProbe.processResult.stderr.slice(0, 1200)
  );
  const structuredSymbolsProbe = runToolProbe('lsp_symbols', {
    repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'),
    file: 'src/math.ts',
    timeoutMs: 5000
  }, structuredEnv);
  const structuredTraceRows = readJsonLines(structuredTracePath);
  check(
    'LSP runtime falls through a failing executable candidate',
    structuredSymbolsProbe.output.status === 'ok' &&
      structuredSymbolsProbe.output.command === 'fake-no-version-lsp --stdio' &&
      structuredSymbolsProbe.output.candidateFailures?.some((failure) =>
        failure.command === 'bad-runtime-lsp --stdio'
      ) &&
      structuredSymbolsProbe.output.expectedCapabilities?.includes('hover') &&
      structuredSymbolsProbe.output.advertisedCapabilities?.includes('symbols') &&
      structuredSymbolsProbe.output.verifiedCapabilities?.includes('symbols'),
    structuredSymbolsProbe.processResult.stdout.slice(0, 1600) ||
      structuredSymbolsProbe.processResult.stderr.slice(0, 1600)
  );
  check(
    'LSP forwards language id initialization options and server settings',
    structuredTraceRows.some((row) =>
      row.method === 'initialize' &&
      sameJson(row.initializationOptions, structuredInitializationOptions)
    ) &&
      structuredTraceRows.some((row) =>
        row.method === 'workspace/didChangeConfiguration' &&
        sameJson(row.settings, structuredServerSettings)
      ) &&
      structuredTraceRows.some((row) =>
        row.method === 'textDocument/didOpen' &&
        row.languageId === 'typescriptreact'
      ),
    JSON.stringify(structuredTraceRows)
  );
  const prepareWithoutAdvertisement = runToolProbe('lsp_prepare_rename', {
    repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'),
    file: 'src/math.ts',
    position: { line: 10, character: 15 },
    timeoutMs: 5000
  }, structuredEnv);
  const directRenameWithoutPrepare = runToolProbe('lsp_rename_preview', {
    repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'),
    file: 'src/math.ts',
    position: { line: 10, character: 15 },
    newName: 'sum',
    timeoutMs: 5000
  }, structuredEnv);
  check(
    'runtime capability distinguishes direct rename from prepare rename',
    prepareWithoutAdvertisement.output.status === 'error' &&
      prepareWithoutAdvertisement.output.unsupportedCapabilities?.includes('prepareRename') &&
      !prepareWithoutAdvertisement.output.advertisedCapabilities?.includes('prepareRename') &&
      directRenameWithoutPrepare.output.status === 'ok' &&
      directRenameWithoutPrepare.output.advertisedCapabilities?.includes('rename') &&
      directRenameWithoutPrepare.output.verifiedCapabilities?.includes('rename'),
    JSON.stringify({
      prepare: prepareWithoutAdvertisement.output,
      rename: directRenameWithoutPrepare.output
    }).slice(0, 3000)
  );
  const structuredDoctorRun = run(
    'node',
    [
      'scripts/doctor-code-intel.js',
      '--repo',
      path.join(ROOT, 'fixtures/repos/typescript-basic'),
      '--json'
    ],
    { env: structuredEnv }
  );
  const structuredDoctor = JSON.parse(structuredDoctorRun.stdout || '{}');
  check(
    'doctor reports expected runtime capabilities candidate and failure',
    structuredDoctorRun.status === 0 &&
      structuredDoctor.languages?.typescript?.expectedCapabilities?.includes('hover') &&
      structuredDoctor.languages?.typescript?.advertisedCapabilities?.includes('symbols') &&
      structuredDoctor.languages?.typescript?.verifiedCapabilities?.includes('symbols') &&
      structuredDoctor.languages?.typescript?.candidateInUse === 'fake-no-version-lsp --stdio' &&
      structuredDoctor.languages?.typescript?.lastFailure?.command === 'bad-runtime-lsp --stdio',
    structuredDoctorRun.stdout.slice(0, 2500) || structuredDoctorRun.stderr.slice(0, 1000)
  );
  const fixtureRepoRoot = path.join(ROOT, 'fixtures/repos/typescript-basic');
  const fixtureFile = 'src/math.ts';
  const fixtureUri = pathToFileURL(path.join(fixtureRepoRoot, fixtureFile)).href;
  const fixturePosition = { line: 10, character: 15 };
  const fixtureTextBeforeExtendedTools = fs.readFileSync(
    path.join(fixtureRepoRoot, fixtureFile),
    'utf8'
  );
  const lspMethodCases = [
    {
      name: 'document symbols',
      tool: 'lsp_symbols',
      method: 'textDocument/documentSymbol',
      verified: 'documentSymbol',
      args: {},
      matches: (output) =>
        output.result?.length === 3 &&
        output.totalItems === 3 &&
        output.returnedItems === 3 &&
        output.truncated === false &&
        output.result[0]?.name === 'Calculator' &&
        output.result[0]?.children?.[0]?.name === 'add' &&
        sameJson(output.result[1]?.selectionRange, lspRange(6, 16, 6, 19)) &&
        output.result[2]?.name === 'total'
    },
    {
      name: 'definition',
      tool: 'lsp_goto_definition',
      method: 'textDocument/definition',
      verified: 'definition',
      args: { position: fixturePosition },
      matches: (output) =>
        output.result?.length === 1 &&
        output.totalItems === 1 &&
        output.returnedItems === 1 &&
        output.truncated === false &&
        output.result[0]?.uri === fixtureUri &&
        sameJson(output.result[0]?.range, lspRange(6, 16, 6, 19))
    },
    {
      name: 'references',
      tool: 'lsp_find_references',
      method: 'textDocument/references',
      verified: 'references',
      args: { position: fixturePosition },
      matches: (output) =>
        output.result?.length === 2 &&
        output.totalItems === 2 &&
        output.returnedItems === 2 &&
        output.truncated === false &&
        output.result.every((reference) => reference.uri === fixtureUri) &&
        sameJson(output.result[0]?.range, lspRange(6, 16, 6, 19)) &&
        sameJson(output.result[1]?.range, lspRange(10, 14, 10, 17))
    },
    {
      name: 'prepare rename',
      tool: 'lsp_prepare_rename',
      method: 'textDocument/prepareRename',
      verified: 'prepareRename',
      args: { position: fixturePosition },
      matches: (output) =>
        output.result?.placeholder === 'add' &&
        sameJson(output.result?.range, lspRange(10, 14, 10, 17))
    },
    {
      name: 'rename preview',
      tool: 'lsp_rename_preview',
      method: 'textDocument/rename',
      verified: 'rename',
      args: { position: fixturePosition, newName: 'sum' },
      matches: (output) => {
        const edits = output.result?.changes?.[fixtureUri];
        return output.previewOnly === true &&
          output.mutated === false &&
          edits?.length === 2 &&
          edits.every((edit) => edit.newText === 'sum') &&
          sameJson(edits[0]?.range, lspRange(6, 16, 6, 19)) &&
          sameJson(edits[1]?.range, lspRange(10, 14, 10, 17));
      }
    },
    {
      name: 'hover',
      tool: 'lsp_hover',
      method: 'textDocument/hover',
      verified: 'hover',
      args: { position: fixturePosition },
      matches: (output) =>
        output.result?.contents?.kind === 'markdown' &&
        output.result?.contents?.value.includes('add') &&
        sameJson(output.result?.range, lspRange(10, 14, 10, 17))
    },
    {
      name: 'bounded completion',
      tool: 'lsp_completion',
      method: 'textDocument/completion',
      verified: 'completion',
      args: { position: fixturePosition, maxResults: 2 },
      matches: (output) =>
        output.result?.items?.length === 2 &&
        output.totalItems === 5 &&
        output.returnedItems === 2 &&
        output.maxResults === 2 &&
        output.truncated === true
    },
    {
      name: 'bounded semantic tokens',
      tool: 'lsp_semantic_tokens',
      method: 'textDocument/semanticTokens/full',
      verified: 'full',
      args: { maxResults: 2 },
      matches: (output) =>
        output.result?.data?.length === 10 &&
        output.totalItems === 5 &&
        output.returnedItems === 2 &&
        output.maxResults === 2 &&
        output.truncated === true
    },
    {
      name: 'formatting preview',
      tool: 'lsp_formatting_preview',
      method: 'textDocument/formatting',
      verified: 'formatting',
      args: { options: { tabSize: 2, insertSpaces: true } },
      matches: (output) =>
        output.previewOnly === true &&
        output.mutated === false &&
        output.result?.length === 1 &&
        output.totalItems === 1 &&
        output.returnedItems === 1 &&
        output.truncated === false &&
        output.result[0]?.newText === '// formatted preview\n'
    },
    {
      name: 'pull diagnostics',
      tool: 'lsp_diagnostics',
      method: 'textDocument/diagnostic',
      verified: 'diagnostic',
      args: {},
      matches: (output) =>
        output.result?.kind === 'full' &&
        output.result?.items?.length === 1 &&
        output.totalItems === 1 &&
        output.returnedItems === 1 &&
        output.truncated === false &&
        output.result.items[0]?.code === 'fixture-warning' &&
        output.result.items[0]?.message === 'fixture diagnostic' &&
        sameJson(output.result.items[0]?.range, lspRange(11, 0, 11, 19))
    }
  ];
  for (const fixtureCase of lspMethodCases) {
    const { processResult, output } = runToolProbe(fixtureCase.tool, {
      repoRoot: fixtureRepoRoot,
      file: fixtureFile,
      timeoutMs: 5000,
      ...fixtureCase.args
    }, fakeLspEnv);
    check(
      `LSP fixture oracle: ${fixtureCase.name}`,
      processResult.status === 0 &&
        output.status === 'ok' &&
        output.method === fixtureCase.method &&
        output.lspState === 'methodVerified' &&
        output.methodVerified === fixtureCase.verified &&
        fixtureCase.matches(output),
      processResult.stdout.slice(0, 1000) || processResult.stderr.slice(0, 1000)
    );
  }
  check(
    'formatting and rename previews leave repository files unchanged',
    fs.readFileSync(path.join(fixtureRepoRoot, fixtureFile), 'utf8') ===
      fixtureTextBeforeExtendedTools,
    fixtureFile
  );

  const unsupportedHoverTracePath = path.join(
    fakeLspRoot,
    'unsupported-hover-trace.jsonl'
  );
  const unsupportedHoverProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: unsupportedHoverTracePath,
      CODE_INTEL_FAKE_DISABLED_CAPABILITIES: 'hover'
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'lsp_hover',
          arguments: {
            repoRoot: fixtureRepoRoot,
            file: fixtureFile,
            position: fixturePosition,
            timeoutMs: 5000
          }
        }
      })
    ])
  });
  const unsupportedHoverOutput = parseProtocolFrames(unsupportedHoverProbe.stdout)
    .find((message) => message.id === 2)?.result?.structuredContent;
  const unsupportedHoverTraceRows = readJsonLines(unsupportedHoverTracePath);
  check(
    'extended LSP tools reject unadvertised methods before request',
    unsupportedHoverProbe.status === 0 &&
      unsupportedHoverOutput?.status === 'unavailable' &&
      unsupportedHoverOutput.unsupportedCapabilities?.includes('hover') &&
      /did not advertise hover/.test(unsupportedHoverOutput.fallbackReason || '') &&
      unsupportedHoverTraceRows.some((row) => row.method === 'initialize') &&
      !unsupportedHoverTraceRows.some((row) => row.method === 'textDocument/hover') &&
      !unsupportedHoverTraceRows.some((row) => row.method === 'textDocument/didOpen'),
    unsupportedHoverProbe.stdout.slice(0, 2000) ||
      unsupportedHoverProbe.stderr.slice(0, 1000)
  );

  const traceRows = readJsonLines(fakeTracePath);
  const sessions = new Map();
  for (const row of traceRows) {
    if (!sessions.has(row.pid)) sessions.set(row.pid, []);
    sessions.get(row.pid).push(row);
  }
  const completeLifecycles = lspMethodCases.every((fixtureCase) => {
    const rows = [...sessions.values()].find((sessionRows) =>
      sessionRows.some((row) => row.event === 'receive' && row.method === fixtureCase.method)
    ) || [];
    const methods = rows.filter((row) => row.event === 'receive').map((row) => row.method);
    const initializeAt = methods.indexOf('initialize');
    const initializedAt = methods.indexOf('initialized');
    const didOpenAt = methods.indexOf('textDocument/didOpen');
    const targetAt = methods.indexOf(fixtureCase.method);
    const shutdownAt = methods.indexOf('shutdown');
    const exitAt = methods.indexOf('exit');
    return initializeAt >= 0 &&
      initializedAt > initializeAt &&
      didOpenAt > initializedAt &&
      targetAt > didOpenAt &&
      shutdownAt > targetAt &&
      exitAt > shutdownAt;
  });
  check(
    'LSP trace captures process-per-request baseline for persistent-session gate',
    sessions.size === lspMethodCases.length && completeLifecycles,
    `processes=${sessions.size}; requests=${lspMethodCases.length}; persistent-target=1`
  );

  const multiCallTracePath = path.join(fakeLspRoot, 'same-mcp-process-trace.jsonl');
  const multiCallProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: multiCallTracePath
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'lsp_symbols',
          arguments: { repoRoot: fixtureRepoRoot, file: fixtureFile, timeoutMs: 5000 }
        }
      }),
      mcpFrame({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'lsp_goto_definition',
          arguments: { repoRoot: fixtureRepoRoot, file: fixtureFile, position: fixturePosition, timeoutMs: 5000 }
        }
      })
    ])
  });
  const multiCallResponses = parseProtocolFrames(multiCallProbe.stdout);
  const multiCallTraceRows = readJsonLines(multiCallTracePath);
  const multiCallProcesses = new Set(
    multiCallTraceRows
      .filter((row) => row.event === 'process-start')
      .map((row) => row.pid)
  );
  const multiCallSessionRows = [...multiCallProcesses].length === 1
    ? multiCallTraceRows.filter((row) => row.pid === [...multiCallProcesses][0])
    : [];
  const multiCallMethods = multiCallSessionRows
    .filter((row) => row.event === 'receive')
    .map((row) => row.method);
  check(
    'same MCP process reuses one repository LSP session',
    multiCallProbe.status === 0 &&
      multiCallResponses.some((message) =>
        message.id === 2 &&
        message.result?.structuredContent?.status === 'ok' &&
        message.result.structuredContent.sessionReused === false
      ) &&
      multiCallResponses.some((message) =>
        message.id === 3 &&
        message.result?.structuredContent?.status === 'ok' &&
        message.result.structuredContent.sessionReused === true
      ) &&
      multiCallProcesses.size === 1 &&
      multiCallMethods.filter((method) => method === 'initialize').length === 1 &&
      multiCallMethods.filter((method) => method === 'textDocument/didOpen').length === 1 &&
      multiCallMethods.includes('textDocument/documentSymbol') &&
      multiCallMethods.includes('textDocument/definition') &&
      multiCallMethods.filter((method) => method === 'textDocument/didClose').length === 1 &&
      multiCallMethods.filter((method) => method === 'shutdown').length === 1 &&
      multiCallMethods.filter((method) => method === 'exit').length === 1,
    `lspProcesses=${multiCallProcesses.size}; methods=${multiCallMethods.join(',')}`
  );

  const isolatedRepoRoot = path.join(fakeLspRoot, 'isolated-repo');
  fs.cpSync(fixtureRepoRoot, isolatedRepoRoot, { recursive: true });
  const isolationTracePath = path.join(fakeLspRoot, 'session-isolation-trace.jsonl');
  const isolationProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: isolationTracePath
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'lsp_symbols',
          arguments: {
            repoRoot: fixtureRepoRoot,
            file: fixtureFile,
            initializationOptions: { profile: 'a' },
            timeoutMs: 5000
          }
        }
      }),
      mcpFrame({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'lsp_goto_definition',
          arguments: {
            repoRoot: fixtureRepoRoot,
            file: fixtureFile,
            position: fixturePosition,
            initializationOptions: { profile: 'a' },
            timeoutMs: 5000
          }
        }
      }),
      mcpFrame({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'lsp_symbols',
          arguments: {
            repoRoot: fixtureRepoRoot,
            file: fixtureFile,
            initializationOptions: { profile: 'b' },
            timeoutMs: 5000
          }
        }
      }),
      mcpFrame({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'lsp_symbols',
          arguments: {
            repoRoot: isolatedRepoRoot,
            file: fixtureFile,
            initializationOptions: { profile: 'a' },
            timeoutMs: 5000
          }
        }
      })
    ])
  });
  const isolationResponses = parseProtocolFrames(isolationProbe.stdout);
  const isolationTraceRows = readJsonLines(isolationTracePath);
  const isolationProcesses = new Set(
    isolationTraceRows.filter((row) => row.event === 'process-start').map((row) => row.pid)
  );
  const isolationInitializes = isolationTraceRows.filter((row) =>
    row.event === 'receive' && row.method === 'initialize'
  );
  check(
    'LSP session key isolates repository and initialization options',
    isolationProbe.status === 0 &&
      [2, 3, 4, 5].every((id) =>
        isolationResponses.some((message) => message.id === id && message.result?.structuredContent?.status === 'ok')
      ) &&
      isolationProcesses.size === 3 &&
      isolationInitializes.length === 3 &&
      isolationInitializes.filter((row) => row.initializationOptions?.profile === 'a').length === 2 &&
      isolationInitializes.filter((row) => row.initializationOptions?.profile === 'b').length === 1 &&
      new Set(isolationInitializes.map((row) => row.rootUri)).size === 2,
    `lspProcesses=${isolationProcesses.size}; initializes=${JSON.stringify(isolationInitializes)}`
  );

  const auditFile = 'src/other.ts';
  fs.writeFileSync(
    path.join(isolatedRepoRoot, auditFile),
    'export const other = 1;\n'
  );
  const auditSessionTracePath = path.join(fakeLspRoot, 'audit-session-trace.jsonl');
  const auditSessionProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: auditSessionTracePath
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'post_edit_audit',
          arguments: {
            repoRoot: isolatedRepoRoot,
            files: [fixtureFile, auditFile],
            timeoutMs: 5000
          }
        }
      })
    ])
  });
  const auditSessionResponses = parseProtocolFrames(auditSessionProbe.stdout);
  const auditSessionTraceRows = readJsonLines(auditSessionTracePath);
  const auditSessionOutput = auditSessionResponses.find((message) => message.id === 2)
    ?.result?.structuredContent;
  const auditSessionMethods = auditSessionTraceRows
    .filter((row) => row.event === 'receive')
    .map((row) => row.method);
  const auditInitializeAt = auditSessionMethods.indexOf('initialize');
  const auditInitializedAt = auditSessionMethods.indexOf('initialized');
  const auditFirstOpenAt = auditSessionMethods.indexOf('textDocument/didOpen');
  check(
    'post-edit audit reuses one LSP session across repository files',
    auditSessionProbe.status === 0 &&
      auditSessionOutput?.status === 'ok' &&
      auditSessionOutput.diagnostics?.length === 2 &&
      auditSessionOutput.diagnostics.every((diagnostic) => diagnostic.status === 'ok') &&
      auditSessionTraceRows.filter((row) => row.event === 'process-start').length === 1 &&
      auditSessionTraceRows.filter((row) =>
        row.event === 'receive' && row.method === 'textDocument/didOpen'
      ).length === 2 &&
      auditSessionTraceRows.filter((row) =>
        row.event === 'receive' && row.method === 'textDocument/diagnostic'
      ).length === 2 &&
      auditInitializeAt >= 0 &&
      auditInitializedAt > auditInitializeAt &&
      auditFirstOpenAt > auditInitializedAt &&
      auditSessionTraceRows.some((row) =>
        row.event === 'receive' && row.method === 'shutdown'
      ),
    auditSessionProbe.stdout.slice(0, 1000) || auditSessionProbe.stderr.slice(0, 1000)
  );

  const changeRepoRoot = path.join(fakeLspRoot, 'change-repo');
  fs.cpSync(fixtureRepoRoot, changeRepoRoot, { recursive: true });
  const changeTracePath = path.join(fakeLspRoot, 'document-change-trace.jsonl');
  const changeManager = new LspSessionManager({
    env: { ...fakeLspEnv, CODE_INTEL_LSP_TRACE_FILE: changeTracePath }
  });
  const changeArgs = {
    repoRoot: changeRepoRoot,
    file: fixtureFile,
    settingsPathExtraDirs: [fakeBinDir],
    timeoutMs: 5000
  };
  const beforeChange = await changeManager.request(
    'fake-no-version-lsp --stdio',
    { language: 'typescript' },
    'textDocument/documentSymbol',
    changeArgs
  );
  fs.appendFileSync(path.join(changeRepoRoot, fixtureFile), '\nexport const changed = true;\n');
  const afterChange = await changeManager.request(
    'fake-no-version-lsp --stdio',
    { language: 'typescript' },
    'textDocument/definition',
    { ...changeArgs, position: fixturePosition }
  );
  await changeManager.shutdownAll();
  const changeTraceRows = readJsonLines(changeTracePath);
  check(
    'persistent LSP session sends didChange with monotonic document version',
    beforeChange.documentVersion === 1 &&
      afterChange.documentVersion === 2 &&
      afterChange.sessionReused === true &&
      changeTraceRows.filter((row) => row.event === 'process-start').length === 1 &&
      changeTraceRows.filter((row) =>
        row.event === 'receive' && row.method === 'textDocument/didOpen' && row.version === 1
      ).length === 1 &&
      changeTraceRows.filter((row) =>
        row.event === 'receive' && row.method === 'textDocument/didChange' && row.version === 2
      ).length === 1 &&
      changeTraceRows.some((row) =>
        row.event === 'receive' && row.method === 'textDocument/didClose'
      ),
    JSON.stringify(changeTraceRows)
  );

  const workspaceRepoRoot = path.join(fakeLspRoot, 'workspace-repo');
  fs.cpSync(fixtureRepoRoot, workspaceRepoRoot, { recursive: true });
  const workspaceTargetFile = 'src/operations.ts';
  fs.writeFileSync(
    path.join(workspaceRepoRoot, workspaceTargetFile),
    'export function add(left: number, right: number) { return left + right; }\n'
  );
  const workspaceTracePath = path.join(fakeLspRoot, 'workspace-lifecycle-trace.jsonl');
  const workspaceManager = new LspSessionManager({
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: workspaceTracePath,
      CODE_INTEL_FAKE_CROSS_FILE_TARGET: workspaceTargetFile,
      CODE_INTEL_FAKE_CONTENT_AWARE_SYMBOLS: '1',
      CODE_INTEL_FAKE_WORKSPACE_CAPABILITIES: '1',
      CODE_INTEL_FAKE_REGISTER_WORKSPACE_WATCHERS: '1',
      CODE_INTEL_FAKE_PUSH_DIAGNOSTICS: '1',
      CODE_INTEL_FAKE_PULL_DIAGNOSTICS: 'unsupported'
    }
  });
  const workspaceArgs = {
    repoRoot: workspaceRepoRoot,
    file: fixtureFile,
    settingsPathExtraDirs: [fakeBinDir],
    timeoutMs: 5000
  };
  const workspaceRuntime = { language: 'typescript' };
  const crossFileDefinition = await workspaceManager.request(
    'fake-no-version-lsp --stdio',
    workspaceRuntime,
    'textDocument/definition',
    { ...workspaceArgs, position: fixturePosition }
  );
  const crossFileReferences = await workspaceManager.request(
    'fake-no-version-lsp --stdio',
    workspaceRuntime,
    'textDocument/references',
    { ...workspaceArgs, position: fixturePosition }
  );
  const symbolsBeforeWorkspaceChange = await workspaceManager.request(
    'fake-no-version-lsp --stdio',
    workspaceRuntime,
    'textDocument/documentSymbol',
    workspaceArgs
  );
  fs.appendFileSync(
    path.join(workspaceRepoRoot, fixtureFile),
    '\nexport const changedWorkspaceSymbol = true;\n'
  );
  const symbolsAfterWorkspaceChange = await workspaceManager.request(
    'fake-no-version-lsp --stdio',
    workspaceRuntime,
    'textDocument/documentSymbol',
    workspaceArgs
  );
  const diagnosticsBeforeClose = await workspaceManager.diagnosticsForFile(
    'fake-no-version-lsp --stdio',
    workspaceRuntime,
    workspaceArgs
  );
  const workspaceSession = [...workspaceManager.sessions.values()][0];
  const canonicalWorkspaceRepoRoot = fs.realpathSync(workspaceRepoRoot);
  const workspaceFileUri = pathToFileURL(
    path.join(canonicalWorkspaceRepoRoot, fixtureFile)
  ).href;
  const diagnosticsCachedBeforeClose = Boolean(
    workspaceSession?.diagnostics.latest(workspaceFileUri)
  );
  const documentClosed = workspaceManager.closeDocument(
    'fake-no-version-lsp --stdio',
    workspaceRuntime,
    workspaceArgs
  );
  const diagnosticsClearedAfterClose = !workspaceSession?.diagnostics.latest(workspaceFileUri);
  const workspaceFolderChanged = workspaceManager.changeWorkspaceFolders(
    'fake-no-version-lsp --stdio',
    workspaceRuntime,
    workspaceArgs,
    {
      added: [{
        uri: pathToFileURL(path.join(canonicalWorkspaceRepoRoot, 'packages')).href,
        name: 'packages'
      }],
      removed: []
    }
  );
  const symbolsAfterReopen = await workspaceManager.request(
    'fake-no-version-lsp --stdio',
    workspaceRuntime,
    'textDocument/documentSymbol',
    workspaceArgs
  );
  await workspaceManager.shutdownAll();
  const workspaceTraceRows = readJsonLines(workspaceTracePath);
  const workspaceReceiveRows = workspaceTraceRows.filter((row) => row.event === 'receive');
  const workspaceRootUri = pathToFileURL(canonicalWorkspaceRepoRoot).href;
  const targetUri = pathToFileURL(
    path.join(canonicalWorkspaceRepoRoot, workspaceTargetFile)
  ).href;
  check(
    'workspace lifecycle advertises folders and watched-file registration',
    workspaceReceiveRows.some((row) =>
      row.method === 'initialize' &&
      row.rootUri === workspaceRootUri &&
      row.workspaceFolders?.[0]?.uri === workspaceRootUri &&
      row.clientCapabilities?.workspace?.workspaceFolders === true &&
      row.clientCapabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true
    ) &&
      workspaceReceiveRows.some((row) =>
        row.method === 'workspace/didChangeWorkspaceFolders'
      ) &&
      workspaceReceiveRows.some((row) =>
        row.method === 'workspace/didChangeWatchedFiles'
      ) &&
      workspaceFolderChanged,
    JSON.stringify(workspaceReceiveRows)
  );
  check(
    'workspace indexing resolves definition and references without opening every file',
    crossFileDefinition.response?.result?.[0]?.uri === targetUri &&
      crossFileReferences.response?.result?.some((reference) => reference.uri === targetUri) &&
      !workspaceReceiveRows.some((row) =>
        row.method === 'textDocument/didOpen' && row.uri === targetUri
      ),
    JSON.stringify({
      definition: crossFileDefinition.response?.result,
      references: crossFileReferences.response?.result
    })
  );
  check(
    'workspace document changes do not reuse stale symbol results',
    symbolsBeforeWorkspaceChange.response?.result?.[0]?.name === 'OriginalWorkspaceSymbol' &&
      symbolsAfterWorkspaceChange.response?.result?.[0]?.name === 'ChangedWorkspaceSymbol' &&
      workspaceReceiveRows.some((row) =>
        row.method === 'textDocument/didChange' && row.version === 2
      ),
    JSON.stringify({
      before: symbolsBeforeWorkspaceChange.response?.result,
      after: symbolsAfterWorkspaceChange.response?.result
    })
  );
  check(
    'explicit close clears document diagnostics and reopen advances version',
    diagnosticsBeforeClose.transport === 'push' &&
      diagnosticsBeforeClose.documentVersion === 2 &&
      diagnosticsCachedBeforeClose &&
      documentClosed &&
      diagnosticsClearedAfterClose &&
      symbolsAfterReopen.documentVersion === 3 &&
      workspaceReceiveRows.some((row) =>
        row.method === 'textDocument/didClose'
      ) &&
      workspaceReceiveRows.filter((row) =>
        row.method === 'textDocument/didOpen'
      ).some((row) => row.version === 3),
    JSON.stringify(workspaceReceiveRows)
  );

  const lifecycleTracePath = path.join(fakeLspRoot, 'document-lifecycle-trace.jsonl');
  const initialText = fs.readFileSync(path.join(fixtureRepoRoot, fixtureFile), 'utf8');
  const changedText = initialText.replace('const total', 'const updatedTotal');
  const lifecycleProbe = run(process.execPath, [path.join(ROOT, 'fixtures/lsp/fake-lsp-server.js')], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: lifecycleTracePath
    },
    input: Buffer.concat([
      mcpFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      mcpFrame({ jsonrpc: '2.0', method: 'initialized', params: {} }),
      mcpFrame({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: fixtureUri,
            languageId: 'typescript',
            version: 1,
            text: initialText
          }
        }
      }),
      mcpFrame({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: fixtureUri, version: 2 },
          contentChanges: [{ text: changedText }]
        }
      }),
      mcpFrame({
        jsonrpc: '2.0',
        method: 'textDocument/didClose',
        params: { textDocument: { uri: fixtureUri } }
      }),
      mcpFrame({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }),
      mcpFrame({ jsonrpc: '2.0', method: 'exit', params: null })
    ])
  });
  const lifecycleTraceRows = readJsonLines(lifecycleTracePath);
  const lifecycleEvents = lifecycleTraceRows.filter((row) =>
    ['document-open', 'document-change', 'document-close'].includes(row.event)
  );
  check(
    'document lifecycle fixture tracks open change and close state',
    lifecycleProbe.status === 0 &&
      lifecycleEvents.length === 3 &&
      lifecycleEvents[0]?.event === 'document-open' &&
      lifecycleEvents[0]?.version === 1 &&
      lifecycleEvents[0]?.openDocuments === 1 &&
      lifecycleEvents[1]?.event === 'document-change' &&
      lifecycleEvents[1]?.version === 2 &&
      lifecycleEvents[1]?.openDocuments === 1 &&
      lifecycleEvents[2]?.event === 'document-close' &&
      lifecycleEvents[2]?.openDocuments === 0,
    lifecycleTraceRows.map((row) => `${row.sequence}:${row.event}:${row.version ?? ''}:${row.openDocuments ?? ''}`).join(', ')
  );

  const crashTracePath = path.join(fakeLspRoot, 'crash-trace.jsonl');
  const crashProbe = runToolProbe('lsp_symbols', {
    repoRoot: fixtureRepoRoot,
    file: fixtureFile,
    timeoutMs: 5000
  }, {
    ...fakeLspEnv,
    CODE_INTEL_LSP_TRACE_FILE: crashTracePath,
    CODE_INTEL_FAKE_CRASH_ON_METHOD: 'textDocument/documentSymbol'
  });
  const crashTraceRows = readJsonLines(crashTracePath);
  check(
    'LSP crash fixture records deterministic unavailable result',
    crashProbe.processResult.status === 0 &&
      crashProbe.output.status === 'unavailable' &&
      crashProbe.output.method === 'textDocument/documentSymbol' &&
      crashTraceRows.some((row) =>
        row.event === 'process-crash' &&
        row.method === 'textDocument/documentSymbol' &&
        row.exitCode === 86
      ),
    crashProbe.processResult.stdout.slice(0, 1000) || crashProbe.processResult.stderr.slice(0, 1000)
  );

  const crashRecoveryTracePath = path.join(fakeLspRoot, 'crash-recovery-trace.jsonl');
  const crashOnceFile = path.join(fakeLspRoot, 'crash-once.marker');
  const crashRecoveryProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: crashRecoveryTracePath,
      CODE_INTEL_FAKE_CRASH_ON_METHOD: 'textDocument/documentSymbol',
      CODE_INTEL_FAKE_CRASH_ONCE_FILE: crashOnceFile
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'lsp_symbols',
          arguments: { repoRoot: fixtureRepoRoot, file: fixtureFile, timeoutMs: 5000 }
        }
      })
    ])
  });
  const crashRecoveryResponses = parseProtocolFrames(crashRecoveryProbe.stdout);
  const crashRecoveryTraceRows = readJsonLines(crashRecoveryTracePath);
  check(
    'persistent LSP session restarts once after a process crash',
    crashRecoveryProbe.status === 0 &&
      crashRecoveryResponses.some((message) =>
        message.id === 2 &&
        message.result?.structuredContent?.status === 'ok' &&
        message.result.structuredContent.restarted === true
      ) &&
      crashRecoveryTraceRows.filter((row) => row.event === 'process-start').length === 2 &&
      crashRecoveryTraceRows.filter((row) => row.event === 'process-crash').length === 1 &&
      crashRecoveryTraceRows.filter((row) =>
        row.event === 'receive' && row.method === 'textDocument/documentSymbol'
      ).length === 2,
    crashRecoveryProbe.stdout.slice(0, 1000) || crashRecoveryProbe.stderr.slice(0, 1000)
  );

  const repeatedCrashTracePath = path.join(fakeLspRoot, 'repeated-crash-trace.jsonl');
  const repeatedCrashProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: repeatedCrashTracePath,
      CODE_INTEL_FAKE_CRASH_ON_METHOD: 'textDocument/documentSymbol'
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'lsp_symbols',
          arguments: { repoRoot: fixtureRepoRoot, file: fixtureFile, timeoutMs: 5000 }
        }
      })
    ])
  });
  const repeatedCrashResponses = parseProtocolFrames(repeatedCrashProbe.stdout);
  const repeatedCrashTraceRows = readJsonLines(repeatedCrashTracePath);
  check(
    'persistent LSP session degrades after one failed restart',
    repeatedCrashProbe.status === 0 &&
      repeatedCrashResponses.some((message) =>
        message.id === 2 &&
        message.result?.structuredContent?.status === 'unavailable' &&
        /exited/.test(message.result.structuredContent.fallbackReason || '')
      ) &&
      repeatedCrashTraceRows.filter((row) => row.event === 'process-start').length === 2 &&
      repeatedCrashTraceRows.filter((row) => row.event === 'process-crash').length === 2,
    repeatedCrashProbe.stdout.slice(0, 1000) || repeatedCrashProbe.stderr.slice(0, 1000)
  );

  const idleTracePath = path.join(fakeLspRoot, 'idle-cleanup-trace.jsonl');
  const idleManager = new LspSessionManager({
    idleTimeoutMs: 25,
    env: { ...fakeLspEnv, CODE_INTEL_LSP_TRACE_FILE: idleTracePath }
  });
  const idleResult = await idleManager.request(
    'fake-no-version-lsp --stdio',
    { language: 'typescript' },
    'textDocument/documentSymbol',
    {
    repoRoot: fixtureRepoRoot,
    file: fixtureFile,
    settingsPathExtraDirs: [fakeBinDir],
    timeoutMs: 5000
    }
  );
  const idleClosed = await waitForCondition(() => idleManager.sessions.size === 0, 1000);
  const idleTraceRows = readJsonLines(idleTracePath);
  await idleManager.shutdownAll();
  check(
    'idle LSP session closes documents and process cleanly',
    Array.isArray(idleResult.response?.result) &&
      idleClosed &&
      idleTraceRows.some((row) => row.event === 'receive' && row.method === 'textDocument/didClose') &&
      idleTraceRows.some((row) => row.event === 'receive' && row.method === 'shutdown') &&
      idleTraceRows.some((row) => row.event === 'receive' && row.method === 'exit'),
    `sessions=${idleManager.sessions.size}; trace=${JSON.stringify(idleTraceRows)}`
  );

  const pushTracePath = path.join(fakeLspRoot, 'push-diagnostics-trace.jsonl');
  const pushOnlyProbe = runToolProbe('lsp_diagnostics', {
    repoRoot: fixtureRepoRoot,
    file: fixtureFile,
    timeoutMs: 5000
  }, {
    ...fakeLspEnv,
    CODE_INTEL_LSP_TRACE_FILE: pushTracePath,
    CODE_INTEL_FAKE_PUSH_DIAGNOSTICS: '1',
    CODE_INTEL_FAKE_PULL_DIAGNOSTICS: 'unsupported'
  });
  const pushTraceRows = readJsonLines(pushTracePath);
  check(
    'push-only diagnostics fixture reproduces publish/pull integration gap',
    pushOnlyProbe.output.status === 'error' &&
      pushOnlyProbe.output.error?.code === -32601 &&
      pushTraceRows.some((row) => row.event === 'send' && row.method === 'textDocument/publishDiagnostics') &&
      pushTraceRows.some((row) => row.event === 'receive' && row.method === 'textDocument/diagnostic'),
    pushOnlyProbe.processResult.stdout.slice(0, 1000) || pushOnlyProbe.processResult.stderr.slice(0, 1000)
  );

  const pullBrokerTracePath = path.join(fakeLspRoot, 'pull-broker-trace.jsonl');
  const pullBrokerProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: pullBrokerTracePath
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'lsp_diagnostics',
          arguments: { repoRoot: fixtureRepoRoot, file: fixtureFile, timeoutMs: 5000 }
        }
      })
    ])
  });
  const pullBrokerOutput = parseProtocolFrames(pullBrokerProbe.stdout)
    .find((message) => message.id === 2)?.result?.structuredContent;
  const pullBrokerTraceRows = readJsonLines(pullBrokerTracePath);
  check(
    'diagnostics broker uses pull when the server advertises diagnosticProvider',
    pullBrokerProbe.status === 0 &&
      pullBrokerOutput?.status === 'ok' &&
      pullBrokerOutput.transport === 'pull' &&
      pullBrokerOutput.documentVersion === 1 &&
      pullBrokerOutput.stale === false &&
      Boolean(pullBrokerOutput.collectedAt) &&
      pullBrokerOutput.result?.items?.length === 1 &&
      pullBrokerTraceRows.some((row) =>
        row.event === 'receive' && row.method === 'textDocument/diagnostic'
      ),
    pullBrokerProbe.stdout.slice(0, 1000) || pullBrokerProbe.stderr.slice(0, 1000)
  );

  const unchangedPullTracePath = path.join(fakeLspRoot, 'unchanged-pull-trace.jsonl');
  const unchangedPullProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: unchangedPullTracePath,
      CODE_INTEL_FAKE_PULL_DIAGNOSTICS: 'unchanged'
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'lsp_diagnostics',
          arguments: { repoRoot: fixtureRepoRoot, file: fixtureFile, timeoutMs: 5000 }
        }
      })
    ])
  });
  const unchangedPullOutput = parseProtocolFrames(unchangedPullProbe.stdout)
    .find((message) => message.id === 2)?.result?.structuredContent;
  check(
    'diagnostics broker preserves unchanged pull reports',
    unchangedPullProbe.status === 0 &&
      unchangedPullOutput?.status === 'ok' &&
      unchangedPullOutput.transport === 'pull' &&
      unchangedPullOutput.result?.kind === 'unchanged' &&
      unchangedPullOutput.result?.resultId === 'fixture-result' &&
      !Object.prototype.hasOwnProperty.call(unchangedPullOutput.result, 'items'),
    unchangedPullProbe.stdout.slice(0, 1000) || unchangedPullProbe.stderr.slice(0, 1000)
  );

  const pushBrokerTracePath = path.join(fakeLspRoot, 'push-broker-trace.jsonl');
  const pushBrokerProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: pushBrokerTracePath,
      CODE_INTEL_FAKE_PUSH_DIAGNOSTICS: '1',
      CODE_INTEL_FAKE_PULL_DIAGNOSTICS: 'unsupported'
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'lsp_diagnostics',
          arguments: { repoRoot: fixtureRepoRoot, file: fixtureFile, timeoutMs: 5000 }
        }
      })
    ])
  });
  const pushBrokerOutput = parseProtocolFrames(pushBrokerProbe.stdout)
    .find((message) => message.id === 2)?.result?.structuredContent;
  const pushBrokerTraceRows = readJsonLines(pushBrokerTracePath);
  check(
    'diagnostics broker consumes push diagnostics without a pull request',
    pushBrokerProbe.status === 0 &&
      pushBrokerOutput?.status === 'ok' &&
      pushBrokerOutput.transport === 'push' &&
      pushBrokerOutput.documentVersion === 1 &&
      pushBrokerOutput.stale === false &&
      Boolean(pushBrokerOutput.collectedAt) &&
      pushBrokerOutput.result?.items?.length === 1 &&
      pushBrokerTraceRows.some((row) =>
        row.event === 'send' && row.method === 'textDocument/publishDiagnostics'
      ) &&
      !pushBrokerTraceRows.some((row) =>
        row.event === 'receive' && row.method === 'textDocument/diagnostic'
      ),
    pushBrokerProbe.stdout.slice(0, 1000) || pushBrokerProbe.stderr.slice(0, 1000)
  );

  const pushAuditTracePath = path.join(fakeLspRoot, 'push-audit-trace.jsonl');
  const pushAuditProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: pushAuditTracePath,
      CODE_INTEL_FAKE_PUSH_DIAGNOSTICS: '1',
      CODE_INTEL_FAKE_PULL_DIAGNOSTICS: 'unsupported'
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'post_edit_audit',
          arguments: {
            repoRoot: fixtureRepoRoot,
            files: [fixtureFile],
            timeoutMs: 5000
          }
        }
      })
    ])
  });
  const pushAuditOutput = parseProtocolFrames(pushAuditProbe.stdout)
    .find((message) => message.id === 2)?.result?.structuredContent;
  const pushAuditTraceRows = readJsonLines(pushAuditTracePath);
  check(
    'post-edit audit reports push diagnostic provenance',
    pushAuditProbe.status === 0 &&
      pushAuditOutput?.diagnostics?.length === 1 &&
      pushAuditOutput.diagnostics[0]?.status === 'ok' &&
      pushAuditOutput.diagnostics[0]?.transport === 'push' &&
      pushAuditOutput.diagnostics[0]?.documentVersion === 1 &&
      pushAuditOutput.diagnostics[0]?.stale === false &&
      Boolean(pushAuditOutput.diagnostics[0]?.collectedAt) &&
      !pushAuditTraceRows.some((row) =>
        row.event === 'receive' && row.method === 'textDocument/diagnostic'
      ),
    pushAuditProbe.stdout.slice(0, 1000) || pushAuditProbe.stderr.slice(0, 1000)
  );

  const pushChangeRepoRoot = path.join(fakeLspRoot, 'push-change-repo');
  fs.cpSync(fixtureRepoRoot, pushChangeRepoRoot, { recursive: true });
  const pushChangeTracePath = path.join(fakeLspRoot, 'push-change-trace.jsonl');
  const pushChangeManager = new LspSessionManager({
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: pushChangeTracePath,
      CODE_INTEL_FAKE_PUSH_DIAGNOSTICS: '1',
      CODE_INTEL_FAKE_PULL_DIAGNOSTICS: 'unsupported',
      CODE_INTEL_FAKE_PUSH_DIAGNOSTICS_EMPTY_ON_CHANGE: '1'
    }
  });
  const pushChangeArgs = {
    repoRoot: pushChangeRepoRoot,
    file: fixtureFile,
    settingsPathExtraDirs: [fakeBinDir],
    timeoutMs: 5000
  };
  const pushBeforeChange = await pushChangeManager.diagnosticsForFile(
    'fake-no-version-lsp --stdio',
    { language: 'typescript' },
    pushChangeArgs
  );
  fs.appendFileSync(
    path.join(pushChangeRepoRoot, fixtureFile),
    '\nexport const diagnosticsCleared = true;\n'
  );
  const pushAfterChange = await pushChangeManager.diagnosticsForFile(
    'fake-no-version-lsp --stdio',
    { language: 'typescript' },
    pushChangeArgs
  );
  await pushChangeManager.shutdownAll();
  check(
    'push diagnostics empty notification clears findings for the current version',
    pushBeforeChange.transport === 'push' &&
      pushBeforeChange.documentVersion === 1 &&
      pushBeforeChange.response?.result?.items?.length === 1 &&
      pushAfterChange.transport === 'push' &&
      pushAfterChange.documentVersion === 2 &&
      pushAfterChange.response?.result?.items?.length === 0 &&
      pushAfterChange.stale === false,
    JSON.stringify({ pushBeforeChange, pushAfterChange })
  );

  const stalePushTracePath = path.join(fakeLspRoot, 'stale-push-trace.jsonl');
  const stalePushProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: stalePushTracePath,
      CODE_INTEL_FAKE_PUSH_DIAGNOSTICS: '1',
      CODE_INTEL_FAKE_PULL_DIAGNOSTICS: 'unsupported',
      CODE_INTEL_FAKE_PUSH_DIAGNOSTICS_VERSION_OFFSET: '-1'
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'lsp_diagnostics',
          arguments: {
            repoRoot: fixtureRepoRoot,
            file: fixtureFile,
            timeoutMs: 5000,
            diagnosticSettleMs: 25
          }
        }
      })
    ])
  });
  const stalePushOutput = parseProtocolFrames(stalePushProbe.stdout)
    .find((message) => message.id === 2)?.result?.structuredContent;
  check(
    'diagnostics broker rejects stale push diagnostics',
    stalePushProbe.status === 0 &&
      stalePushOutput?.status === 'unavailable' &&
      stalePushOutput.transport === 'push' &&
      stalePushOutput.documentVersion === 1 &&
      stalePushOutput.stale === true &&
      /timed out waiting for push diagnostics/.test(stalePushOutput.fallbackReason || ''),
    stalePushProbe.stdout.slice(0, 1000) || stalePushProbe.stderr.slice(0, 1000)
  );

  const missingPushTracePath = path.join(fakeLspRoot, 'missing-push-trace.jsonl');
  const missingPushProbe = run(process.execPath, ['mcp/code-intel-server/index.js'], {
    env: {
      ...fakeLspEnv,
      CODE_INTEL_LSP_TRACE_FILE: missingPushTracePath,
      CODE_INTEL_FAKE_PULL_DIAGNOSTICS: 'unsupported'
    },
    input: Buffer.concat([
      initializeFrame(),
      mcpFrame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'lsp_diagnostics',
          arguments: {
            repoRoot: fixtureRepoRoot,
            file: fixtureFile,
            timeoutMs: 5000,
            diagnosticSettleMs: 25
          }
        }
      })
    ])
  });
  const missingPushOutput = parseProtocolFrames(missingPushProbe.stdout)
    .find((message) => message.id === 2)?.result?.structuredContent;
  check(
    'diagnostics broker reports a clear push timeout when no notification arrives',
    missingPushProbe.status === 0 &&
      missingPushOutput?.status === 'unavailable' &&
      missingPushOutput.transport === 'push' &&
      missingPushOutput.documentVersion === 1 &&
      missingPushOutput.stale === false &&
      /timed out waiting for push diagnostics/.test(missingPushOutput.fallbackReason || ''),
    missingPushProbe.stdout.slice(0, 1000) || missingPushProbe.stderr.slice(0, 1000)
  );
} catch (error) {
  check('LSP fixture oracle suite executes', false, error.stack || error.message);
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
  const extraDiscoveryProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: targetRepo, mode: 'full' })], {
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
  const relativeDiscoveryProbe = run('node', ['mcp/code-intel-server/index.js', '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: targetRepo, mode: 'full' })], {
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
  const relativeExtraDiscoveryProbe = run(process.execPath, [path.join(ROOT, 'mcp/code-intel-server/index.js'), '--call-tool', 'capability_discover', '--args', JSON.stringify({ repoRoot: targetRepo, mode: 'full' })], {
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
    strictProbe.status === 0 &&
      strictOutput.status === 'ok' &&
      strictOutput.serverInfo?.name === 'code-intel-strict-init-lsp' &&
      strictOutput.result?.length === 1 &&
      strictOutput.result[0]?.name === 'add' &&
      sameJson(strictOutput.result[0]?.selectionRange, lspRange(0, 0, 0, 3)),
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
      previewResult.replacementTemplate &&
      (previewResult.patchCandidates || []).every((candidate) =>
        !Object.prototype.hasOwnProperty.call(candidate, 'after') &&
        !Object.prototype.hasOwnProperty.call(candidate, 'replacementTemplate')
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
const auditFindingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-audit-finding-'));
try {
  fs.mkdirSync(path.join(auditFindingRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(auditFindingRoot, 'src', 'finding.ts'), 'console.log("finding");\n');
  const findingAudit = postEditAudit(
    { repoRoot: auditFindingRoot, files: ['src/finding.ts'], timeoutMs: 1000 },
    {
      loadSettings: () => ({
        version: 1,
        path: { extraDirs: [] },
        astGrep: { command: 'ast-grep', configPath: './sgconfig.yml' },
        fallback: ['rg', 'grep'],
        languages: {
          typescript: {
            extensions: ['.ts'],
            astGrep: { languageId: 'typescript' },
            lsp: { commands: [], capabilities: ['diagnostics'] }
          }
        }
      }),
      lspDiagnosticsForFile: (repoRoot, file) => ({
        file,
        language: 'typescript',
        status: 'ok',
        method: 'textDocument/diagnostic',
        result: { kind: 'full', items: [] },
        fallbackUsed: null,
        fallbackReason: null,
        stderrSummary: ''
      }),
      astGrepScan: () => ({
        status: 'ok',
        results: [{ file: 'src/finding.ts', ruleId: 'local.no-console', message: 'console.log found', severity: 'warning' }],
        fallback: [],
        fallbackReason: null
      })
    }
  );
  check(
    'post_edit_audit reports AST findings at top level',
    findingAudit.status === 'ok' &&
      findingAudit.astGrepScan?.status === 'ok' &&
      findingAudit.astGrepScan.results.length === 1 &&
      findingAudit.findingCount === 1 &&
      findingAudit.hasFindings === true &&
      /reported findings/.test(findingAudit.fallbackReason || ''),
    JSON.stringify(findingAudit).slice(0, 1000)
  );
} finally {
  fs.rmSync(auditFindingRoot, { recursive: true, force: true });
}
const auditLspSettingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-audit-lsp-settings-'));
try {
  const repoRoot = path.join(auditLspSettingsRoot, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'main.ts'), 'export const value = 1;\n');
  const envSettingsPath = path.join(auditLspSettingsRoot, 'env-settings.json');
  writeJson(envSettingsPath, {
    version: 1,
    path: { extraDirs: [] },
    astGrep: { command: 'missing-ast-grep-for-audit', configPath: null },
    fallback: ['rg', 'grep'],
    languages: {
      typescript: {
        extensions: ['.ts'],
        astGrep: { languageId: 'typescript' },
        lsp: { commands: [`node "${path.join(ROOT, 'fixtures/lsp/fake-lsp-server.js')}"`], capabilities: ['diagnostics'] }
      }
    }
  });
  const passedSettings = {
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
  };
  const originalDefaultSettingsPath = process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH;
  const originalUserSettingsPath = process.env.CODE_INTEL_USER_SETTINGS_PATH;
  const originalProjectSettingsPath = process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
  let isolatedDiagnostics;
  try {
    process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH = envSettingsPath;
    process.env.CODE_INTEL_USER_SETTINGS_PATH = path.join(auditLspSettingsRoot, 'missing-user-settings.json');
    process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = path.join(auditLspSettingsRoot, 'missing-project-settings.json');
    isolatedDiagnostics = lspDiagnosticsForFile(repoRoot, 'src/main.ts', passedSettings, 1000);
  } finally {
    if (originalDefaultSettingsPath === undefined) delete process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH;
    else process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH = originalDefaultSettingsPath;
    if (originalUserSettingsPath === undefined) delete process.env.CODE_INTEL_USER_SETTINGS_PATH;
    else process.env.CODE_INTEL_USER_SETTINGS_PATH = originalUserSettingsPath;
    if (originalProjectSettingsPath === undefined) delete process.env.CODE_INTEL_PROJECT_SETTINGS_PATH;
    else process.env.CODE_INTEL_PROJECT_SETTINGS_PATH = originalProjectSettingsPath;
  }
  check(
    'lspDiagnosticsForFile honors passed settings over environment settings',
    isolatedDiagnostics.status === 'unavailable' &&
      isolatedDiagnostics.language === 'typescript' &&
      isolatedDiagnostics.fallbackReason === 'LSP command missing',
    JSON.stringify(isolatedDiagnostics).slice(0, 1000)
  );
} finally {
  fs.rmSync(auditLspSettingsRoot, { recursive: true, force: true });
}
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
const INIT_FIXTURE_ORACLES = {
  'typescript-basic': { language: 'typescript', files: 1, astGrepSmoke: 'passed' },
  'python-basic': { language: 'python', files: 1, astGrepSmoke: 'passed' },
  'mixed-no-lsp': { language: 'javascript', files: 1, astGrepSmoke: 'passed' },
  'unsupported-language': { unsupportedExtension: '.foo', unsupportedFiles: 1 }
};
const initTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-fixtures-'));
try {
  const initEnv = isolatedSettingsEnv(initTmpRoot);
  for (const fixture of Object.keys(INIT_FIXTURE_ORACLES)) {
    const sourceFixtureRoot = path.join(ROOT, 'fixtures/repos', fixture);
    const fixtureRoot = path.join(initTmpRoot, fixture);
    fs.cpSync(sourceFixtureRoot, fixtureRoot, { recursive: true, filter: (src) => !src.includes(`${path.sep}docs${path.sep}code-intel`) });
    const first = run('node', ['scripts/init-code-intel.js', '--repo', fixtureRoot, '--json'], { env: initEnv });
    const second = run('node', ['scripts/init-code-intel.js', '--repo', fixtureRoot, '--json'], { env: initEnv });
    check(`init ${fixture} succeeds twice`, first.status === 0 && second.status === 0, (first.stderr || second.stderr || '').slice(0, 300));
    for (const report of ['capability-report.md','routing-profile.json','validation-report.md']) check(`init ${fixture} writes ${report}`, fs.existsSync(path.join(fixtureRoot, 'docs/code-intel', report)), report);
    const profile = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'docs/code-intel/routing-profile.json'), 'utf8'));
    const oracle = INIT_FIXTURE_ORACLES[fixture];
    const fixtureMatchesOracle = oracle.language
      ? profile.inventory?.languages?.[oracle.language]?.files === oracle.files &&
        profile.languages?.[oracle.language]?.files === oracle.files &&
        profile.languages?.[oracle.language]?.astGrepSmoke?.status === oracle.astGrepSmoke
      : profile.inventory?.unsupportedExtensions?.[oracle.unsupportedExtension] === oracle.unsupportedFiles;
    check(`init ${fixture} matches fixture inventory oracle`, fixtureMatchesOracle, JSON.stringify({
      oracle,
      inventory: profile.inventory,
      language: oracle.language ? profile.languages?.[oracle.language] : null
    }).slice(0, 1000));
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
  const freshDoctorEnv = isolatedSettingsEnv(freshDoctorTmpRoot);
  const initRun = run('node', ['scripts/init-code-intel.js', '--repo', freshDoctorTmpRoot, '--json'], { env: freshDoctorEnv });
  const doctorRun = run('node', ['scripts/doctor-code-intel.js', '--repo', freshDoctorTmpRoot, '--json'], { env: freshDoctorEnv });
  const doctor = JSON.parse(doctorRun.stdout || '{}');
  const reasons = (doctor.findings || []).map((finding) => finding.reason);
  check('fresh init then doctor does not report generated report inventory mismatch', initRun.status === 0 && doctorRun.status === 0 && !reasons.includes('language inventory major mismatch'), reasons.join(' | '));

  const profilePath = path.join(freshDoctorTmpRoot, 'docs/code-intel/routing-profile.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  profile.settingsSources = { project: profile.settingsSources.project, user: profile.settingsSources.user, default: profile.settingsSources.default };
  writeJson(profilePath, profile);
  const reorderedRun = run('node', ['scripts/doctor-code-intel.js', '--repo', freshDoctorTmpRoot, '--json'], { env: freshDoctorEnv });
  const reorderedDoctor = JSON.parse(reorderedRun.stdout || '{}');
  const reorderedReasons = (reorderedDoctor.findings || []).map((finding) => finding.reason);
  check('doctor treats reordered settings sources as equivalent', reorderedRun.status === 0 && !reorderedReasons.includes('settings source differs'), reorderedReasons.join(' | '));

  profile.settingsSources = { ...profile.settingsSources, default: 'stale-settings-source' };
  writeJson(profilePath, profile);
  const changedRun = run('node', ['scripts/doctor-code-intel.js', '--repo', freshDoctorTmpRoot, '--json'], { env: freshDoctorEnv });
  const changedDoctor = JSON.parse(changedRun.stdout || '{}');
  const changedReasons = (changedDoctor.findings || []).map((finding) => finding.reason);
  check('doctor detects changed settings source', changedRun.status === 0 && changedReasons.includes('settings source differs'), changedReasons.join(' | '));
} finally {
  fs.rmSync(freshDoctorTmpRoot, { recursive: true, force: true });
}
const staleTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-stale-profile-'));
try {
  fs.cpSync(path.join(ROOT, 'fixtures/repos/typescript-basic'), staleTmpRoot, { recursive: true });
  const staleDoctorEnv = isolatedSettingsEnv(staleTmpRoot);
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
  const doctorRun = run('node', ['scripts/doctor-code-intel.js', '--repo', staleTmpRoot, '--json'], { env: staleDoctorEnv });
  const doctor = JSON.parse(doctorRun.stdout || '{}');
  const reasons = (doctor.findings || []).map((finding) => finding.reason).join(' | ');
  check('doctor detects stale routing profile version and inventory mismatch', reasons.includes('plugin version differs') && reasons.includes('settings version differs') && reasons.includes('settings source differs') && reasons.includes('language inventory major mismatch'), reasons);
  fs.writeFileSync(path.join(staleDocs, 'routing-profile.json'), '{bad json');
  const corruptDoctorRun = run('node', ['scripts/doctor-code-intel.js', '--repo', staleTmpRoot, '--json'], { env: staleDoctorEnv });
  const corruptDoctor = JSON.parse(corruptDoctorRun.stdout || '{}');
  const corruptReasons = (corruptDoctor.findings || []).map((finding) => finding.reason).join(' | ');
  check('doctor survives malformed routing profile and reports live fallback', corruptDoctorRun.status === 0 && corruptReasons.includes('routing profile unreadable'), corruptReasons || corruptDoctorRun.stderr);
} finally {
  fs.rmSync(staleTmpRoot, { recursive: true, force: true });
}

const coreSkillSource = fs.readFileSync(path.join(ROOT, 'skills/code-intel/SKILL.md'), 'utf8');
check(
  'code-intel skill keeps routine tool routing internal',
  /do not announce/i.test(coreSkillSource) &&
    /materially (reduces|affects)/i.test(coreSkillSource),
  coreSkillSource.slice(0, 1200)
);
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
for (const dir of ['scripts','settings','mcp']) {
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
check('no script settings or MCP path calls forbidden shorthand command', offenders.length === 0, offenders.join(', ') || 'none');

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

await finish();
