import { discoverCapabilities, resolveCapabilityRoute } from './capabilities.js';
import { astGrepSearch, astGrepScan, astGrepReplacePreview } from './ast-grep.js';
import { postEditAudit } from './audit.js';
import { lspTool } from './lsp.js';

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
  'lsp_rename_preview'
];

export function callTool(name, args = {}) {
  switch (name) {
    case 'capability_discover': return discoverCapabilities(args.repoRoot || process.cwd());
    case 'capability_route': return resolveCapabilityRoute(args);
    case 'ast_grep_search': return astGrepSearch(args);
    case 'ast_grep_scan': return astGrepScan(args);
    case 'ast_grep_replace_preview': return astGrepReplacePreview(args);
    case 'post_edit_audit': return postEditAudit(args);
    case 'lsp_diagnostics': return lspTool('textDocument/diagnostic', args);
    case 'lsp_symbols': return lspTool('textDocument/documentSymbol', args);
    case 'lsp_goto_definition': return lspTool('textDocument/definition', args);
    case 'lsp_find_references': return lspTool('textDocument/references', args);
    case 'lsp_prepare_rename': return lspTool('textDocument/prepareRename', args);
    case 'lsp_rename_preview': return { ...lspTool('textDocument/rename', args), previewOnly: true, mutated: false };
    default: throw new Error(`unknown tool: ${name}`);
  }
}

export const commonProps = {
  repoRoot: { type: 'string', description: 'Repository root. Defaults to current working directory.' },
  language: { type: 'string', description: 'Language id such as typescript or python.' },
  file: { type: 'string', description: 'Repo-relative file path for LSP-oriented operations.' },
  position: { type: 'object', description: 'Zero-based LSP position {line, character}.' }
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
    base.description = 'Run preview/read-only structural search through the ast-grep executable when available.';
    base.inputSchema.required = ['pattern', 'language'];
    base.inputSchema.properties = { repoRoot: commonProps.repoRoot, pattern: { type: 'string' }, language: commonProps.language, maxResults: { type: 'number' } };
  } else if (name === 'ast_grep_scan') {
    base.description = 'Run read-only ast-grep rule scan using the effective astGrep.configPath.';
    base.inputSchema.properties = {
      repoRoot: commonProps.repoRoot,
      paths: { type: 'array', items: { type: 'string' } },
      maxResults: { type: 'number' }
    };
  } else if (name === 'ast_grep_replace_preview') {
    base.description = 'Preview structural replacement candidates without mutating files.';
    base.inputSchema.required = ['pattern', 'language', 'replacement'];
    base.inputSchema.properties = { repoRoot: commonProps.repoRoot, pattern: { type: 'string' }, language: commonProps.language, replacement: { type: 'string' }, maxResults: { type: 'number' } };
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
  }
  return base;
});
