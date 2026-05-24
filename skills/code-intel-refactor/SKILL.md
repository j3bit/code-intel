---
name: code-intel-refactor
description: "Run refactoring with code-intel gates: discover capability, preview changes, apply through normal edits, then run diagnostics and audits."
---

# Code Intel Refactor

Use for rename or structural rewrite tasks.

1. Discover capabilities.
2. Prefer `lsp_prepare_rename` and `lsp_rename_preview` for rename.
3. Use `ast_grep_replace_preview` only for previewable structural rewrites.
4. Apply approved edits through normal Codex file editing, not through MCP mutation.
5. Run diagnostics and structural/text audits after edits.
6. Report degraded capability and fallback route.

Read `references/routing-policy.md` for route order and `references/mcp-tool-contract.md` for preview-only tool contracts.
