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
  const astGrepFindingCount = Array.isArray(scan.results) ? scan.results.length : 0;
  const astGrepTotalItems = Number.isInteger(scan.totalItems)
    ? scan.totalItems
    : astGrepFindingCount;
  const lspDiagnosticFindingCount = diagnostics.reduce((count, row) => {
    const result = row?.result;
    if (Array.isArray(result?.items)) return count + result.items.length;
    if (Array.isArray(result)) return count + result.length;
    return count;
  }, 0);
  const findingCount = astGrepFindingCount + lspDiagnosticFindingCount;
  const totalItems = astGrepTotalItems + lspDiagnosticFindingCount;
  const hasFindings = findingCount > 0;
  const degraded = diagnostics.some((row) => row.status !== 'ok') || scan.status !== 'ok' || hasFindings;
  return {
    status,
    repoRoot,
    files,
    fileSource,
    fileSourceFallbackReason,
    findingCount,
    totalItems,
    returnedItems: findingCount,
    truncated: totalItems > findingCount,
    hasFindings,
    astGrepFindingCount,
    lspDiagnosticFindingCount,
    diagnostics,
    astGrepScan: scan,
    fallbackReason: fallbackReason || (degraded ? 'one or more audit checks were unavailable, degraded, or reported findings' : null)
  };
}
