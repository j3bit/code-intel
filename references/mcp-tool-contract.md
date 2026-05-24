# MCP Tool Contract

The MCP server exposes stable tool names, descriptions, input schemas, and output schemas. Preview tools never mutate repository files. Replacement preview is match-only unless executable validation proves safe metavariable substitution; match-only candidates must not pretend to be directly applicable `after` text.

Initial tools:

- `capability_discover`
- `ast_grep_search`
- `ast_grep_replace_preview`
- `lsp_diagnostics`
- `lsp_symbols`
- `lsp_goto_definition`
- `lsp_find_references`
- `lsp_prepare_rename`
- `lsp_rename_preview`
