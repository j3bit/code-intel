---
name: init-code-intel
description: Discover repository language support and write durable code-intel capability, routing, and validation reports.
---

# Init Code Intel

Run when a repository needs a fresh code-intel profile.

```sh
init-code-intel --repo <repo-root>
# From this plugin repository checkout, the equivalent fallback is:
node scripts/init-code-intel.js --repo <repo-root>
```

Outputs:

- `docs/code-intel/capability-report.md`
- `docs/code-intel/routing-profile.json`
- `docs/code-intel/validation-report.md`

The profile is a cache and routing hint. Live failures override stale profile data.

Read `references/language-adapter-contract.md` when changing adapter coverage.
