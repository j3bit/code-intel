#!/usr/bin/env node
import fs from 'node:fs';

const input = fs.readFileSync(0, 'utf8');
const text = input.toLowerCase();
const edited = /\b(write|edit|apply_patch|modified|changed|created)\b/.test(text);
if (edited) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: 'code-intel: after code edits, run LSP diagnostics when available and AST/text audits for structural rewrites.'
    }
  }));
}
