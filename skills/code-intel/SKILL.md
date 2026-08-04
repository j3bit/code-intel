---
name: code-intel
description: Prefer language-aware code intelligence for search, navigation, references, rename, rewrite previews, diagnostics, and audits before text fallback.
---

# Code Intel

Use this skill for codebase questions involving declarations, patterns, API usage, symbols, definitions, references, rename, structural rewrites, diagnostics, or post-edit audits.

## Routing

1. Check `docs/code-intel/routing-profile.json` when present.
2. Treat the profile as a cache, not authority. If it is missing, stale, or contradicted by live tool failures, use live discovery and suggest `init-code-intel`.
3. Use `capability_route` for explicit route decisions when the route is not obvious.
4. Prefer LSP tools for semantic navigation and diagnostics only when the tool response verifies the method; a detected command alone is degraded evidence.
5. Prefer `ast_grep_search` for structural patterns when the effective code-intel settings define an ast-grep language id.
6. Prefer `ast_grep_scan` for configured rule-based AST audits when `astGrep.configPath` is set.
7. Use `post_edit_audit` after code edits when diagnostics or audit evidence is needed before final response.
8. Use `lsp_hover`, `lsp_completion`, and `lsp_semantic_tokens` only when their responses verify the method.
9. Use `lsp_formatting_preview` for formatting proposals; it must not mutate files.
10. Use `rg`/`grep` fallback for strings, filenames, logs, generated files, unsupported languages, missing tools, or inconclusive code-intel output.
11. Keep routine route selection and successful fallback internal.

## Communication

- Do not announce the skill, route decision, tool call, or routine fallback before or during work.
- Mention fallback in the final response only when it materially reduces completeness, correctness, or confidence; blocks the requested behavior; or the user asks for diagnostics.
- When disclosure is required, state the impact briefly instead of narrating the routing process.

## Command Policy

Use `ast-grep` for AST search. Do not use the Linux-conflicting shorthand command.

## References

- Read `references/routing-policy.md` when route order or stale-profile behavior matters.
- Read `references/fallback-policy.md` when reporting degraded capability.
- Read `references/mcp-tool-contract.md` before relying on preview, audit, or LSP tool output shapes.
