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

`languages` maps language ids to file extensions, ast-grep language ids, LSP
command candidates, and expected LSP capabilities.

An LSP may use structured `command` and `args`. Legacy `commands` entries remain
ordered fallback candidates. `languageId`, `initializationOptions`, and `settings`
are forwarded to the server. `expectedCapabilities` is the preferred declaration;
legacy `capabilities` is treated as the same expectation for compatibility.

Executable discovery proves only that a candidate can be started. Runtime reports
separate expected, initialize-advertised, method-verified, and method-unsupported
capabilities.
