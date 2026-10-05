// Claude Code substitutes `$0`, `$1`, ... in a SKILL.md with the invocation's
// arguments before the model reads it. A literal `$0` in an awk snippet was
// silently replaced with a file path, corrupting the command; awk's `$(0)` form
// is equivalent and is not substituted.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SKILLS = path.join(__dirname, "..", "plugins", "claude-skills", "skills");

const POSITIONAL_ARG = /\$\d/;

const skillFiles = fs
  .readdirSync(SKILLS)
  .map((dir) => path.join(SKILLS, dir, "SKILL.md"))
  .filter((file) => fs.existsSync(file));

test("no SKILL.md contains a positional-argument token like $0", () => {
  const offenders = [];

  for (const file of skillFiles) {
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (POSITIONAL_ARG.test(line)) {
          offenders.push(path.relative(SKILLS, file) + ":" + (i + 1) + ": " + line.trim());
        }
      });
  }

  assert.deepStrictEqual(
    offenders,
    [],
    "use $(N) instead of $N so argument substitution leaves it alone",
  );
});
