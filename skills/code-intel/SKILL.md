---
name: code-intel
description: Prefer language-aware code intelligence for search, navigation, references, rename, rewrite previews, and diagnostics before text fallback.
---

# Code Intel

Use this skill for codebase questions involving declarations, patterns, API usage, symbols, definitions, references, rename, structural rewrites, diagnostics, or post-edit audits.

## Routing

1. Check `docs/code-intel/routing-profile.json` when present.
2. Treat the profile as a cache, not authority. If it is missing, stale, or contradicted by live tool failures, use live discovery and suggest `init-code-intel`.
3. Prefer LSP tools for semantic navigation and diagnostics only when the tool response verifies the method; a detected command alone is degraded evidence.
4. Prefer `ast_grep_search` for structural patterns when the adapter supports built-in AST search.
5. Use `rg`/`grep` fallback for strings, filenames, logs, generated files, unsupported languages, missing tools, or inconclusive code-intel output.
6. Report the route and fallback reason.

## Command policy

Use `ast-grep` for AST search. Do not use the Linux-conflicting shorthand command.

## References

- Read `references/routing-policy.md` when route order or stale-profile behavior matters.
- Read `references/fallback-policy.md` when reporting degraded capability.
- Read `references/mcp-tool-contract.md` before relying on preview or LSP tool output shapes.
