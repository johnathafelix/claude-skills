// Locks the staging of the check skills' workflow.js: proof-of-read anchors are
// computed from the guideline files (never hand-copied), and `lines` matches what
// the checker agent's `wc -l` prints.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PLUGIN = path.join(__dirname, "..", "plugins", "claude-skills");
const SCRIPT = path.join(PLUGIN, "scripts", "stage-workflow.js");
const { guidelineMeta, stage } = require(SCRIPT);

const META_LINE = /^const GUIDELINE_META = (.*)$/m;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stage-workflow-"));
}

function wcLines(file) {
  return Number(spawnSync("wc", ["-l", file], { encoding: "utf8" }).stdout.trim().split(/\s+/)[0]);
}

const anchorCases = [
  {
    name: "trailing newline",
    content: "# Title\nbody\nlast line\n",
    want: { lines: 3, title: "# Title", lastLine: "last line" },
  },
  {
    name: "no trailing newline",
    content: "# Title\nbody\nlast line",
    want: { lines: 2, title: "# Title", lastLine: "last line" },
  },
  {
    name: "trailing blank and whitespace-only lines",
    content: "# Title\nlast line\n\n   \n\t\n",
    want: { lines: 5, title: "# Title", lastLine: "last line" },
  },
  {
    name: "markdown last line with backticks, quotes and $&",
    content: "# T\n**Finding fields:** `{ file, rule: 'x' }` costs $& and $'\n",
    want: { lines: 2, title: "# T", lastLine: "**Finding fields:** `{ file, rule: 'x' }` costs $& and $'" },
  },
  {
    name: "blank first line",
    content: "\n# Title\n",
    want: { lines: 2, title: "", lastLine: "# Title" },
  },
];

for (const { name, content, want } of anchorCases) {
  test(`guidelineMeta: ${name}`, () => {
    const dir = tmpDir();
    const file = path.join(dir, "rule.md");

    fs.writeFileSync(file, content);

    const meta = guidelineMeta(dir);

    assert.deepStrictEqual(meta, { rule: { path: file, ...want } });
    assert.strictEqual(meta.rule.lines, wcLines(file));
  });
}

for (const skill of ["ts-check", "golang-check", "test-check"]) {
  test(`stage: ${skill} injects anchors computed from its guidelines`, () => {
    const skillDir = path.join(PLUGIN, "skills", skill);
    const guidelines = path.join(skillDir, "guidelines");
    const out = path.join(tmpDir(), "workflow.js");

    const result = spawnSync("node", [SCRIPT, guidelines, path.join(skillDir, "workflow.js"), out], {
      encoding: "utf8",
    });

    assert.strictEqual(result.status, 0, result.stderr);

    const staged = fs.readFileSync(out, "utf8");
    const injected = JSON.parse(staged.match(META_LINE)[1]);

    assert.deepStrictEqual(injected, guidelineMeta(guidelines));
    assert.ok(staged.startsWith("export const meta"), "meta must stay the script's first statement");

    for (const [stem, { path: file, lines, title }] of Object.entries(injected)) {
      assert.strictEqual(lines, wcLines(file), `${stem} line count`);
      assert.ok(result.stdout.includes(`${stem}\t${file}\t${title}\n`), `${stem} printed`);
    }
  });
}

test("stage: preserves $& and $' in anchors", () => {
  const dir = tmpDir();
  const workflow = path.join(dir, "workflow.js");
  const out = path.join(dir, "out.js");

  fs.writeFileSync(path.join(dir, "rule.md"), "# T\nprice $& and $'\n");
  fs.writeFileSync(workflow, "const GUIDELINE_META = null\n");

  stage(dir, workflow, out);

  const injected = JSON.parse(fs.readFileSync(out, "utf8").match(META_LINE)[1]);

  assert.strictEqual(injected.rule.lastLine, "price $& and $'");
});

const failureCases = [
  { name: "no marker", workflow: "const x = 1\n", guideline: "# T\n", error: /expected exactly one/ },
  {
    name: "two markers",
    workflow: "const GUIDELINE_META = null\nconst GUIDELINE_META = null\n",
    guideline: "# T\n",
    error: /expected exactly one/,
  },
  { name: "no guidelines", workflow: "const GUIDELINE_META = null\n", guideline: null, error: /no guideline/ },
];

for (const { name, workflow, guideline, error } of failureCases) {
  test(`stage fails: ${name}`, () => {
    const dir = tmpDir();
    const workflowFile = path.join(dir, "workflow.js");

    fs.writeFileSync(workflowFile, workflow);

    if (guideline) fs.writeFileSync(path.join(dir, "rule.md"), guideline);

    assert.throws(() => stage(dir, workflowFile, path.join(dir, "out.js")), error);
  });
}
