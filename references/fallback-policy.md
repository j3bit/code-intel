# Fallback Policy

Fallback must be explicit and non-blocking.

Required missing `ast-grep` message:

```text
Fallback reason: ast-grep executable was not found on PATH.
Command policy: this plugin does not call sg.
```

Missing LSP servers degrade only LSP features. AST search can still be available independently.

Stale routing profiles are hints, not authority. Use live evidence for the current task and suggest `init-code-intel` to refresh reports.
