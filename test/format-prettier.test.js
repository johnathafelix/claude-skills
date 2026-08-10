// End-to-end tests for format-prettier.cjs: real files on disk, a real
// `npx prettier` run (except where a stub is installed).
//
// Two constraints dictate the sandbox location, and both are easy to get wrong in a
// way that makes these tests pass for the wrong reason:
//
//  1. NOT os.tmpdir(). On macOS that is /var/folders/..., which the script's own
//     isTemp() skip list drops. A sandbox rooted there is never formatted and every
//     assertion below would be asserting the skip, not the feature. So the sandbox
//     lives under test/ instead (see .gitignore).
//  2. Each sandbox gets its own .git. That bounds the script's upward walk inside the
//     sandbox, so the run root is the sandbox — not this repo, whose config files and
//     .gitignore would otherwise leak into the result.
//
// These tests shell out to `npx --yes prettier`, so the first run on a cold npx cache
// fetches prettier from the registry.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(
  __dirname,
  "..",
  "plugins",
  "claude-skills",
  "skills",
  "format-prettier",
  "format-prettier.cjs",
);

let counter = 0;

/**
 * A sandbox repo with `files` ({ relative path: contents }) written into it, removed
 * when the test ends.
 */
function sandbox(t, files) {
  const dir = path.join(__dirname, `tmp-sandbox-${process.pid}-${counter++}`);

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

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
 * Installs a stub prettier into `dir` that prints `stdout` (and, if `exitCode` is
 * nonzero, exits with it) instead of formatting anything. Mirrors npm's real layout
 * (package manifest + .bin symlink), which is what makes `npx` prefer it over the
 * cache — the same preference a project with a pinned prettier relies on.
 */
function stubLocalPrettier(dir, stdout, exitCode = 0) {
  const pkgDir = path.join(dir, "node_modules", "prettier");

  fs.mkdirSync(pkgDir, { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    '{ "name": "proj", "version": "1.0.0", "devDependencies": { "prettier": "^3.0.0" } }\n',
  );
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    '{ "name": "prettier", "version": "3.9.6", "bin": { "prettier": "bin.js" } }\n',
  );
  fs.writeFileSync(
    path.join(pkgDir, "bin.js"),
    "#!/usr/bin/env node\n" +
      "process.stdout.write(" +
      JSON.stringify(stdout) +
      ")\n" +
      (exitCode ? `process.exit(${exitCode})\n` : ""),
    { mode: 0o755 },
  );
  fs.symlinkSync(
    path.join("..", "prettier", "bin.js"),
    path.join(dir, "node_modules", ".bin", "prettier"),
  );
}

/** Runs the script the way the skill does: `node format-prettier.cjs [--force] <paths>`. */
function run(paths, opts = {}) {
  const args = opts.force ? ["--force", ...paths] : [...paths];
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
  });

  return {
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: r.stderr || "",
  };
}

test("formats a configured project, honoring its config", (t) => {
  const { paths } = sandbox(t, {
    ".prettierrc": '{ "semi": false }\n',
    "a.js": "const a =1\n",
  });

  const r = run([paths["a.js"]]);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(paths["a.js"], "utf8"), "const a = 1\n");
});

// SKILL.md's own scope step lists `git diff --name-only` output, which is
// repo-relative — the .claude/ exclusion has to work on that, not just on the
// absolute paths a transcript-driven hook always got.
test("filters a repo-relative .claude/ path the same as an absolute one", (t) => {
  const { dir } = sandbox(t, {
    ".prettierrc": "{}\n",
    ".claude/hooks/local.js": "const c =3\n",
  });

  const r = run([".claude/hooks/local.js"], { cwd: dir });

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(
    fs.readFileSync(path.join(dir, ".claude/hooks/local.js"), "utf8"),
    "const c =3\n",
  );
  assert.strictEqual(r.stdout, "nothing to format");
});

// A bare .prettierignore (no .prettierrc, no package.json) is enough to count as
// "this project uses prettier" — this repo itself is exactly that shape.
test("a bare .prettierignore counts as declaring prettier", (t) => {
  const { paths } = sandbox(t, {
    ".prettierignore": "dist/\n",
    "a.js": "const a =1\n",
  });

  const r = run([paths["a.js"]]);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(paths["a.js"], "utf8"), "const a = 1;\n");
});

// A file .prettierignore excludes gets no output line from prettier at all — not
// even "(unchanged)". Counting it via `files.length - rewritten` would misreport
// it as "already formatted", which is false: prettier never looked at it.
test("a file excluded by .prettierignore is not counted as already formatted", (t) => {
  const { paths } = sandbox(t, {
    ".prettierignore": "ignored.js\n",
    "ignored.js": "const a =1\n",
  });

  const r = run([paths["ignored.js"]]);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(
    fs.readFileSync(paths["ignored.js"], "utf8"),
    "const a =1\n",
  );
  assert.strictEqual(
    r.stdout,
    "",
    "an ignored file must not be reported as formatted or already-formatted",
  );
});

test("filters .claude/, unsupported extensions, and missing files", (t) => {
  const { dir, paths } = sandbox(t, {
    ".prettierrc": "{}\n",
    ".claude/hooks/local.js": "const c =3\n",
    "src/main.go": "package  main\n",
  });

  const missing = path.join(dir, "src", "gone.js");
  const r = run([
    paths[".claude/hooks/local.js"],
    paths["src/main.go"],
    missing,
  ]);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(
    fs.readFileSync(paths[".claude/hooks/local.js"], "utf8"),
    "const c =3\n",
  );
  assert.strictEqual(
    fs.readFileSync(paths["src/main.go"], "utf8"),
    "package  main\n",
  );
  assert.strictEqual(r.stdout, "nothing to format");
});

// The gate this move exists to add: a repo that never declared prettier must not get
// formatted with its defaults just because the model called this skill unprompted.
test("skips a no-config project by default", (t) => {
  const { paths } = sandbox(t, { "a.js": "const a =1\n" });

  const r = run([paths["a.js"]]);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(paths["a.js"], "utf8"), "const a =1\n");
  assert.match(r.stdout, /no prettier config/);
  assert.match(r.stdout, /--force/);
});

test("--force formats a no-config project with prettier defaults", (t) => {
  const { paths } = sandbox(t, { "a.js": "const a =1\n" });

  const r = run([paths["a.js"]], { force: true });

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(paths["a.js"], "utf8"), "const a = 1;\n");
});

// A project-local prettier is a different binary whose stdout the script has to parse
// just as carefully — and it's the case that already worked before this move, so a
// miscount here would be a regression, not a new rough edge.
test("counts only rewritten files in a project-local prettier run", (t) => {
  const { dir, paths } = sandbox(t, {
    ".prettierrc": "{}\n",
    "a.js": "const a =1\n",
    "b.js": "const b = 2;\n",
  });

  stubLocalPrettier(
    dir,
    // npm's own preamble, prettier's two per-file lines, and a stray warning.
    "\n> prettier@3.9.6 npx\n> prettier -u --write a.js b.js\n\n" +
      "a.js 12ms\n" +
      "b.js 3ms (unchanged)\n" +
      "[warn] something unexpected\n",
  );

  const r = run([paths["a.js"], paths["b.js"]]);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^prettier formatted 1 file/);
  assert.match(r.stdout, /1 file already formatted/);
});

// The one behavior separating "a config picks the run directory" from a plain walk to
// the repo root: a package declaring its own prettier must run from that package, so
// the prettier it pins is the one that executes. The stub formats nothing, so
// untouched content is the proof it ran and the npx cache did not.
test("runs from a package config root, not the repo root above it", (t) => {
  const { dir, paths } = sandbox(t, { "pkg/a.js": "const a =1\n" });

  stubLocalPrettier(path.join(dir, "pkg"), "a.js 12ms\n");

  const r = run([paths["pkg/a.js"]]);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(
    fs.readFileSync(paths["pkg/a.js"], "utf8"),
    "const a =1\n",
    "the package's own prettier never ran — the run root walked past it to the repo root",
  );
  assert.match(r.stdout, /^prettier formatted 1 file/);
});

test("reports already-clean files without formatting anything", (t) => {
  const { paths } = sandbox(t, {
    ".prettierrc": "{}\n",
    "a.js": "const a = 1;\n",
  });

  const r = run([paths["a.js"]]);

  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(paths["a.js"], "utf8"), "const a = 1;\n");
  assert.strictEqual(r.stdout, "1 file already formatted");
});

test("a prettier failure surfaces in the message and the exit code", (t) => {
  const { dir, paths } = sandbox(t, { "a.js": "const a =1\n" });

  stubLocalPrettier(dir, "something exploded\n", 2);

  const r = run([paths["a.js"]]);

  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /prettier failed for/);
});
