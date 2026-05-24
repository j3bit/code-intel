# Code Intel Routing Policy

Use `code-intel` when the user asks for code structure, symbols, definitions, references, rename, rewrite, diagnostics, or post-edit audits.

## Route order

1. Use LSP when the task needs semantic answers and an initialized server is available.
2. Use `ast-grep` when the task is structurally expressible and the language adapter supports built-in AST search.
3. Supplement with `rg` or `grep` for strings, logs, filenames, generated files, unsupported languages, incomplete AST output, or confirmation.
4. Report the route used and any fallback reason.

Fallback is not failure. It lowers confidence and should be visible in the final response.

## Behavior scenario routes

- Rename symbol: use `lsp_prepare_rename`, then `lsp_rename_preview`; if unavailable, use a preview fallback such as `ast_grep_replace_preview` when structurally expressible.
- Rewrite structural pattern: use `ast_grep_replace_preview` only; apply approved changes through normal edits.
- Edit file then run diagnostics: use `lsp_diagnostics` when available; otherwise report fallback audit commands.
