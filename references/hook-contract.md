# Hook Contract

Hooks are optional accelerators, not correctness dependencies.

- User-prompt hooks inject short routing reminders for structural search, definitions, references, rename, diagnostics, and rewrite intent.
- Pre-tool hooks nudge structural text search or manual replacement toward code-intel first when supported.
- Post-tool hooks suggest diagnostics or structural audits after code edits.
- Hooks never block `rg`, `grep`, or normal file edits.
- Hooks must behave safely when no routing profile exists.
