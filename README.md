# Code Intel Codex Plugin

`code-intel` is a standalone Codex plugin that makes language-aware code intelligence the preferred route for code tasks before falling back to text search.

The MVP ships:

- Codex skills for everyday routing, initialization, doctor troubleshooting, and refactor gates.
- A Node-based MCP server using only built-in Node modules.
- Zero-config settings for AST/LSP capability discovery, with optional user and project overrides.
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

Real language servers are exercised only by the opt-in matrix:

```sh
npm run integration:real
```

Missing optional servers are recorded as skips. If a configured executable is
installed but its required protocol checks fail, the command exits non-zero and
writes `artifacts/code-intel-integration-matrix.json` with executable paths,
versions, per-method result hashes, and corpus provenance.

For a user-local tcsh-lsp build that is not on `PATH`, set its command explicitly:

```sh
CODE_INTEL_TCSH_LSP_COMMAND=/absolute/path/to/tcsh-lsp npm run integration:real
```
