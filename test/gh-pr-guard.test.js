// Locks the PR guard: attribution in a title, body or body file is denied, and so
// is a body file the guard can't read, since an unchecked body is how it leaked.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const GUARD = path.join(__dirname, "..", "plugins", "claude-skills", "hooks", "gh-pr-guard.js");

const ATTRIBUTION = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-pr-guard-"));

fs.writeFileSync(path.join(dir, "clean.md"), "## Change\n\nFixes the thing.\n");

fs.writeFileSync(path.join(dir, "attributed.md"), `## Change\n\n${ATTRIBUTION}\n`);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function runGuard(command) {
  const result = spawnSync("node", [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd: dir }),
    encoding: "utf8",
  });

  assert.strictEqual(result.status, 0, result.stderr);

  return result.stdout;
}

const cases = [
  { name: "a clean body file", command: "gh pr create --fill --body-file clean.md", allowed: true },
  { name: "a clean absolute body file", command: `gh pr edit 12 -F ${path.join(dir, "clean.md")}`, allowed: true },
  { name: "a clean $(cat FILE) body", command: 'gh pr create --body "$(cat clean.md)"', allowed: true },
  { name: "an empty body", command: 'gh pr create --fill --body ""', allowed: true },
  { name: "a non-PR gh command", command: "gh pr view --json url -F missing.md", allowed: true },
  { name: "attribution in --body", command: `gh pr create --body "${ATTRIBUTION}"`, allowed: false },
  { name: "attribution in a body file", command: "gh pr create --body-file attributed.md", allowed: false },
  { name: "a body file path held in a variable", command: 'B=attributed.md; gh pr create --body-file "$B"', allowed: false },
  { name: "a bare variable body file path", command: "gh pr create --fill --body-file $B --base main", allowed: false },
  { name: "a body file written in the same command", command: "cat > new.md <<'EOF'\nhi\nEOF\ngh pr create -F new.md", allowed: false },
  { name: "a body read from stdin", command: "printf hi | gh pr create -F -", allowed: false },
  { name: "a $(cat FILE) body that doesn't exist", command: 'gh pr create --body "$(cat missing.md)"', allowed: false },
];

for (const { name, command, allowed } of cases) {
  test(`${allowed ? "allows" : "denies"}: ${name}`, () => {
    const out = runGuard(command);

    if (allowed) {
      assert.strictEqual(out, "");
    } else {
      assert.match(out, /"permissionDecision":"deny"/);
    }
  });
}

test("an unreadable body file says how to fix it", () => {
  const out = runGuard("gh pr create --body-file $B");

  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /earlier command.*literal path/);
});
