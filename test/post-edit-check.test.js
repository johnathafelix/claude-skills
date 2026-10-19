// Locks the post-edit check: literal invisible characters and broken Go builds
// are fed back to Claude, while clean edits stay silent. Characters are built from
// code points so this file itself stays ASCII.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK = path.join(
  __dirname,
  "..",
  "plugins",
  "claude-skills",
  "hooks",
  "post-edit-check.js",
);

const BOM = String.fromCodePoint(0xfeff);
const BRAILLE_BLANK = String.fromCodePoint(0x2800);
const NBSP = String.fromCodePoint(0xa0);
const E_ACUTE = String.fromCodePoint(0xe9);

const HAS_GO = spawnSync("go", ["version"]).status === 0;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-check-"));
}

function runHook(toolName, filePath, written) {
  const toolInput =
    toolName === "Write"
      ? { file_path: filePath, content: written }
      : { file_path: filePath, old_string: "x", new_string: written };

  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
  });

  assert.strictEqual(result.status, 0, result.stderr);

  return result.stdout === "" ? null : JSON.parse(result.stdout);
}

function writeAndRun(name, content) {
  const file = path.join(tmpDir(), name);
  fs.writeFileSync(file, content);

  return runHook("Write", file, content);
}

test("blocks a literal BOM and names the escape to write", () => {
  const out = writeAndRun("a.txt", 'const bom = "' + BOM + '"\n');

  assert.strictEqual(out.decision, "block");
  assert.match(out.reason, /line 1: U\+FEFF BYTE ORDER MARK/);
  assert.match(out.reason, /escape: \\uFEFF/);
});

test("blocks braille blank and NBSP with file line numbers on Edit", () => {
  const file = path.join(tmpDir(), "b.txt");
  const written = "a" + BRAILLE_BLANK + "\nb" + NBSP;
  fs.writeFileSync(file, "header\n" + written + "\n");

  const out = runHook("Edit", file, written);

  assert.strictEqual(out.decision, "block");
  assert.match(out.reason, /line 2: U\+2800 BRAILLE PATTERN BLANK/);
  assert.match(out.reason, /line 3: U\+00A0 NO-BREAK SPACE/);
});

test("notes visible non-ASCII in source without blocking", () => {
  const out = writeAndRun("c.py", 'name = "caf' + E_ACUTE + '"\n');

  assert.strictEqual(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /U\+00E9/);
});

test("ignores visible non-ASCII outside source files", () => {
  assert.strictEqual(writeAndRun("d.md", "caf" + E_ACUTE + "\n"), null);
});

test("stays silent on a clean edit", () => {
  assert.strictEqual(writeAndRun("e.py", "x = 1\n"), null);
});

test("blocks a Python syntax error", () => {
  const out = writeAndRun("f.py", "def broken(:\n");

  assert.strictEqual(out.decision, "block");
  assert.match(out.reason, /SyntaxError/);
});

test("blocks a Go test file with a missing import", { skip: !HAS_GO }, () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/m\n\ngo 1.21\n");
  fs.writeFileSync(path.join(dir, "m.go"), "package m\n");

  const testFile = path.join(dir, "m_test.go");
  const content =
    'package m\n\nimport "testing"\n\nfunc TestX(t *testing.T) {\n\t_ = strconv.Itoa(1)\n}\n';
  fs.writeFileSync(testFile, content);

  const out = runHook("Write", testFile, content);

  assert.strictEqual(out.decision, "block");
  assert.match(out.reason, /undefined: strconv/);
});

test("formats an edited Go file with gofmt", { skip: !HAS_GO }, () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/m\n\ngo 1.21\n");

  const file = path.join(dir, "m.go");
  const content = "package m\n\nvar   X =   1\n";
  fs.writeFileSync(file, content);

  assert.strictEqual(runHook("Write", file, content), null);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "package m\n\nvar X = 1\n");
});

test("passes a Go package that compiles", { skip: !HAS_GO }, () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/m\n\ngo 1.21\n");

  const file = path.join(dir, "m.go");
  const content = 'package m\n\nimport "strconv"\n\nvar S = strconv.Itoa(1)\n';
  fs.writeFileSync(file, content);

  assert.strictEqual(runHook("Write", file, content), null);
});
