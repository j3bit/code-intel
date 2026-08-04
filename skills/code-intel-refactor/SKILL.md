---
name: code-intel-refactor
description: "Run refactoring with code-intel gates: discover capability, preview changes, apply normal edits, then run explicit post-edit audit."
---

# Code Intel Refactor

Use for rename or structural rewrite tasks.

1. Run `capability_route` with `intent: "rename"` or `intent: "structural"` for the target file/language.
2. Prefer `lsp_prepare_rename` and `lsp_rename_preview` for rename.
3. Use `ast_grep_replace_preview` only for previewable structural rewrites.
4. Apply approved edits through normal Codex file editing, not through MCP mutation.
5. Run `post_edit_audit` with the edited repo-relative files before final response.
6. Keep routine routing internal; report degraded capability only when it materially affects the requested refactor or verification.

Read `references/routing-policy.md` for route order and `references/mcp-tool-contract.md` for preview-only tool contracts.
