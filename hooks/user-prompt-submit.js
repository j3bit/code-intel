#!/usr/bin/env node
import fs from 'node:fs';

const input = fs.readFileSync(0, 'utf8');
const text = input.toLowerCase();
const intents = [
  ['rename', /\b(rename|symbol rename|prepare rename)\b/],
  ['references', /\b(reference|references|call sites|usage|usages)\b/],
  ['definition', /\b(definition|go to|goto|declaration|declarations)\b/],
  ['diagnostics', /\b(diagnostic|diagnostics|errors|typecheck|lint)\b/],
  ['structural-search', /\b(class|function|method|pattern|api usage|structural|ast)\b/],
  ['rewrite', /\b(rewrite|replace pattern|structural replace|refactor)\b/]
];
const matched = intents.filter(([, re]) => re.test(text)).map(([name]) => name);
if (matched.length) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `code-intel: prefer LSP/ast_grep tools for structural code work; use rg/grep fallback only with an explicit reason. Matched intent: ${matched.join(', ')}.`
    }
  }));
}
