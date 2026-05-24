#!/usr/bin/env node
import fs from 'node:fs';

const input = fs.readFileSync(0, 'utf8');
const text = input.toLowerCase();
const looksLikeTextSearch = /\b(rg|grep)\b/.test(text);
const looksStructural = /\b(class|function|method|def |interface|references|rename|pattern|ast|structural)\b/.test(text);
const looksManualReplace = /\b(apply_patch|edit|multi_edit|replace|rewrite|rename|newstring|oldstring)\b/.test(text);
if ((looksLikeTextSearch || looksManualReplace) && looksStructural) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: 'code-intel soft nudge: for structural code search or manual replacement, try code-intel AST/LSP preview first if supported; rg/grep and normal edits remain allowed with fallback reason.'
    }
  }));
}
