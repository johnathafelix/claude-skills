#!/usr/bin/env node
/**
 * PreToolUse:Bash guard — blocks AI/Claude attribution from leaking into a PR
 * title or body, whether created via the draft-pr / create-pr / update-pr-description skills
 * or by a direct `gh pr create` / `gh pr edit`.
 *
 * Fires only on `gh pr create` / `gh pr edit`. Checks, for forbidden attribution:
 *   - --title/-t and --body/-b (quoted or heredoc)
 *   - --body-file/-F: the referenced file's contents are read and checked
 *   - --body "$(cat FILE)" / "$(< FILE)": the file reference is resolved and read
 * and denies if any forbidden attribution is present. Relative paths resolve
 * against the payload cwd. PR titles are prose, so there is NO conventional-type
 * or lowercase check here.
 *
 * Denies when a body reference can't be checked, since an unchecked body is
 * how attribution leaked before: a path holding a shell expansion
 * (`-F "$B"`), `-F -` (stdin, already consumed for the payload), or a file
 * that can't be read, including one written later in the same command
 * (`printf ... > f.md && gh pr create -F f.md`): hooks run before the
 * command. The fix is to write the file in an earlier command and pass its
 * literal path. Still not resolved (contrived vs. the real vector, left open
 * on purpose): a `$(cat FILE)` in --title (no --title-file exists), variable
 * indirection in --body (`B=$(cat f); --body "$B"`), and non-cat readers
 * (`$(head f)` etc.).
 */

const fs = require("fs");
const path = require("path");

const FORBIDDEN = [
  { re: /co-authored-by/i, msg: "remove co-author line" },
  { re: /generated with .*claude/i, msg: "remove 'generated with claude' line" },
  { re: /claude code/i, msg: "remove 'claude code' attribution" },
  { re: /🤖/, msg: "remove 🤖 emoji" },
];

function readStdin() {
  try {
    return require("fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allow() {
  process.exit(0); // no output = no decision = normal flow
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

/** Pull the value of a flag (--body / -b / --title / -t) from a command, or "". */
function flagValue(cmd, longName, shortName) {
  const flags = `(?:--${longName}|-${shortName})`;

  // heredoc: --body "$(cat <<'EOF' ... EOF )"
  const here = cmd.match(
    new RegExp(`${flags}[ =]\\s*"?\\$\\(cat\\s*<<-?\\s*'?(\\w+)'?\\s*\\n([\\s\\S]*?)\\n\\s*\\1\\b`)
  );
  if (here) return here[2];

  const dq = cmd.match(new RegExp(`${flags}[ =]\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (dq) return dq[1];

  const sq = cmd.match(new RegExp(`${flags}[ =]\\s*'((?:[^'])*)'`));
  if (sq) return sq[1];

  return "";
}

/** Pull the (quoted or bare) file path for --body-file / -F, or "". */
function fileFlagPath(cmd, longName, shortName) {
  const flags = `(?:--${longName}|-${shortName})`;
  const m =
    cmd.match(new RegExp(`${flags}[ =]\\s*"([^"]+)"`)) ||
    cmd.match(new RegExp(`${flags}[ =]\\s*'([^']+)'`)) ||
    cmd.match(new RegExp(`${flags}[ =]\\s*(\\S+)`));

  return m ? m[1] : "";
}

/** If value is a `$(cat FILE)` / `$(< FILE)` substitution, return FILE, else "". */
function substFilePath(value) {
  const m = value.match(/\$\(\s*(?:cat\s+|<\s*)([^)]+?)\s*\)/);

  return m ? m[1] : "";
}

/** Read a body-reference file (resolved against cwd), or null when it can't be checked. */
function readBodyFile(cwd, p) {
  const clean = p.replace(/^['"]|['"]$/g, "");
  if (clean === "" || clean === "-" || clean.includes("$")) return null;

  const resolved = path.isAbsolute(clean) ? clean : path.resolve(cwd || ".", clean);
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return allow();
  }

  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== "string" || !/\bgh\s+pr\s+(create|edit)\b/.test(cmd)) return allow();

  const cwd = payload?.cwd;
  const body = flagValue(cmd, "body", "b");
  const sources = [flagValue(cmd, "title", "t"), body];

  const bodyRefs = [fileFlagPath(cmd, "body-file", "F"), substFilePath(body)].filter(Boolean);

  for (const ref of bodyRefs) {
    const content = readBodyFile(cwd, ref);
    if (content === null) {
      return deny(
        `pr body file \`${ref}\` can't be checked for AI attribution (stdin, a shell ` +
          "expansion, or a file that doesn't exist yet: hooks run before the command).\n\n" +
          "write the body file in an earlier command, then pass its literal path."
      );
    }

    sources.push(content);
  }

  const text = sources.join("\n");
  if (text.trim() === "") return allow();

  const reasons = FORBIDDEN.filter(({ re }) => re.test(text)).map(({ msg }) => msg);

  if (reasons.length > 0) {
    return deny(
      "pr title/body contains AI attribution (skills forbid this):\n- " +
        reasons.join("\n- ") +
        "\n\nremove the attribution and run the command again."
    );
  }

  return allow();
}

main();
