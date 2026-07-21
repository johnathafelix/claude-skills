#!/usr/bin/env node
// Stop hook: after a turn that changed TypeScript source, force Claude to run
// the /ts-check skill once before finishing. Modeled on auto-code-simplifier.js.
const fs = require('fs');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main() {
  let input;
  try { input = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

  // Loop guard — we already triggered in this stop-continuation chain (once per turn).
  if (input.stop_hook_active) process.exit(0);

  // Skip plan mode (no real source edits land there).
  if (input.permission_mode === 'plan') process.exit(0);

  // Load the transcript.
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) process.exit(0);

  let entries = [];
  try {
    for (const line of fs.readFileSync(tp, 'utf8').split('\n')) {
      if (!line) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
  } catch { process.exit(0); }

  // Find the start of the current turn = last real human prompt.
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i].message;
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    const isToolResult = Array.isArray(c) && c.some(b => b && b.type === 'tool_result');
    if (!isToolResult) { start = i; break; }
  }

  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
  // OS temp trees (incl. Claude's session scratchpad) hold throwaway helpers, not source.
  const isTemp = p => ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']
    .some(t => p.startsWith(t));
  // Mirror /ts-check's default scope: hand-written .ts/.tsx (tests INCLUDED).
  const skip = p =>
    (!p.endsWith('.ts') && !p.endsWith('.tsx')) || // TypeScript source only
    p.endsWith('.d.ts') ||                          // declaration files (type-only/generated)
    p.includes('/node_modules/') ||                 // deps
    p.includes('/.claude/') ||                      // claude infra/hooks/skills
    isTemp(p) ||                                    // scratchpad/temp files
    /\.gen\.tsx?$/.test(p);                          // generated

  const changed = new Set();
  for (let i = start; i < entries.length; i++) {
    const m = entries[i].message;
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue;
      const fp = (b.input && b.input.file_path) || '';
      if (!fp || skip(fp)) continue;
      changed.add(fp);
    }
  }

  if (changed.size === 0) process.exit(0);

  const n = changed.size;
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      'TypeScript source was modified this turn (' + n + ' file' + (n === 1 ? '' : 's') +
      '). Before finishing, run the /ts-check skill on the changed .ts/.tsx ' +
      'file' + (n === 1 ? '' : 's') + ' to check and fix them against the TypeScript ' +
      'quality rules (strong types, no magic values, data over logic). Apply its ' +
      'fixes, then stop. (Runs once per turn.)'
  }));
  process.exit(0);
}

main();
