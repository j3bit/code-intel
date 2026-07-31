# Code Intel Routing Policy

Use `code-intel` when the user asks for code structure, symbols, definitions, references, rename, rewrite, diagnostics, or post-edit audits.

## Route order

1. Use `capability_route` when a task needs an explicit route decision before selecting a specialized tool.
2. Use LSP when the task needs semantic answers and an initialized server verifies the requested method.
3. Use `ast-grep` when the task is structurally expressible and the effective settings define an ast-grep language id for that language.
4. Use `ast_grep_scan` when the effective settings define `astGrep.configPath` and the task needs configured rule-based AST audit.
5. Supplement with `rg` or `grep` for strings, logs, filenames, generated files, unsupported languages, incomplete AST output, or confirmation.
6. Report the route used and any fallback reason.

Fallback is not failure. It lowers confidence and should be visible in the final response.

## Behavior scenario routes

- Route decision: use `capability_route` with intent `semantic`, `structural`, `diagnostics`, `rename`, or `audit`.
- Rename symbol: use `lsp_prepare_rename`, then `lsp_rename_preview`; if unavailable, use a preview fallback such as `ast_grep_replace_preview` when structurally expressible.
- Rewrite structural pattern: use `ast_grep_replace_preview` only; apply approved changes through normal edits.
- Rule-based AST audit: use `ast_grep_scan` when `astGrep.configPath` is configured.
- Edit file then audit: use `post_edit_audit` with edited repo-relative files; it runs LSP diagnostics when available and ast-grep scan when configured.
- Inspect symbol context: use `lsp_hover` when the server advertises hover.
- Request candidates: use `lsp_completion` with a bounded `maxResults`.
- Inspect semantic classification: use `lsp_semantic_tokens` with a bounded `maxResults`.
- Preview formatting: use `lsp_formatting_preview`; apply reviewed edits separately.
