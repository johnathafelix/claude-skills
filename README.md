# claude-skills

My personal [Claude Code](https://claude.com/claude-code) skills and hooks, packaged as an installable plugin.

This repo is a **plugin marketplace** containing a single plugin, `claude-skills`, that bundles:

- **18 skills** — dev-workflow helpers for git, PRs, TDD, TypeScript/Go quality, code and PR review, REST API review, writing cleanup, formatting, code simplification, and end-to-end task implementation.
- **7 agents** — `go-idiom-checker` / `ts-quality-checker` / `test-checker` (the restricted sub-agents `golang-check` / `ts-check` / `test-check` fan out to) plus the implementation team used by `ship-task`: `lead-orchestrator`, `planner`, `deep-reasoner`, `fast-worker`.
- **2 hooks** — guardrails for safe commits/PRs.

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
| `rebase-or-merge` | Rebase onto the PR base and push with `--force-with-lease`; on conflict, abort the rebase and fall back to merging the base in, resolving conflicts, verifying, pushing |
| `update-pr-description` | Regenerate a PR description from its commits |
| `grill-me` | Stress-test a plan or design with relentless questioning |
| `tdd` | Test-driven development (red-green-refactor) |
| `test-check` | Check the tests behind a branch's changes — coverage of new/modified lines (≥80%), assertions that prove what the test name claims, assertion strictness (`mock.Anything` last resort), DB operations covered by real-engine integration tests, mock expectations asserted both ways. One read-only opus agent per guideline via the Workflow tool, then an adversarial opus verifier per finding. Report only — never edits |
| `golang-check` | Check Go code against Go conventions — dispatches via the Workflow tool, one agent per guideline (falls back to a direct fan-out if Workflow is unavailable) — pinned to opus |
| `ts-check` | Run all TypeScript quality checks (strong types, no magic values, data over logic, redundant-variable inlining) on changed files — dispatches via the Workflow tool, one agent per guideline (falls back to a direct fan-out if Workflow is unavailable) — pinned to opus |
| `check-rest-api-design` | Review a REST/HTTP API against design best practices |
| `humanizer` | Remove signs of AI-generated writing; make text sound human (MIT, credit: [@blader](https://github.com/blader/humanizer)) |
| `compact-comments` | Triage every comment added in the current PR: delete the ones that only restate the code, compact the rest into succinct 1-2 line comments. Doc comments on exported symbols, directives and ticket-bearing TODOs are never deleted. Scoped by default to comments added in the current PR; auto-invoked after comments are written |
| `format-prettier` | Format files with `prettier --write`. Auto-invoked after edits in a repo that declares prettier; runs on a repo with no config only when explicitly asked (`--force`) |
| `simplify-code` | Dispatch the `code-simplifier` agent to simplify source for clarity and maintainability, preserving functionality. Claude invokes it on its own before finishing a nontrivial change or opening a PR; also runs directly via `/simplify-code` |
| `code-review` | Report-only code review: 15 finder angles (bugs, error handling, type invariants, security, tests, comment accuracy, cleanup, CLAUDE.md conventions) plus a gap sweep, every finding verified by an adversarial agent, all on opus. Each finding is marked `issue` or `nit`. Reviews your branch's changes by default, or a teammate's PR given its URL (checked out in a temporary worktree). Takes an effort level, default `high`. Invoke as `/claude-skills:code-review` — the bare `/code-review` is Claude Code's built-in. `ship-task` and `address-pr-review-comments` run the same review |
| `review-pr` | Review a teammate's PR end to end: runs the `code-review` workflow on it, plus `golang-check` / `ts-check` for its language (findings verified by the same adversarial reviewer) and `test-check` (runs the PR's suite in the worktree for coverage), posts every finding as an inline comment, rewritten by `humanizer` to read less machine-made (findings outside the diff go in the review body), and approves when there are no findings or only nits — otherwise posts a non-blocking comment review. Posts without a confirmation step; never approves a draft, your own PR, a head that moved mid-review, or a review where an angle or check failed to run (coverage not measured is reported but doesn't block). Invoke as `/claude-skills:review-pr <PR URL> [effort]` |
| `ship-task` | Ship one task end to end: `lead-orchestrator` plans/implements via `planner` (fable) and `fast-worker` (sonnet) — the main session runs it in the background and polls it for status so long waves don't leave it stalled — then a dedicated opus code review runs, `planner` (fable) drafts a fix plan the user approves, `fast-worker` applies it, `deep-reasoner` verifies, and the result is committed with a draft PR |
| `address-pr-review-comments` | Address a PR's review comments, verification first: a fable verifier checks each comment against the codebase (widening to sibling repos for cross-system contracts) and an adversarial challenger attacks every verdict, the user settles what the code can't, then the `ship-task` pipeline fixes what survived — pushed to the same branch, with a short reply posted in each thread (the fix, or why the reviewer was wrong) |

### Hooks

| Hook | Event | What it does |
|---|---|---|
| `git-commit-guard.js` | PreToolUse (Bash) | Guards risky `git commit` invocations |
| `gh-pr-guard.js` | PreToolUse (Bash) | Guards risky `gh pr` invocations |

`golang-check`, `ts-check`, and `simplify-code` used to be hook-enforced on every turn that touched relevant source; they're now plain skills Claude invokes at its own judgment (see their descriptions), so nothing here blocks the turn from ending. All three still run directly on request, via `/golang-check`, `/ts-check`, and `/simplify-code`.

The `format-prettier` skill (see Skills, above) runs `prettier --write` on given files, one run per project root — walking up from each file to the nearest prettier config (`.prettierrc*`, `prettier.config.*`, `.prettierignore`, `package.json#prettier`) or else the repo root. Running from that root picks a project-local prettier binary over the `npx` cache and roots `.gitignore`/`.prettierignore` resolution. A repo with **no** prettier config is skipped by default — Claude auto-invokes the skill only when a config is present, and formats an unconfigured repo only when explicitly asked, via `--force`. It counts as formatted only the files prettier actually rewrote — already-clean files are reported separately, and files `.prettierignore` excludes aren't counted at all.

## Dependencies & caveats

- **Required plugin dependency: `code-simplifier`** — a hard dependency, auto-installed with `claude-skills`, needed for the `simplify-code` skill's agent. See [Setup → Required dependency](#2-required-dependency--code-simplifier) for the details and the bare-machine fix.

## Developing this plugin

**Repo edits to `agents/`, `hooks/`, and `skills/` are INERT until you commit, push, and `/plugin update`.** Claude Code loads the plugin from a SHA-pinned cache at `~/.claude/plugins/cache/claude-skills/claude-skills/<sha>/`, not from your working tree. Editing a file here changes nothing in the running session.

This is not hypothetical. A live `ts-check` run once finished with `agents_error: 4` because it ran **84 seconds before** the commit that added `agents/ts-quality-checker.md` — the agent type did not exist in the loaded plugin, so every agent failed to resolve. Its sibling `golang-check` test looked green only because `go-idiom-checker.md` happened to be cached already from an earlier commit, so the newly-added-agent path was never exercised at all.

### Live-test procedure

Do all five, in order:

1. **Confirm the cache is behind before you start.** Compare `ls -t ~/.claude/plugins/cache/claude-skills/claude-skills/` against `git rev-parse --short=12 HEAD`. If they differ, nothing you just edited is loaded.
2. **Commit and push.** This plugin sets no `version`, so it is tracked by commit — every push is a release.
3. **Refresh and reload:** `/plugin marketplace update claude-skills`, then `/plugin update claude-skills@claude-skills`, then `/reload-plugins`.
4. **Re-verify.** The newest cache directory should now match `HEAD`, and every file you changed should be present under it — in particular new files in `agents/` and each `skills/*/workflow.js`, which the cache does not synthesize.
5. **Read the `<usage>` block of the task notification, not just `<status>`.** `<status>completed</status>` coexists with total failure: it means the workflow script returned, not that the work succeeded, and `agent_count` counts spawn attempts rather than successes. A run is a real pass only when `agents_error` is `0`, `agents_done` equals `agent_count`, and `unverified` is empty. `agents_error == agent_count` with `tool_uses: 0` means the agent type did not resolve — go back to step 1.

`npm test` covers hook registration invariants and the `format-prettier` skill script (zero dependencies, `node --test`). Both are subject to the same cache rule, so a passing suite is necessary but not sufficient — an edit to either still needs steps 2–4 before it runs live.

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

## Notes for my own machines

If you already wire these hooks manually in `~/.claude/settings.json` (pointing at `~/.claude/hooks/*.js`), **remove those entries after installing this plugin** — otherwise each hook fires twice. Likewise the loose skill copies in `~/.claude/skills/` become redundant once the plugin provides them.

## License

MIT — see [LICENSE](./LICENSE).
