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
