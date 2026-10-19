#!/usr/bin/env node
/**
 * PostToolUse:Edit|Write check — catches encoding slips and broken builds right
 * after a file is written, instead of later in tests.
 *
 * Flow:
 *   1. Scan only the text the tool wrote (Edit new_string / Write content):
 *        - invisible or control code points (BOM, zero-width, bidi controls,
 *          NBSP and other odd spaces, braille blank, Hangul fillers, C0/C1
 *          controls) -> block with line, U+XXXX and the escape to write instead.
 *        - other non-ASCII in a source file -> soft note asking to confirm it
 *          was meant literally and not as an escape.
 *   2. .go files are formatted in place with `gofmt -w`.
 *   3. Quick build of the edited file:
 *        - .go -> `go test -count=1 -run '^$' .` in the file's package (compiles
 *          package and _test.go files, runs nothing); skipped without go.mod.
 *        - .py -> syntax-only parse.
 *      A failure -> block with the compiler output.
 *
 * "block" here only feeds the reason back to Claude; the write already happened.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const BUILD_TIMEOUT_MS = 60_000;
const MAX_REPORTED = 10;
const MAX_OUTPUT_LINES = 40;

const SOURCE_EXTS = new Set([
  ".go", ".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".cs", ".php", ".scala",
  ".sh", ".bash", ".zsh", ".sql",
]);

// Invisible code points outside the Cc/Cf/Zs/Zl/Zp categories the regex covers.
const EXTRA_INVISIBLE = new Set([0x034f, 0x115f, 0x1160, 0x2800, 0x3164, 0xffa0]);

const NAMES = {
  0x00a0: "NO-BREAK SPACE",
  0x00ad: "SOFT HYPHEN",
  0x034f: "COMBINING GRAPHEME JOINER",
  0x115f: "HANGUL CHOSEONG FILLER",
  0x1160: "HANGUL JUNGSEONG FILLER",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x2028: "LINE SEPARATOR",
  0x2029: "PARAGRAPH SEPARATOR",
  0x202f: "NARROW NO-BREAK SPACE",
  0x2060: "WORD JOINER",
  0x2800: "BRAILLE PATTERN BLANK",
  0x3000: "IDEOGRAPHIC SPACE",
  0x3164: "HANGUL FILLER",
  0xfeff: "BYTE ORDER MARK / ZERO WIDTH NO-BREAK SPACE",
  0xffa0: "HALFWIDTH HANGUL FILLER",
};

const INVISIBLE_CATEGORY_RE = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/u;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allow() {
  process.exit(0); // no output = nothing to report
}

function hex(cp) {
  return cp.toString(16).toUpperCase().padStart(4, "0");
}

function isInvisible(cp, ch) {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20) return false;

  return EXTRA_INVISIBLE.has(cp) || INVISIBLE_CATEGORY_RE.test(ch);
}

/** Escape text to write in place of the literal code point, e.g. \uFEFF. */
function escapeFor(cp) {
  return cp > 0xffff ? "\\U" + hex(cp).padStart(8, "0") : "\\u" + hex(cp);
}

/** Line in the file where the written text starts, so findings carry file lines. */
function baseLine(filePath, written) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const idx = content.indexOf(written);

    if (idx < 0) return 1;

    return content.slice(0, idx).split("\n").length;
  } catch {
    return 1;
  }
}

function scan(written, firstLine) {
  const invisible = [];
  const nonAscii = [];

  written.split("\n").forEach((line, i) => {
    for (const ch of line) {
      const cp = ch.codePointAt(0);

      if (cp < 0x80 && !isInvisible(cp, ch)) continue;

      const finding = { line: firstLine + i, cp };

      if (isInvisible(cp, ch)) invisible.push(finding);
      else nonAscii.push({ ...finding, ch });
    }
  });

  return { invisible, nonAscii };
}

function formatInvisible(findings) {
  const lines = findings.slice(0, MAX_REPORTED).map(
    ({ line, cp }) =>
      `- line ${line}: U+${hex(cp)}${NAMES[cp] ? " " + NAMES[cp] : ""} (escape: ${escapeFor(cp)})`,
  );

  if (findings.length > MAX_REPORTED) {
    lines.push(`- ...and ${findings.length - MAX_REPORTED} more`);
  }

  return (
    "invisible/control characters were written as literal bytes:\n" +
    lines.join("\n") +
    "\n\nif you meant escape text, the tool argument decoded your backslash escape into the raw character. " +
    "rewrite those spots with the escape (a doubled backslash in the tool argument), or fix in place with perl, e.g. " +
    "`perl -CSD -pi -e 's/\\x{FEFF}/\\\\uFEFF/g' <file>`. " +
    "verify with `LC_ALL=C grep -n '[^ -~[:space:]]' <file>`. if the raw character is intended, say so and move on."
  );
}

function formatNonAscii(findings) {
  const lines = findings.slice(0, MAX_REPORTED).map(
    ({ line, cp, ch }) => `- line ${line}: "${ch}" U+${hex(cp)} (escape: ${escapeFor(cp)})`,
  );

  if (findings.length > MAX_REPORTED) {
    lines.push(`- ...and ${findings.length - MAX_REPORTED} more`);
  }

  return (
    "non-ASCII characters were written into source:\n" +
    lines.join("\n") +
    "\nconfirm each is meant literally; if it was meant as escape text, rewrite it as the escape."
  );
}

function findUp(startDir, name) {
  let dir = startDir;

  while (true) {
    if (fs.existsSync(path.join(dir, name))) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return null;

    dir = parent;
  }
}

function tail(text) {
  const lines = text.trim().split("\n");

  return lines.slice(-MAX_OUTPUT_LINES).join("\n");
}

/** Run a build command; returns failure text, or null on success/skip. */
function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
  });

  if (res.error?.code === "ENOENT") return null; // toolchain not installed

  if (res.error?.code === "ETIMEDOUT" || res.signal) {
    return `\`${cmd} ${args.join(" ")}\` timed out after ${BUILD_TIMEOUT_MS / 1000}s; build it yourself before claiming done.`;
  }

  if (res.status === 0) return null;

  return `\`${cmd} ${args.join(" ")}\` failed in ${cwd}:\n${tail((res.stdout || "") + (res.stderr || ""))}`;
}

function build(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);

  if (ext === ".go") {
    if (/[\\/](testdata|vendor)[\\/]/.test(filePath)) return null;

    if (!findUp(dir, "go.mod")) return null;

    return run("go", ["test", "-count=1", "-run", "^$", "."], dir);
  }

  if (ext === ".py") {
    return run(
      "python3",
      ["-c", "import ast, sys; ast.parse(open(sys.argv[1], 'rb').read(), sys.argv[1])", filePath],
      dir,
    );
  }

  return null;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return allow();
  }

  const input = payload?.tool_input ?? {};
  const filePath = input.file_path;
  if (typeof filePath !== "string" || !fs.existsSync(filePath)) return allow();

  const written = payload.tool_name === "Write" ? input.content : input.new_string;
  const problems = [];
  let note = null;

  if (typeof written === "string" && written !== "") {
    const { invisible, nonAscii } = scan(written, baseLine(filePath, written));

    if (invisible.length > 0) problems.push(formatInvisible(invisible));

    if (nonAscii.length > 0 && SOURCE_EXTS.has(path.extname(filePath))) {
      note = formatNonAscii(nonAscii);
    }
  }

  if (path.extname(filePath) === ".go") {
    // Rewrites only when formatting changes; a syntax error is left to the build.
    spawnSync("gofmt", ["-w", filePath], { timeout: BUILD_TIMEOUT_MS });
  }

  const buildFailure = build(filePath);
  if (buildFailure) {
    problems.push(
      buildFailure +
        "\n\nfix it now (missing/unused imports are the usual cause). " +
        "if you are mid-way through a multi-file change, finish it and recheck the build.",
    );
  }

  if (problems.length > 0) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: `post-edit check on ${filePath}:\n\n` + problems.join("\n\n"),
        ...(note && {
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note },
        }),
      }),
    );

    return process.exit(0);
  }

  if (note) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note },
      }),
    );
  }

  return process.exit(0);
}

main();
