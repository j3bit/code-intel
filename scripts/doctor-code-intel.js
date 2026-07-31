#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  discoverCapabilities,
  lspTool,
  readJson
} from '../mcp/code-intel-server/core.js';

function parseArgs(argv) {
  const out = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') out.repo = argv[++i];
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

function inventoryMismatch(profileInventory, liveInventory) {
  const profileLanguages = profileInventory?.languages || {};
  const liveLanguages = liveInventory?.languages || {};
  const languageNames = new Set([...Object.keys(profileLanguages), ...Object.keys(liveLanguages)]);
  for (const language of languageNames) {
    const profileFiles = profileLanguages[language]?.files || 0;
    const liveFiles = liveLanguages[language]?.files || 0;
    if (profileFiles !== liveFiles) return true;
  }
  return false;
}

function decrementInventoryLanguage(inventory, language) {
  const current = inventory.languages?.[language]?.files || 0;
  if (!current) return;
  inventory.languages[language] = { ...inventory.languages[language], files: current - 1 };
  if (inventory.languages[language].files <= 0) delete inventory.languages[language];
}

function comparableLiveInventory(repoRoot, inventory) {
  const comparable = JSON.parse(JSON.stringify(inventory || {}));
  comparable.languages ||= {};
  const reports = [
    { file: 'routing-profile.json', language: 'json' },
    { file: 'capability-report.md' },
    { file: 'validation-report.md' }
  ];
  for (const report of reports) {
    if (!fs.existsSync(path.join(repoRoot, 'docs', 'code-intel', report.file))) continue;
    comparable.totalFiles = Math.max(0, (comparable.totalFiles || 0) - 1);
    if (report.language) decrementInventoryLanguage(comparable, report.language);
  }
  return comparable;
}

function stableStringify(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function stableJsonEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function loadProfile(repoRoot, discovery) {
  const file = path.join(repoRoot, 'docs', 'code-intel', 'routing-profile.json');
  if (!fs.existsSync(file)) return { path: file, exists: false, staleReasons: ['routing profile missing; run init-code-intel'] };
  let profile;
  try {
    profile = readJson(file);
  } catch (error) {
    return { path: file, exists: true, profile: null, staleReasons: [`routing profile unreadable: ${error.message}`] };
  }
  const staleReasons = [];
  if (path.resolve(profile.repoRoot || '') !== repoRoot) staleReasons.push('repo root differs');
  if (!profile.generatedAt) staleReasons.push('profile timestamp missing');
  if (profile.pluginVersion !== discovery.pluginVersion) staleReasons.push('plugin version differs');
  if (profile.settingsVersion !== discovery.settingsVersion) staleReasons.push('settings version differs');
  if (!stableJsonEqual(profile.settingsSources || {}, discovery.settingsSources || {})) staleReasons.push('settings source differs');
  if (inventoryMismatch(profile.inventory, comparableLiveInventory(repoRoot, discovery.inventory))) staleReasons.push('language inventory major mismatch');
  return { path: file, exists: true, profile, staleReasons };
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(args.repo);
const discovery = discoverCapabilities(repoRoot);
const profile = loadProfile(repoRoot, discovery);
const findings = [];
const languageRuntimes = {};
if (!discovery.tools.astGrep.available) findings.push({ severity: 'degraded', capability: 'AST search', reason: 'ast-grep executable was not found on PATH', fallback: ['rg', 'grep'] });
for (const [language, info] of Object.entries(discovery.languages)) {
  if (!info.presentFiles) continue;
  if (info.astGrepProbe?.status === 'failed') {
    findings.push({
      severity: 'degraded',
      capability: `${language} AST`,
      reason: info.astGrepProbe.stderrSummary || 'ast-grep language parse smoke failed',
      fallback: ['rg', 'grep']
    });
  }
  if (info.lsp === 'missing') findings.push({ severity: 'degraded', capability: `${language} LSP`, reason: 'LSP command missing', fallback: info.astGrep === 'available' ? ['ast-grep', 'rg', 'grep'] : ['rg', 'grep'] });
  else if (info.lsp === 'commandDetected') {
    const file = discovery.inventory.languages[language]?.examples?.[0];
    const result = file
      ? lspTool('textDocument/documentSymbol', {
          repoRoot,
          language,
          file,
          timeoutMs: 5000
        })
      : null;
    const runtime = {
      expectedCapabilities: info.expectedCapabilities,
      advertisedCapabilities: result?.advertisedCapabilities || [],
      verifiedCapabilities: result?.verifiedCapabilities || [],
      unsupportedCapabilities: result?.unsupportedCapabilities || [],
      candidateInUse: result?.command || info.lspCommand,
      candidateFailures: result?.candidateFailures || [],
      lastFailure: result?.candidateFailures?.at(-1) || null,
      status: result?.status || 'skipped'
    };
    languageRuntimes[language] = runtime;
    const missingExpected = runtime.status === 'ok'
      ? runtime.expectedCapabilities.filter((capability) =>
          !runtime.advertisedCapabilities.includes(capability) &&
          !runtime.verifiedCapabilities.includes(capability)
        )
      : runtime.expectedCapabilities;
    findings.push({
      severity: runtime.status === 'ok' && !missingExpected.length ? 'info' : 'degraded',
      capability: `${language} LSP`,
      reason: runtime.status === 'ok'
        ? missingExpected.length
          ? `expected capabilities not advertised or verified: ${missingExpected.join(', ')}`
          : 'LSP initialize and documentSymbol method verified'
        : runtime.lastFailure?.reason || result?.fallbackReason || 'LSP runtime probe failed',
      fallback: info.astGrep === 'available' ? ['ast-grep', 'rg', 'grep'] : ['rg', 'grep']
    });
  }
}
for (const reason of profile.staleReasons) findings.push({ severity: 'info', capability: 'routing profile', reason, fallback: ['live detection'] });
const report = { status: findings.some((f) => f.severity === 'degraded') ? 'degraded' : 'ok', repoRoot, generatedAt: discovery.generatedAt, settingsVersion: discovery.settingsVersion, settingsSources: discovery.settingsSources, profile, tools: discovery.tools, languages: languageRuntimes, findings, commandPolicy: 'this plugin does not call sg' };
if (args.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`# Code Intel Doctor\n\nRepository: ${repoRoot}\nStatus: ${report.status}\n`);
  for (const f of findings) console.log(`- [${f.severity}] ${f.capability}: ${f.reason}; fallback: ${f.fallback.join(', ')}`);
  if (!findings.length) console.log('- No degraded capability detected.');
}
