#!/usr/bin/env node
// Stop hook: after a turn that changed Go source, force Claude to run the
// /golang-check skill once before finishing. Modeled on auto-code-simplifier.js.
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
  // Mirror /golang-check's default scope: real, hand-written .go only.
  const skip = p =>
    !p.endsWith('.go') ||          // Go source only
    p.endsWith('_test.go') ||      // test files excluded from default scope
    p.includes('/vendor/') ||      // vendored deps
    p.includes('/.claude/') ||     // claude infra/hooks/skills
    isTemp(p) ||                   // scratchpad/temp files
    /\.pb\.go$/.test(p) ||         // protobuf generated
    /_gen\.go$/.test(p) ||         // generated
    /\.gen\.go$/.test(p);          // generated

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
      'Go source was modified this turn (' + n + ' file' + (n === 1 ? '' : 's') +
      '). Before finishing, run the /golang-check skill on the changed Go ' +
      'file' + (n === 1 ? '' : 's') + ' to check them against the Go conventions ' +
      '(it fans out one focused sub-agent per guideline and reports violations). ' +
      'Address or report its findings, then stop. (Runs once per turn.)'
  }));
  process.exit(0);
}

main();
