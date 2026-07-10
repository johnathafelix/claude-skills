#!/usr/bin/env node
/**
 * PreToolUse:Bash guard — enforces the /git-commit skill's hard rules on every
 * `git commit` and routes direct commits to the skill.
 *
 * Flow:
 *   1. Commands with no parseable -m (editor/rebase/merge commits) -> allow.
 *   2. Commands without CC_GIT_SKILL=1 marker AND without --amend -> denyRedirect
 *      (forces the model to invoke the /git-commit skill).
 *   3. Marker'd commits and --amend commits -> validate message:
 *        - subject matches conventional `type(scope)?!: summary`
 *        - subject <= 72 chars
 *        - subject lowercase (body may carry caps for code identifiers)
 *        - no co-author / claude / AI-generated / 🤖 attribution lines
 *      On violation -> deny with reasons. On pass -> allow.
 *
 * The CC_GIT_SKILL=1 marker is emitted by the /git-commit skill as an inline
 * env-var prefix on the commit command so this guard can distinguish skill
 * commits (validate) from direct model commits (redirect).
 */

const SKILL_MARKER = "CC_GIT_SKILL=1";

const TYPES = "feat|fix|refactor|chore|docs|test|style|perf|ci|build|revert";
const SUBJECT_RE = new RegExp(`^(${TYPES})(\\([^)]+\\))?!?: .+`);
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

function denyRedirect() {
  const reason =
    "commit blocked: route every commit through the /git-commit skill — do not run `git commit` directly.\n\n" +
    "invoke the /git-commit skill now; it analyzes the diff, writes a conventional message, and commits.\n\n" +
    "(if you ARE the /git-commit skill, prefix the commit command with the marker `" + SKILL_MARKER +
    "`, e.g. `" + SKILL_MARKER + " git commit -m \"...\"`, so this guard validates and allows it.)";
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

function deny(reasons) {
  const reason =
    "commit message violates /git-commit conventions:\n- " +
    reasons.join("\n- ") +
    "\n\nfix the message (lowercase, `type: summary`, no attribution) or invoke the /git-commit skill, then commit again.";
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

/** Pull the commit message out of a `git commit` command, or null if none/editor. */
function extractMessage(cmd) {
  // heredoc: git commit -m "$(cat <<'EOF' ... EOF )"
  const here = cmd.match(/<<-?\s*'?(\w+)'?\s*\n([\s\S]*?)\n\s*\1\b/);
  if (here) return here[2];

  // -m / --message with double or single quotes
  const dq = cmd.match(/(?:-m|--message)\s+"((?:[^"\\]|\\.)*)"/);
  if (dq) return dq[1];

  const sq = cmd.match(/(?:-m|--message)\s+'((?:[^'])*)'/);
  if (sq) return sq[1];

  return null; // editor commit or unparseable -> caller allows
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return allow();
  }

  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== "string" || !/\bgit\b(?:\s+\S+)*?\s+commit\b/.test(cmd)) return allow();

  // amend --no-edit keeps the existing (already-validated) message
  if (/--no-edit/.test(cmd)) return allow();

  const msg = extractMessage(cmd);
  if (msg == null || msg.trim() === "") return allow();

  const hasMarker = cmd.includes(SKILL_MARKER);
  const isAmend = /--amend\b/.test(cmd);

  if (!hasMarker && !isAmend) return denyRedirect();

  const lines = msg.split("\n");
  const subject = lines.find((l) => l.trim() !== "") ?? "";
  const reasons = [];

  if (!SUBJECT_RE.test(subject)) {
    reasons.push(
      `subject must be \`type(scope)?: summary\` (type one of ${TYPES.replace(/\|/g, ", ")}); got: "${subject}"`
    );
  }

  if (subject.length > 72) {
    reasons.push(`subject is ${subject.length} chars; keep <= 72`);
  }

  if (/[A-Z]/.test(subject)) {
    reasons.push("subject must be lowercase");
  }

  for (const { re, msg: m } of FORBIDDEN) {
    if (re.test(msg)) reasons.push(m);
  }

  if (reasons.length > 0) return deny(reasons);

  return allow();
}

main();
