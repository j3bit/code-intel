import path from 'node:path';

import { astGrepScan } from './ast-grep.js';
import { lspDiagnosticsForFile } from './lsp.js';
import { lspDiagnosticsForFileWithSession } from './lsp-session-manager.js';
import { gitChangedFiles, resolveRepoRelativePaths } from './repo.js';
import { formatPostEditAuditResult } from './audit-result.js';
import { loadSettings } from './settings.js';

export function postEditAudit(args = {}, deps = {}) {
  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const settings = (deps.loadSettings || loadSettings)(repoRoot);
  const explicitFiles = Array.isArray(args.files) && args.files.length ? args.files : null;
  const source = explicitFiles
    ? { files: explicitFiles, reason: null }
    : (deps.gitChangedFiles || gitChangedFiles)(repoRoot);
  const safeFiles = (deps.resolveRepoRelativePaths || resolveRepoRelativePaths)(repoRoot, source.files);
  if (!safeFiles.ok) {
    return formatPostEditAuditResult({
      status: 'error',
      repoRoot,
      files: [],
      diagnostics: [],
      astGrepScan: { status: 'unavailable', fallbackReason: safeFiles.reason },
      fallbackReason: safeFiles.reason
    });
  }
  if (safeFiles.paths.length === 0) {
    const reason = source.reason || 'no files selected for post_edit_audit';
    return formatPostEditAuditResult({
      repoRoot,
      files: [],
      fileSource: explicitFiles ? 'args.files' : 'git diff',
      fileSourceFallbackReason: reason,
      diagnostics: [],
      astGrepScan: { status: 'unavailable', results: [], fallback: settings.fallback, fallbackReason: reason }
    });
  }
  const timeoutMs = args.timeoutMs || 10000;
  const runScan = deps.astGrepScan || astGrepScan;
  const astGrepScanResult = settings.astGrep.configPath
    ? runScan({ repoRoot, paths: safeFiles.paths, timeoutMs, maxResults: args.maxResults || 100 })
    : { status: 'unavailable', results: [], fallback: settings.fallback, fallbackReason: 'ast-grep configPath is not configured for post_edit_audit' };
  const format = (diagnostics) => formatPostEditAuditResult({
    repoRoot,
    files: safeFiles.paths,
    fileSource: explicitFiles ? 'args.files' : 'git diff',
    fileSourceFallbackReason: source.reason,
    diagnostics,
    astGrepScan: astGrepScanResult
  });
  if (deps.lspSessionManager) {
    return Promise.all(safeFiles.paths.map((file) =>
      lspDiagnosticsForFileWithSession(
        deps.lspSessionManager,
        repoRoot,
        file,
        settings,
        timeoutMs
      )
    )).then(format);
  }
  const runDiagnostics = deps.lspDiagnosticsForFile || lspDiagnosticsForFile;
  return format(safeFiles.paths.map((file) =>
    runDiagnostics(repoRoot, file, settings, timeoutMs)
  ));
}
