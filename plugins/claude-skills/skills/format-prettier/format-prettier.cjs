#!/usr/bin/env node
// Formats given files with `prettier --write`. A project that never declared
// prettier is skipped unless --force is passed; the config that clears that gate
// also decides which directory prettier runs from.
// Usage: node format-prettier.cjs [--force] <path> [path...]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PRETTIER_EXT = new Set([
  '.angular', '.cjs', '.css', '.flow', '.gql', '.graphql', '.hbs', '.html',
  '.js', '.json', '.json5', '.jsx', '.less', '.md', '.mdx', '.mjs', '.mjml',
  '.scss', '.ts', '.tsx', '.vue', '.yaml', '.yml'
]);

const CONFIG_RE = /^\.prettierrc(\..+)?$/;
const CONFIG_JS_RE = /^prettier\.config\.(js|cjs|mjs)$/;

/**
 * True if `dir` itself declares prettier use (own package.json/ignore file,
 * not inherited). `names` is the already-read directory listing of `dir`.
 */
function hasPrettierConfig(dir, names) {
  if (names.some(n => CONFIG_RE.test(n) || CONFIG_JS_RE.test(n))) return true;
  if (names.includes('.prettierignore')) return true;
  if (!names.includes('package.json')) return false;

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

    return Boolean(pkg.prettier || pkg.dependencies?.prettier || pkg.devDependencies?.prettier);
  } catch {
    return false;  // unreadable/invalid package.json — keep walking
  }
}

/**
 * Walk up from `dir` for the directory prettier should run in. Stops at the
 * nearest prettier config (`configured: true`), else the enclosing repo root
 * or the filesystem root (`configured: false`). Results memoized by dir.
 *
 * cwd still matters even though prettier resolves each file's config from the
 * file's own path: it picks which prettier binary runs (a project-local
 * install beats the npx cache) and where .gitignore/.prettierignore resolve
 * from. So a project that declares a config runs from its own root.
 */
function findRunRoot(dir, cache) {
  if (cache.has(dir)) return cache.get(dir);

  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* unreadable dir — keep walking */ }

  const parent = path.dirname(dir);

  let result;
  if (hasPrettierConfig(dir, names)) {
    result = { root: dir, configured: true };
  } else if (names.includes('.git')) {
    result = { root: dir, configured: false };
  } else if (parent === dir) {
    // The filesystem root bounds the walk so it can't escape onto the machine.
    result = { root: dir, configured: false };
  } else {
    result = findRunRoot(parent, cache);
  }

  cache.set(dir, result);
  return result;
}

// A file prettier rewrote: "src/a.js 12ms". One it left alone gets a trailing
// "(unchanged)" and so does not match, and neither does anything else npx may print.
// A file `.prettierignore` excludes gets NO line at all — not "(unchanged)", nothing —
// so it must never be inferred by subtracting from the file count handed to prettier.
const REWRITTEN_RE = /\s\d+ms$/;
const UNCHANGED_RE = /\(unchanged\)$/;

/** How many files a `prettier --write` run actually rewrote, from its own output. */
function countRewritten(stdout) {
  return stdout.split('\n').filter(l => REWRITTEN_RE.test(l.trimEnd())).length;
}

/** How many files prettier looked at and left alone, from its own output. */
function countUnchanged(stdout) {
  return stdout.split('\n').filter(l => UNCHANGED_RE.test(l.trimEnd())).length;
}

/** A count as the report words it: "1 file", "2 files". */
function fileCount(n) {
  return `${n} file${n === 1 ? '' : 's'}`;
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const candidates = args.filter(a => a !== '--force');

  // OS temp trees (incl. Claude's session scratchpad) hold throwaway helpers, not source.
  const isTemp = p => ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']
    .some(t => p.startsWith(t));
  const ext = p => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i).toLowerCase(); };

  const changed = new Set();
  for (const fp of candidates) {
    // Resolve first: candidates may be repo-relative (e.g. from `git diff --name-only`),
    // and every filter below assumes an absolute path.
    const abs = path.resolve(fp);

    if (!PRETTIER_EXT.has(ext(abs))) continue;
    if (abs.includes('/.claude/')) continue;  // claude infra/plans/hooks
    if (isTemp(abs)) continue;                // scratchpad/temp files
    if (!fs.existsSync(abs)) continue;        // passed then deleted/moved
    changed.add(abs);
  }

  if (changed.size === 0) {
    console.log('nothing to format');
    process.exit(0);
  }

  // One prettier run per root directory.
  const rootCache = new Map();
  const byRoot = new Map();
  for (const fp of changed) {
    const dir = path.dirname(fp);
    const { root, configured } = findRunRoot(dir, rootCache);
    if (!byRoot.has(root)) byRoot.set(root, { files: [], configured });
    byRoot.get(root).files.push(fp);
  }

  let formatted = 0;
  let unchanged = 0;
  let skippedNoConfig = 0;
  const skippedRoots = [];
  const failures = [];

  for (const [root, { files, configured }] of byRoot) {
    if (!configured && !force) {
      skippedNoConfig += files.length;
      skippedRoots.push(root);
      continue;
    }

    try {
      // --yes so a project without prettier installed resolves it from the npx cache
      // instead of stalling on npm's install confirmation.
      const out = execFileSync('npx', ['--yes', 'prettier', '-u', '--write', ...files], {
        cwd: root,
        stdio: 'pipe',
        encoding: 'utf8',
      });

      formatted += countRewritten(out);
      unchanged += countUnchanged(out);
    } catch (err) {
      const detail = (err.stderr || err.message || 'unknown error').trim();

      failures.push(`${root}: ${detail}`);
    }
  }

  const parts = [];
  if (formatted > 0) parts.push(`prettier formatted ${fileCount(formatted)}`);
  if (unchanged > 0) parts.push(`${fileCount(unchanged)} already formatted`);
  if (skippedNoConfig > 0) {
    parts.push(
      `skipped ${fileCount(skippedNoConfig)}: no prettier config under ` +
      `${skippedRoots.join(', ')} — re-run with --force to use prettier defaults`,
    );
  }
  if (failures.length > 0) parts.push(`prettier failed for ${failures.join('; ')}`);

  console.log(parts.join('; '));
  process.exit(failures.length > 0 ? 1 : 0);
}

main();
