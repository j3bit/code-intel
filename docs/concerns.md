# Concerns

## Hook Frequency And Context Cost

- The current hook behavior appears to run often during normal agent work.
- Repeated `additionalContext` output can consume context budget without adding much new information.
- `PostToolUse` is especially likely to repeat reminders during edit-heavy work.

## Soft Nudge Versus Hard Guard

- The current hook implementation is a soft nudge, not a routing or enforcement layer.
- Soft nudges can be ignored by the model.
- Hard guards may be possible through hook blocking behavior, but they risk interrupting valid workflows.
- Blocking ordinary `rg`, `grep`, or direct edits can be wrong for string search, logs, docs, generated files, unsupported languages, or unavailable code-intel capabilities.

## Skill Routing Ambiguity

- The hooks do not currently choose one of the four code-intel skills.
- The hooks only add contextual reminders about code-intel usage.
- It is unclear whether users should expect natural coding prompts to route to `code-intel`, `init-code-intel`, `code-intel-doctor`, or `code-intel-refactor`.
- Explicitly mentioning `code-intel` in prompts should not be required for normal code modification tasks.

## Progressive Disclosure Tension

- OpenAI's skill model emphasizes loading detailed skill instructions only when relevant.
- Frequent hook-injected context can work against that goal by repeatedly adding routing hints.
- Hook-based routing may blur the boundary between lightweight lifecycle guidance and skill selection.

## User And Project Settings Clarity

- User-scope settings are `~/.codex/code-intel/settings.json`.
- Project-scope settings are `<repoRoot>/.code-intel/settings.json`.
- The similar names can cause confusion between user-global `code-intel` and project-local `.code-intel`.

