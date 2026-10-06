// Locks the subject-case rule of the commit guard: lowercase prose, while
// identifiers (acronyms, env vars, tickets, camelCase, code spans) keep their caps.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const path = require("path");

const GUARD = path.join(
  __dirname,
  "..",
  "plugins",
  "claude-skills",
  "hooks",
  "git-commit-guard.js",
);

function runGuard(subject) {
  const command = `CC_GIT_SKILL=1 git commit -m "${subject}"`;
  const result = spawnSync("node", [GUARD], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
  });

  assert.strictEqual(result.status, 0, result.stderr);

  return result.stdout;
}

const cases = [
  { subject: "feat(review-pr): configurable default effort via env var", allowed: true },
  { subject: "feat(review-pr): configurable default effort via REVIEW_PR_EFFORT", allowed: true },
  { subject: "fix(api): handle API and HTTP timeouts in JSON client", allowed: true },
  { subject: "fix: retry failed APIs", allowed: true },
  { subject: "fix: ENG-123 null pointer on checkout", allowed: true },
  { subject: "refactor(auth): extract getUserToken helper", allowed: true },
  { subject: "refactor: rename GetPortfolio and XMLParser", allowed: true },
  { subject: "docs: explain `Config.Load` behavior", allowed: true },
  { subject: "feat: Add configurable effort", allowed: false },
  { subject: "fix: handle Configurable values", allowed: false },
  { subject: "fix: add A record", allowed: false },
  { subject: "Feat: add thing", allowed: false },
];

for (const { subject, allowed } of cases) {
  test(`${allowed ? "allows" : "denies"}: ${subject}`, () => {
    const out = runGuard(subject);

    if (allowed) {
      assert.strictEqual(out, "");
    } else {
      assert.match(out, /"permissionDecision":"deny"/);
    }
  });
}
