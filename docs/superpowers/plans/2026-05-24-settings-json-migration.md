# Settings JSON Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the adapter registry with a single settings model that supports built-in defaults, user-scope overrides at `~/.codex/code-intel/settings.json`, project overrides at `<repoRoot>/.code-intel/settings.json`, and optional external ast-grep `sgconfig` paths.

**Architecture:** The plugin will ship `settings/defaults.json` and `settings/schema.json`; runtime code will load defaults, merge user settings, merge project settings, validate the effective result, and route AST/LSP operations from that settings object. The old `adapters/` registry concept disappears entirely, including env vars, docs, validation checks, and routing-profile stale checks.

**Tech Stack:** Node.js ESM, built-in `fs/path/os/child_process/url` modules only, existing MCP JSON-RPC stdio server, existing validator harness in `scripts/validate-plugin.js`.

---

## File Structure

- Create: `settings/defaults.json` — shipped zero-config defaults for common languages, ast-grep command, fallback commands, and PATH extras.
- Create: `settings/schema.json` — JSON schema for the merged settings contract.
- Modify: `mcp/code-intel-server/core.js` — replace registry loading and adapter lookup with settings loading, merge, path expansion, language lookup, AST config, and LSP command discovery.
- Modify: `scripts/validate-plugin.js` — replace registry tests with settings schema, merge precedence, user/project override, ast-grep config, and stale-profile assertions.
- Modify: `scripts/init-code-intel.js` — report effective settings source/version instead of adapter registry version.
- Modify: `scripts/doctor-code-intel.js` — detect stale routing profiles by settings version/signature instead of adapter registry version; include settings source diagnostics.
- Modify: `README.md`, `skills/*/SKILL.md`, `references/*.md`, `.codex-plugin/plugin.json` — remove adapter terminology and document settings paths.
- Delete: `adapters/registry.json`.
- Delete or move: `adapters/schema.json` into `settings/schema.json`; after migration, remove empty `adapters/` directory.
- Optional cache sync after source validation: `/Users/jeongsaebit/.codex/plugins/cache/user-local/code-intel/0.1.0/`.

## Settings Contract v1

The effective settings object must validate against this shape:

```json
{
  "version": 1,
  "path": {
    "extraDirs": []
  },
  "astGrep": {
    "command": "ast-grep",
    "configPath": null
  },
  "fallback": ["rg", "grep"],
  "languages": {
    "python": {
      "extensions": [".py"],
      "astGrep": { "languageId": "python" },
      "lsp": {
        "commands": ["pyright-langserver --stdio", "pylsp"],
        "capabilities": ["definition", "references", "rename", "diagnostics", "symbols"]
      }
    }
  }
}
```

Merge precedence is fixed:

1. `settings/defaults.json`
2. user settings from `~/.codex/code-intel/settings.json`, or test override `CODE_INTEL_USER_SETTINGS_PATH`
3. project settings from `<repoRoot>/.code-intel/settings.json`, or test override `CODE_INTEL_PROJECT_SETTINGS_PATH`
4. tool call args, only for fields already accepted by the specific MCP tool

Deep merge rules:

- Object fields merge recursively.
- Arrays replace the lower-precedence array.
- `languages.<name>` merges recursively so a project can override only `lsp.commands` without redefining extensions.
- `null` is an explicit value for nullable fields such as `astGrep.configPath`.
- Unknown top-level fields fail schema validation.

---

### Task 1: Add settings schema and shipped defaults

**Files:**
- Create: `settings/schema.json`
- Create: `settings/defaults.json`
- Modify: `scripts/validate-plugin.js`

- [ ] **Step 1: Write failing structure/schema checks**

In `scripts/validate-plugin.js`, replace the adapter structure checks near the current `adapter schema exists` block with settings checks that initially fail because `settings/` does not exist yet.

```js
check('settings schema exists', exists('settings/schema.json'), 'settings/schema.json');
check('default settings exists', exists('settings/defaults.json'), 'settings/defaults.json');
let defaultSettings;
try {
  defaultSettings = readJson('settings/defaults.json');
  validateSettings(defaultSettings);
  check('default settings validate against settings/schema.json', true, 'settings/defaults.json');
} catch (error) {
  check('default settings validate against settings/schema.json', false, error.message);
  finish();
}
check('default settings include python language', Boolean(defaultSettings.languages?.python?.lsp?.commands?.length), JSON.stringify(defaultSettings.languages?.python || {}));
check('default settings include typescript language', Boolean(defaultSettings.languages?.typescript?.lsp?.commands?.length), JSON.stringify(defaultSettings.languages?.typescript || {}));
check('default settings command policy uses ast-grep', defaultSettings.astGrep?.command === 'ast-grep', defaultSettings.astGrep?.command);
```

Update the import at the top of `scripts/validate-plugin.js` after Task 2 exposes the functions:

```js
import { tools, callTool, loadSettings, validateSettings, splitCommandLine } from '../mcp/code-intel-server/core.js';
```

- [ ] **Step 2: Run RED validation**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({status:j.status,failed:j.failed,failures:j.results.filter(r=>!r.ok).map(r=>r.name)}, null, 2)); if(j.status==="passed") process.exit(1);})'
```

Expected: FAIL with at least `settings schema exists` and `default settings exists` failing.

- [ ] **Step 3: Create `settings/schema.json`**

Write this exact file:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Code Intel Settings",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "path", "astGrep", "fallback", "languages"],
  "properties": {
    "version": { "const": 1 },
    "path": {
      "type": "object",
      "additionalProperties": false,
      "required": ["extraDirs"],
      "properties": {
        "extraDirs": { "type": "array", "items": { "type": "string" } }
      }
    },
    "astGrep": {
      "type": "object",
      "additionalProperties": false,
      "required": ["command", "configPath"],
      "properties": {
        "command": { "type": "string", "minLength": 1, "not": { "const": "sg" } },
        "configPath": { "type": ["string", "null"] }
      }
    },
    "fallback": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "languages": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "required": ["extensions", "astGrep", "lsp"],
        "properties": {
          "extensions": { "type": "array", "items": { "type": "string", "pattern": "^\\." }, "minItems": 1 },
          "astGrep": {
            "type": "object",
            "additionalProperties": false,
            "required": ["languageId"],
            "properties": {
              "languageId": { "type": "string", "minLength": 1 }
            }
          },
          "lsp": {
            "type": "object",
            "additionalProperties": false,
            "required": ["commands", "capabilities"],
            "properties": {
              "commands": { "type": "array", "items": { "type": "string" } },
              "capabilities": { "type": "array", "items": { "type": "string" } }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Create `settings/defaults.json`**

Write this exact file:

```json
{
  "version": 1,
  "path": {
    "extraDirs": []
  },
  "astGrep": {
    "command": "ast-grep",
    "configPath": null
  },
  "fallback": ["rg", "grep"],
  "languages": {
    "typescript": {
      "extensions": [".ts", ".tsx"],
      "astGrep": { "languageId": "typescript" },
      "lsp": {
        "commands": ["typescript-language-server --stdio"],
        "capabilities": ["definition", "references", "rename", "diagnostics", "symbols"]
      }
    },
    "javascript": {
      "extensions": [".js", ".jsx", ".mjs", ".cjs"],
      "astGrep": { "languageId": "javascript" },
      "lsp": {
        "commands": ["typescript-language-server --stdio"],
        "capabilities": ["definition", "references", "rename", "diagnostics", "symbols"]
      }
    },
    "python": {
      "extensions": [".py"],
      "astGrep": { "languageId": "python" },
      "lsp": {
        "commands": ["pyright-langserver --stdio", "pylsp"],
        "capabilities": ["definition", "references", "rename", "diagnostics", "symbols"]
      }
    },
    "json": {
      "extensions": [".json"],
      "astGrep": { "languageId": "json" },
      "lsp": {
        "commands": [],
        "capabilities": []
      }
    }
  }
}
```

- [ ] **Step 5: Do not delete `adapters/` yet**

Keep `adapters/` until Task 5 has moved all tests and runtime callers off `loadRegistry()`. This avoids mixing schema creation with runtime migration.

---

### Task 2: Implement settings loading, validation, path expansion, and merge precedence

**Files:**
- Modify: `mcp/code-intel-server/core.js`
- Modify: `scripts/validate-plugin.js`

- [ ] **Step 1: Add failing settings-loader tests**

In `scripts/validate-plugin.js`, after default settings validation, add a temp user/project settings merge test.

```js
const settingsMergeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-settings-merge-'));
try {
  const userSettingsPath = path.join(settingsMergeRoot, 'user-settings.json');
  const projectRoot = path.join(settingsMergeRoot, 'repo');
  const projectSettingsDir = path.join(projectRoot, '.code-intel');
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  writeJson(userSettingsPath, {
    version: 1,
    path: { extraDirs: [path.join(settingsMergeRoot, 'user-bin')] },
    astGrep: { configPath: path.join(settingsMergeRoot, 'user-sgconfig.yml') },
    languages: {
      python: { lsp: { commands: ['user-pyright --stdio'] } },
      systemverilog: {
        extensions: ['.sv', '.svh'],
        astGrep: { languageId: 'systemverilog' },
        lsp: { commands: ['slangd'], capabilities: ['definition', 'diagnostics', 'symbols'] }
      }
    }
  });
  writeJson(path.join(projectSettingsDir, 'settings.json'), {
    version: 1,
    languages: {
      python: { lsp: { commands: ['project-pyright --stdio'] } }
    }
  });
  const merged = loadSettings(projectRoot, { userSettingsPath });
  check('settings merge uses user scope custom language', Boolean(merged.languages.systemverilog), JSON.stringify(merged.languages.systemverilog || {}));
  check('settings merge lets project override user LSP command', merged.languages.python.lsp.commands[0] === 'project-pyright --stdio', JSON.stringify(merged.languages.python.lsp.commands));
  check('settings merge preserves default python extensions', merged.languages.python.extensions.includes('.py'), JSON.stringify(merged.languages.python));
  check('settings merge records source paths', merged.sources.user === userSettingsPath && merged.sources.project.endsWith('.code-intel/settings.json'), JSON.stringify(merged.sources));
} finally {
  fs.rmSync(settingsMergeRoot, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run RED validation**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({status:j.status,failed:j.failed,failures:j.results.filter(r=>!r.ok).slice(0,8)}, null, 2)); if(j.status==="passed") process.exit(1);})'
```

Expected: FAIL because `loadSettings` and `validateSettings` are not exported yet.

- [ ] **Step 3: Replace registry constants with settings constants**

In `mcp/code-intel-server/core.js`, replace:

```js
const DEFAULT_REGISTRY_PATH = path.join(ROOT, 'adapters', 'registry.json');
const DEFAULT_SCHEMA_PATH = path.join(ROOT, 'adapters', 'schema.json');
```

with:

```js
const DEFAULT_SETTINGS_PATH = path.join(ROOT, 'settings', 'defaults.json');
const SETTINGS_SCHEMA_PATH = path.join(ROOT, 'settings', 'schema.json');
const USER_SETTINGS_PATH = path.join(process.env.HOME || '', '.codex', 'code-intel', 'settings.json');
```

- [ ] **Step 4: Add settings helpers**

In `mcp/code-intel-server/core.js`, replace `validateRegistry()` and `loadRegistry()` with this implementation:

```js
function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return process.env.HOME || value;
  if (value.startsWith('~/')) return path.join(process.env.HOME || '', value.slice(2));
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return null;
  return readJson(file);
}

export function validateSettings(settings) {
  const schema = readJson(SETTINGS_SCHEMA_PATH);
  const errors = validateAgainstSchema(settings, schema, '$');
  if (settings?.astGrep?.command === 'sg') errors.push('$.astGrep.command must be ast-grep or another explicit executable, not sg');
  if (errors.length) {
    const error = new Error(`settings schema validation failed: ${errors.slice(0, 8).join('; ')}`);
    error.validationErrors = errors;
    throw error;
  }
  return settings;
}

export function loadSettings(repoRoot = process.cwd(), opts = {}) {
  const defaultPath = opts.defaultSettingsPath || process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH || DEFAULT_SETTINGS_PATH;
  const userPath = opts.userSettingsPath || process.env.CODE_INTEL_USER_SETTINGS_PATH || USER_SETTINGS_PATH;
  const projectPath = opts.projectSettingsPath || process.env.CODE_INTEL_PROJECT_SETTINGS_PATH || path.join(path.resolve(repoRoot), '.code-intel', 'settings.json');
  const defaults = readJson(defaultPath);
  const user = readJsonIfExists(expandHome(userPath));
  const project = readJsonIfExists(expandHome(projectPath));
  const merged = validateSettings(deepMerge(deepMerge(defaults, user || {}), project || {}));
  Object.defineProperty(merged, 'sources', {
    enumerable: false,
    value: {
      default: defaultPath,
      user: user ? expandHome(userPath) : null,
      project: project ? expandHome(projectPath) : null
    }
  });
  return merged;
}
```

If the current Node runtime does not expose `structuredClone`, replace `structuredClone(base)` with `JSON.parse(JSON.stringify(base))` in the same step.

- [ ] **Step 5: Extend schema validator to support `additionalProperties`, `const`, `minLength`, `minItems`, and `not.const`**

In `validateAgainstSchema()`, add these checks inside `visit()`:

```js
if (Object.prototype.hasOwnProperty.call(currentSchema, 'const') && current !== currentSchema.const) {
  errors.push(`${label} expected ${JSON.stringify(currentSchema.const)}`);
}
if (currentSchema.minLength && typeof current === 'string' && current.length < currentSchema.minLength) {
  errors.push(`${label} expected length >= ${currentSchema.minLength}`);
}
if (currentSchema.minItems && Array.isArray(current) && current.length < currentSchema.minItems) {
  errors.push(`${label} expected at least ${currentSchema.minItems} items`);
}
if (currentSchema.not?.const !== undefined && current === currentSchema.not.const) {
  errors.push(`${label} must not be ${JSON.stringify(currentSchema.not.const)}`);
}
if (currentSchema.additionalProperties === false && isPlainObject(current)) {
  const allowed = new Set(Object.keys(currentSchema.properties || {}));
  for (const key of Object.keys(current)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  }
}
if (isPlainObject(currentSchema.additionalProperties) && isPlainObject(current)) {
  const explicit = new Set(Object.keys(currentSchema.properties || {}));
  for (const [key, value] of Object.entries(current)) {
    if (!explicit.has(key)) visit(value, currentSchema.additionalProperties, `${label}.${key}`);
  }
}
```

- [ ] **Step 6: Run GREEN for settings loader only**

Run:

```bash
node --check mcp/code-intel-server/core.js
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); const relevant=j.results.filter(r=>/settings/.test(r.name)); console.log(JSON.stringify(relevant, null, 2)); if(relevant.some(r=>!r.ok)) process.exit(1);})'
```

Expected: settings-related checks pass. Registry-related checks may still fail until Task 5 removes them.

---

### Task 3: Wire runtime AST/LSP discovery to settings

**Files:**
- Modify: `mcp/code-intel-server/core.js`
- Modify: `scripts/validate-plugin.js`

- [ ] **Step 1: Rename adapter lookup functions to language lookup functions**

In `mcp/code-intel-server/core.js`, replace `adapterForFile` and `adapterForLanguage` with:

```js
export function languageForFile(file, settings = loadSettings()) {
  const ext = path.extname(file).toLowerCase();
  return Object.entries(settings.languages).find(([, language]) => language.extensions.includes(ext))?.[0] || null;
}

export function languageConfigForFile(file, settings = loadSettings()) {
  const language = languageForFile(file, settings);
  return language ? { language, config: settings.languages[language] } : { language: null, config: null };
}

export function languageConfigForLanguage(language, settings = loadSettings()) {
  if (!language) return { language: null, config: null };
  if (settings.languages[language]) return { language, config: settings.languages[language] };
  const found = Object.entries(settings.languages).find(([, config]) => config.astGrep.languageId === language);
  return found ? { language: found[0], config: found[1] } : { language: null, config: null };
}
```

- [ ] **Step 2: Update inventory and discovery to use settings**

Change `languageInventory(repoRoot, registry = loadRegistry())` to:

```js
export function languageInventory(repoRoot, settings = loadSettings(repoRoot)) {
  const files = walkFiles(repoRoot);
  const languages = {};
  const unsupported = {};
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const { language, config } = languageConfigForFile(file, settings);
    if (language && config) {
      languages[language] ??= { files: 0, extensions: config.extensions, examples: [] };
      languages[language].files += 1;
      if (languages[language].examples.length < 5) languages[language].examples.push(rel);
    } else {
      const ext = path.extname(file).toLowerCase() || '[no extension]';
      unsupported[ext] = (unsupported[ext] || 0) + 1;
    }
  }
  return { totalFiles: files.length, languages, unsupportedExtensions: unsupported };
}
```

Change `discoverCapabilities()` to load settings once and iterate over `Object.entries(settings.languages)`:

```js
export function discoverCapabilities(repoRoot = process.cwd()) {
  const settings = loadSettings(repoRoot);
  const ast = detectExecutable(settings.astGrep.command, ['--version']);
  const inventory = languageInventory(repoRoot, settings);
  const languages = {};
  for (const [language, config] of Object.entries(settings.languages)) {
    const present = inventory.languages[language]?.files || 0;
    const lspCommands = config.lsp.commands.map((command) => commandAvailable(command, repoRoot, settings));
    const lspAvailable = lspCommands.find((candidate) => candidate.available)?.command || null;
    languages[language] = {
      presentFiles: present,
      extensions: config.extensions,
      astGrep: ast.available ? 'available' : 'unavailable',
      astGrepLanguageId: config.astGrep.languageId,
      lsp: lspAvailable ? 'commandDetected' : 'missing',
      lspState: lspAvailable ? 'commandDetected' : 'missing',
      methodVerified: [],
      methodUnsupported: [],
      lspCommand: lspAvailable,
      lspCommands,
      capabilities: config.lsp.capabilities,
      fallback: settings.fallback
    };
  }
  return {
    status: 'ok',
    pluginVersion: PLUGIN_VERSION,
    settingsVersion: settings.version,
    settingsSources: settings.sources,
    generatedAt: new Date().toISOString(),
    repoRoot: path.resolve(repoRoot),
    inventory,
    languages,
    tools: {
      astGrep: {
        command: settings.astGrep.command,
        available: ast.available,
        version: ast.stdout || ast.stderr,
        configPath: settings.astGrep.configPath,
        note: 'Do not use sg alias.'
      }
    },
    fallbackPolicy: ast.available ? 'Use rg/grep when AST or LSP is unsupported or inconclusive.' : 'Fallback reason: ast-grep executable was not found on PATH. Command policy: this plugin does not call sg.'
  };
}
```

- [ ] **Step 3: Let command discovery use `path.extraDirs`**

Change signatures:

```js
function executableCandidates(command, baseDir = process.cwd(), settings = null) {
```

Inside the no-path-separator branch, replace PATH dirs with:

```js
const extraDirs = (settings?.path?.extraDirs || []).map(expandHome);
const dirs = [...extraDirs, ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)];
return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
```

Then propagate `settings` through:

```js
export function executableOnPath(command, baseDir = process.cwd(), settings = null) { ... }
export function commandAvailable(commandLine, baseDir = process.cwd(), settings = null) { ... }
```

- [ ] **Step 4: Update AST search and replace preview to use settings**

In `astGrepSearch(args)`, load settings and derive command/config:

```js
const settings = loadSettings(repoRoot);
const { language: resolvedLanguage, config } = language ? languageConfigForLanguage(language, settings) : { language: null, config: null };
if (language && !config) return astUnavailable(language, `unsupported language: ${language}`);
const ast = detectExecutable(settings.astGrep.command, ['--version']);
if (!ast.available) return astUnavailable(language || 'unknown');
const lang = config?.astGrep.languageId || language;
if (!lang) return { status: 'needs_language', error: 'language is required when path inference is not provided', results: [], fallback: settings.fallback };
const cmdArgs = [];
if (settings.astGrep.configPath) cmdArgs.push('--config', expandHome(settings.astGrep.configPath));
cmdArgs.push('--pattern', pattern, '--lang', lang, '--json', repoRoot);
const result = spawnSync(settings.astGrep.command, cmdArgs, { cwd: repoRoot, encoding: 'utf8', timeout: args.timeoutMs || 10000, maxBuffer: 10 * 1024 * 1024 });
```

Update return objects to use `executable: settings.astGrep.command`, `fallback: settings.fallback`, and include `configPath: settings.astGrep.configPath || null`.

- [ ] **Step 5: Update LSP lookup to use settings**

Replace `findLspCommand()` body with:

```js
function findLspCommand(args = {}) {
  const repoRoot = path.resolve(args.repoRoot || process.cwd());
  const settings = loadSettings(repoRoot);
  const resolved = args.language
    ? languageConfigForLanguage(args.language, settings)
    : args.file
      ? languageConfigForFile(path.resolve(repoRoot, args.file), settings)
      : { language: null, config: null };
  if (!resolved.config) return { language: resolved.language, config: null, command: null, settings };
  const available = resolved.config.lsp.commands.map((command) => commandAvailable(command, repoRoot, settings)).find((candidate) => candidate.available);
  return { language: resolved.language, config: resolved.config, command: available?.command || null, settings };
}
```

Then change `lspTool()` to pass `{ language, config }` into existing LSP code. Keep the parameter name `adapter` internally only if needed for smaller diff, but update returned language/capability data to come from the settings language name.

- [ ] **Step 6: Run runtime smoke checks**

Run:

```bash
node --check mcp/code-intel-server/core.js
node mcp/code-intel-server/index.js --call-tool capability_discover --args '{"repoRoot":"fixtures/repos/python-basic"}'
node mcp/code-intel-server/index.js --call-tool ast_grep_search --args '{"repoRoot":"fixtures/repos/python-basic","language":"python","pattern":"Greeter().format_greeting($NAME)","maxResults":5}'
node mcp/code-intel-server/index.js --call-tool lsp_symbols --args '{"repoRoot":"fixtures/repos/python-basic","file":"example.py","timeoutMs":5000}'
```

Expected:

- capability discovery prints `settingsVersion: 1` and `tools.astGrep.command: "ast-grep"`.
- ast-grep search returns `status: "ok"` and at least one result.
- LSP symbols returns `status: "ok"` when `pyright-langserver` is on PATH, or clean `status: "unavailable"` with fallback when not.

---

### Task 4: Update init and doctor workflows for settings

**Files:**
- Modify: `scripts/init-code-intel.js`
- Modify: `scripts/doctor-code-intel.js`
- Modify: `skills/init-code-intel/SKILL.md`
- Modify: `skills/code-intel-doctor/SKILL.md`

- [ ] **Step 1: Update init profile fields**

In `scripts/init-code-intel.js`, replace `adapterRegistryVersion` with settings fields in the profile:

```js
settingsVersion: discovery.settingsVersion,
settingsSources: discovery.settingsSources,
```

Replace stale rules:

```js
staleRules: ['repo root differs', 'settings version differs', 'settings source differs', 'plugin version differs', 'profile timestamp predates material plugin upgrade', 'language inventory major mismatch'],
```

Replace markdown validation check:

```js
checks.push(['settings version recorded', Boolean(discovery.settingsVersion), discovery.settingsVersion]);
checks.push(['settings sources recorded', Boolean(discovery.settingsSources), JSON.stringify(discovery.settingsSources)]);
```

Remove the old line:

```js
checks.push(['adapter registry version recorded', Boolean(discovery.adapterRegistryVersion), discovery.adapterRegistryVersion]);
```

- [ ] **Step 2: Update init wording**

In `markdownCapability()`, replace:

```js
if (!Object.values(discovery.languages).some((l) => l.presentFiles)) lines.push('No adapter-supported files detected.', '');
```

with:

```js
if (!Object.values(discovery.languages).some((l) => l.presentFiles)) lines.push('No settings-supported files detected.', '');
```

- [ ] **Step 3: Update doctor stale detection**

In `scripts/doctor-code-intel.js`, replace:

```js
if (profile.adapterRegistryVersion !== discovery.adapterRegistryVersion) staleReasons.push('adapter registry version differs');
```

with:

```js
if (profile.settingsVersion !== discovery.settingsVersion) staleReasons.push('settings version differs');
if (JSON.stringify(profile.settingsSources || {}) !== JSON.stringify(discovery.settingsSources || {})) staleReasons.push('settings source differs');
```

- [ ] **Step 4: Update doctor report with settings source**

Change report construction to include settings metadata:

```js
const report = {
  status: findings.some((finding) => finding.severity === 'degraded') ? 'degraded' : 'ok',
  repoRoot,
  generatedAt: discovery.generatedAt,
  settingsVersion: discovery.settingsVersion,
  settingsSources: discovery.settingsSources,
  profile,
  tools: discovery.tools,
  findings,
  commandPolicy: 'this plugin does not call sg'
};
```

- [ ] **Step 5: Update skills**

In `skills/init-code-intel/SKILL.md`, replace adapter guidance with:

```md
Read `references/settings-contract.md` when changing language coverage, LSP commands, PATH extras, or ast-grep config behavior.
```

In `skills/code-intel-doctor/SKILL.md`, replace:

```md
- adapter coverage,
```

with:

```md
- effective code-intel settings sources and language coverage,
```

- [ ] **Step 6: Run init/doctor smoke checks**

Run:

```bash
TMP=$(mktemp -d)
cp -R fixtures/repos/python-basic "$TMP/python-basic"
node scripts/init-code-intel.js --repo "$TMP/python-basic" --json
node scripts/doctor-code-intel.js --repo "$TMP/python-basic" --json
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log({settingsVersion:p.settingsVersion, settingsSources:p.settingsSources}); if(!p.settingsVersion) process.exit(1)' "$TMP/python-basic/docs/code-intel/routing-profile.json"
rm -rf "$TMP"
```

Expected: init and doctor exit 0, routing profile contains `settingsVersion` and `settingsSources`, and no `adapterRegistryVersion` field.

---

### Task 5: Migrate validation fixtures from registry env vars to settings env vars

**Files:**
- Modify: `scripts/validate-plugin.js`
- Modify: `mcp/code-intel-server/core.js`

- [ ] **Step 1: Remove registry-specific validation imports and checks**

In `scripts/validate-plugin.js`, replace:

```js
import { tools, callTool, loadRegistry, splitCommandLine } from '../mcp/code-intel-server/core.js';
```

with:

```js
import { tools, callTool, loadSettings, validateSettings, splitCommandLine } from '../mcp/code-intel-server/core.js';
```

Remove checks for:

- `adapter schema exists`
- `adapter registry exists`
- `registry has version and adapters`
- `registry validates against adapters/schema.json`
- `adapter ${adapter.language} shape`
- `registry schema validation rejects malformed registry`

- [ ] **Step 2: Add malformed settings schema rejection test**

Add this replacement test:

```js
if (!process.env.CODE_INTEL_EXPECT_VALIDATION_FAILURE) {
  const malformedSettingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-bad-settings-'));
  try {
    writeJson(path.join(malformedSettingsRoot, 'bad-settings.json'), { version: 1, astGrep: { command: 'sg' } });
    const badSettingsRun = run('node', ['scripts/validate-plugin.js', '--json'], {
      env: {
        ...process.env,
        CODE_INTEL_DEFAULT_SETTINGS_PATH: path.join(malformedSettingsRoot, 'bad-settings.json'),
        CODE_INTEL_EXPECT_VALIDATION_FAILURE: '1'
      }
    });
    const badSettingsEvidence = `${badSettingsRun.stdout}\n${badSettingsRun.stderr}`;
    check('settings schema validation rejects malformed settings', badSettingsRun.status !== 0 && badSettingsEvidence.includes('settings schema'), badSettingsEvidence.slice(0, 500));
  } finally {
    fs.rmSync(malformedSettingsRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 3: Rewrite fake LSP settings fixtures**

Replace fake registry temp files with settings files. For the fake no-version LSP test, write:

```js
const fakeSettingsPath = path.join(fakeLspRoot, 'settings.json');
writeJson(fakeSettingsPath, {
  version: 1,
  path: { extraDirs: [fakeBinDir] },
  astGrep: { command: 'ast-grep', configPath: null },
  fallback: ['rg', 'grep'],
  languages: {
    typescript: {
      extensions: ['.ts'],
      astGrep: { languageId: 'typescript' },
      lsp: { commands: ['fake-no-version-lsp --stdio'], capabilities: ['definition', 'references', 'rename', 'diagnostics', 'symbols'] }
    }
  }
});
const fakeLspEnv = { ...process.env, CODE_INTEL_DEFAULT_SETTINGS_PATH: fakeSettingsPath };
```

- [ ] **Step 4: Rewrite repo-relative LSP settings fixture**

Replace the relative registry file with:

```js
const relativeSettingsPath = path.join(relativeLspRoot, 'settings.json');
writeJson(relativeSettingsPath, {
  version: 1,
  path: { extraDirs: [] },
  astGrep: { command: 'ast-grep', configPath: null },
  fallback: ['rg', 'grep'],
  languages: {
    typescript: {
      extensions: ['.ts'],
      astGrep: { languageId: 'typescript' },
      lsp: { commands: ['./node_modules/.bin/fake-relative-lsp --stdio'], capabilities: ['symbols'] }
    }
  }
});
const relativeEnv = { ...process.env, CODE_INTEL_DEFAULT_SETTINGS_PATH: relativeSettingsPath };
```

- [ ] **Step 5: Rewrite strict LSP settings fixture**

Replace the strict registry file with:

```js
const strictSettingsPath = path.join(strictLspRoot, 'settings.json');
writeJson(strictSettingsPath, {
  version: 1,
  path: { extraDirs: [] },
  astGrep: { command: 'ast-grep', configPath: null },
  fallback: ['rg', 'grep'],
  languages: {
    typescript: {
      extensions: ['.ts'],
      astGrep: { languageId: 'typescript' },
      lsp: { commands: [`node "${path.join(ROOT, 'fixtures/lsp/strict-init-lsp-server.js')}"`], capabilities: ['definition', 'references', 'rename', 'diagnostics', 'symbols'] }
    }
  }
});
```

Use env:

```js
{ ...process.env, CODE_INTEL_DEFAULT_SETTINGS_PATH: strictSettingsPath }
```

- [ ] **Step 6: Update stale profile validation**

Replace the stale profile seed:

```js
adapterRegistryVersion: '0.0.0-stale',
```

with:

```js
settingsVersion: 0,
settingsSources: { default: 'stale', user: null, project: null },
```

Replace assertion:

```js
check('doctor detects stale routing profile version and inventory mismatch', reasons.includes('plugin version differs') && reasons.includes('settings version differs') && reasons.includes('language inventory major mismatch'), reasons);
```

- [ ] **Step 7: Update no-forbidden-command scan directories**

Replace:

```js
for (const dir of ['scripts','hooks','adapters','mcp']) {
```

with:

```js
for (const dir of ['scripts','hooks','settings','mcp']) {
```

- [ ] **Step 8: Run validator**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({status:j.status,total:j.total,passed:j.passed,failed:j.failed,failures:j.results.filter(r=>!r.ok).map(r=>r.name)}, null, 2)); if(j.status!=="passed") process.exit(1);})'
```

Expected: PASS before deleting `adapters/`, except any intentional adapter-doc checks removed in Task 6.

---

### Task 6: Remove adapters directory and update docs/skill contracts

**Files:**
- Delete: `adapters/registry.json`
- Delete: `adapters/schema.json`
- Modify: `README.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `references/routing-policy.md`
- Modify: `references/language-adapter-contract.md`
- Modify: `references/fallback-policy.md` if needed
- Modify: `skills/code-intel/SKILL.md`
- Modify: `skills/init-code-intel/SKILL.md`
- Modify: `skills/code-intel-doctor/SKILL.md`
- Modify: `scripts/validate-plugin.js`

- [ ] **Step 1: Rename the contract reference**

Move `references/language-adapter-contract.md` to `references/settings-contract.md` and replace its contents with:

```md
# Code Intel Settings Contract

`code-intel` uses one effective settings object for language coverage, AST routing, LSP command candidates, fallback commands, and optional user/project overrides.

Settings precedence:

1. Shipped defaults in `settings/defaults.json`.
2. User scope `~/.codex/code-intel/settings.json` when present.
3. Project scope `<repoRoot>/.code-intel/settings.json` when present.
4. Tool-call arguments for the specific operation.

The settings schema lives at `settings/schema.json`.

`astGrep.command` defaults to `ast-grep`. The plugin must not call the `sg` shorthand.

`astGrep.configPath` may point to a separate ast-grep config file, for example `~/.codex/code-intel/sgconfig.yml`. The settings file is not itself an ast-grep config.

`languages` maps language ids to file extensions, ast-grep language ids, LSP command candidates, and declared LSP capabilities.
```

- [ ] **Step 2: Update validator reference list**

In `scripts/validate-plugin.js`, replace:

```js
const REFS = ['routing-policy.md','language-adapter-contract.md','fallback-policy.md','mcp-tool-contract.md','hook-contract.md'];
```

with:

```js
const REFS = ['routing-policy.md','settings-contract.md','fallback-policy.md','mcp-tool-contract.md','hook-contract.md'];
```

- [ ] **Step 3: Update routing policy wording**

In `references/routing-policy.md`, replace:

```md
Use `ast-grep` when the task is structurally expressible and the language adapter supports built-in AST search.
```

with:

```md
Use `ast-grep` when the task is structurally expressible and the effective settings define an ast-grep language id for that language.
```

- [ ] **Step 4: Update skill wording**

In `skills/code-intel/SKILL.md`, replace:

```md
Prefer `ast_grep_search` for structural patterns when the adapter supports built-in AST search.
```

with:

```md
Prefer `ast_grep_search` for structural patterns when the effective code-intel settings define an ast-grep language id.
```

- [ ] **Step 5: Update README and plugin manifest wording**

In `README.md`, replace:

```md
- An adapter registry for AST/LSP capability discovery.
```

with:

```md
- Zero-config settings for AST/LSP capability discovery, with optional user and project overrides.
```

In `.codex-plugin/plugin.json`, replace `adapter registry` in `interface.longDescription` with `settings contract`.

- [ ] **Step 6: Delete adapters directory**

Run:

```bash
rm -rf adapters
```

- [ ] **Step 7: Verify no adapter/registry references remain**

Run:

```bash
grep -R "adapter\|registry\|CODE_INTEL_REGISTRY_PATH\|adapters/" -n README.md skills references scripts mcp .codex-plugin package.json settings 2>/dev/null || true
```

Expected: no hits except historical `.omx/` files if they are intentionally excluded from grep. Do not scan `.omx/` for this check.

---

### Task 7: Final validation, cache sync, and post-edit audit

**Files:**
- Source tree files changed by Tasks 1-6
- Installed cache under `/Users/jeongsaebit/.codex/plugins/cache/user-local/code-intel/0.1.0/`

- [ ] **Step 1: Run full validation**

Run:

```bash
npm run --silent validate -- --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({status:j.status,total:j.total,passed:j.passed,failed:j.failed,failures:j.results.filter(r=>!r.ok).map(r=>r.name)}, null, 2)); if(j.status!=="passed") process.exit(1);})'
```

Expected: `status: "passed"` and `failed: 0`.

- [ ] **Step 2: Run syntax checks**

Run:

```bash
node --check mcp/code-intel-server/core.js
node --check mcp/code-intel-server/index.js
node --check scripts/init-code-intel.js
node --check scripts/doctor-code-intel.js
node --check scripts/validate-plugin.js
node --check hooks/user-prompt-submit.js
node --check hooks/pre-tool-use.js
node --check hooks/post-tool-use.js
```

Expected: all commands exit 0.

- [ ] **Step 3: Run runtime zero-config smoke checks**

Run:

```bash
node mcp/code-intel-server/index.js --call-tool capability_discover --args '{"repoRoot":"fixtures/repos/python-basic"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify({settingsVersion:j.settingsVersion, astGrep:j.tools.astGrep, python:j.languages.python}, null, 2)); if(j.tools.astGrep.command!=="ast-grep") process.exit(1);})'
node mcp/code-intel-server/index.js --call-tool ast_grep_search --args '{"repoRoot":"fixtures/repos/python-basic","language":"python","pattern":"Greeter().format_greeting($NAME)","maxResults":5}'
node mcp/code-intel-server/index.js --call-tool lsp_diagnostics --args '{"repoRoot":"fixtures/repos/python-basic","file":"example.py","timeoutMs":5000}'
```

Expected: ast-grep command is `ast-grep`; AST search returns `status: "ok"`; LSP diagnostics either returns `status: "ok"` when `pyright-langserver` is available or clean unavailable output with fallback reason.

- [ ] **Step 4: Run user/project settings override smoke**

Run:

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/repo/.code-intel" "$TMP/bin"
cp -R fixtures/repos/python-basic/. "$TMP/repo/"
cat > "$TMP/repo/.code-intel/settings.json" <<JSON
{
  "version": 1,
  "languages": {
    "python": {
      "lsp": {
        "commands": ["missing-project-pyright --stdio"]
      }
    }
  }
}
JSON
node mcp/code-intel-server/index.js --call-tool capability_discover --args "{\"repoRoot\":\"$TMP/repo\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); console.log(JSON.stringify(j.languages.python.lspCommands, null, 2)); if(j.languages.python.lspCommand!==null) process.exit(1);})'
rm -rf "$TMP"
```

Expected: project settings override Python LSP command and reports missing command cleanly.

- [ ] **Step 5: Sync installed cache**

Run:

```bash
CACHE=/Users/jeongsaebit/.codex/plugins/cache/user-local/code-intel/0.1.0
rsync -a --delete \
  --exclude '.git/' \
  --exclude '.omx/' \
  ./ "$CACHE"/
node --check "$CACHE/mcp/code-intel-server/core.js"
node --check "$CACHE/scripts/validate-plugin.js"
```

Expected: cache contains `settings/`, no `adapters/`, and syntax checks pass.

- [ ] **Step 6: Verify MCP startup from arbitrary cwd using cache manifest**

Run:

```bash
node <<'NODE'
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const config = JSON.parse(fs.readFileSync('/Users/jeongsaebit/.codex/plugins/cache/user-local/code-intel/0.1.0/.mcp.json', 'utf8'));
const server = config.mcpServers['code-intel'];
const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
const input = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
const result = spawnSync(server.command, server.args, { cwd: os.tmpdir(), input, encoding: 'utf8', timeout: 5000 });
console.log(JSON.stringify({ status: result.status, ok: result.status === 0 && result.stdout.includes('code-intel'), stdout: result.stdout.slice(0, 180), stderr: result.stderr.slice(0, 180) }, null, 2));
if (result.status !== 0 || !result.stdout.includes('code-intel')) process.exit(1);
NODE
```

Expected: `ok: true`.

- [ ] **Step 7: Inspect final status**

Run:

```bash
git status --short --branch
find settings -maxdepth 2 -type f -print | sort
find adapters -maxdepth 2 -type f -print 2>/dev/null || true
```

Expected: changed files are limited to settings migration, docs/skills, validators, and prior known fixture edit if it remains; `settings/defaults.json` and `settings/schema.json` exist; `adapters/` has no files.

---

## Self-Review Checklist

- Spec coverage: The plan removes `adapters/registry.json`, moves schema responsibility to `settings/schema.json`, defines `~/.codex/code-intel/settings.json`, defines `<repoRoot>/.code-intel/settings.json`, keeps PATH-based zero-config, supports optional separate `sgconfig`, and updates init/doctor/skills/docs/validation.
- Placeholder scan completed: no unresolved markers, no open-ended test instructions, and each task has exact files, code snippets, commands, and expected outcomes.
- Type consistency: The plan uses `settingsVersion`, `settingsSources`, `loadSettings()`, `validateSettings()`, `languageConfigForFile()`, and `languageConfigForLanguage()` consistently across core, init, doctor, and validation.
