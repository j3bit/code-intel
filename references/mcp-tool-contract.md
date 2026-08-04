# MCP Tool Contract

The MCP server exposes stable tool names, descriptions, input schemas, and output schemas. Preview tools never mutate repository files. Audit tools report available checks and explicit unavailable/fallback reasons; they do not edit repository files. Replacement preview is match-only unless executable validation proves safe metavariable substitution; match-only candidates must not pretend to be directly applicable `after` text.

Initial tools:

- `capability_discover`
- `capability_route`
- `ast_grep_search`
- `ast_grep_scan`
- `ast_grep_replace_preview`
- `post_edit_audit`
- `lsp_diagnostics`
- `lsp_symbols`
- `lsp_goto_definition`
- `lsp_find_references`
- `lsp_prepare_rename`
- `lsp_rename_preview`
- `lsp_hover`
- `lsp_completion`
- `lsp_semantic_tokens`
- `lsp_formatting_preview`

The four extended read tools require the corresponding initialize capability
before sending a method request. Completion and semantic-token results report
`totalItems`, `returnedItems`, `maxResults`, and `truncated`; callers cannot raise
the limit above 1000. Formatting returns only `TextEdit` preview data with
`previewOnly: true` and `mutated: false`.

`ast_grep_search` runs the complete search into an expiring local result set and
returns a bounded page. Callers continue with the opaque `nextCursor` and the
same repository, language, and pattern. `complete: true` means the stored result
set is exhaustive; `pageComplete: true` means the current page is the last page.
`maxResults` remains a deprecated alias for `pageSize`.
