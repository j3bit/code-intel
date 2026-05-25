# Hook Contract

Hooks are optional accelerators, not correctness dependencies.

- User-prompt hooks may inject one short routing hint for structural search, definitions, references, rename, diagnostics, and rewrite intent.
- Pre-tool and post-tool lifecycle nudges are intentionally not shipped because repeated `additionalContext` output can pollute the model context without guaranteeing tool execution.
- Hooks never run LSP, AST, text search, diagnostics, or audits by themselves.
- Hooks never block `rg`, `grep`, or normal file edits.
- Post-edit verification belongs to explicit MCP tools such as `post_edit_audit` and to skill workflows, not repeated lifecycle reminders.
- Hooks must behave safely when no routing profile exists.
