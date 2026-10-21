#!/usr/bin/env node
/**
 * PreToolUse guard for prod-monitor sessions: production stays read-only.
 *
 * Active only when PROD_MONITOR_GUARD=1 is in the environment, which the
 * prod-monitor loop sets for every headless session it starts (set it in your
 * own shell to get the same protection in an interactive session). Inactive, it
 * allows everything, so ordinary sessions are not affected.
 *
 * Datadog MCP tools (the datadog plugin's server or the claude.ai connector): only
 * read-only tools are allowed, by name (search_*, get_*, list_*, aggregate_*,
 * analyze_*, load_*, ask_*, execute_code and the authentication handshake);
 * anything that creates, updates, mutes or deletes is denied.
 *
 * Bash: every segment of the command (split on ; && || | newlines and command
 * substitutions) is checked by the program it runs:
 *   kubectl    allowed only for read-only subcommands (get, describe, logs, top,
 *              events, explain, diff, wait, api-*, version, cluster-info, config
 *              view/current-context/get-*, rollout status/history, auth can-i)
 *   gcloud     allowed only when the command verb is read-only (list, describe,
 *              read, tail, get*, print-*-token, version, info, help); anything
 *              else, including config set and auth login, is denied
 *   gsutil     ls, cat, stat, du, hash, version only
 *   helm       list, get, status, history, show, template, search, version, env,
 *              lint, repo list only
 *   terraform / tofu / pulumi   apply, destroy, import, taint, state, workspace,
 *              up, refresh denied
 *   git        destructive forms denied: push --force/-f/--force-with-lease/
 *              --delete/-d/+ref, reset --hard/--merge, clean -f/-d/-x,
 *              checkout -- / . / -f, restore (except --staged only), stash
 *              drop/clear, branch -D/-d/--delete, rebase, commit --amend,
 *              filter-branch, tag -d, update-ref -d, worktree remove --force
 *
 * Edit/Write/MultiEdit/NotebookEdit: the target file must sit under one of the
 * roots in PROD_MONITOR_WRITABLE (os.pathsep-separated); with the variable empty
 * every write is denied. Relative paths resolve against the payload cwd.
 */

const path = require("path");

const KUBECTL_READ = new Set([
  "get", "describe", "logs", "top", "explain", "api-resources", "api-versions", "version",
  "cluster-info", "events", "diff", "wait", "options", "completion",
]);
const KUBECTL_READ_SUB = {
  config: new Set(["view", "current-context", "get-contexts", "get-clusters", "get-users"]),
  rollout: new Set(["status", "history"]),
  auth: new Set(["can-i", "whoami"]),
  plugin: new Set(["list"]),
};
const KUBECTL_VALUE_FLAGS = new Set([
  "-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server",
  "-l", "--selector", "-o", "--output", "--as", "--as-group", "--token", "--request-timeout",
  "--field-selector", "--sort-by", "--template", "-c", "--container", "--since", "--tail",
]);
const GCLOUD_READ = new Set([
  "list", "describe", "read", "tail", "get", "get-value", "get-credentials", "get-iam-policy",
  "print-access-token", "print-identity-token", "version", "info", "help",
]);
const GSUTIL_READ = new Set(["ls", "cat", "stat", "du", "hash", "version"]);
const HELM_READ = new Set(["list", "ls", "get", "status", "history", "show", "template", "search", "version", "env", "lint"]);
const IAC_DENY = new Set(["apply", "destroy", "import", "taint", "untaint", "state", "workspace", "up", "refresh"]);
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "command", "exec", "xargs", "nice"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function readStdin() {
  try {
    return require("fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "prod-monitor guard: " + reason,
      },
    })
  );
  process.exit(0);
}

/** Split a shell command into the simple commands it runs. */
function segments(cmd) {
  return cmd
    .split(/\n|;|&&|\|\||\||\$\(|`|\(/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tokenize one simple command, honouring quotes; quoted tokens are marked. */
function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quoted = false;
  let quote = "";
  let has = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"' && i + 1 < segment.length) current += segment[++i];
      else current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      has = true;
    } else if (ch === "\\" && i + 1 < segment.length) {
      current += segment[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) tokens.push({ text: current, quoted });
      current = "";
      quoted = false;
      has = false;
    } else {
      current += ch;
      has = true;
    }
  }

  if (has) tokens.push({ text: current, quoted });

  return tokens;
}

/** Drop wrappers and VAR=value prefixes; return [program, args...] texts. */
function program(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i].text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !tokens[i].quoted) i++;
    else if (WRAPPERS.has(path.basename(t))) i++;
    else break;
  }

  return tokens.slice(i).map((t) => ({ ...t, text: t.text }));
}

/** Non-flag arguments; value-taking flags swallow their next token. */
function positionals(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === "--") {
      out.push(...args.slice(i + 1));
      break;
    }

    if (t.startsWith("-")) {
      if (valueFlags.has(t) && !t.includes("=")) i++;
      continue;
    }

    out.push(args[i]);
  }

  return out;
}

function checkKubectl(args) {
  const [sub, subsub] = positionals(args, KUBECTL_VALUE_FLAGS).map((t) => t.text);
  if (!sub) return "";
  if (KUBECTL_READ.has(sub)) return "";
  if (KUBECTL_READ_SUB[sub] && subsub && KUBECTL_READ_SUB[sub].has(subsub)) return "";

  return `\`kubectl ${sub}${subsub ? " " + subsub : ""}\` is not allowed: production is read-only here. Use get, describe, logs, top or events.`;
}

function checkGcloud(args) {
  for (const t of positionals(args, new Set())) {
    if (t.quoted) break;
    if (t.text === "alpha" || t.text === "beta") continue;
    if (GCLOUD_READ.has(t.text)) return "";
    if (!/^[a-z][a-z0-9-]*$/.test(t.text)) break;
  }

  return "only read-only gcloud commands are allowed (list, describe, logging read, get-credentials, ...).";
}

function firstVerb(args, valueFlags = new Set()) {
  const first = positionals(args, valueFlags)[0];

  return first ? first.text : "";
}

function checkGsutil(args) {
  const verb = firstVerb(args);

  return !verb || GSUTIL_READ.has(verb) ? "" : `\`gsutil ${verb}\` is not allowed: buckets are read-only here.`;
}

function checkHelm(args) {
  const verb = firstVerb(args);
  if (!verb || HELM_READ.has(verb)) return "";

  return `\`helm ${verb}\` is not allowed: releases are read-only here.`;
}

function checkIac(name, args) {
  const verb = firstVerb(args);

  return IAC_DENY.has(verb) ? `\`${name} ${verb}\` is not allowed: infrastructure is read-only here.` : "";
}

function checkGit(args) {
  const parts = positionals(args, GIT_VALUE_FLAGS);
  const flags = new Set(args.map((t) => t.text).filter((t) => t.startsWith("-")));
  const [sub, ...rest] = parts.map((t) => t.text);
  const has = (...names) => names.some((n) => flags.has(n));

  switch (sub) {
    case "push":
      if (has("--force", "-f", "--force-with-lease", "--delete", "-d") || rest.some((r) => r.startsWith("+")))
        return "git push with --force, --force-with-lease, --delete or a +refspec is not allowed.";
      return "";
    case "reset":
      return has("--hard", "--merge") ? "git reset --hard/--merge discards work and is not allowed." : "";
    case "clean":
      return has("-n", "--dry-run") ? "" : "git clean is not allowed (only a dry run with -n).";
    case "checkout":
      return has("--", "-f", "--force") || rest.includes(".") || args.some((t) => t.text === "--")
        ? "git checkout that discards working-tree changes is not allowed."
        : "";
    case "restore":
      return has("--staged") && !has("--worktree", "-W") ? "" : "git restore discards working-tree changes and is not allowed.";
    case "stash":
      return ["drop", "clear"].includes(rest[0]) ? "git stash drop/clear is not allowed." : "";
    case "branch":
      return has("-D", "-d", "--delete") ? "deleting branches is not allowed." : "";
    case "rebase":
      return "git rebase rewrites history and is not allowed.";
    case "commit":
      return has("--amend") ? "git commit --amend rewrites history and is not allowed." : "";
    case "filter-branch":
    case "filter-repo":
      return `git ${sub} is not allowed.`;
    case "tag":
      return has("-d", "--delete") ? "deleting tags is not allowed." : "";
    case "update-ref":
      return has("-d") ? "git update-ref -d is not allowed." : "";
    case "worktree":
      return rest[0] === "remove" && has("--force", "-f") ? "git worktree remove --force is not allowed." : "";
    default:
      return "";
  }
}

function checkSegment(segment) {
  const tokens = program(tokenize(segment));
  if (!tokens.length) return "";

  const name = path.basename(tokens[0].text);
  const args = tokens.slice(1);
  switch (name) {
    case "kubectl":
      return checkKubectl(args);
    case "gcloud":
      return checkGcloud(args);
    case "gsutil":
      return checkGsutil(args);
    case "helm":
      return checkHelm(args);
    case "terraform":
    case "tofu":
    case "pulumi":
      return checkIac(name, args);
    case "git":
      return checkGit(args);
    case "bash":
    case "sh":
    case "zsh":
    case "dash":
      return checkShellScript(args);
    case "eval":
      return checkCommand(args.map((t) => t.text).join(" "));
    default:
      return "";
  }
}

/** `bash -c "<script>"`: the script is checked like a top-level command. */
function checkShellScript(args) {
  const index = args.findIndex((t) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t.text));
  if (index < 0 || index + 1 >= args.length) return "";

  return checkCommand(args[index + 1].text);
}

function checkCommand(cmd) {
  for (const segment of segments(cmd)) {
    const reason = checkSegment(segment);
    if (reason) return reason;
  }

  return "";
}

function checkWrite(target, cwd, writable) {
  if (typeof target !== "string" || !target) return "";

  const resolved = path.resolve(cwd || ".", target);
  const roots = (writable || "").split(path.delimiter).filter(Boolean).map((r) => path.resolve(r));
  const inside = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));

  return inside ? "" : `writing ${resolved} is not allowed: this session may only write under ${roots.join(", ") || "(nothing)"}.`;
}

const DATADOG_SERVERS = /^mcp__(plugin_datadog_mcp|claude_ai_Datadog)__(.+)$/;
const DATADOG_READ_ONLY = /^(search_|get_|list_|aggregate_|analyze_|load_|ask_|execute_code$|authenticate$|complete_authentication$)/;

function checkMcp(tool) {
  const match = typeof tool === "string" ? tool.match(DATADOG_SERVERS) : null;
  if (!match) return "";

  return DATADOG_READ_ONLY.test(match[2]) ? "" : `${tool} is not allowed: this session may only read from Datadog (search, get, list, aggregate, analyze), never create, change, mute or delete anything.`;
}

function main() {
  if (process.env.PROD_MONITOR_GUARD !== "1") return allow();

  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return allow();
  }

  const tool = payload?.tool_name;
  const input = payload?.tool_input || {};
  let reason = "";
  if (tool === "Bash" && typeof input.command === "string") {
    reason = checkCommand(input.command);
  } else if (WRITE_TOOLS.has(tool)) {
    reason = checkWrite(input.file_path || input.notebook_path, payload.cwd, process.env.PROD_MONITOR_WRITABLE);
  } else {
    reason = checkMcp(tool);
  }

  return reason ? deny(reason) : allow();
}

if (require.main === module) main();

module.exports = { checkCommand, checkWrite, checkMcp };
