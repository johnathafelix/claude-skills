// The prod-monitor guard keeps production read-only inside the monitor's headless
// sessions. It is table-tested here through the real hook process, with the
// activating environment variable, because a regex that lets `kubectl delete`
// through would otherwise only be noticed in production.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("path");

const HOOK = path.join(__dirname, "..", "plugins", "claude-skills", "hooks", "prod-guard.js");

function run(toolName, toolInput, env = { PROD_MONITOR_GUARD: "1" }, cwd = "/work") {
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
    encoding: "utf8",
    env: { ...process.env, PROD_MONITOR_GUARD: "", PROD_MONITOR_WRITABLE: "", ...env },
  });
  assert.strictEqual(result.status, 0, result.stderr);

  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
}

const ALLOWED = [
  "kubectl get pods -n payments",
  "kubectl -n payments --context prod describe pod api-7d9f-abcde",
  "kubectl logs -n payments deploy/api --since=1h --tail=200",
  "kubectl top pods -n payments",
  "kubectl get events -n payments --sort-by=.lastTimestamp",
  "kubectl rollout status deployment/api -n payments",
  "kubectl config current-context",
  "kubectl auth can-i delete pods",
  "kubectl get deploy api -n payments -o yaml | grep image",
  "gcloud logging read 'severity>=ERROR AND textPayload:\"delete\"' --project=p --format=json --limit=200",
  "gcloud container clusters get-credentials prod --region us-east1 --project p",
  "gcloud compute instances list --project p",
  "gcloud run services describe api --region us-east1",
  "gcloud config get-value project",
  "gcloud version",
  "gsutil ls gs://bucket/",
  "helm list -n payments",
  "helm get values api -n payments",
  "terraform plan",
  "git -C /repos/api fetch origin",
  "git -C /repos/api worktree add --detach /work/worktrees/api origin/main",
  "git -C /work/worktrees/api checkout --detach origin/main",
  "git log --oneline -n 20 -- src/handler.go",
  "git push origin fix/thing",
  "git restore --staged file.go",
  "git clean -n",
  "git stash list",
  "jq '.[0]' logs.json",
  "echo kubectl delete",
];

const DENIED = [
  "kubectl delete pod api-7d9f-abcde -n payments",
  "kubectl apply -f deploy.yaml",
  "kubectl -n payments scale deploy/api --replicas=0",
  "kubectl rollout restart deployment/api -n payments",
  "kubectl exec -it api-7d9f-abcde -n payments -- sh",
  "kubectl edit deploy api",
  "kubectl patch deploy api -p '{}'",
  "kubectl config use-context staging",
  "kubectl cordon node-1",
  "kubectl debug pod/api -it --image=busybox",
  "kubectl \"delete\" pod x",
  "kubectl get pods -n payments && kubectl delete pod x -n payments",
  "kubectl get pods -o name | xargs kubectl delete",
  "gcloud compute instances delete vm-1 --project p",
  "gcloud run deploy api --image x",
  "gcloud config set project other",
  "gcloud auth login",
  "gcloud compute instances \"delete\" vm-1",
  "gcloud container clusters resize prod --num-nodes 0",
  "gsutil rm -r gs://bucket/path",
  "helm upgrade api ./chart -n payments",
  "helm uninstall api -n payments",
  "terraform apply -auto-approve",
  "git push --force origin main",
  "git push -f origin main",
  "git push --force-with-lease origin main",
  "git push origin --delete feature",
  "git push origin +main",
  "git -C /repos/api reset --hard origin/main",
  "git clean -fd",
  "git checkout -- .",
  "git checkout .",
  "git -C /repos/api checkout -f main",
  "git restore src/handler.go",
  "git stash drop",
  "git branch -D feature",
  "git rebase origin/main",
  "git commit --amend --no-edit",
  "git tag -d v1.0.0",
  "sudo kubectl delete ns payments",
  "FOO=1 kubectl delete pod x",
  "bash -c 'kubectl delete pod x'",
  "echo $(kubectl delete pod x)",
];

test("read-only production and repo commands are allowed", () => {
  for (const command of ALLOWED) {
    assert.strictEqual(run("Bash", { command }), null, "should allow: " + command);
  }
});

test("mutating production and destructive repo commands are denied", () => {
  for (const command of DENIED) {
    const out = run("Bash", { command });
    assert.ok(out && out.permissionDecision === "deny", "should deny: " + command);
    assert.match(out.permissionDecisionReason, /^prod-monitor guard: /);
  }
});

test("datadog MCP tools are limited to reads", () => {
  for (const tool of ["mcp__plugin_datadog_mcp__search_datadog_logs", "mcp__plugin_datadog_mcp__get_datadog_trace", "mcp__plugin_datadog_mcp__aggregate_spans", "mcp__plugin_datadog_mcp__analyze_datadog_logs", "mcp__plugin_datadog_mcp__list_datadog_skills", "mcp__plugin_datadog_mcp__load_datadog_skill", "mcp__plugin_datadog_mcp__execute_code", "mcp__claude_ai_Datadog__search_logs", "mcp__claude_ai_Datadog__authenticate"]) {
    assert.strictEqual(run(tool, { query: "status:error" }), null, "should allow: " + tool);
  }

  for (const tool of ["mcp__plugin_datadog_mcp__create_datadog_notebook", "mcp__plugin_datadog_mcp__update_datadog_monitor", "mcp__plugin_datadog_mcp__mute_datadog_monitor", "mcp__plugin_datadog_mcp__delete_datadog_dashboard", "mcp__claude_ai_Datadog__create_incident"]) {
    const out = run(tool, {});
    assert.ok(out && out.permissionDecision === "deny", "should deny: " + tool);
    assert.match(out.permissionDecisionReason, /^prod-monitor guard: .*only read from Datadog/);
  }

  assert.strictEqual(run("mcp__claude_ai_Linear__save_issue", {}), null, "other servers are not the guard's business");
  assert.strictEqual(run("mcp__plugin_datadog_mcp__create_datadog_notebook", {}, { PROD_MONITOR_GUARD: "" }), null);
});

test("inactive without PROD_MONITOR_GUARD=1", () => {
  for (const command of DENIED) {
    assert.strictEqual(run("Bash", { command }, { PROD_MONITOR_GUARD: "" }), null, "should allow when inactive: " + command);
  }

  assert.strictEqual(run("Write", { file_path: "/etc/hosts", content: "" }, { PROD_MONITOR_GUARD: "0" }), null);
});

test("writes are confined to PROD_MONITOR_WRITABLE roots", () => {
  const env = { PROD_MONITOR_GUARD: "1", PROD_MONITOR_WRITABLE: ["/work/run/findings", "/work/worktrees"].join(path.delimiter) };

  assert.strictEqual(run("Write", { file_path: "/work/run/findings/issue.md", content: "" }, env), null);
  assert.strictEqual(run("Edit", { file_path: "/work/worktrees/api/src/a.go" }, env), null);
  assert.strictEqual(run("Write", { file_path: "findings/issue.md", content: "" }, env, "/work/run"), null);

  for (const file_path of ["/repos/api/src/a.go", "/work/run/findings-other/x.md", "/work/run/triage/triage.md", "../repos/api/a.go"]) {
    const out = run("Write", { file_path, content: "" }, env, "/work/run");
    assert.ok(out && out.permissionDecision === "deny", "should deny write to " + file_path);
  }

  const notebook = run("NotebookEdit", { notebook_path: "/repos/api/nb.ipynb" }, env);
  assert.ok(notebook && notebook.permissionDecision === "deny");
});

test("with no writable roots every write is denied", () => {
  const out = run("Write", { file_path: "/work/run/findings/issue.md", content: "" }, { PROD_MONITOR_GUARD: "1", PROD_MONITOR_WRITABLE: "" });
  assert.ok(out && out.permissionDecision === "deny");
});

test("malformed payloads are allowed through", () => {
  const result = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8", env: { ...process.env, PROD_MONITOR_GUARD: "1" } });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
});
