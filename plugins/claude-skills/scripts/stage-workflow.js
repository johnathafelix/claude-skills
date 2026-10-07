#!/usr/bin/env node
/**
 * Stages code-review and the language/test check skills for the
 * Workflow tool, with each guideline's proof-of-read anchors injected: its
 * absolute path, line count (newlines, as `wc -l` counts them), first line and
 * last non-empty line. Computing them here means the orchestrating model never
 * transcribes them by hand — a long markdown last line copied into args by hand
 * used to drift by a character and fail the gate.
 *
 * Usage: node stage-workflow.js <guidelines dir, or - for code-review> <workflow.js> <scratchpad output path>
 * Prints one `stem<TAB>path<TAB>first line` row per staged guideline.
 */

const fs = require("fs");
const path = require("path");

const MARKER = "const GUIDELINE_META = null";

function guidelineMeta(dir) {
  const meta = {};

  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();

  for (const name of names) {
    const file = path.join(dir, name);
    const rows = fs.readFileSync(file, "utf8").split("\n");

    meta[path.basename(name, ".md")] = {
      path: file,
      lines: rows.length - 1,
      title: rows[0],
      lastLine: rows.filter((row) => row.trim()).pop() || "",
    };
  }

  return meta;
}

function stage(guidelinesDir, workflowFile, outFile) {
  const source = fs.readFileSync(workflowFile, "utf8");
  const isReview = guidelinesDir === null || guidelinesDir === '-';
  if (source.split(MARKER).length !== (isReview ? 1 : 2)) {
    throw new Error(`${workflowFile}: expected ${isReview ? 'no' : 'exactly one'} "${MARKER}" line`);
  }
  const meta = isReview ? {} : guidelineMeta(path.resolve(guidelinesDir));
  if (!isReview && Object.keys(meta).length === 0) {
    throw new Error(`${guidelinesDir}: no guideline .md files found`);
  }

  // A replacer function, so `$&` or `$'` inside a guideline line is not
  // expanded as a replacement pattern.
  let staged = isReview ? source : source.replace(MARKER, () => `const GUIDELINE_META = ${JSON.stringify(meta)}`);
  const runtimeMarker = "// GROUPED_CHECK_RUNTIME";
  if (staged.includes(runtimeMarker)) {
    if (staged.split(runtimeMarker).length !== 2) throw new Error("Expected exactly one grouped runtime marker");
    const runtime = fs.readFileSync(path.join(__dirname, "grouped-check-runtime.js"), "utf8");
    staged = staged.replace(runtimeMarker, () => runtime);
  }
  const inputsMarker = '// REVIEW_INPUT_RUNTIME';
  if (staged.includes(inputsMarker) || isReview) {
    if (staged.split(inputsMarker).length !== 2) throw new Error('Expected exactly one review input runtime marker');
    const inputs = fs.readFileSync(path.join(__dirname, 'workflow-inputs.js'), 'utf8');
    staged = staged.replace(inputsMarker, () => inputs);
  }

  fs.writeFileSync(outFile, staged);

  return meta;
}

if (require.main === module) {
  const [guidelinesDir, workflowFile, outFile] = process.argv.slice(2);

  if (!outFile) {
    console.error("usage: node stage-workflow.js <guidelines dir, or - for code-review> <workflow.js> <scratchpad output path>");
    process.exit(2);
  }

  try {
    const meta = stage(guidelinesDir, workflowFile, outFile);

    for (const [stem, { path: file, title }] of Object.entries(meta)) console.log(`${stem}\t${file}\t${title}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { guidelineMeta, stage };
