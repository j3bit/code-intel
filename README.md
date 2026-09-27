# Code Intel

`code-intel` is a portable Codex, Claude Code, and OpenCode plugin bundle. It routes code search and navigation through AST/LSP capabilities before text fallback while keeping routine routing and successful fallback silent.

## What is shared

- `skills/` contains the client-neutral Agent Skills core.
- `mcp/code-intel-server/` contains the read-only, preview-oriented MCP server.
- `settings/` and `references/` contain capability and policy contracts.
- The repository root's `.agents/skills/` holds small OpenCode entry points that point back to these skills.
- `.codex-plugin/`, `.claude-plugin/`, and `clients/` contain thin client integrations.

The plugin does not bundle or install `ast-grep` or language servers. Missing optional tools degrade to supported fallback behavior.

## Claude Code

Install from the parent marketplace:

```sh
claude plugin marketplace add j3bit/agent-plugins
claude plugin install code-intel@j3bit-plugins
```

For local development, load this directory with Claude Code's `--plugin-dir` option. The Claude MCP configuration resolves its entry point through `${CLAUDE_PLUGIN_ROOT}`, so it does not depend on the caller's working directory.

## OpenCode

Expose the four folders under `skills/` through OpenCode's `.agents/skills`, `.claude/skills`, `.opencode/skills`, or configured skill catalog. The parent repository's `.agents/skills/` already contains entry points for them.

Then merge the `mcp.code-intel` entry from `clients/opencode/opencode.example.json` into your OpenCode configuration and launch OpenCode with the plugin root available:

```sh
CODE_INTEL_PLUGIN_ROOT="$HOME/Dev/agent-plugins/plugins/code-intel" opencode
```

OpenCode does not have to start a separate native LSP integration. The code-intel MCP server owns its language-server sessions, avoiding duplicate servers and duplicate diagnostics.

## Local checks

```sh
node mcp/code-intel-server/index.js --list-tools
node scripts/init-code-intel.js --repo fixtures/repos/typescript-basic
node scripts/doctor-code-intel.js --repo fixtures/repos/typescript-basic
node scripts/validate-plugin.js
```

Real language servers are exercised only by the opt-in `npm run integration:real` matrix. Preview tools never mutate repository files.
