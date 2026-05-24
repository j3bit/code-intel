# Repository Guidelines

## Project Structure & Module Organization

This repository is the standalone `code-intel` Codex plugin. Core MCP logic lives in `mcp/code-intel-server/`, with the executable entrypoint in `index.js` and shared implementation in `core.js`. User-facing CLI workflows are in `scripts/` (`init`, `doctor`, `validate`). Codex skill instructions live under `skills/*/SKILL.md`; optional soft hooks live in `hooks/` with `hooks/hooks.json` as the manifest. Language capability data is in `adapters/`, policy contracts are in `references/`, and the maintained project direction lives in `docs/project-direction.md`. Historical design notes may be kept only as local ignored archives. Test fixtures are under `fixtures/repos/`, with fake LSP servers in `fixtures/lsp/`.

## Build, Test, and Development Commands

- `npm run mcp:list-tools` — starts the MCP server in list-tools mode and verifies tool registration.
- `npm run init:code-intel -- --repo fixtures/repos/typescript-basic` — generates code-intel reports for a fixture repo.
- `npm run doctor:code-intel -- --repo fixtures/repos/typescript-basic` — checks local AST/LSP availability and fallback reasons.
- `npm run validate` or `npm run --silent validate -- --json` — runs the full structural, MCP, hook, fixture, and policy validation suite.

The package has no runtime dependencies; use built-in Node modules unless a new dependency is explicitly justified.

## Coding Style & Naming Conventions

Use ESM JavaScript (`import`/`export`) and two-space indentation. Keep scripts executable when they are listed as package binaries. Prefer descriptive kebab-case for files and package scripts, and snake_case for MCP tool names (for example, `ast_grep_search`). The AST command policy is `ast-grep`; do not introduce the Linux-conflicting `sg` shorthand.

## Testing Guidelines

Extend `scripts/validate-plugin.js` for new behavior and add focused fixtures under `fixtures/repos/` or `fixtures/lsp/`. Validation should prove graceful fallback when `ast-grep` or an LSP server is missing. Preview tools must stay non-mutating; add regression checks before changing MCP tool behavior.

## Commit & Pull Request Guidelines

Recent history uses short imperative commits such as `Fix LSP command detection` and `Resolve code-intel review findings`. Keep commits scoped and validation-backed. PRs should describe behavior changes, list affected paths, mention any policy-contract updates, and include `npm run validate` evidence. Link issues or review threads when applicable.

## Agent-Specific Instructions

Inspect real repository files before editing. Preserve standalone operation: no bundled `ast-grep`, no bundled language servers, no automatic dependency installation, and explicit fallback reporting when text search is used.
