# Porting Report

## Scope

- Source: `j3bit/code-intel` (imported with history into `j3bit/agent-plugins` on 2026-09-28)
- Distribution: `plugins/code-intel` in `j3bit/agent-plugins`
- Targets: Codex, Claude Code, OpenCode
- Version: 0.3.0
- Skills: `code-intel`, `code-intel-doctor`, `code-intel-refactor`, `init-code-intel`

## Conversion decisions

- Kept one shared `skills/` core. Skills reach the plugin-root `references/` and `settings/` through `../../` paths, matching the other plugins in `j3bit/agent-plugins`, instead of carrying per-skill copies.
- Preserved Codex `agents/openai.yaml` policy files because they control explicit invocation. Claude Code and OpenCode ignore this client-specific metadata.
- Added a Claude Code manifest and MCP configuration using `${CLAUDE_PLUGIN_ROOT}`.
- Added OpenCode entry points in the repository root's `.agents/skills/` plus an environment-relative OpenCode MCP configuration example.
- Did not add native Claude Code or OpenCode LSP configuration. The MCP server already manages LSP sessions; enabling both would duplicate processes and diagnostics.
- Preserved silent routing instructions: successful tool choice and routine fallback are not narrated to the user.

## Behavioral compatibility

- MCP tool names, schemas, pagination, byte caps, preview-only guarantees, and fallback reporting are unchanged.
- `ast_grep_search` still stores the exhaustive result set and returns bounded pages with cursors.
- `capability_discover` still defaults to a compact summary and writes details to a temporary report.
- External `ast-grep` and language-server binaries remain optional and are never installed automatically.

## Trigger checks

Positive cases: symbol/reference lookup, structural AST search, rename or rewrite preview, code-intel initialization, and degraded-capability diagnosis.

Negative cases: prose search, filenames/logs/generated files, unsupported languages, and ordinary tasks with no code-navigation or structural-search need.

## Installation caveat

Claude Code installs the MCP configuration with the plugin. OpenCode discovers the skills independently, so its `mcp.code-intel` entry must be configured once using `clients/opencode/opencode.example.json`.

## Validation evidence

- Portable skill checker: passed (four expected Codex-policy warnings).
- Existing plugin regression suite: 250/250 checks passed.
- Claude Code `plugin validate --strict`: passed.
- Claude Code MCP configuration: 16 tools listed successfully.
- OpenCode skill discovery: all four skills found.
- OpenCode MCP status: `code-intel connected`.
