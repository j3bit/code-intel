# Code Intel Project Direction

## North Star

`code-intel` exists to make language-aware code understanding the default path
for Codex coding work, while remaining useful in plain Codex setups without any
larger orchestration layer. The project should give agents IDE-like confidence:
structural search, symbol navigation, references, rename previews, rewrite
previews, and post-edit diagnostics should be easy to discover, safe to run, and
honest about their limits.

This is not a general agent harness, package manager, or language-server bundle.
It should stay focused on the code-intelligence layer that improves how an agent
reads, reasons about, and safely changes repositories.

## Product Boundary

The plugin should remain standalone and behavior-first:

- **Standalone Codex plugin:** skills and MCP tools must work without assuming
  any specific orchestration runtime.
- **Optional acceleration:** hooks may provide short routing nudges, but they
  must not become correctness dependencies.
- **External tooling:** do not bundle `ast-grep`, language servers, or custom
  parser build chains in the core path.
- **No automatic installation:** report missing tools with install hints, but do
  not install dependencies automatically.
- **Canonical AST command:** use the `ast-grep` executable name only; do not add
  command paths that call the Linux-conflicting `sg` shorthand.
- **Graceful degradation:** missing AST or LSP support should produce explicit
  fallback reasons and keep `rg`/`grep` available.
- **Preview before mutation:** MCP tools that imply edits should return previews
  or candidates; file mutation stays in the normal Codex edit path.

## Operating Model

`code-intel` has four cooperating layers:

1. **MCP capability layer** — exposes actual code-intelligence tools that can be
   attached independently of any orchestration runtime.
2. **Skill behavior layer** — teaches agents when to prefer code-intel for
   search, navigation, references, rename, rewrite, diagnostics, and audits.
3. **Optional hook layer** — provides short deterministic nudges for structural
   intent, text-search detours, manual replacements, and post-edit checks.
4. **Adapter and reporting layer** — keeps language support declarative and
   writes durable capability evidence for future turns.

Hooks may improve routing, but the MCP server and skills must remain useful when
hooks are absent. Generated routing profiles are hints, not authority; live tool
failures and method-specific responses override stale cached data.

## Core Capabilities

The project should keep the following capabilities first-class:

1. **Capability discovery** — identify repository languages, available
   `ast-grep`, LSP command candidates, method-readiness evidence, and fallback
   status.
2. **Structural search** — use `ast_grep_search` for parseable AST patterns when
   the language is supported.
3. **Semantic navigation** — use LSP for definitions, references, symbols, and
   diagnostics only when the server interaction proves method readiness.
4. **Safe refactor previews** — expose rename and rewrite intent as preview
   flows before normal edits are applied.
5. **Post-change verification** — encourage diagnostics or structural/text
   audits after edits, especially after refactors.

## Routing Contracts

Every user-visible route should be explicit about the path used and the fallback
reason when degraded.

- **Structural search:** try AST search for supported languages; supplement with
  `rg`/`grep` for strings, filenames, logs, generated files, unsupported
  languages, incomplete AST output, or confirmation.
- **Semantic navigation:** try LSP definitions, references, symbols, and
  diagnostics when a server interaction verifies the requested method; otherwise
  degrade to AST search when structurally expressible, then text fallback.
- **Rename and rewrite:** try `lsp_prepare_rename` and `lsp_rename_preview` for
  rename; use `ast_grep_replace_preview` only for previewable structural
  rewrites; otherwise use normal manual edits plus text/structural audits.
- **Post-edit validation:** after normal edits, prefer LSP diagnostics when
  available and use AST/text audits when diagnostics are missing or inconclusive.
- **Stale profiles:** treat repo-root mismatch, plugin or adapter-version drift,
  missing timestamps, and major language-inventory mismatches as stale-profile
  signals; use live evidence and suggest refreshing with `init-code-intel`.

## Capability and Reporting Contracts

Project initialization should produce durable evidence under `docs/code-intel/`:

```text
docs/code-intel/
  capability-report.md
  routing-profile.json
  validation-report.md
```

Reports should record supported languages, unsupported extensions, available and
missing tools, validated methods, degraded capabilities, fallback routes, and why
fallback was used. Reports must remain concise enough for future agents to read
quickly.

Language adapters should declare:

- language id and file extensions,
- `ast-grep` language id and support status,
- LSP command candidates,
- supported LSP capabilities,
- fallback policy,
- fixture expectations for success and degraded operation.

Keep adapters declarative until a language clearly needs deeper integration.
When deeper integration becomes necessary, add fixtures and validation before
broadening user-facing behavior.

## Validation Bar

Validation should prove behavior, not only file presence.

Required validation surfaces:

- **Plugin structure:** manifest, skills, MCP registration, adapter schema,
  registry, references, executable scripts, and hook manifest.
- **MCP contract:** server startup, framed initialize, tool listing, stable tool
  schemas, clean unavailable responses, and non-mutating preview tools.
- **AST behavior:** `ast-grep` detection, built-in-language smoke search,
  structured result rows, unsupported-language fallback, invalid-pattern
  fallback, and no executable/config path calling `sg`.
- **LSP behavior:** command detection without requiring `--version`, initialize
  ordering, repo-relative command resolution, method request/response smoke,
  path-safety checks, clean shutdown, and explicit failure reasons.
- **Init and doctor:** report generation, semantic idempotency, stale-profile
  detection, malformed-profile survival, and visible fallback recommendations.
- **Hooks:** short pure input/output nudges, no blocking of `rg`/`grep` or normal
  edits, safe behavior when no routing profile exists.
- **Behavior scenarios:** executable route tests for definition lookup,
  references, rename preview, structural rewrite preview, post-edit diagnostics,
  unsupported language fallback, missing `ast-grep`, and missing LSP.

A validation check that only confirms documentation wording is weaker than a
check that executes the relevant tool route. Prefer executable scenario tests
when they can be kept deterministic and dependency-light.

## Development Principles

- Prefer real tool responses over cached profiles.
- Keep fallback reporting visible in both tools and documentation.
- Treat `ast-grep` as the canonical executable name.
- Preserve standalone operation; avoid coupling the plugin to one workflow style.
- Keep hooks short, deterministic, and optional.
- Keep preview tools honest: distinguish executable edits from match-only
  candidates, and never imply a replacement is safe unless the substituted output
  has been proven.
- Add fixtures before broadening behavior; every new route should have validation
  for success and degraded operation.
- Favor small reliable language coverage over a broad but unreliable adapter
  registry.

## Roadmap Priorities

### 1. Reliability Before Breadth

Strengthen MCP framing, LSP lifecycle handling, path safety, timeout behavior,
and degraded responses before adding many languages. A small set of reliable
adapters is more valuable than a broad but unreliable registry.

### 2. Honest Preview Workflows

Improve replacement and rename previews so they clearly distinguish executable
edits from match-only candidates. Never imply that a replacement is safe to
apply unless the tool has proven the substituted output.

### 3. Better Repository Initialization

Make `init-code-intel` produce concise, durable reports that help future agents
choose the right route quickly: supported languages, known missing tools,
validated methods, stale-profile signals, and recommended fallback commands.

### 4. Language Adapter Expansion

Add languages through adapter contracts, fixtures, and validation gates. Each
adapter should document file extensions, AST support, LSP command candidates,
capabilities, fallback behavior, and fixture expectations.

### 5. Refactor Guidance

Evolve `code-intel-refactor` into a practical workflow for mechanical changes:
baseline diagnostics, structural/semantic preview, normal edit application, and
post-change verification.

## Success Criteria

The project is on track when an agent can answer:

- Which code-intel route should I try first?
- Why is this language supported or degraded?
- Which tool response proves the result?
- If AST or LSP is unavailable, what fallback did I use and why?
- After an edit, what diagnostic or audit evidence confirms the change?

Future work should be judged by whether it makes those answers clearer, safer,
and easier to verify without expanding beyond the code-intelligence layer.
