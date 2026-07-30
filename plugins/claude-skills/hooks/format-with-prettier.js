#!/usr/bin/env node
// Stop hook: after every other Stop hook has had its say, format files this turn
// touched with `prettier --write`, but only in projects that opted into prettier
// (a .prettierrc*/prettier.config.*/package.json#prettier found walking up from the
// file). Deliberately has NO stop_hook_active guard — see below.
//
// Ordering guarantee: continuation loops only continue when a hook blocks. This hook
// never blocks, so it is safe to run on every Stop in the chain, including the final
// one where auto-code-simplifier.js / enforce-golang-check.js / enforce-ts-check.js
// have all bailed on stop_hook_active. That makes this the last thing to touch the
// files, by construction — do NOT add the guard back, it would break that ordering.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

const PRETTIER_EXT = new Set([
  '.angular', '.cjs', '.css', '.flow', '.gql', '.graphql', '.hbs', '.html',
  '.js', '.json', '.json5', '.jsx', '.less', '.md', '.mdx', '.mjs', '.mjml',
  '.scss', '.ts', '.tsx', '.vue', '.yaml', '.yml'
]);

const CONFIG_RE = /^\.prettierrc(\..+)?$/;
const CONFIG_JS_RE = /^prettier\.config\.(js|cjs|mjs)$/;

/**
 * True if `dir` itself declares a prettier config (own package.json, not inherited).
 * `names` is the already-read directory listing of `dir`.
 */
function hasPrettierConfig(dir, names) {
  if (names.some(n => CONFIG_RE.test(n) || CONFIG_JS_RE.test(n))) return true;
  if (!names.includes('package.json')) return false;

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

    return Boolean(pkg.prettier || pkg.dependencies?.prettier || pkg.devDependencies?.prettier);
  } catch {
    return false;  // unreadable/invalid package.json — keep walking
  }
}

/** Walk up from `dir` for a prettier project root, or null. Results memoized by dir. */
function findPrettierRoot(dir, cache) {
  if (cache.has(dir)) return cache.get(dir);

  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* unreadable dir — keep walking */ }

  const parent = path.dirname(dir);

  let result;
  if (hasPrettierConfig(dir, names)) {
    result = dir;
  } else if (names.includes('.git') || parent === dir) {
    // A repo root (or the filesystem root) bounds the walk so it can't escape onto the machine.
    result = null;
  } else {
    result = findPrettierRoot(parent, cache);
  }

  cache.set(dir, result);
  return result;
}

function main() {
  let input;
  try { input = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

  // Skip plan mode (only the plan file gets edited there, and it's .md).
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
  const ext = p => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i).toLowerCase(); };

  const changed = new Set();
  for (let i = start; i < entries.length; i++) {
    const m = entries[i].message;
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue;
      const fp = (b.input && b.input.file_path) || '';
      if (!fp) continue;
      if (!PRETTIER_EXT.has(ext(fp))) continue;
      if (fp.includes('/.claude/')) continue;  // claude infra/plans/hooks
      if (isTemp(fp)) continue;                // scratchpad/temp files
      if (!fs.existsSync(fp)) continue;        // edited then deleted/moved
      changed.add(fp);
    }
  }

  if (changed.size === 0) process.exit(0);

  // Group files by prettier project root; files with no root are skipped (opt-in only).
  const rootCache = new Map();
  const byRoot = new Map();
  for (const fp of changed) {
    const root = findPrettierRoot(path.dirname(fp), rootCache);
    if (!root) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(fp);
  }

  if (byRoot.size === 0) process.exit(0);

  let formatted = 0;
  const failures = [];
  for (const [root, files] of byRoot) {
    try {
      execFileSync('npx', ['prettier', '-u', '--write', ...files], {
        cwd: root,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 20_000,
      });
      formatted += files.length;
    } catch (err) {
      const detail = (err.stderr || err.message || 'unknown error').trim();

      failures.push(`${path.basename(root)}: ${detail}`);
    }
  }

  const parts = [];
  if (formatted > 0) parts.push(`prettier formatted ${formatted} file${formatted === 1 ? '' : 's'}`);
  if (failures.length > 0) parts.push(`prettier failed for ${failures.join('; ')}`);

  if (parts.length > 0) {
    process.stdout.write(JSON.stringify({ systemMessage: parts.join('; ') }));
  }

  process.exit(0);
}

main();
