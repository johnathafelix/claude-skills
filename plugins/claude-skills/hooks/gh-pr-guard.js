#!/usr/bin/env node
/**
 * PreToolUse:Bash guard — blocks AI/Claude attribution from leaking into a PR
 * title or body, whether created via the draft-pr / update-pr-description skills
 * or by a direct `gh pr create` / `gh pr edit`.
 *
 * Fires only on `gh pr create` / `gh pr edit`. Extracts --title/-t and --body/-b
 * (quoted or heredoc) and denies if any forbidden attribution is present.
 * PR titles are prose, so there is NO conventional-type or lowercase check here.
 * --body-file / editor / unparseable -> allow (never breaks the flow).
 */

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

function deny(reasons) {
  const reason =
    "pr title/body contains AI attribution (skills forbid this):\n- " +
    reasons.join("\n- ") +
    "\n\nremove the attribution and run the command again.";
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

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return allow();
  }

  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== "string" || !/\bgh\s+pr\s+(create|edit)\b/.test(cmd)) return allow();

  const text = [flagValue(cmd, "title", "t"), flagValue(cmd, "body", "b")].join("\n");
  if (text.trim() === "") return allow();

  const reasons = FORBIDDEN.filter(({ re }) => re.test(text)).map(({ msg }) => msg);

  if (reasons.length > 0) return deny(reasons);

  return allow();
}

main();
