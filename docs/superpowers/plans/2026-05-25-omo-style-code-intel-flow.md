# OMO-Style Code Intel Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `code-intel` so repeated lifecycle hook nudges are removed and OMO-style, low-noise MCP tools and skill workflows own routing and post-edit verification.

**Architecture:** Keep `code-intel` standalone and dependency-light: MCP tools perform capability routing, AST/LSP operations, rule scans, and post-edit audits through small server modules with clear boundaries; `core.js` remains a compatibility facade rather than the owner of new workflows; skills describe when to call those tools; hooks provide only a single prompt-time hint. Validation proves the new behavior with executable MCP calls and architecture guards rather than relying on repeated `additionalContext` reminders.

**Tech Stack:** Node.js ESM, built-in `fs/path/os/child_process/url` modules only, existing MCP JSON-RPC stdio server, `ast-grep` executable when present, existing validator harness in `scripts/validate-plugin.js`.

---

## File Structure

- Modify: `hooks/hooks.json` — keep only `UserPromptSubmit`; remove `PreToolUse` and `PostToolUse` registrations from the shipped manifest.
- Modify: `hooks/user-prompt-submit.js` — keep a short one-shot prompt classifier with fewer broad terms and no lifecycle reminders.
- Delete: `hooks/pre-tool-use.js` — remove the repeated pre-tool structural-search nudge from the active plugin surface.
- Delete: `hooks/post-tool-use.js` — remove the repeated post-tool diagnostics/audit nudge from the active plugin surface.
- Modify: `references/hook-contract.md` — document hooks as low-frequency optional prompt hints, not tool execution or verification drivers.
- Create: `mcp/code-intel-server/settings.js` — settings loading, schema defaults, home/path expansion, and command-line splitting.
- Create: `mcp/code-intel-server/repo.js` — repo path safety, file walking, repo-relative normalization, and changed-file discovery.
- Create: `mcp/code-intel-server/capabilities.js` — language inventory, executable candidate discovery, and route decisions.
- Create: `mcp/code-intel-server/ast-grep.js` — ast-grep command construction, search, rule scan, replacement preview, and JSON normalization.
- Create: `mcp/code-intel-server/lsp.js` — LSP process lifecycle, protocol calls, diagnostics, symbols, definitions, references, and rename previews.
- Create: `mcp/code-intel-server/audit.js` — `post_edit_audit` use-case orchestration only; it delegates git/file selection, diagnostics, scan execution, and result formatting.
- Create: `mcp/code-intel-server/audit-result.js` — post-edit audit result shaping and fallback summary text.
- Create: `mcp/code-intel-server/tools.js` — `TOOL_NAMES`, tool schemas, and `callTool()` dispatch composition.
- Modify: `mcp/code-intel-server/core.js` — keep import compatibility by re-exporting from the focused modules; do not add new workflow logic here.
- Modify: `references/mcp-tool-contract.md` — list the new read-only tools and their non-mutating contract.
- Modify: `references/routing-policy.md` — make route selection and post-edit verification explicit MCP operations.
- Modify: `skills/code-intel/SKILL.md` — route structural/semantic work through `capability_route`, LSP, AST, and fallback.
- Modify: `skills/code-intel-refactor/SKILL.md` — make `post_edit_audit` the final verification gate for edits.
- Modify: `docs/project-direction.md` — update the north-star operating model to OMO-style low-noise hooks and explicit audit tools.
- Modify: `scripts/validate-plugin.js:10` — extend `EXPECTED_TOOLS`.
- Modify: `scripts/validate-plugin.js:930-970` — replace Pre/Post hook checks with prompt-only hook checks and absence checks.
- Modify: `scripts/validate-plugin.js:311-315` and nearby MCP contract checks — add `capability_route`, `ast_grep_scan`, and `post_edit_audit` executable checks.
- Modify: `scripts/validate-plugin.js:1012-1024` — update behavior scenario documentation checks to reflect explicit route/audit tools.

## Design Invariants

- Hooks must not be correctness dependencies.
- Hooks must not inject context after every search, edit, or shell tool call.
- MCP tools must be read-only unless their contract says otherwise; replacement and rename remain preview-only.
- `post_edit_audit` must run available checks and report unavailable checks, not silently imply verification happened.
- Missing `ast-grep`, missing LSP, missing `astGrep.configPath`, unsupported languages, and non-git repositories must return explicit fallback reasons.
- The plugin must keep using the `ast-grep` executable name, never the `sg` shorthand.
- New server behavior must enter through focused modules, not by expanding `core.js`.

## Clean Architecture Boundary Rules

- `core.js` is the composition and compatibility facade. It may re-export server API and preserve the CLI worker entrypoint, but it must not own new use cases, subprocess driver details, route policy, audit orchestration, or presenter formatting.
- `settings.js` owns configuration parsing and path expansion. Other modules receive normalized settings or call this gateway; they must not duplicate home/config resolution.
- `repo.js` owns repository path safety, repo-relative path normalization, file walking, and changed-file discovery. Git subprocess usage belongs here.
- `capabilities.js` owns language detection, capability discovery, executable candidate selection, and route decisions.
- `ast-grep.js` owns ast-grep subprocess calls, command arguments, JSON parsing, and AST result normalization.
- `lsp.js` owns LSP subprocess lifecycle, protocol messages, method calls, and LSP result normalization.
- `audit.js` owns the post-edit audit use case by coordinating `repo.js`, `lsp.js`, and `ast-grep.js`; it must not contain git command construction, LSP protocol plumbing, or ast-grep command construction.
- `audit-result.js` owns final post-edit audit response shaping so the use case does not grow presentation rules.
- `tools.js` owns MCP tool names, schemas, and dispatch wiring. It composes the modules above and keeps tool contracts in one place.
- `scripts/validate-plugin.js` must include architecture guards that fail when new workflow code is added to `core.js`.

## Boundary Risk Review

- Current `core.js` already combines settings, repo path safety, language inventory, capability routing, ast-grep execution, LSP protocol handling, tool dispatch, and worker CLI behavior. Adding new workflows directly there would make the existing boundary mix worse.
- The highest-risk plan item was `post_edit_audit`: the previous shape placed git changed-file discovery, file selection, LSP diagnostics, ast-grep scan execution, and final response formatting in one `core.js` function.
- `ast_grep_scan` also risks mixing AST subprocess details with MCP schema and route policy if it is added beside `callTool()` instead of inside an AST gateway module.
- `capability_route` risks becoming a policy branch inside tool dispatch if route decisions are not kept in `capabilities.js`.
- The corrected plan therefore splits the server first, then adds route, scan, and audit behavior through the focused modules and keeps validation guards around `core.js`.

---

### Task 1: Make Hooks Prompt-Only And Low-Noise

**Files:**
- Modify: `hooks/hooks.json:1-25`
- Modify: `hooks/user-prompt-submit.js:1-22`
- Delete: `hooks/pre-tool-use.js`
- Delete: `hooks/post-tool-use.js`
- Modify: `references/hook-contract.md:1-9`
- Modify: `scripts/validate-plugin.js:930-970`

- [ ] **Step 1: Write failing hook validation checks**

In `scripts/validate-plugin.js`, replace the hook validation block at lines `930-970` with this exact block:

```js
// Hook validation
const hookManifest = readJson('hooks/hooks.json');
check(
  'hook manifest wires only prompt-time soft hook',
  JSON.stringify(hookManifest.hooks?.UserPromptSubmit || '').includes('${PLUGIN_ROOT}/hooks/user-prompt-submit.js') &&
    !hookManifest.hooks?.PreToolUse &&
    !hookManifest.hooks?.PostToolUse,
  JSON.stringify(hookManifest).slice(0, 500)
);
function parseHookOutput(stdout) {
  if (!stdout.trim()) return { ok: true, empty: true, value: null, evidence: 'empty stdout' };
  try {
    const value = JSON.parse(stdout);
    return { ok: true, empty: false, value, evidence: stdout };
  } catch (error) {
    return { ok: false, empty: false, value: null, evidence: error.message };
  }
}
function validSoftHookOutput(stdout, expected) {
  const parsed = parseHookOutput(stdout);
  if (!parsed.ok || parsed.empty || !parsed.value || Array.isArray(parsed.value)) return { ok: false, evidence: parsed.evidence };
  const allowedTopLevel = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'decision', 'reason', 'hookSpecificOutput']);
  const unknownTopLevel = Object.keys(parsed.value).filter((key) => !allowedTopLevel.has(key));
  const hookSpecificOutput = parsed.value.hookSpecificOutput;
  const ok = unknownTopLevel.length === 0 &&
    hookSpecificOutput &&
    hookSpecificOutput.hookEventName === expected &&
    typeof hookSpecificOutput.additionalContext === 'string' &&
    hookSpecificOutput.additionalContext.includes('code-intel') &&
    hookSpecificOutput.additionalContext.length < 360;
  return { ok, evidence: ok ? hookSpecificOutput.additionalContext : JSON.stringify({ unknownTopLevel, value: parsed.value }).slice(0, 800) };
}
const promptHook = run('node', ['hooks/user-prompt-submit.js'], { input: 'rename symbol and find references' });
const promptHookResult = validSoftHookOutput(promptHook.stdout, 'UserPromptSubmit');
check('UserPromptSubmit emits one short Codex-compatible JSON hint', promptHook.status === 0 && promptHookResult.ok, promptHookResult.evidence || promptHook.stderr);
const ordinaryPromptHook = run('node', ['hooks/user-prompt-submit.js'], { input: 'summarize the README' });
check('UserPromptSubmit stays silent for non-code-intel prompts', ordinaryPromptHook.status === 0 && ordinaryPromptHook.stdout.trim() === '', ordinaryPromptHook.stdout);
check('PreToolUse hook script retired', !exists('hooks/pre-tool-use.js'), 'hooks/pre-tool-use.js');
check('PostToolUse hook script retired', !exists('hooks/post-tool-use.js'), 'hooks/post-tool-use.js');
```

- [ ] **Step 2: Run RED validation for hook behavior**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({status:j.status,failed:j.failed,failures:j.results.filter(r=>!r.ok).map(r=>r.name)}, null, 2)); if(j.status==="passed") process.exit(1);})'
```

Expected: FAIL with `hook manifest wires only prompt-time soft hook`, `PreToolUse hook script retired`, and `PostToolUse hook script retired`.

- [ ] **Step 3: Replace `hooks/hooks.json`**

Write this exact file:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${PLUGIN_ROOT}/hooks/user-prompt-submit.js\"" }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Replace `hooks/user-prompt-submit.js`**

Write this exact file:

```js
#!/usr/bin/env node
import fs from 'node:fs';

const input = fs.readFileSync(0, 'utf8');
const text = input.toLowerCase();
const intents = [
  ['rename', /\b(rename|symbol rename|prepare rename)\b/],
  ['references', /\b(reference|references|call sites|usages)\b/],
  ['definition', /\b(definition|goto|declaration|declarations)\b/],
  ['diagnostics', /\b(diagnostic|diagnostics|typecheck)\b/],
  ['structural-search', /\b(api usage|structural|ast|ast-grep)\b/],
  ['rewrite', /\b(rewrite|replace pattern|structural replace|refactor)\b/]
];
const matched = intents.filter(([, re]) => re.test(text)).map(([name]) => name);
if (matched.length) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `code-intel: structural or semantic code work detected; prefer capability_route plus LSP/ast_grep MCP tools, and use rg/grep fallback with a reason. Matched intent: ${matched.join(', ')}.`
    }
  }));
}
```

- [ ] **Step 5: Delete retired lifecycle hook scripts**

Run:

```bash
rm hooks/pre-tool-use.js hooks/post-tool-use.js
```

Expected: both files are removed from `git status`.

- [ ] **Step 6: Replace `references/hook-contract.md`**

Write this exact file:

```md
# Hook Contract

Hooks are optional accelerators, not correctness dependencies.

- User-prompt hooks may inject one short routing hint for structural search, definitions, references, rename, diagnostics, and rewrite intent.
- Pre-tool and post-tool lifecycle nudges are intentionally not shipped because repeated `additionalContext` output can pollute the model context without guaranteeing tool execution.
- Hooks never run LSP, AST, text search, diagnostics, or audits by themselves.
- Hooks never block `rg`, `grep`, or normal file edits.
- Post-edit verification belongs to explicit MCP tools such as `post_edit_audit` and to skill workflows, not repeated lifecycle reminders.
- Hooks must behave safely when no routing profile exists.
```

- [ ] **Step 7: Run hook-focused validation**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const names=j.results.filter(r=>r.name.toLowerCase().includes("hook")); console.log(JSON.stringify(names, null, 2)); if(names.some(r=>!r.ok)) process.exit(1);})'
```

Expected: all hook-related checks have `"ok": true`.

- [ ] **Step 8: Commit Task 1**

```bash
git add hooks/hooks.json hooks/user-prompt-submit.js references/hook-contract.md scripts/validate-plugin.js
git add -u hooks/pre-tool-use.js hooks/post-tool-use.js
git commit -m "Reduce code-intel hook noise"
```

Expected: commit succeeds after the repo's local commit hooks accept the message.

---

### Task 2: Split MCP Server Boundaries Before Adding Tools

**Files:**
- Create: `mcp/code-intel-server/settings.js`
- Create: `mcp/code-intel-server/repo.js`
- Create: `mcp/code-intel-server/capabilities.js`
- Create: `mcp/code-intel-server/ast-grep.js`
- Create: `mcp/code-intel-server/lsp.js`
- Create: `mcp/code-intel-server/tools.js`
- Modify: `mcp/code-intel-server/core.js`
- Modify: `mcp/code-intel-server/index.js`
- Modify: `scripts/validate-plugin.js`

- [ ] **Step 1: Add failing architecture guard checks**

Add this validation block after the MCP tool-list check in `scripts/validate-plugin.js`:

```js
// MCP server architecture validation
const requiredServerModules = [
  'settings.js',
  'repo.js',
  'capabilities.js',
  'ast-grep.js',
  'lsp.js',
  'tools.js'
];
for (const moduleFile of requiredServerModules) {
  check(`server boundary module exists: ${moduleFile}`, exists(path.join('mcp/code-intel-server', moduleFile)), moduleFile);
}
const coreSource = fs.readFileSync(path.join(ROOT, 'mcp/code-intel-server/core.js'), 'utf8');
const coreLineCount = coreSource.split(/\r?\n/).length;
check('core.js stays facade-sized', coreLineCount <= 260, `${coreLineCount} lines`);
const forbiddenCorePatterns = [
  [/function\s+postEditAudit\b/, 'post-edit audit use case belongs in audit.js'],
  [/function\s+gitChangedFiles\b/, 'git changed-file driver belongs in repo.js'],
  [/spawnSync\(['"]git['"]/, 'git subprocess calls belong in repo.js'],
  [/textDocument\/diagnostic[\s\S]+astGrepScan/, 'audit orchestration belongs in audit.js'],
  [/function\s+normalizeAstGrepJson\b/, 'ast-grep normalization belongs in ast-grep.js'],
  [/function\s+lspFrame\b/, 'LSP protocol framing belongs in lsp.js']
];
for (const [pattern, reason] of forbiddenCorePatterns) {
  check(`core.js boundary: ${reason}`, !pattern.test(coreSource), reason);
}
```

- [ ] **Step 2: Run RED validation for the architecture guard**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const rows=j.results.filter(r=>r.name.includes("server boundary") || r.name.includes("core.js boundary") || r.name==="core.js stays facade-sized"); console.log(JSON.stringify(rows, null, 2)); if(rows.every(r=>r.ok)) process.exit(1);})'
```

Expected: FAIL because the focused modules do not exist yet and `core.js` still owns multiple responsibilities.

- [ ] **Step 3: Extract settings and repo boundaries**

Move these symbols from `mcp/code-intel-server/core.js` to `mcp/code-intel-server/settings.js` and export the functions used by other modules:

```text
readJson
typeOf
typeMatches
resolveHomeDir
defaultUserSettingsPath
expandHome
isPlainObject
deepMerge
readJsonIfExists
settingsSourceError
readSettingsOverrideIfExists
normalizeSettingsPaths
validateAgainstSchema
validateSettings
loadSettings
splitCommandLine
firstToken
```

Keep `PLUGIN_VERSION`, `ROOT`, `DEFAULT_SETTINGS_PATH`, and `SETTINGS_SCHEMA_PATH` in `settings.js` with the same values. Export `PLUGIN_VERSION` and `ROOT` because downstream modules need the repo root for defaults and validation.

Move these symbols to `mcp/code-intel-server/repo.js`:

```text
walkFiles
realpathIfExists
insideDir
resolveRepoRelativeFile
```

Export `resolveRepoRelativePaths(repoRoot, files)` from `repo.js`:

```js
export function resolveRepoRelativePaths(repoRoot, files = []) {
  const paths = [];
  for (const file of files) {
    const resolved = resolveRepoRelativeFile(repoRoot, file);
    if (!resolved.ok) return { ok: false, paths: [], reason: resolved.reason };
    paths.push(path.relative(resolved.repoRoot, resolved.filePath));
  }
  return { ok: true, paths, reason: null };
}
```

- [ ] **Step 4: Extract capability, AST, and LSP boundaries**

Move these symbols to `mcp/code-intel-server/capabilities.js` and import settings/repo helpers from the new modules:

```text
detectExecutable
resolveExtraDir
executableCandidates
executableOnPath
detectExecutableFromSettings
envWithExtraPathDirs
commandAvailable
languageForFile
languageConfigForFile
languageConfigForLanguage
languageInventory
discoverCapabilities
resolveCapabilityRoute
runtimeFallbackUsed
findLspCommand
```

Move these symbols to `mcp/code-intel-server/ast-grep.js`:

```text
astUnavailable
normalizeAstGrepJson
astGrepSearch
astGrepReplacePreview
```

Move these symbols to `mcp/code-intel-server/lsp.js`:

```text
lspUnavailable
lspFrame
parseLspFrames
readLspMessagesFromBuffer
waitForLspMessage
lspParams
runLspRequestAsync
runLspRequest
lspTool
runLspWorkerCli
```

Import `findLspCommand`, `runtimeFallbackUsed`, and language helpers from `capabilities.js` into `lsp.js`. Keep LSP worker CLI behavior in `lsp.js` so `core.js` does not own protocol details. When moving `runLspRequest()` and `runLspWorkerCli()`, make the worker subprocess invoke `fileURLToPath(import.meta.url)` from `lsp.js`, not `core.js`.

- [ ] **Step 5: Extract MCP tool dispatch**

Create `mcp/code-intel-server/tools.js` with `TOOL_NAMES`, `commonProps`, `tools`, and `callTool()`. Import `discoverCapabilities` and `resolveCapabilityRoute` from `capabilities.js`, `astGrepSearch` and `astGrepReplacePreview` from `ast-grep.js`, and `lspTool` from `lsp.js`.

Change `mcp/code-intel-server/index.js` to import `callTool` and `tools` from `./tools.js` instead of `./core.js`.

- [ ] **Step 6: Replace `core.js` with a compatibility facade**

Replace `mcp/code-intel-server/core.js` with re-exports only:

```js
export * from './settings.js';
export * from './repo.js';
export * from './capabilities.js';
export * from './ast-grep.js';
export * from './lsp.js';
export * from './tools.js';
```

- [ ] **Step 7: Run architecture validation**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const rows=j.results.filter(r=>r.name.includes("server boundary") || r.name.includes("core.js boundary") || r.name==="core.js stays facade-sized" || r.name==="tool list includes expected tools"); console.log(JSON.stringify(rows, null, 2)); if(rows.some(r=>!r.ok)) process.exit(1);})'
```

Expected: architecture checks and existing MCP tool list pass.

- [ ] **Step 8: Commit Task 2**

```bash
git add mcp/code-intel-server scripts/validate-plugin.js
git commit -m "Split code-intel server boundaries"
```

Expected: commit succeeds.

---

### Task 3: Expose Explicit Capability Routing As An MCP Tool

**Files:**
- Modify: `mcp/code-intel-server/tools.js`
- Modify: `mcp/code-intel-server/capabilities.js`
- Modify: `scripts/validate-plugin.js:10`
- Modify: `scripts/validate-plugin.js:311-315`

- [ ] **Step 1: Write failing MCP route tests**

Update `EXPECTED_TOOLS` in `scripts/validate-plugin.js:10`:

```js
const EXPECTED_TOOLS = ['capability_discover','capability_route','ast_grep_search','ast_grep_replace_preview','lsp_diagnostics','lsp_symbols','lsp_goto_definition','lsp_find_references','lsp_prepare_rename','lsp_rename_preview'];
```

After the existing `capability_discover works` check near line `315`, add:

```js
const routeSemantic = callTool('capability_route', { repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'), file: 'src/math.ts', intent: 'semantic' });
check(
  'capability_route exposes semantic route decision',
  ['try-lsp', 'try-ast-grep', 'fallback'].includes(routeSemantic.status) &&
    routeSemantic.language === 'typescript' &&
    Array.isArray(routeSemantic.route) &&
    routeSemantic.route.length > 0,
  JSON.stringify(routeSemantic)
);
const routeAudit = callTool('capability_route', { repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'), file: 'src/math.ts', intent: 'audit' });
check(
  'capability_route exposes audit route decision',
  ['try-lsp', 'try-ast-grep', 'fallback'].includes(routeAudit.status) &&
    routeAudit.intent === 'audit' &&
    Array.isArray(routeAudit.route),
  JSON.stringify(routeAudit)
);
```

- [ ] **Step 2: Run RED validation for missing tool**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify(j.results.filter(r=>!r.ok).map(r=>r.name), null, 2)); if(j.status==="passed") process.exit(1);})'
```

Expected: FAIL with `tool list includes expected tools` and `capability_route exposes semantic route decision`.

- [ ] **Step 3: Add `capability_route` to `TOOL_NAMES`**

Change `TOOL_NAMES` in `mcp/code-intel-server/tools.js` to:

```js
const TOOL_NAMES = [
  'capability_discover',
  'capability_route',
  'ast_grep_search',
  'ast_grep_replace_preview',
  'lsp_diagnostics',
  'lsp_symbols',
  'lsp_goto_definition',
  'lsp_find_references',
  'lsp_prepare_rename',
  'lsp_rename_preview'
];
```

- [ ] **Step 4: Extend `resolveCapabilityRoute()`**

Replace `resolveCapabilityRoute()` in `mcp/code-intel-server/capabilities.js` with:

```js
export function resolveCapabilityRoute(args = {}) {
  const repoRoot = args.repoRoot || process.cwd();
  const discovery = discoverCapabilities(repoRoot);
  const settings = loadSettings(repoRoot);
  const intent = args.intent || 'structural';
  const language = args.language || (args.file ? languageConfigForFile(path.resolve(repoRoot, args.file), settings).language : null);
  const info = language ? discovery.languages[language] : null;
  const base = { intent, language, repoRoot: path.resolve(repoRoot) };
  if (!info) {
    return { ...base, status: 'fallback', route: ['rg', 'grep'], fallbackReason: 'unsupported language or missing language hint' };
  }
  if (intent === 'semantic' || intent === 'diagnostics' || intent === 'rename' || intent === 'audit') {
    if (info.lsp === 'commandDetected') {
      return { ...base, status: 'try-lsp', route: ['lsp', 'ast-grep', 'rg', 'grep'], capabilityState: info.lspState, fallbackReason: 'LSP command detected; method readiness must be verified by the LSP tool response' };
    }
    if (info.astGrep === 'available') return { ...base, status: 'try-ast-grep', route: ['ast-grep', 'rg', 'grep'], fallbackReason: 'LSP command missing' };
    return { ...base, status: 'fallback', route: ['rg', 'grep'], fallbackReason: 'LSP and ast-grep unavailable' };
  }
  if (info.astGrep === 'available') return { ...base, status: 'try-ast-grep', route: ['ast-grep', 'rg', 'grep'], fallbackReason: null };
  return { ...base, status: 'fallback', route: ['rg', 'grep'], fallbackReason: 'ast-grep unavailable or unsupported' };
}
```

- [ ] **Step 5: Wire `capability_route` through `callTool()`**

Add this case after `capability_discover` in `mcp/code-intel-server/tools.js`:

```js
case 'capability_route': return resolveCapabilityRoute(args);
```

- [ ] **Step 6: Add `capability_route` tool schema**

In the `tools` mapper in `mcp/code-intel-server/tools.js`, add this branch after the `capability_discover` branch:

```js
  } else if (name === 'capability_route') {
    base.description = 'Return the recommended code-intel route for semantic, structural, rename, diagnostics, or audit intent without mutating files.';
    base.inputSchema.properties = {
      repoRoot: commonProps.repoRoot,
      language: commonProps.language,
      file: commonProps.file,
      intent: { type: 'string', enum: ['semantic', 'structural', 'diagnostics', 'rename', 'audit'] }
    };
```

- [ ] **Step 7: Run route validation**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const names=j.results.filter(r=>r.name.includes("capability_route") || r.name==="tool list includes expected tools"); console.log(JSON.stringify(names, null, 2)); if(names.some(r=>!r.ok)) process.exit(1);})'
```

Expected: the tool list and both `capability_route` checks pass.

- [ ] **Step 8: Commit Task 3**

```bash
git add mcp/code-intel-server/tools.js mcp/code-intel-server/capabilities.js scripts/validate-plugin.js
git commit -m "Expose explicit code-intel route decisions"
```

Expected: commit succeeds.

---

### Task 4: Add Rule-Based `ast_grep_scan`

**Files:**
- Modify: `mcp/code-intel-server/tools.js`
- Modify: `mcp/code-intel-server/ast-grep.js`
- Modify: `mcp/code-intel-server/repo.js`
- Modify: `scripts/validate-plugin.js:10`
- Modify: `scripts/validate-plugin.js:328-357`
- Modify: `references/mcp-tool-contract.md:8-15`

- [ ] **Step 1: Write failing tool and fallback tests**

Update `EXPECTED_TOOLS` in `scripts/validate-plugin.js:10`:

```js
const EXPECTED_TOOLS = ['capability_discover','capability_route','ast_grep_search','ast_grep_scan','ast_grep_replace_preview','lsp_diagnostics','lsp_symbols','lsp_goto_definition','lsp_find_references','lsp_prepare_rename','lsp_rename_preview'];
```

After the `missing ast-grep PATH simulation reports explicit fallback` block near line `357`, add:

```js
const missingScanConfig = callTool('ast_grep_scan', { repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic') });
check(
  'ast_grep_scan reports missing configPath cleanly',
  missingScanConfig.status === 'unavailable' &&
    /configPath/.test(missingScanConfig.fallbackReason || '') &&
    Array.isArray(missingScanConfig.fallback),
  JSON.stringify(missingScanConfig)
);
const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-scan-'));
try {
  fs.mkdirSync(path.join(scanRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(scanRoot, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(scanRoot, 'src', 'main.ts'), 'console.log("scan-me");\n');
  fs.writeFileSync(path.join(scanRoot, 'rules', 'no-console.yml'), [
    'id: local.no-console',
    'message: console.log found',
    'severity: warning',
    'language: TypeScript',
    'rule:',
    '  pattern: console.log($$$ARGS)',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(scanRoot, 'sgconfig.yml'), [
    'ruleDirs:',
    '  - rules',
    ''
  ].join('\n'));
  fs.mkdirSync(path.join(scanRoot, '.code-intel'), { recursive: true });
  writeJson(path.join(scanRoot, '.code-intel', 'settings.json'), {
    version: 1,
    astGrep: { configPath: './sgconfig.yml' }
  });
  const scanResult = callTool('ast_grep_scan', { repoRoot: scanRoot, paths: ['src/main.ts'], maxResults: 5 });
  const scanUnavailable = scanResult.status === 'unavailable' && /ast-grep executable was not found/.test(scanResult.fallbackReason || '');
  const scanOk = scanResult.status === 'ok' &&
    scanResult.configPath === path.join(scanRoot, 'sgconfig.yml') &&
    scanResult.results.some((row) => row.ruleId === 'local.no-console' && row.file && row.file.endsWith('src/main.ts'));
  check('ast_grep_scan executes configured rule scan when available', scanUnavailable || scanOk, JSON.stringify(scanResult).slice(0, 1000));
} finally {
  fs.rmSync(scanRoot, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run RED validation for missing scan tool**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify(j.results.filter(r=>!r.ok).map(r=>r.name), null, 2)); if(j.status==="passed") process.exit(1);})'
```

Expected: FAIL with `tool list includes expected tools` and `ast_grep_scan reports missing configPath cleanly`.

- [ ] **Step 3: Add `ast_grep_scan` to `TOOL_NAMES`**

Change `TOOL_NAMES` to include `ast_grep_scan` after `ast_grep_search`:

```js
const TOOL_NAMES = [
  'capability_discover',
  'capability_route',
  'ast_grep_search',
  'ast_grep_scan',
  'ast_grep_replace_preview',
  'lsp_diagnostics',
  'lsp_symbols',
  'lsp_goto_definition',
  'lsp_find_references',
  'lsp_prepare_rename',
  'lsp_rename_preview'
];
```

- [ ] **Step 4: Add scan config helper and JSON normalization**

In `mcp/code-intel-server/ast-grep.js`, import `expandHome` from `settings.js` if needed, then add this code after `normalizeAstGrepJson()`:

```js
function normalizeAstGrepScanJson(stdout) {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((item) => ({
    file: item.file || item.path || item.filePath || null,
    range: item.range || item.labels?.[0]?.range || null,
    message: item.message || item.note || item.text || null,
    ruleId: item.ruleId || item.id || item.rule || null,
    severity: item.severity || null,
    confidence: 'ast-grep-scan'
  }));
}

function resolveAstGrepConfigPath(settings, repoRoot) {
  if (!settings.astGrep.configPath) return null;
  const expanded = expandHome(settings.astGrep.configPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
}
```

- [ ] **Step 5: Add `astGrepScan()`**

In `mcp/code-intel-server/ast-grep.js`, import `resolveRepoRelativePaths` from `repo.js`, then add this function after `astGrepSearch()`:

```js
export function astGrepScan(args = {}) {
  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const settings = loadSettings(repoRoot);
  const configPath = resolveAstGrepConfigPath(settings, repoRoot);
  if (!configPath) return astUnavailable('scan', 'ast-grep configPath is required for ast_grep_scan', settings);
  const ast = detectExecutableFromSettings(settings.astGrep.command, ['--version'], repoRoot, settings);
  if (!ast.available) return astUnavailable('scan', `${settings.astGrep.command} executable was not found on PATH`, settings);
  const requestedPaths = Array.isArray(args.paths) && args.paths.length ? args.paths : [];
  const safePaths = resolveRepoRelativePaths(repoRoot, requestedPaths);
  if (!safePaths.ok) return astUnavailable('scan', safePaths.reason, settings);
  const scanTargets = safePaths.paths.length ? safePaths.paths : ['.'];
  const cmdArgs = ['scan', '--config', configPath, '--json', ...scanTargets];
  const result = spawnSync(ast.resolvedCommand || settings.astGrep.command, cmdArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: args.timeoutMs || 10000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0 && !result.stdout) {
    return {
      status: 'error',
      executable: settings.astGrep.command,
      configPath,
      resolvedCommand: ast.resolvedCommand,
      stderrSummary: (result.stderr || result.error?.message || '').trim().slice(0, 1000),
      results: [],
      fallback: settings.fallback,
      fallbackReason: 'ast-grep scan failed; inspect sgconfig rules or use text fallback',
      commandPolicy: 'this plugin does not call sg'
    };
  }
  let results = [];
  try { results = normalizeAstGrepScanJson(result.stdout).slice(0, args.maxResults || 100); }
  catch (error) { return { status: 'error', error: `failed to parse ast-grep scan JSON: ${error.message}`, raw: result.stdout.slice(0, 1000), results: [], fallback: settings.fallback, configPath }; }
  return {
    status: 'ok',
    executable: settings.astGrep.command,
    configPath,
    resolvedCommand: ast.resolvedCommand,
    scanned: scanTargets,
    results,
    fallback: results.length ? [] : settings.fallback,
    fallbackReason: results.length ? null : 'ast-grep scan returned no findings'
  };
}
```

- [ ] **Step 6: Wire `ast_grep_scan` through MCP**

Add this case in `mcp/code-intel-server/tools.js`:

```js
case 'ast_grep_scan': return astGrepScan(args);
```

Add this tool schema branch after `ast_grep_search` in `mcp/code-intel-server/tools.js`:

```js
  } else if (name === 'ast_grep_scan') {
    base.description = 'Run read-only ast-grep rule scan using the effective astGrep.configPath.';
    base.inputSchema.properties = {
      repoRoot: commonProps.repoRoot,
      paths: { type: 'array', items: { type: 'string' } },
      maxResults: { type: 'number' }
    };
```

- [ ] **Step 7: Update MCP contract reference**

In `references/mcp-tool-contract.md`, replace the initial tool list with:

```md
Initial tools:

- `capability_discover`
- `capability_route`
- `ast_grep_search`
- `ast_grep_scan`
- `ast_grep_replace_preview`
- `lsp_diagnostics`
- `lsp_symbols`
- `lsp_goto_definition`
- `lsp_find_references`
- `lsp_prepare_rename`
- `lsp_rename_preview`
```

- [ ] **Step 8: Run scan validation**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const rows=j.results.filter(r=>r.name.includes("ast_grep_scan") || r.name==="tool list includes expected tools"); console.log(JSON.stringify(rows, null, 2)); if(rows.some(r=>!r.ok)) process.exit(1);})'
```

Expected: `ast_grep_scan` checks pass. If `ast-grep` is absent, the scan execution check passes through the explicit unavailable response branch.

- [ ] **Step 9: Commit Task 4**

```bash
git add mcp/code-intel-server/tools.js mcp/code-intel-server/ast-grep.js mcp/code-intel-server/repo.js scripts/validate-plugin.js references/mcp-tool-contract.md
git commit -m "Add ast-grep rule scan tool"
```

Expected: commit succeeds.

---

### Task 5: Add Explicit `post_edit_audit` Without Crossing Boundaries

**Files:**
- Modify: `mcp/code-intel-server/tools.js`
- Modify: `mcp/code-intel-server/repo.js`
- Modify: `mcp/code-intel-server/lsp.js`
- Create: `mcp/code-intel-server/audit.js`
- Create: `mcp/code-intel-server/audit-result.js`
- Modify: `scripts/validate-plugin.js:10`
- Modify: `scripts/validate-plugin.js:771-805`
- Modify: `skills/code-intel-refactor/SKILL.md:8-17`

- [ ] **Step 1: Write failing post-edit audit tests**

Update `EXPECTED_TOOLS` in `scripts/validate-plugin.js:10`:

```js
const EXPECTED_TOOLS = ['capability_discover','capability_route','ast_grep_search','ast_grep_scan','ast_grep_replace_preview','post_edit_audit','lsp_diagnostics','lsp_symbols','lsp_goto_definition','lsp_find_references','lsp_prepare_rename','lsp_rename_preview'];
```

Extend the `requiredServerModules` architecture guard from Task 2 with `audit.js` and `audit-result.js`.

After the preview checks near line `805`, add:

```js
const auditResult = callTool('post_edit_audit', {
  repoRoot: path.join(ROOT, 'fixtures/repos/typescript-basic'),
  files: ['src/math.ts'],
  timeoutMs: 5000
});
check(
  'post_edit_audit returns per-file diagnostic evidence or fallback',
  auditResult.status === 'ok' &&
    auditResult.files.includes('src/math.ts') &&
    Array.isArray(auditResult.diagnostics) &&
    auditResult.diagnostics.some((row) => row.file === 'src/math.ts' && ['ok', 'unavailable', 'error'].includes(row.status)),
  JSON.stringify(auditResult).slice(0, 1000)
);
check(
  'post_edit_audit reports AST scan availability separately',
  auditResult.status === 'ok' &&
    auditResult.astGrepScan &&
    ['ok', 'unavailable', 'error'].includes(auditResult.astGrepScan.status),
  JSON.stringify(auditResult.astGrepScan).slice(0, 1000)
);
```

- [ ] **Step 2: Run RED validation for missing audit tool**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify(j.results.filter(r=>!r.ok).map(r=>r.name), null, 2)); if(j.status==="passed") process.exit(1);})'
```

Expected: FAIL with `post_edit_audit returns per-file diagnostic evidence or fallback`.

- [ ] **Step 3: Add changed-file discovery to `repo.js`**

In `mcp/code-intel-server/repo.js`, ensure `spawnSync` is imported from `node:child_process`, then add this repository gateway:

```js
export function gitChangedFiles(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD', '--'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) return { files: [], reason: 'git diff failed; pass files explicitly for post_edit_audit' };
  const files = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { files, reason: files.length ? null : 'no changed files detected by git diff' };
}
```

- [ ] **Step 4: Add diagnostic gateway to `lsp.js`**

In `mcp/code-intel-server/lsp.js`, import `path` and `languageConfigForFile` if the extraction did not already do so, then add this helper next to `lspTool()`:

```js
export function lspDiagnosticsForFile(repoRoot, file, settings, timeoutMs) {
  const resolved = languageConfigForFile(path.resolve(repoRoot, file), settings);
  if (!resolved.config) {
    return { file, status: 'unavailable', language: null, fallbackReason: 'unsupported language or file extension' };
  }
  const result = lspTool('textDocument/diagnostic', { repoRoot, file, language: resolved.language, timeoutMs });
  return {
    file,
    language: resolved.language,
    status: result.status,
    method: result.method || 'textDocument/diagnostic',
    result: result.result || null,
    fallbackUsed: result.fallbackUsed || null,
    fallbackReason: result.fallbackReason || null,
    stderrSummary: result.stderrSummary || ''
  };
}
```

- [ ] **Step 5: Add audit result formatter**

Create `mcp/code-intel-server/audit-result.js`:

```js
export function formatPostEditAuditResult({
  status = 'ok',
  repoRoot,
  files = [],
  fileSource = null,
  fileSourceFallbackReason = null,
  diagnostics = [],
  astGrepScan = null,
  fallbackReason = null
}) {
  const scan = astGrepScan || { status: 'unavailable', results: [], fallbackReason: 'audit did not request ast-grep scan' };
  const degraded = diagnostics.some((row) => row.status !== 'ok') || scan.status !== 'ok';
  return {
    status,
    repoRoot,
    files,
    fileSource,
    fileSourceFallbackReason,
    diagnostics,
    astGrepScan: scan,
    fallbackReason: fallbackReason || (degraded ? 'one or more audit checks were unavailable, degraded, or reported findings' : null)
  };
}
```

- [ ] **Step 6: Add `postEditAudit()` as orchestration only**

Create `mcp/code-intel-server/audit.js`:

```js
import path from 'node:path';

import { astGrepScan } from './ast-grep.js';
import { lspDiagnosticsForFile } from './lsp.js';
import { gitChangedFiles, resolveRepoRelativePaths } from './repo.js';
import { formatPostEditAuditResult } from './audit-result.js';
import { loadSettings } from './settings.js';

export function postEditAudit(args = {}, deps = {}) {
  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const settings = (deps.loadSettings || loadSettings)(repoRoot);
  const explicitFiles = Array.isArray(args.files) && args.files.length ? args.files : null;
  const source = explicitFiles
    ? { files: explicitFiles, reason: null }
    : (deps.gitChangedFiles || gitChangedFiles)(repoRoot);
  const safeFiles = (deps.resolveRepoRelativePaths || resolveRepoRelativePaths)(repoRoot, source.files);
  if (!safeFiles.ok) {
    return formatPostEditAuditResult({
      status: 'error',
      repoRoot,
      files: [],
      diagnostics: [],
      astGrepScan: { status: 'unavailable', fallbackReason: safeFiles.reason },
      fallbackReason: safeFiles.reason
    });
  }
  const runDiagnostics = deps.lspDiagnosticsForFile || lspDiagnosticsForFile;
  const diagnostics = safeFiles.paths.map((file) => runDiagnostics(repoRoot, file, settings, args.timeoutMs || 10000));
  const runScan = deps.astGrepScan || astGrepScan;
  const astGrepScanResult = settings.astGrep.configPath
    ? runScan({ repoRoot, paths: safeFiles.paths, timeoutMs: args.timeoutMs || 10000, maxResults: args.maxResults || 100 })
    : { status: 'unavailable', results: [], fallback: settings.fallback, fallbackReason: 'ast-grep configPath is not configured for post_edit_audit' };
  return formatPostEditAuditResult({
    repoRoot,
    files: safeFiles.paths,
    fileSource: explicitFiles ? 'args.files' : 'git diff',
    fileSourceFallbackReason: source.reason,
    diagnostics,
    astGrepScan: astGrepScanResult
  });
}
```

- [ ] **Step 7: Add `post_edit_audit` to `TOOL_NAMES`, `callTool()`, and schemas**

In `mcp/code-intel-server/tools.js`, import `postEditAudit` from `./audit.js`, then add `post_edit_audit` after `ast_grep_replace_preview` in `TOOL_NAMES`.

Add this case in `callTool()`:

```js
case 'post_edit_audit': return postEditAudit(args);
```

Add this schema branch before the LSP `else` branch:

```js
  } else if (name === 'post_edit_audit') {
    base.description = 'Run explicit post-edit audit: LSP diagnostics per file when available and ast-grep rule scan when configured.';
    base.inputSchema.properties = {
      repoRoot: commonProps.repoRoot,
      files: { type: 'array', items: { type: 'string' } },
      timeoutMs: { type: 'number' },
      maxResults: { type: 'number' }
    };
```

- [ ] **Step 8: Update refactor skill**

Replace `skills/code-intel-refactor/SKILL.md` with:

```md
---
name: code-intel-refactor
description: "Run refactoring with code-intel gates: discover capability, preview changes, apply normal edits, then run explicit post-edit audit."
---

# Code Intel Refactor

Use for rename or structural rewrite tasks.

1. Run `capability_route` with `intent: "rename"` or `intent: "structural"` for the target file/language.
2. Prefer `lsp_prepare_rename` and `lsp_rename_preview` for rename.
3. Use `ast_grep_replace_preview` only for previewable structural rewrites.
4. Apply approved edits through normal Codex file editing, not through MCP mutation.
5. Run `post_edit_audit` with the edited repo-relative files before final response.
6. Report degraded capability and fallback route.

Read `references/routing-policy.md` for route order and `references/mcp-tool-contract.md` for preview-only tool contracts.
```

- [ ] **Step 9: Run audit validation**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const rows=j.results.filter(r=>r.name.includes("post_edit_audit") || r.name.includes("core.js boundary") || r.name==="tool list includes expected tools"); console.log(JSON.stringify(rows, null, 2)); if(rows.some(r=>!r.ok)) process.exit(1);})'
```

Expected: `post_edit_audit` checks pass with either LSP diagnostic evidence or explicit LSP fallback, and the `core.js` boundary checks still pass.

- [ ] **Step 10: Commit Task 5**

```bash
git add mcp/code-intel-server/tools.js mcp/code-intel-server/repo.js mcp/code-intel-server/lsp.js mcp/code-intel-server/audit.js mcp/code-intel-server/audit-result.js scripts/validate-plugin.js skills/code-intel-refactor/SKILL.md
git commit -m "Add explicit post-edit audit tool"
```

Expected: commit succeeds.

---

### Task 6: Align Routing Docs, Skills, And Project Direction

**Files:**
- Modify: `docs/project-direction.md:35-67`
- Modify: `docs/project-direction.md:74-89`
- Modify: `docs/project-direction.md:120-146`
- Modify: `docs/project-direction.md:148-195`
- Modify: `references/routing-policy.md:1-18`
- Modify: `references/mcp-tool-contract.md:1-15`
- Modify: `skills/code-intel/SKILL.md:8-27`
- Modify: `scripts/validate-plugin.js:1012-1024`

- [ ] **Step 1: Write failing documentation scenario checks**

Replace the `behavior` array at `scripts/validate-plugin.js:1013-1021` with:

```js
const behavior = [
  ['route decision', 'capability_route'],
  ['find class or function definition', 'lsp when available, else ast-grep, else rg'],
  ['find references', 'lsp_find_references, then ast_grep_search, then rg'],
  ['rename symbol', 'lsp_prepare_rename and lsp_rename_preview, else preview fallback'],
  ['rewrite structural pattern', 'ast_grep_replace_preview only, then normal edits'],
  ['rule-based AST audit', 'ast_grep_scan'],
  ['edit file then audit', 'post_edit_audit'],
  ['unsupported language fallback', 'rg/grep with reason'],
  ['missing ast-grep fallback', 'rg/grep with reason'],
  ['missing LSP fallback', 'ast-grep or rg/grep with reason']
];
```

Replace `routingPolicy` at line `1023` with:

```js
const routingPolicy = [
  fs.readFileSync(path.join(ROOT, 'references/routing-policy.md'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'references/fallback-policy.md'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'references/mcp-tool-contract.md'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'docs/project-direction.md'), 'utf8')
].join('\n');
```

- [ ] **Step 2: Run RED docs validation**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const rows=j.results.filter(r=>r.name.startsWith("behavior documented")); console.log(JSON.stringify(rows, null, 2)); if(rows.some(r=>!r.ok)) process.exit(1);})'
```

Expected: at least the `rule-based AST audit` or `edit file then audit` documentation check fails before docs are updated.

- [ ] **Step 3: Replace `references/routing-policy.md`**

Write this exact file:

```md
# Code Intel Routing Policy

Use `code-intel` when the user asks for code structure, symbols, definitions, references, rename, rewrite, diagnostics, or post-edit audits.

## Route order

1. Use `capability_route` when a task needs an explicit route decision before selecting a specialized tool.
2. Use LSP when the task needs semantic answers and an initialized server verifies the requested method.
3. Use `ast-grep` when the task is structurally expressible and the effective settings define an ast-grep language id for that language.
4. Use `ast_grep_scan` when the effective settings define `astGrep.configPath` and the task needs configured rule-based AST audit.
5. Supplement with `rg` or `grep` for strings, logs, filenames, generated files, unsupported languages, incomplete AST output, or confirmation.
6. Report the route used and any fallback reason.

Fallback is not failure. It lowers confidence and should be visible in the final response.

## Behavior scenario routes

- Route decision: use `capability_route` with intent `semantic`, `structural`, `diagnostics`, `rename`, or `audit`.
- Rename symbol: use `lsp_prepare_rename`, then `lsp_rename_preview`; if unavailable, use a preview fallback such as `ast_grep_replace_preview` when structurally expressible.
- Rewrite structural pattern: use `ast_grep_replace_preview` only; apply approved changes through normal edits.
- Rule-based AST audit: use `ast_grep_scan` when `astGrep.configPath` is configured.
- Edit file then audit: use `post_edit_audit` with edited repo-relative files; it runs LSP diagnostics when available and ast-grep scan when configured.
```

- [ ] **Step 4: Replace `skills/code-intel/SKILL.md`**

Write this exact file:

```md
---
name: code-intel
description: Prefer language-aware code intelligence for search, navigation, references, rename, rewrite previews, diagnostics, and audits before text fallback.
---

# Code Intel

Use this skill for codebase questions involving declarations, patterns, API usage, symbols, definitions, references, rename, structural rewrites, diagnostics, or post-edit audits.

## Routing

1. Check `docs/code-intel/routing-profile.json` when present.
2. Treat the profile as a cache, not authority. If it is missing, stale, or contradicted by live tool failures, use live discovery and suggest `init-code-intel`.
3. Use `capability_route` for explicit route decisions when the route is not obvious.
4. Prefer LSP tools for semantic navigation and diagnostics only when the tool response verifies the method; a detected command alone is degraded evidence.
5. Prefer `ast_grep_search` for structural patterns when the effective code-intel settings define an ast-grep language id.
6. Prefer `ast_grep_scan` for configured rule-based AST audits when `astGrep.configPath` is set.
7. Use `post_edit_audit` after code edits when diagnostics or audit evidence is needed before final response.
8. Use `rg`/`grep` fallback for strings, filenames, logs, generated files, unsupported languages, missing tools, or inconclusive code-intel output.
9. Report the route and fallback reason.

## Command Policy

Use `ast-grep` for AST search. Do not use the Linux-conflicting shorthand command.

## References

- Read `references/routing-policy.md` when route order or stale-profile behavior matters.
- Read `references/fallback-policy.md` when reporting degraded capability.
- Read `references/mcp-tool-contract.md` before relying on preview, audit, or LSP tool output shapes.
```

- [ ] **Step 5: Update `docs/project-direction.md` operating model**

Replace `docs/project-direction.md:37-51` with:

```md
`code-intel` has four cooperating layers:

1. **MCP capability layer** — exposes actual code-intelligence tools that can be
   attached independently of any orchestration runtime. Its public surface is
   composed from focused modules: settings, repo path safety, capability
   routing, ast-grep, LSP, audit orchestration, audit result formatting, and MCP
   tool dispatch. `core.js` stays a compatibility facade rather than a place for
   new workflows.
2. **Skill behavior layer** — teaches agents when to prefer code-intel for
   search, navigation, references, rename, rewrite, diagnostics, and audits.
3. **Optional hook layer** — provides at most a short prompt-time routing hint
   for structural or semantic code intent. It must not inject repeated pre-tool
   or post-tool reminders.
4. **Settings and reporting layer** — keeps language coverage declarative in
   settings defaults/schema and writes durable capability evidence for future
   turns.

Hooks may improve discovery, but the MCP server and skills must remain useful
when hooks are absent. Generated routing profiles are hints, not authority; live
tool failures and method-specific responses override stale cached data.

The MCP layer should preserve Clean Architecture boundaries: drivers such as
git, ast-grep, and LSP subprocesses remain behind module gateways; use cases
coordinate those gateways; tool schemas and result formatting stay separate from
subprocess implementation details.
```

- [ ] **Step 6: Update `docs/project-direction.md` capabilities and routes**

Replace `docs/project-direction.md:55-67` with:

```md
The project should keep the following capabilities first-class:

1. **Capability discovery and routing** — identify repository languages,
   available `ast-grep`, LSP command candidates, method-readiness evidence,
   fallback status, and the recommended route for a requested intent.
2. **Structural search** — use `ast_grep_search` for parseable AST patterns when
   effective settings define an ast-grep language id for the language.
3. **Rule-based AST audit** — use `ast_grep_scan` when effective settings define
   `astGrep.configPath`.
4. **Semantic navigation** — use LSP for definitions, references, symbols, and
   diagnostics only when the server interaction proves method readiness.
5. **Safe refactor previews** — expose rename and rewrite intent as preview
   flows before normal edits are applied.
6. **Post-change verification** — expose `post_edit_audit` so diagnostics and
   AST scan evidence are run explicitly instead of requested through repeated
   hook reminders.
```

Replace `docs/project-direction.md:74-89` with:

```md
- **Route decision:** use `capability_route` to make the first route explicit
  when semantic, structural, diagnostics, rename, or audit intent is unclear.
- **Structural search:** try AST search when effective settings define an
  ast-grep language id; supplement with `rg`/`grep` for strings, filenames,
  logs, generated files, unsupported languages, incomplete AST output, or
  confirmation.
- **Semantic navigation:** try LSP definitions, references, symbols, and
  diagnostics when a server interaction verifies the requested method; otherwise
  degrade to AST search when structurally expressible, then text fallback.
- **Rename and rewrite:** try `lsp_prepare_rename` and `lsp_rename_preview` for
  rename; use `ast_grep_replace_preview` only for previewable structural
  rewrites; otherwise use normal manual edits plus text/structural audits.
- **Rule-based audit:** use `ast_grep_scan` when `astGrep.configPath` is
  configured; report missing config as a degraded audit surface.
- **Post-edit validation:** after normal edits, run `post_edit_audit` with the
  edited repo-relative files; report which LSP diagnostics and AST scan checks
  ran, degraded, or were unavailable.
- **Stale profiles:** treat repo-root mismatch, plugin version drift, settings
  source/version drift, missing timestamps, and major language-inventory
  mismatches as stale-profile signals; use live evidence and suggest refreshing
  with `init-code-intel`.
```

- [ ] **Step 7: Update `docs/project-direction.md` validation and roadmap**

Replace `docs/project-direction.md:128-142` with:

```md
- **MCP contract:** server startup, framed initialize, tool listing, stable tool
  schemas, clean unavailable responses, explicit route decisions, audit tools,
  and non-mutating preview tools.
- **AST behavior:** `ast-grep` detection, built-in-language smoke search,
  configured rule scan, structured result rows, unsupported-language fallback,
  invalid-pattern fallback, missing-config fallback, and no executable/config
  path calling `sg`.
- **LSP behavior:** command detection without requiring `--version`, initialize
  ordering, repo-relative command resolution, method request/response smoke,
  path-safety checks, clean shutdown, and explicit failure reasons.
- **Init and doctor:** report generation, semantic idempotency, stale-profile
  detection, malformed-profile survival, and visible fallback recommendations.
- **Hooks:** one short prompt-time input/output nudge, no lifecycle reminder
  spam, no blocking of `rg`/`grep` or normal edits, and safe behavior when no
  routing profile exists.
- **Behavior scenarios:** executable route tests for route decision, definition
  lookup, references, rename preview, structural rewrite preview, rule-based
  AST audit, post-edit audit, unsupported language fallback, missing `ast-grep`,
  and missing LSP.
```

Replace `docs/project-direction.md:148-160` with:

```md
- Prefer real tool responses over cached profiles.
- Keep fallback reporting visible in both tools and documentation.
- Treat `ast-grep` as the canonical executable name.
- Preserve standalone operation; avoid coupling the plugin to one workflow style.
- Keep hooks short, deterministic, prompt-time only, and optional.
- Use explicit MCP audit tools instead of repeated lifecycle reminders.
- Keep preview tools honest: distinguish executable edits from match-only
  candidates, and never imply a replacement is safe unless the substituted output
  has been proven.
- Add fixtures before broadening behavior; every new route should have validation
  for success and degraded operation.
- Favor small reliable language coverage over broad but unreliable settings
  coverage.
```

Insert this new roadmap section before the current `### 1. Reliability Before Breadth`:

```md
### 1. Low-Noise OMO-Style Operation

Move repeated lifecycle guidance out of hooks and into explicit MCP tools and
skill workflows. Prompt-time hooks may help discovery, but route decisions,
rule scans, and post-edit audits should be actual tool calls with structured
results and fallback reasons.
```

Then renumber the existing roadmap headings so the sequence runs from `### 2.` through `### 6.`.

- [ ] **Step 8: Run documentation validation**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const rows=j.results.filter(r=>r.name.startsWith("behavior documented") || r.name.includes("frontmatter")); console.log(JSON.stringify(rows, null, 2)); if(rows.some(r=>!r.ok)) process.exit(1);})'
```

Expected: behavior documentation and skill frontmatter checks pass.

- [ ] **Step 9: Commit Task 6**

```bash
git add docs/project-direction.md references/routing-policy.md references/mcp-tool-contract.md skills/code-intel/SKILL.md scripts/validate-plugin.js
git commit -m "Document low-noise code-intel operating model"
```

Expected: commit succeeds.

---

### Task 7: Full Validation And Context Hygiene Audit

**Files:**
- Modify only if checks fail: files changed by Tasks 1-6

- [ ] **Step 1: Run full validation**

Run:

```bash
npm run validate
```

Expected: exits `0` and reports all checks passing.

- [ ] **Step 2: Verify no lifecycle hook nudge remains**

Run:

```bash
rg -n "PreToolUse|PostToolUse|after code edits|manual replacement|lifecycle reminder|additionalContext" hooks references skills docs/project-direction.md scripts/validate-plugin.js
```

Expected: no `PreToolUse` or `PostToolUse` hook registration remains; any `additionalContext` match is only in `hooks/user-prompt-submit.js` or hook validation code.

- [ ] **Step 3: Verify no forbidden AST shorthand is introduced**

Run:

```bash
rg -n "['\"]sg['\"]|\\bsg\\s+scan\\b|\\bsg\\s+run\\b" mcp scripts hooks settings references skills docs/project-direction.md
```

Expected: no matches that call `sg`; documentation may mention the forbidden shorthand only as a policy warning.

- [ ] **Step 4: Smoke list tools**

Run:

```bash
npm run --silent mcp:list-tools | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const names=JSON.parse(s).tools.map(t=>t.name); console.log(names.join("\\n")); for (const n of ["capability_route","ast_grep_scan","post_edit_audit"]) if(!names.includes(n)) process.exit(1);})'
```

Expected: output includes `capability_route`, `ast_grep_scan`, and `post_edit_audit`.

- [ ] **Step 5: Verify `core.js` stayed a facade**

Run:

```bash
test "$(wc -l < mcp/code-intel-server/core.js | tr -d ' ')" -le 260
! rg -n "postEditAudit|gitChangedFiles|spawnSync\\(['\"]git['\"]|normalizeAstGrepJson|lspFrame|textDocument/diagnostic.*astGrepScan" mcp/code-intel-server/core.js
```

Expected: both commands exit `0`; audit orchestration, git driver calls, ast-grep normalization, and LSP protocol details are absent from `core.js`.

- [ ] **Step 6: Run direct audit smoke**

Run:

```bash
node mcp/code-intel-server/index.js --call-tool post_edit_audit --args '{"repoRoot":"fixtures/repos/typescript-basic","files":["src/math.ts"],"timeoutMs":5000}'
```

Expected: JSON output has `"status": "ok"`, includes `"files": ["src/math.ts"]`, and includes a `diagnostics` array with either LSP results or explicit fallback.

- [ ] **Step 7: Inspect final diff**

Run:

```bash
git diff --stat HEAD~6..HEAD
git diff --check HEAD~6..HEAD
```

Expected: `git diff --check` exits `0`; changed files match the file structure in this plan.

- [ ] **Step 8: Commit final fixups if needed**

If Step 1-7 required small fixes, stage only the affected files and commit:

```bash
git add mcp/code-intel-server scripts/validate-plugin.js hooks references skills docs/project-direction.md
git commit -m "Validate OMO-style code-intel flow"
```

Expected: either a final fixup commit is created, or no commit is needed because Tasks 1-6 already passed.

---

## Self-Review

**Spec coverage:** This plan covers the requested plugin improvement and explicitly includes `docs/project-direction.md` changes. It moves noisy lifecycle hooks out of the active surface, adds explicit MCP route/audit tools, aligns skills and references, splits server responsibilities before adding new behavior, and verifies behavior through `npm run validate`.

**Red-flag scan:** The plan avoids unspecified future work and gives concrete file paths, code snippets, commands, and expected outcomes for each task.

**Type consistency:** New tool names are consistently `capability_route`, `ast_grep_scan`, and `post_edit_audit` across `TOOL_NAMES`, `callTool()`, tool schemas, validation, skills, and docs.

**Boundary consistency:** `core.js` is treated as a facade; git changed-file discovery, LSP diagnostics, ast-grep scan execution, post-edit audit orchestration, and audit result formatting are assigned to separate modules with validation guards.
