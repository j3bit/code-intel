import { discoverCapabilities, resolveCapabilityRoute } from './capabilities.js';
import { astGrepSearch, astGrepScan, astGrepReplacePreview } from './ast-grep.js';
import { postEditAudit } from './audit.js';
import { lspTool } from './lsp.js';
import { lspToolWithSession } from './lsp-session-manager.js';

export const TOOL_NAMES = [
  'capability_discover',
  'capability_route',
  'ast_grep_search',
  'ast_grep_scan',
  'ast_grep_replace_preview',
  'post_edit_audit',
  'lsp_diagnostics',
  'lsp_symbols',
  'lsp_goto_definition',
  'lsp_find_references',
  'lsp_prepare_rename',
  'lsp_rename_preview',
  'lsp_hover',
  'lsp_completion',
  'lsp_semantic_tokens',
  'lsp_formatting_preview'
];

function callLspTool(runtime, method, args) {
  return runtime.lspSessionManager
    ? lspToolWithSession(runtime.lspSessionManager, method, args)
    : lspTool(method, args);
}

function renamePreview(result) {
  if (result && typeof result.then === 'function') {
    return result.then((value) => ({ ...value, previewOnly: true, mutated: false }));
  }
  return { ...result, previewOnly: true, mutated: false };
}

function mapResult(result, mapper) {
  return result && typeof result.then === 'function'
    ? result.then(mapper)
    : mapper(result);
}

function boundedLimit(value, fallback = 200) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), 1000));
}

function limitCompletion(result, maxResults) {
  if (result?.status !== 'ok') return result;
  const limit = boundedLimit(maxResults);
  const completionList = !Array.isArray(result.result) && result.result?.items;
  const items = Array.isArray(result.result)
    ? result.result
    : completionList
      ? result.result.items
      : [];
  const limited = items.slice(0, limit);
  return {
    ...result,
    result: Array.isArray(result.result)
      ? limited
      : { ...result.result, items: limited },
    totalItems: items.length,
    returnedItems: limited.length,
    maxResults: limit,
    truncated: items.length > limited.length
  };
}

function limitSemanticTokens(result, maxResults) {
  if (result?.status !== 'ok') return result;
  const limit = boundedLimit(maxResults);
  const data = Array.isArray(result.result?.data) ? result.result.data : [];
  const totalItems = Math.floor(data.length / 5);
  const returnedItems = Math.min(totalItems, limit);
  return {
    ...result,
    result: { ...result.result, data: data.slice(0, returnedItems * 5) },
    totalItems,
    returnedItems,
    maxResults: limit,
    truncated: totalItems > returnedItems
  };
}

function formattingPreview(result) {
  return {
    ...result,
    previewOnly: true,
    mutated: false
  };
}

export function callTool(name, args = {}, runtime = {}) {
  switch (name) {
    case 'capability_discover': return discoverCapabilities(args.repoRoot || process.cwd());
    case 'capability_route': return resolveCapabilityRoute(args);
    case 'ast_grep_search': return astGrepSearch(args);
    case 'ast_grep_scan': return astGrepScan(args);
    case 'ast_grep_replace_preview': return astGrepReplacePreview(args);
    case 'post_edit_audit': return postEditAudit(args, runtime);
    case 'lsp_diagnostics': return callLspTool(runtime, 'textDocument/diagnostic', args);
    case 'lsp_symbols': return callLspTool(runtime, 'textDocument/documentSymbol', args);
    case 'lsp_goto_definition': return callLspTool(runtime, 'textDocument/definition', args);
    case 'lsp_find_references': return callLspTool(runtime, 'textDocument/references', args);
    case 'lsp_prepare_rename': return callLspTool(runtime, 'textDocument/prepareRename', args);
    case 'lsp_rename_preview': return renamePreview(callLspTool(runtime, 'textDocument/rename', args));
    case 'lsp_hover': return callLspTool(runtime, 'textDocument/hover', { ...args, requireAdvertisedCapability: true });
    case 'lsp_completion': return mapResult(
      callLspTool(runtime, 'textDocument/completion', { ...args, requireAdvertisedCapability: true }),
      (result) => limitCompletion(result, args.maxResults)
    );
    case 'lsp_semantic_tokens': return mapResult(
      callLspTool(runtime, 'textDocument/semanticTokens/full', { ...args, requireAdvertisedCapability: true }),
      (result) => limitSemanticTokens(result, args.maxResults)
    );
    case 'lsp_formatting_preview': return mapResult(
      callLspTool(runtime, 'textDocument/formatting', { ...args, requireAdvertisedCapability: true }),
      formattingPreview
    );
    default: throw new Error(`unknown tool: ${name}`);
  }
}

export const commonProps = {
  repoRoot: { type: 'string', description: 'Repository root. Defaults to current working directory.' },
  language: { type: 'string', description: 'Language id such as typescript or python.' },
  file: { type: 'string', description: 'Repo-relative file path for LSP-oriented operations.' },
  position: { type: 'object', description: 'Zero-based LSP position {line, character}.' },
  pageSize: { type: 'number', description: 'Results requested per page; defaults to 10 and is capped at 100. The response byte limit may return fewer.' },
  cursor: { type: 'string', description: 'Opaque cursor from a previous page of the same search.' }
};

export const tools = TOOL_NAMES.map((name) => {
  const base = { name, description: '', inputSchema: { type: 'object', properties: {}, additionalProperties: true }, outputSchema: { type: 'object', properties: { status: { type: 'string' }, fallbackReason: { type: ['string', 'null'] } } } };
  if (name === 'capability_discover') {
    base.description = 'Discover code-intel capabilities, language inventory, ast-grep availability, LSP command candidates, and fallback reasons.';
    base.inputSchema.properties = { repoRoot: commonProps.repoRoot };
  } else if (name === 'capability_route') {
    base.description = 'Return the recommended code-intel route for semantic, structural, rename, diagnostics, or audit intent without mutating files.';
    base.inputSchema.properties = {
      repoRoot: commonProps.repoRoot,
      language: commonProps.language,
      file: commonProps.file,
      intent: { type: 'string', enum: ['semantic', 'structural', 'diagnostics', 'rename', 'audit'] }
    };
  } else if (name === 'ast_grep_search') {
    base.description = 'Run exhaustive read-only structural search and return a stable, bounded result page.';
    base.inputSchema.required = ['pattern', 'language'];
    base.inputSchema.properties = {
      repoRoot: commonProps.repoRoot,
      pattern: { type: 'string' },
      language: commonProps.language,
      pageSize: commonProps.pageSize,
      cursor: commonProps.cursor,
      maxResults: { type: 'number', description: 'Deprecated alias for pageSize.' }
    };
  } else if (name === 'ast_grep_scan') {
    base.description = 'Run read-only ast-grep rule scan using the effective astGrep.configPath.';
    base.inputSchema.properties = {
      repoRoot: commonProps.repoRoot,
      paths: { type: 'array', items: { type: 'string' } },
      maxResults: { type: 'number' }
    };
  } else if (name === 'ast_grep_replace_preview') {
    base.description = 'Preview one stable page of exhaustive structural replacement candidates without mutating files.';
    base.inputSchema.required = ['pattern', 'language', 'replacement'];
    base.inputSchema.properties = {
      repoRoot: commonProps.repoRoot,
      pattern: { type: 'string' },
      language: commonProps.language,
      replacement: { type: 'string' },
      pageSize: commonProps.pageSize,
      cursor: commonProps.cursor,
      maxResults: { type: 'number', description: 'Deprecated alias for pageSize.' }
    };
  } else if (name === 'post_edit_audit') {
    base.description = 'Run explicit post-edit audit: LSP diagnostics per file when available and ast-grep rule scan when configured.';
    base.inputSchema.properties = {
      repoRoot: commonProps.repoRoot,
      files: { type: 'array', items: { type: 'string' } },
      timeoutMs: { type: 'number' },
      maxResults: { type: 'number' }
    };
  } else {
    base.description = `Check or preview LSP operation ${name}; degrades gracefully when no server is available.`;
    base.inputSchema.properties = { repoRoot: commonProps.repoRoot, language: commonProps.language, file: commonProps.file, position: commonProps.position, symbol: { type: 'string' }, newName: { type: 'string' } };
    base.inputSchema.required = ['file'];
    if (['lsp_goto_definition', 'lsp_find_references', 'lsp_prepare_rename', 'lsp_rename_preview'].includes(name)) {
      base.inputSchema.required.push('position');
    }
    if (name === 'lsp_rename_preview') base.inputSchema.required.push('newName');
    if (['lsp_completion', 'lsp_semantic_tokens'].includes(name)) {
      base.inputSchema.properties.maxResults = {
        type: 'number',
        description: 'Maximum completion items or semantic tokens returned; capped at 1000.'
      };
    }
    if (name === 'lsp_completion') {
      base.inputSchema.properties.context = { type: 'object' };
      base.inputSchema.required.push('position');
    }
    if (name === 'lsp_hover') base.inputSchema.required.push('position');
    if (name === 'lsp_formatting_preview') {
      base.inputSchema.properties.options = { type: 'object' };
      base.description = 'Preview LSP document formatting TextEdits without mutating the file.';
    }
  }
  return base;
});
