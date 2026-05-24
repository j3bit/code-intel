# Code Intel Codex Plugin

`code-intel` is a standalone Codex plugin that makes language-aware code intelligence the preferred route for code tasks before falling back to text search.

The MVP ships:

- Codex skills for everyday routing, initialization, doctor troubleshooting, and refactor gates.
- A Node-based MCP server using only built-in Node modules.
- An adapter registry for AST/LSP capability discovery.
- Optional soft hooks that nudge but never block agent behavior.
- Validation scripts and fixture repositories.

## Hard MVP policies

- The plugin does **not** bundle `ast-grep` or language servers.
- The plugin does **not** install dependencies automatically.
- The AST command policy is `ast-grep` only; the Linux-conflicting shorthand is not used as a command path.
- MCP tools are preview/read-only for repository contents and do not mutate files.
- `rg`/`grep` fallback remains valid and must be reported when used.

## Quick checks

```sh
node mcp/code-intel-server/index.js --list-tools
node scripts/init-code-intel.js --repo fixtures/repos/typescript-basic
node scripts/doctor-code-intel.js --repo fixtures/repos/typescript-basic
node scripts/validate-plugin.js
```
