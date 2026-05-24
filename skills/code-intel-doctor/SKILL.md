---
name: code-intel-doctor
description: Troubleshoot missing ast-grep, stale routing profiles, missing LSP servers, and degraded fallback behavior.
---

# Code Intel Doctor

Run when code-intel capability seems missing, stale, or degraded.

```sh
doctor-code-intel --repo <repo-root>
# From this plugin repository checkout, the equivalent fallback is:
node scripts/doctor-code-intel.js --repo <repo-root>
```

Doctor reports:

- tool availability,
- stale profile signals,
- adapter coverage,
- LSP command availability,
- fallback reasons,
- safe next actions.

It never installs dependencies automatically.

Read `references/fallback-policy.md` when interpreting degraded capabilities.
