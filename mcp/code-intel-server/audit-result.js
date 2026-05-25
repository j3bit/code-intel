export function formatPostEditAuditResult({
  status = 'ok',
  repoRoot,
  files = [],
  fileSource = null,
  fileSourceFallbackReason = null,
  diagnostics = [],
  astGrepScan = null,
  fallbackReason = null
}) {
  const scan = astGrepScan || { status: 'unavailable', results: [], fallbackReason: 'audit did not request ast-grep scan' };
  const degraded = diagnostics.some((row) => row.status !== 'ok') || scan.status !== 'ok';
  return {
    status,
    repoRoot,
    files,
    fileSource,
    fileSourceFallbackReason,
    diagnostics,
    astGrepScan: scan,
    fallbackReason: fallbackReason || (degraded ? 'one or more audit checks were unavailable, degraded, or reported findings' : null)
  };
}
