import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

export function realpathIfExists(target) {
  try { return fs.realpathSync(target); }
  catch { return null; }
}

export function insideDir(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function canonicalRepoRoot(repoRoot) {
  const resolvedRoot = path.resolve(repoRoot || process.cwd());
  return realpathIfExists(resolvedRoot) || resolvedRoot;
}

export function resolveRepoRelativeFile(repoRoot, file) {
  if (!file) return { ok: false, reason: 'file is required for LSP operation' };
  if (path.isAbsolute(file)) return { ok: false, reason: 'file must be repo-relative, not absolute' };
  const canonicalRoot = canonicalRepoRoot(repoRoot);
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

export function resolveRepoRelativePaths(repoRoot, files = []) {
  const paths = [];
  for (const file of files) {
    const resolved = resolveRepoRelativeFile(repoRoot, file);
    if (!resolved.ok) return { ok: false, paths: [], reason: resolved.reason };
    paths.push(path.relative(resolved.repoRoot, resolved.filePath));
  }
  return { ok: true, paths, reason: null };
}

export function workspaceFolderForRepo(repoRoot) {
  const canonicalRoot = canonicalRepoRoot(repoRoot);
  return {
    uri: pathToFileURL(canonicalRoot).href,
    name: path.basename(canonicalRoot)
  };
}

export function gitChangedFiles(repoRoot) {
  const diff = spawnSync('git', ['-C', repoRoot, 'diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD', '--'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  if (diff.status !== 0) return { files: [], reason: 'git diff failed; pass files explicitly for post_edit_audit' };
  const untracked = spawnSync('git', ['-C', repoRoot, 'ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  const files = [
    ...diff.stdout.split(/\r?\n/),
    ...(untracked.status === 0 ? untracked.stdout.split(/\r?\n/) : [])
  ].map((line) => line.trim()).filter(Boolean);
  const uniqueFiles = [...new Set(files)];
  return { files: uniqueFiles, reason: uniqueFiles.length ? null : 'no changed files detected by git diff or untracked scan' };
}
