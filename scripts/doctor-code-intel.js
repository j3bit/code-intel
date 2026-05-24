#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { discoverCapabilities, readJson } from '../mcp/code-intel-server/core.js';

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
  if (profile.adapterRegistryVersion !== discovery.adapterRegistryVersion) staleReasons.push('adapter registry version differs');
  if (inventoryMismatch(profile.inventory, discovery.inventory)) staleReasons.push('language inventory major mismatch');
  return { path: file, exists: true, profile, staleReasons };
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(args.repo);
const discovery = discoverCapabilities(repoRoot);
const profile = loadProfile(repoRoot, discovery);
const findings = [];
if (!discovery.tools.astGrep.available) findings.push({ severity: 'degraded', capability: 'AST search', reason: 'ast-grep executable was not found on PATH', fallback: ['rg', 'grep'] });
for (const [language, info] of Object.entries(discovery.languages)) {
  if (!info.presentFiles) continue;
  if (info.lsp === 'missing') findings.push({ severity: 'degraded', capability: `${language} LSP`, reason: 'LSP command missing', fallback: info.astGrep === 'available' ? ['ast-grep', 'rg', 'grep'] : ['rg', 'grep'] });
  else if (info.lsp === 'commandDetected') findings.push({ severity: 'info', capability: `${language} LSP`, reason: 'LSP command detected; method readiness requires initialize/method smoke', fallback: info.astGrep === 'available' ? ['ast-grep', 'rg', 'grep'] : ['rg', 'grep'] });
}
for (const reason of profile.staleReasons) findings.push({ severity: 'info', capability: 'routing profile', reason, fallback: ['live detection'] });
const report = { status: findings.some((f) => f.severity === 'degraded') ? 'degraded' : 'ok', repoRoot, generatedAt: discovery.generatedAt, profile, tools: discovery.tools, findings, commandPolicy: 'this plugin does not call sg' };
if (args.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`# Code Intel Doctor\n\nRepository: ${repoRoot}\nStatus: ${report.status}\n`);
  for (const f of findings) console.log(`- [${f.severity}] ${f.capability}: ${f.reason}; fallback: ${f.fallback.join(', ')}`);
  if (!findings.length) console.log('- No degraded capability detected.');
}
