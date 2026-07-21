#!/usr/bin/env node
// Stop hook: after a turn that modified source code, force Claude to run the
// code-simplifier:code-simplifier subagent once.
const fs = require('fs');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main() {
  let input;
  try { input = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

  // Loop guard — we already triggered in this continuation chain.
  if (input.stop_hook_active) process.exit(0);

  // Skip plan mode (only the plan file gets edited there).
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

  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const SKIP_EXT = new Set([
    '.md', '.markdown', '.json', '.yaml', '.yml', '.txt',
    '.lock', '.toml', '.ini', '.cfg', '.env', '.gitignore'
  ]);
  // Shell rc/profile dotfiles are config, not source code.
  const SKIP_BASENAME = new Set([
    '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout',
    '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile'
  ]);
  // OS temp trees (incl. Claude's session scratchpad) hold throwaway helpers, not source.
  const TMP_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'];
  const isTemp = p => TMP_PREFIXES.some(t => p.startsWith(t));
  const ext = p => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i).toLowerCase(); };
  const base = p => p.slice(p.lastIndexOf('/') + 1);

  let codeEdited = false;
  for (let i = start; i < entries.length; i++) {
    const m = entries[i].message;
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue;
      const fp = (b.input && (b.input.file_path || b.input.notebook_path)) || '';
      if (!fp) continue;
      if (fp.includes('/.claude/')) continue;  // claude infra/plans/hooks
      if (isTemp(fp)) continue;  // scratchpad/temp files
      if (SKIP_BASENAME.has(base(fp))) continue;  // shell rc/profile
      if (SKIP_EXT.has(ext(fp))) continue;   // docs/config only
      codeEdited = true;
    }
  }

  if (!codeEdited) process.exit(0);

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      'Source code was modified this turn. Before finishing, use the Task tool to ' +
      'launch the `code-simplifier:code-simplifier` subagent to review and simplify ' +
      'ONLY the files changed in this turn, preserving all functionality. Apply its ' +
      'suggestions, then stop. (Runs once per turn.)'
  }));
  process.exit(0);
}

main();
