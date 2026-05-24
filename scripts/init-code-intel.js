#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverCapabilities, lspTool } from '../mcp/code-intel-server/core.js';

function parseArgs(argv) {
  const out = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') out.repo = argv[++i];
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }

function astGrepSmoke(repoRoot, language, info, discovery) {
  if (info.astGrep !== 'available') return { status: 'skipped', reason: 'ast-grep unavailable or language unsupported' };
  const example = discovery.inventory.languages[language]?.examples?.[0];
  if (!example) return { status: 'skipped', reason: 'no sample file detected for language' };
  const result = spawnSync('ast-grep', ['--lang', info.astGrepLanguageId, '--pattern', '$A', '--json', path.join(repoRoot, example)], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  if (result.status === 0 || result.stdout) return { status: 'passed', file: example, languageId: info.astGrepLanguageId };
  return { status: 'failed', file: example, languageId: info.astGrepLanguageId, stderrSummary: (result.stderr || result.error?.message || '').trim().slice(0, 300) };
}

function lspInitializeSmoke(repoRoot, language, info, discovery) {
  if (info.lsp !== 'commandDetected') return { status: 'skipped', reason: 'no LSP command detected' };
  const example = discovery.inventory.languages[language]?.examples?.[0];
  if (!example) return { status: 'skipped', reason: 'no sample file detected for language' };
  const result = lspTool('textDocument/documentSymbol', { repoRoot, language, file: example, timeoutMs: 5000 });
  if (result.status === 'ok') return { status: 'passed', file: example, command: result.command, serverInfo: result.serverInfo || null, methodVerified: result.methodVerified || 'documentSymbol' };
  return { status: 'failed', file: example, command: result.command || info.lspCommand, reason: result.fallbackReason || result.error?.message || result.status };
}

function markdownCapability(discovery) {
  const lines = ['# Code Intel Capability Report', '', `Generated: ${discovery.generatedAt}`, `Repository: \`${discovery.repoRoot}\``, '', '## Tooling', '', `- ast-grep: ${discovery.tools.astGrep.available ? 'available' : 'missing'}`, `- command policy: use \`ast-grep\`; this plugin does not call sg.`, '', '## Languages', ''];
  for (const [language, info] of Object.entries(discovery.languages)) {
    if (!info.presentFiles) continue;
    lines.push(`### ${language}`, '', `- files: ${info.presentFiles}`, `- AST: ${info.astGrep}`, `- ast-grep smoke: ${info.astGrepSmoke?.status || 'not-run'}`, `- LSP: ${info.lsp}${info.lspCommand ? ` (${info.lspCommand}; method readiness requires smoke)` : ''}`, `- LSP initialize smoke: ${info.lspInitializeSmoke?.status || 'not-run'}`, `- fallback: ${info.fallback.join(', ')}`, '');
  }
  if (!Object.values(discovery.languages).some((l) => l.presentFiles)) lines.push('No adapter-supported files detected.', '');
  lines.push('## Fallback', '', discovery.fallbackPolicy, '');
  return lines.join('\n');
}

function markdownValidation(discovery) {
  const checks = [];
  checks.push(['routing profile generated', true, 'docs/code-intel/routing-profile.json']);
  checks.push(['ast-grep command name', discovery.tools.astGrep.command === 'ast-grep', discovery.tools.astGrep.command]);
  checks.push(['fallback status explicit', Boolean(discovery.fallbackPolicy), discovery.fallbackPolicy]);
  checks.push(['adapter registry version recorded', Boolean(discovery.adapterRegistryVersion), discovery.adapterRegistryVersion]);
  checks.push(['per-language ast-grep smoke recorded', Object.values(discovery.languages).filter((l) => l.presentFiles).every((l) => l.astGrepSmoke), 'routing-profile languages.*.astGrepSmoke']);
  checks.push(['optional LSP initialize smoke recorded', Object.values(discovery.languages).filter((l) => l.presentFiles).every((l) => l.lspInitializeSmoke), 'routing-profile languages.*.lspInitializeSmoke']);
  const lines = ['# Code Intel Validation Report', '', `Generated: ${discovery.generatedAt}`, '', '| Check | Status | Evidence |', '|---|---:|---|'];
  for (const [name, ok, evidence] of checks) lines.push(`| ${name} | ${ok ? 'pass' : 'fail'} | ${String(evidence).replace(/\|/g, '\\|')} |`);
  lines.push('');
  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(args.repo);
const discovery = discoverCapabilities(repoRoot);
for (const [language, info] of Object.entries(discovery.languages)) {
  if (!info.presentFiles) continue;
  info.astGrepSmoke = astGrepSmoke(repoRoot, language, info, discovery);
  info.lspInitializeSmoke = lspInitializeSmoke(repoRoot, language, info, discovery);
}
const docsDir = path.join(repoRoot, 'docs', 'code-intel');
ensureDir(docsDir);
const profile = {
  repoRoot: discovery.repoRoot,
  generatedAt: discovery.generatedAt,
  pluginVersion: discovery.pluginVersion,
  adapterRegistryVersion: discovery.adapterRegistryVersion,
  tools: discovery.tools,
  languages: Object.fromEntries(Object.entries(discovery.languages).filter(([, v]) => v.presentFiles > 0).map(([k, v]) => [k, { astGrep: v.astGrep, astGrepLanguageId: v.astGrepLanguageId, astGrepSmoke: v.astGrepSmoke, lsp: v.lsp, lspState: v.lspState, lspCommand: v.lspCommand, lspInitializeSmoke: v.lspInitializeSmoke, methodVerified: v.lspInitializeSmoke?.status === 'passed' ? ['documentSymbol'] : [], fallback: v.fallback, files: v.presentFiles }])),
  inventory: discovery.inventory,
  staleRules: ['repo root differs', 'adapter registry version differs', 'plugin version differs', 'profile timestamp predates material plugin upgrade', 'language inventory major mismatch'],
  commandPolicy: 'this plugin does not call sg'
};
writeJson(path.join(docsDir, 'routing-profile.json'), profile);
fs.writeFileSync(path.join(docsDir, 'capability-report.md'), markdownCapability(discovery));
fs.writeFileSync(path.join(docsDir, 'validation-report.md'), markdownValidation(discovery));
const summary = { status: 'ok', repoRoot, reports: ['docs/code-intel/capability-report.md', 'docs/code-intel/routing-profile.json', 'docs/code-intel/validation-report.md'] };
if (args.json) console.log(JSON.stringify(summary, null, 2));
else console.log(`code-intel init complete: ${summary.reports.join(', ')}`);
