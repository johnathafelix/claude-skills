// End-to-end tests for format-with-prettier.js: a real transcript on stdin, a real
// `npx prettier` run, real files on disk.
//
// Two constraints dictate the sandbox location, and both are easy to get wrong in a
// way that makes these tests pass for the wrong reason:
//
//  1. NOT os.tmpdir(). On macOS that is /var/folders/..., which the hook's own isTemp()
//     skip list drops. A sandbox rooted there is never formatted and every assertion
//     below would be asserting the skip, not the feature. So the sandbox lives under
//     test/ instead (see .gitignore).
//  2. Each sandbox gets its own .git. That bounds the hook's upward walk inside the
//     sandbox, so the run root is the sandbox — not this repo, whose config files and
//     .gitignore would otherwise leak into the result.
//
// These tests shell out to `npx --yes prettier`, so the first run on a cold npx cache
// fetches prettier from the registry.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runHook, stopInput, turnEditing } = require('./helpers/transcript');

let counter = 0;

/**
 * A sandbox repo with `files` ({ relative path: contents }) written into it, removed
 * when the test ends.
 */
function sandbox(t, files) {
  const dir = path.join(__dirname, `tmp-sandbox-${process.pid}-${counter++}`);

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });

  const paths = {};
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    paths[rel] = abs;
  }

  return { dir, paths };
}

/**
 * Installs a stub prettier into `dir` that prints `stdout` and formats nothing.
 * Mirrors npm's real layout (package manifest + .bin symlink), which is what makes
 * `npx` prefer it over the cache — the same preference a project with a pinned
 * prettier relies on.
 */
function stubLocalPrettier(dir, stdout) {
  const pkgDir = path.join(dir, 'node_modules', 'prettier');

  fs.mkdirSync(pkgDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    '{ "name": "proj", "version": "1.0.0", "devDependencies": { "prettier": "^3.0.0" } }\n',
  );
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    '{ "name": "prettier", "version": "3.9.6", "bin": { "prettier": "bin.js" } }\n',
  );
  fs.writeFileSync(
    path.join(pkgDir, 'bin.js'),
    '#!/usr/bin/env node\nprocess.stdout.write(' + JSON.stringify(stdout) + ')\n',
    { mode: 0o755 },
  );
  fs.symlinkSync(path.join('..', 'prettier', 'bin.js'), path.join(dir, 'node_modules', '.bin', 'prettier'));
}

/** Runs the hook on a turn that edited every file in `paths`. */
function formatTurn(paths) {
  return runHook('format-with-prettier.js', stopInput(turnEditing(Object.values(paths))));
}

// The headline change: no .prettierrc, no prettier dependency, nothing opted in.
// Before, every one of these files was skipped; now the supported ones get formatted
// and only the deliberate exclusions stay untouched.
test('formats changed files in a project that never opted into prettier', t => {
  const cases = [
    {
      name: 'js under src/',
      rel: 'src/a.js',
      input: 'const a =1\n',
      expected: 'const a = 1;\n',
    },
    {
      name: 'json',
      rel: 'src/data.json',
      input: '{"b":  2}\n',
      expected: '{ "b": 2 }\n',
    },
    {
      name: 'claude infra is still excluded',
      rel: '.claude/hooks/local.js',
      input: 'const c =3\n',
      expected: 'const c =3\n',
    },
    {
      name: 'extension prettier does not support',
      rel: 'src/main.go',
      input: 'package  main\n',
      expected: 'package  main\n',
    },
  ];

  const { paths } = sandbox(t, Object.fromEntries(cases.map(c => [c.rel, c.input])));

  const r = formatTurn(paths);

  assert.strictEqual(r.status, 0, r.stderr);

  for (const c of cases) {
    assert.strictEqual(fs.readFileSync(paths[c.rel], 'utf8'), c.expected, c.name);
  }

  const changedCount = cases.filter(c => c.input !== c.expected).length;
  assert.match(r.parsed?.systemMessage || '', new RegExp(`formatted ${changedCount} files`));
});

// The config is no longer a gate, but it must still be obeyed where it exists —
// a widening that quietly replaced project settings with prettier's defaults would
// be a regression for every project the hook already handled.
test('still honors a project prettier config', t => {
  const { paths } = sandbox(t, {
    '.prettierrc': '{ "semi": false }\n',
    'a.js': 'const a =1\n',
  });

  const r = formatTurn({ 'a.js': paths['a.js'] });

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(paths['a.js'], 'utf8'), 'const a = 1\n');
});

test('no-ops when the turn changed nothing prettier can format', t => {
  const { paths } = sandbox(t, { 'main.go': 'package  main\n' });

  const r = formatTurn(paths);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '', 'a turn with nothing to format must stay silent');
});

// Everything above resolves prettier from the npx cache. A project with prettier
// installed goes through a different binary whose stdout the hook has to parse just
// as carefully — and a project-local prettier is the case that already worked before
// the widening, so a miscount here would be a regression, not a new rough edge.
test('counts only rewritten files in a project-local prettier run', t => {
  const { dir, paths } = sandbox(t, { 'a.js': 'const a =1\n', 'b.js': 'const b = 2;\n' });

  stubLocalPrettier(
    dir,
    // npm's own preamble, prettier's two per-file lines, and a stray warning.
    '\n> prettier@3.9.6 npx\n> prettier -u --write a.js b.js\n\n' +
      'a.js 12ms\n' +
      'b.js 3ms (unchanged)\n' +
      '[warn] something unexpected\n',
  );

  const r = formatTurn(paths);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.parsed?.systemMessage || '', /^prettier formatted 1 file$/);
});

// The one behavior separating "a config picks the run directory" from a plain walk to
// the repo root: a package declaring its own prettier must run from that package, so
// the prettier it pins is the one that executes. The stub formats nothing, so
// untouched content is the proof it ran and the npx cache did not.
test('runs from a package config root, not the repo root above it', t => {
  const { dir, paths } = sandbox(t, { 'pkg/a.js': 'const a =1\n' });

  stubLocalPrettier(path.join(dir, 'pkg'), 'a.js 12ms\n');

  const r = formatTurn(paths);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(
    fs.readFileSync(paths['pkg/a.js'], 'utf8'),
    'const a =1\n',
    "the package's own prettier never ran — the run root walked past it to the repo root",
  );
  assert.match(r.parsed?.systemMessage || '', /^prettier formatted 1 file$/);
});

// Now that every project is in scope, most turns hand prettier files it has nothing
// to do to. Reporting those would put a banner on nearly every turn.
test('stays silent when every changed file was already formatted', t => {
  const { paths } = sandbox(t, { 'a.js': 'const a = 1;\n' });

  const r = formatTurn(paths);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(paths['a.js'], 'utf8'), 'const a = 1;\n');
  assert.strictEqual(r.stdout, '', 'an already-formatted file must not be reported');
});
