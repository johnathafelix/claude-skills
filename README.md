# claude-skills

My personal [Claude Code](https://claude.com/claude-code) skills and hooks, packaged as an installable plugin.

This repo is a **plugin marketplace** containing a single plugin, `claude-skills`, that bundles:

- **19 skills** — dev-workflow helpers for git, PRs, TDD, TypeScript/Go quality, code and PR review, REST API review, writing cleanup, formatting, code simplification, and end-to-end task implementation.
- **7 agents** — `go-idiom-checker` / `ts-quality-checker` / `test-checker` (the restricted sub-agents `golang-check` / `ts-check` / `test-check` fan out to) plus the implementation team used by `ship-task`: `lead-orchestrator`, `planner`, `hard-worker`, `fast-worker`.
- **3 hooks** — guardrails for safe commits/PRs, plus a post-edit encoding and build check.

## Setup

### 1. Install the plugin

```
/plugin marketplace add johnathafelix/claude-skills
/plugin install claude-skills@claude-skills
```

Restart Claude Code (or run `/plugin`) and the skills + hooks are active.

To update later (this plugin sets no `version`, so it's tracked by git commit — every push counts as an update):

```
/plugin marketplace update claude-skills
/plugin update claude-skills@claude-skills
/reload-plugins
```

`marketplace update` refreshes from GitHub, `plugin update` installs the latest commit, and `/reload-plugins` applies it without a full restart.

### 2. Required dependency — `code-simplifier`

`claude-skills` declares a hard dependency on the `code-simplifier` plugin — the `simplify-code` skill dispatches its agent, so the plugin **will not load** without it. It lives in Claude Code's built-in **`claude-plugins-official`** marketplace and is **auto-installed** with `claude-skills`, so on a normal machine there's no extra step.

On a bare setup where `claude-plugins-official` isn't registered yet, the install fails to load with a message like:

> Dependency "code-simplifier@claude-plugins-official" is not installed — run `claude plugin install code-simplifier@claude-plugins-official`, or check that its marketplace is added

Fix it once by adding the official marketplace, then (re)install:

```
claude plugin marketplace add anthropics/claude-plugins-official
/plugin install claude-skills@claude-skills
```

### 3. Optional: status line

Ships in this repo but can't be auto-installed by a plugin; wire it up by hand (see [Status line](#status-line-optional-manual-setup)).

## What's inside

### Skills

| Skill | What it does |
|---|---|
| `git-commit` | Commit staged/unstaged changes with conventional messages |
| `draft-pr` | Push unpushed commits and open a draft PR |
| `create-pr` | Push unpushed commits and open a PR that is ready for review (same as `draft-pr`, minus `--draft`) |
| `rebase-or-merge` | Rebase onto the PR base and push with `--force-with-lease`; on conflict, abort the rebase and fall back to merging the base in, resolving conflicts, verifying, pushing |
| `update-pr-description` | Regenerate a PR description from its commits |
| `grill-me` | Stress-test a plan or design with relentless questioning |
| `tdd` | Test-driven development (red-green-refactor) |
| `test-check` | Check the tests behind a branch's changes — coverage of new/modified lines (≥80%), assertions that prove what the test name claims, assertion strictness (`mock.Anything` last resort), DB operations covered by real-engine integration tests, mock expectations asserted both ways. Two related read-only sonnet guideline groups, then bounded adversarial batches of up to four claims. Report only — never edits |
| `golang-check` | Check Go code against Go conventions — dispatches via the Workflow tool, related guideline groups with shared source reads (bounded direct groups if Workflow is unavailable) — pinned to sonnet |
| `ts-check` | Run all TypeScript quality checks (strong types, no magic values, data over logic, object parameters, redundant-variable inlining) on changed files — dispatches via the Workflow tool, related guideline groups with shared source reads (bounded direct groups if Workflow is unavailable) — pinned to sonnet |
| `check-rest-api-design` | Review a REST/HTTP API against design best practices |
| `humanizer` | Remove signs of AI-generated writing; make text sound human, direct, and concise (MIT, credit: [@blader](https://github.com/blader/humanizer)) |
| `compact-comments` | Triage every comment added in the current PR: delete the ones that only restate the code, compact the rest into succinct 1-2 line comments. Doc comments on exported symbols, directives and ticket-bearing TODOs are never deleted. Scoped by default to comments added in the current PR; auto-invoked after comments are written |
| `format-prettier` | Format files with `prettier --write`. Auto-invoked after edits in a repo that declares prettier; always runs with `--force`, so a repo with no config is formatted with prettier's defaults |
| `simplify-code` | Dispatch the `code-simplifier` agent (opus, medium effort) to simplify source for clarity and maintainability, preserving functionality. Claude invokes it on its own before finishing a nontrivial change or opening a PR; also runs directly via `/simplify-code` |
| `code-review` | Report-only Opus review (medium effort by default, high for thorough): standard groups all 15 angles into three source-reading passes; fast uses two groups, thorough groups all angles into five passes plus a bounded sweep. Independent verification batches four claims, prioritizes issues and caps calls at eight; missing/overflow verdicts remain explicit gaps. Structured symbol/invariant/trigger identities deduplicate equivalent claims across shifted lines before verification. Reviews local branch/working-tree changes against the merge base, or a PR in a temporary worktree. Default standard/medium. Invoke as `/claude-skills:code-review`; the bare `/code-review` is Claude Code's built-in |
| `review-pr` | Review and post confirmed PR findings with grouped Opus code review and language/test checks and one independent challenge queue. Default standard/medium (high for thorough); accepts fast/thorough, an effort, approve and full. Re-reviews use a pinned prior complete review's delta plus affected callers and independently recheck old findings; changed base, policy, history or broad configuration falls back to full. Coverage uses affected packages, isolated dependency caches and fingerprinted reports, with install/coverage limits of 180/300 seconds. Drafts plain comments directly, approves clean/nit-only reviews, reports gaps and preserves unresolved prior issues. With approve, posts findings and approves despite issues/gaps. Never approves own/draft/moved heads. Invoke `/claude-skills:review-pr <PR URL> [profile] [effort] [approve] [full]`. Defaults configurable through REVIEW_PR_PROFILE and REVIEW_PR_EFFORT; headless coordinator defaults to sonnet (REVIEW_PR_COORDINATOR_MODEL), review and check agents use opus. Helpers store caches outside repos; REVIEW_PR_CACHE_DIR and REVIEW_PR_ARTIFACT_CACHE_DIR override locations |
| `review-requests` | Watch teammates' requests using the existing Claude Slack connector and Haiku, with no Slack API token. Runs at most two headless reviews; queued PR URLs persist before the channel cursor advances, so a full queue never rereads old pages. Local completions/queue checks run every 30 seconds and GitHub watches every minute. Connector reads start every 5 minutes (REVIEW_REQUESTS_INTERVAL_MINUTES), backing off up to 30 minutes while idle (REVIEW_REQUESTS_MAX_IDLE_INTERVAL_MINUTES); set both equal to disable backoff. Completion replies do not wait for a channel read. Re-reviews after a push settles for 10 minutes; the second review uses approve, and later pushes are approved without review. State/logs persist in ~/.claude/review-requests. Relay hooks/skills/project settings/memory are disabled, responses bounded, posts batched; token logs include all attempts. Needs REVIEW_REQUESTS_CHANNEL_ID and preferably REVIEW_REQUESTS_USER_ID. Invoke `/claude-skills:review-requests` once; closing the session stops the watch while detached reviews continue |
| `ship-task` | Ship an approved task with fast, standard or thorough execution, task-only manifests, grouped quality checks, bounded in-scope remediation and evidence reuse. Cleanup runs before review/verification; commit and draft PR creation use a prepared description once |
| `prod-monitor` | Background production error monitor for GCP. Every PROD_MONITOR_INTERVAL (default 1h) a Python loop reads the watched namespaces' warnings/errors with `gcloud logging read` (no model; the window is read in PROD_MONITOR_FETCH_SLICE_MINUTES slices, each keeping its newest share of PROD_MONITOR_LOG_LIMIT, so a noisy hour is sampled evenly) into `<workdir>/<dd-MM-yyyy-HH-mm>/gcp-logs`, an opus triage session classifies them (`triage/`), all-severity context around each issue's samples (same pods or traces, 5 min before to 1 min after, no model) is saved next to it, one opus high-effort session per actionable issue finds the probable root cause and a fix in the repos under PROD_MONITOR_REPOS_DIR (read from detached worktrees; read-only kubectl/gcloud allowed) (`findings/`), one opus high-effort session per finding challenges it (`challenged-findings/`), and a sonnet relay creates one Linear ticket per confirmed finding in the configured team/project, assigned to the user, with the configured labels. Known issues (`known-issues.json`) remember their log signatures, so their groups are folded out before triage and counted as recurrences; the triage session only sees what is new and is skipped when nothing is. Rejected ones rest for PROD_MONITOR_SKIP_TTL_HOURS. Every stage leaves markers so a stopped loop resumes; per-run reports go to `<workdir>/tickets/<dd-MM-yyyy>/`, the append-only log to `<workdir>/logs/<dd-MM-yyyy>.txt`. Every session runs with the `prod-guard` hook active. PROD_MONITOR_OPEN_PRS=1 adds a draft PR per confirmed ticket. Invoke `/claude-skills:prod-monitor` once; closing the session stops the loop |
| `address-pr-review-comments` | Address a PR's review comments, verification first: a fable verifier (high effort) checks each comment against the codebase (widening to sibling repos for cross-system contracts) and an opus adversarial challenger (high effort) attacks every verdict, the user settles what the code can't, then the `ship-task` pipeline fixes what survived (fable planner; implementation lead on opus at medium effort, executors on sonnet at medium effort (`fast-worker`) or opus at high effort (`hard-worker`), code review on opus at high effort) — pushed to the same branch, with a short reply posted in each thread (the fix, or why the reviewer was wrong) |

### Hooks

| Hook | Event | What it does |
|---|---|---|
| `git-commit-guard.js` | PreToolUse (Bash) | Guards risky `git commit` invocations |
| `gh-pr-guard.js` | PreToolUse (Bash) | Guards risky `gh pr` invocations |
| `prod-guard.js` | PreToolUse (Bash, Edit, Write, MultiEdit, NotebookEdit) | Active only with `PROD_MONITOR_GUARD=1` in the environment (the `prod-monitor` loop sets it for every session it starts). Denies mutating `kubectl` (anything but get/describe/logs/top/events/explain/diff/wait/config view/rollout status...), non-read-only `gcloud` (only list/describe/read/tail/get*/print-*-token/version), `gsutil` writes, `helm` releases changes, `terraform`/`tofu`/`pulumi` apply/destroy/import/state, destructive `git` (force push, reset --hard, clean, checkout --, restore, stash drop, branch -D, rebase, amend, tag -d) and any file write outside the `PROD_MONITOR_WRITABLE` roots |
| `post-edit-check.js` | PostToolUse (Edit, Write) | Scans the written text for literal invisible/control characters (BOM, zero-width, bidi, NBSP, braille blank, Hangul fillers) and reports each with its line and `\uXXXX` escape; notes other non-ASCII in source files. Then builds the edited file: Go via `go test -run '^$'` in its package (compiles `_test.go` too) after formatting it with `gofmt -w`, Python via a syntax parse. TypeScript/JS are not built (`tsc` is project-wide and slow). Findings are fed back to Claude; nothing is undone |

`golang-check`, `ts-check`, and `simplify-code` used to be hook-enforced on every turn that touched relevant source; they're now plain skills Claude invokes at its own judgment (see their descriptions), so nothing here blocks the turn from ending. All three still run directly on request, via `/golang-check`, `/ts-check`, and `/simplify-code`.

The `format-prettier` skill (see Skills, above) runs `prettier --write` on given files, one run per project root — walking up from each file to the nearest prettier config (`.prettierrc*`, `prettier.config.*`, `.prettierignore`, `package.json#prettier`) or else the repo root. Running from that root picks a project-local prettier binary over the `npx` cache and roots `.gitignore`/`.prettierignore` resolution. The script skips a repo with **no** prettier config unless `--force` is passed; the skill always passes it, so an unconfigured repo is formatted with prettier's defaults — Claude still auto-invokes the skill only when a config is present. It counts as formatted only the files prettier actually rewrote — already-clean files are reported separately, and files `.prettierignore` excludes aren't counted at all.

## Dependencies & caveats

- **Required plugin dependency: `code-simplifier`** — a hard dependency, auto-installed with `claude-skills`, needed for the `simplify-code` skill's agent. See [Setup → Required dependency](#2-required-dependency--code-simplifier) for the details and the bare-machine fix.

## Developing this plugin

**Installed sessions use a SHA-pinned plugin cache, so repo edits do not change the running session.** Load a checkout in a new session to try unpublished changes:

```bash
claude --plugin-dir "$PWD/plugins/claude-skills"
```

The headless review runner loads the plugin containing its script directly. A watcher
started from the installed plugin still uses that installed copy. To update the
installed plugin, commit, push, update and reload as below.

This is not hypothetical. A live `ts-check` run once finished with `agents_error: 4` because it ran **84 seconds before** the commit that added `agents/ts-quality-checker.md` — the agent type did not exist in the loaded plugin, so every agent failed to resolve. Its sibling `golang-check` test looked green only because `go-idiom-checker.md` happened to be cached already from an earlier commit, so the newly-added-agent path was never exercised at all.

### Live-test procedure

Do all five, in order:

1. **Confirm the cache is behind before you start.** Compare `ls -t ~/.claude/plugins/cache/claude-skills/claude-skills/` against `git rev-parse --short=12 HEAD`. If they differ, nothing you just edited is loaded.
2. **Commit and push.** This plugin sets no `version`, so it is tracked by commit — every push is a release.
3. **Refresh and reload:** `/plugin marketplace update claude-skills`, then `/plugin update claude-skills@claude-skills`, then `/reload-plugins`.
4. **Re-verify.** The newest cache directory should now match `HEAD`, and every file you changed should be present under it — in particular new files in `agents/` and each `skills/*/workflow.js`, which the cache does not synthesize.
5. **Read the `<usage>` block of the task notification, not just `<status>`.** `<status>completed</status>` coexists with total failure: it means the workflow script returned, not that the work succeeded, and `agent_count` counts spawn attempts rather than successes. A run is a real pass only when `agents_error` is `0`, `agents_done` equals `agent_count`, and `unverified` is empty. `agents_error == agent_count` with `tool_uses: 0` means the agent type did not resolve — go back to step 1.

`npm test` covers hooks, workflow grouping/verification, review caches/timeouts and
connector queue/restart behavior (`node --test`, plus Python 3 for review helpers).
Formatter integration tests use `npx prettier`. A passing suite does not establish
live review quality; load the checkout explicitly or update the installed plugin
before comparing representative sessions.

## Recommended plugins

Other Claude Code plugins I run alongside `claude-skills`. (`code-simplifier` isn't here — it's already a required dependency and installs automatically.)

They all live in Claude Code's built-in **`claude-plugins-official`** marketplace, so one command installs each:

```
/plugin install code-review@claude-plugins-official
/plugin install context7@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
/plugin install gopls-lsp@claude-plugins-official
/plugin install pyright-lsp@claude-plugins-official
/plugin install typescript-lsp@claude-plugins-official
```

| Plugin | What it does |
|---|---|
| `code-review` | Automated PR review with multiple agents + confidence scoring |
| `context7` | MCP server for up-to-date, version-specific library docs |
| `frontend-design` | Distinctive, production-grade frontend UI generation |
| `gopls-lsp` | Go language server (code intelligence, refactoring) |
| `pyright-lsp` | Python language server (Pyright) — type checking |
| `typescript-lsp` | TypeScript/JavaScript language server |

## Status line (optional, manual setup)

Claude Code does **not** let a plugin auto-install the main status line: `statusLine` in `plugin.json` is ignored at load time, and `${CLAUDE_PLUGIN_ROOT}` isn't expanded in status-line commands. So this repo ships the script and you wire it up once by hand.

`statusline/statusline-command.sh` renders `user@host cwd ‹branch› [model] 97% left · 5h 12% · 7d 8%`. It needs `jq` and `bc` on `PATH`.

1. Copy it to a stable path and make it executable:
   ```bash
   cp statusline/statusline-command.sh ~/.claude/statusline-command.sh
   chmod +x ~/.claude/statusline-command.sh
   ```
2. Add this to `~/.claude/settings.json`:
   ```json
   "statusLine": { "type": "command", "command": "bash ~/.claude/statusline-command.sh" }
   ```

## Model assignments — where to look when quality degrades

Models were rebalanced for cost (see commits `5ed2b31`..`aa52a7c`). If a skill starts
missing things or producing weak output, check here first.

### Who runs on what

| Model | Used for |
|---|---|
| **fable** | `planner` (high effort) and the `address-pr-review-comments` verifier (high effort) |
| **opus** | `hard-worker` (high effort; renamed from `deep-reasoner`); the `address-pr-review-comments` challenger (high effort); every `code-review` / `review-pr` / `ship-task` review agent (medium effort, high for thorough) and the `address-pr-review-comments` code review (high); every grouped check agent (high effort by default; `ship-task` passes medium for fast/standard and high for thorough, `review-pr` passes its review effort); `check-rest-api-design` (and its sub-agents) and the `simplify-code` subagent (medium effort); `lead-orchestrator` everywhere (medium effort); `grill-me` (medium effort); the `address-pr-review-comments` final check (high effort); `prod-monitor` triage (medium effort), findings and challenge sessions (high effort) and its optional fix-PR sessions (medium effort) |
| **sonnet** | `fast-worker` by default (opus where a skill above overrides it), `update-pr-description`, the three checker agents' own frontmatter (the grouped-check runtime overrides it), the `ts-check` / `test-check` / `golang-check` dispatchers, `tdd` and `humanizer` (both at high effort), `compact-comments`, `rebase-or-merge`, the `review-requests` review-session coordinator, and the `prod-monitor` Linear relay |
| **haiku** | `git-commit`, `draft-pr`, `create-pr`, `format-prettier`, `simplify-code` (dispatcher only), and the `review-requests` Slack relay |
| **session model** | Skills with no `model:` run their main thread on whatever your session uses: `ship-task`, `review-pr`, `review-requests`, `address-pr-review-comments`, `code-review`, `prod-monitor` (its loop uses no model of its own) |

A skill's `model:` sets the dispatcher only. A subagent launched without an explicit
`model` inherits the caller's unless its own definition pins one.

### Where the knobs live

| What | File | Setting |
|---|---|---|
| Verify / challenge model and effort | `skills/address-pr-review-comments/verify-workflow.js` | `VERIFY_MODEL`, `CHALLENGE_MODEL`, `VERIFY_EFFORT`, `CHALLENGE_EFFORT`, `MAX_CHALLENGERS` |
| `code-review` finders, sweep and verifiers | `skills/code-review/workflow.js` | `model` arg (default `opus`) and `effort` arg (default medium, high for thorough) |
| `ts-check` / `test-check` / `golang-check` | `scripts/grouped-check-runtime.js` (check and verify calls), `agents/*-checker.md`, each skill's `SKILL.md` | `model` / `effort` args (default `opus` at `high`; `review-pr` passes its review effort), `model:` |
| Agent defaults | `agents/*.md` | `model:`, `effort:` |
| Pinned planner / lead / executor models | `skills/ship-task/SKILL.md`, `skills/address-pr-review-comments/SKILL.md`, `skills/simplify-code/SKILL.md` | `model: "..."`, `effort: "..."` in the `Agent` calls |
| `review-requests` coordinator / Slack relay | `skills/review-requests/scripts/run-review.py`, `scripts/slack.py` | `REVIEW_PR_COORDINATOR_MODEL` (default `sonnet`), `--model haiku` |
| `prod-monitor` stages | `skills/prod-monitor/scripts/common.py` (`load_config`) | `PROD_MONITOR_TRIAGE_MODEL`/`_EFFORT` (opus, medium), `PROD_MONITOR_FINDINGS_MODEL`/`_EFFORT` (opus, high), `PROD_MONITOR_CHALLENGE_MODEL`/`_EFFORT` (opus, high), `PROD_MONITOR_LINEAR_MODEL` (sonnet), `PROD_MONITOR_PR_MODEL`/`_EFFORT` (opus, medium) |

Effort accepts `low`, `medium`, `high`, `xhigh`, `max`.

### Symptom → likely cause

- **Reviews miss bugs or the findings look shallow** (`/code-review`, `/review-pr`,
  `/address-pr-review-comments` Phase 6, `/ship-task`): they run opus at `medium` effort
  (`high` for thorough and for address-pr Phase 6). Pass a higher effort
  (`/code-review high`, `REVIEW_PR_EFFORT`) or raise the default in `code-review/workflow.js`.
- **Language or test checks miss rules or raise false positives**: check agents run opus
  at `high` effort by default; `review-pr` runs them on opus at its review effort. Raise `model` / `effort` in the args, or the default in `grouped-check-runtime.js`.
- **`address-pr-review-comments` returns thin `evidence`, parks too many threads as
  `needs-user-input`, or wrongly rebuts a reviewer**: the verifier runs fable and the
  challenger opus, both at `high` effort. Raise `VERIFY_EFFORT` / `CHALLENGE_EFFORT` further. The challenger is shown the sibling root and the
  repos the verifier checked so it can catch an unchecked cross-system contract.
- **Many threads make that workflow expensive**: it runs one verifier and one challenger
  per thread (challengers capped at `MAX_CHALLENGERS`); lower effort or the cap.
- **`simplify-code` produces weak refactors**: the dispatcher is haiku and its `Agent`
  call pins the `code-simplifier` subagent to opus at medium effort. Raise `effort:`; if the
  pin is removed, the subagent inherits haiku.
- **`format-prettier` reformats a repo with no prettier config**: it always passes
  `--force`. The only guard is the "use PROACTIVELY only where prettier is declared"
  sentence in its description.
- **Poor commit messages or PR descriptions**: `git-commit`, `draft-pr` and `create-pr`
  are haiku (`update-pr-description` is sonnet); revert the `model:` frontmatter line.

### After changing any of this

Edits take effect only after the plugin cache is refreshed: update the plugin, then
`/reload-plugins` (other open sessions need it too). The cache lives in
`~/.claude/plugins/cache/claude-skills/claude-skills/<sha>/`; one directory per installed
commit, and `installed_plugins.json` names the active one.

## Notes for my own machines

If you already wire these hooks manually in `~/.claude/settings.json` (pointing at `~/.claude/hooks/*.js`), **remove those entries after installing this plugin** — otherwise each hook fires twice. Likewise the loose skill copies in `~/.claude/skills/` become redundant once the plugin provides them.

## License

MIT — see [LICENSE](./LICENSE).

## Shipping cost and validation

`ship-task` selects a profile by task risk. The default standard review covers the
existing angles in three related passes; thorough covers all angles in five related passes and a
bounded fresh sweep. Go source checks ordinarily use three groups (plus testing when scoped),
TypeScript two, and test quality two. Reviewer and checker agents run opus everywhere: reviewers at medium effort (high for thorough), checkers at high effort unless the caller passes one. Each rule still
has its own scope and proof anchors; failed rules retry once without repeating their
successful siblings. Independent challengers share source context across four claims,
with at most eight calls and four agents active. Overflow and missing verdicts remain
visible, and downstream PR workflows do not post them as confirmed findings.

Pipeline finders focus on correctness and nits with concrete maintenance/testing cost;
standalone language checks retain their full style rules. Scope validation normalizes
absolute and repo-relative paths within the pinned checkout. Rejected claims retain
their validation errors and prevent complete cache reuse. Stage every review/check
payload with `review-dispatch.js`; it stages exact scripts into a declared readable
scratchpad or supplies unchanged inline bytes. Cached and GitHub prior claims join the
independent queue, and missing prior verdicts block complete cache writes. `workflow-metrics.js` reads compact elapsed
times and phase agent spans from completed harness metadata, without sandbox clocks.

The task manifest helper stores a baseline and patches outside the repo, including
new/deleted files and edits within pre-existing dirty files. It batches historical Git
blob reads, scans content once and reuses unchanged patches; it does not stage changes.
Scoped coverage validates all expected sources. Jest plans generate config arrays,
preserve project setup and avoid CLI source-list parsing; one locked tracked task
reports phase/result in JSON.
Coverage/test evidence needs matching inputs rather than a recent timestamp. Workers'
passing commands can be reused when those inputs remain unchanged.

These changes target the observed local-session overhead: the four October 6 Go runs
used 48–63 agents, and review/quality checks accounted for about 51% of newly supplied
input/cache-write tokens. This is a baseline observation, not a measurement of the new
pipeline or a dollar estimate. Re-run representative tasks after plugin reload and
compare total elapsed time excluding approval waits, actual agent calls, all-request
usage, and independently confirmed defects. Local tests exercise grouping, retry
isolation, verification budgets/failures and task ownership; they cannot establish
live model recall or an actual token/time reduction.
