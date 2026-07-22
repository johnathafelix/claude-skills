# claude-skills

My personal [Claude Code](https://claude.com/claude-code) skills and hooks, packaged as an installable plugin.

This repo is a **plugin marketplace** containing a single plugin, `claude-skills`, that bundles:

- **16 skills** — dev-workflow helpers for git, PRs, TDD, TypeScript/Go quality, REST API review, code-graph navigation, writing cleanup, and end-to-end task implementation.
- **5 agents** — `go-idiom-checker` (the restricted sub-agent `golang-check` fans out to) plus the `plan-and-implement-task` team: `lead-orchestrator`, `planner`, `deep-reasoner`, `fast-worker`.
- **5 hooks** — guardrails for safe commits/PRs and post-turn quality enforcement.

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

`claude-skills` declares a hard dependency on the `code-simplifier` plugin — the `auto-code-simplifier.js` Stop hook drives its agent, so the plugin **will not load** without it. It lives in Claude Code's built-in **`claude-plugins-official`** marketplace and is **auto-installed** with `claude-skills`, so on a normal machine there's no extra step.

On a bare setup where `claude-plugins-official` isn't registered yet, the install fails to load with a message like:

> Dependency "code-simplifier@claude-plugins-official" is not installed — run `claude plugin install code-simplifier@claude-plugins-official`, or check that its marketplace is added

Fix it once by adding the official marketplace, then (re)install:

```
claude plugin marketplace add anthropics/claude-plugins-official
/plugin install claude-skills@claude-skills
```

### 3. Optional: graph skills (`code-review-graph`)

The four graph skills — `debug-issue`, `explore-codebase`, `refactor-safely`, `review-changes` — call the `code-review-graph` MCP tools, so they need its server. It's a public Python package. Set it up once:

1. Install the CLI (needs Python ≥ 3.10 and [pipx](https://pipx.pypa.io)):
   ```bash
   pipx install code-review-graph
   ```
2. Register its MCP server with Claude Code — this plugin already ships the graph skills, so skip its own copies:
   ```bash
   code-review-graph install --platform claude-code --no-skills
   ```
   It can also add auto-update hooks and inject graph instructions into `CLAUDE.md`; see `code-review-graph install --help`.
3. Build the graph in each repo you want to use it in:
   ```bash
   cd /path/to/repo
   code-review-graph build
   ```
   After that it updates incrementally (via the hooks step 2 installs, or `code-review-graph watch`).

Without this, only the four graph skills are inert — the rest of the plugin works fine.

### 4. Optional: status line

Ships in this repo but can't be auto-installed by a plugin; wire it up by hand (see [Status line](#status-line-optional-manual-setup)).

## What's inside

### Skills

| Skill | What it does |
|---|---|
| `git-commit` | Commit staged/unstaged changes with conventional messages |
| `draft-pr` | Push unpushed commits and open a draft PR |
| `merge` | Merge the PR base into your branch, resolve conflicts, verify, push |
| `update-pr-description` | Regenerate a PR description from its commits |
| `grill-me` | Stress-test a plan or design with relentless questioning |
| `plan-and-implement-task` | Implement one task end to end: user-approved plan (plan mode), wave-scheduled implementation by a fable/opus/sonnet agent team, final lead code review |
| `tdd` | Test-driven development (red-green-refactor) |
| `write-pending-unit-tests` | Write tests for files changed vs. the base branch |
| `golang-check` | Check Go code against Go conventions (fans out per-guideline) |
| `ts-check` | Run all TypeScript quality checks (strong types, no magic values, data over logic, redundant-variable inlining) on changed files — self-contained, fans out per-guideline |
| `check-rest-api-design` | Review a REST/HTTP API against design best practices |
| `debug-issue` | Systematically debug using graph-powered navigation † |
| `explore-codebase` | Navigate codebase structure via the knowledge graph † |
| `refactor-safely` | Plan/execute refactors using dependency analysis † |
| `review-changes` | Risk-aware code review via change detection + impact † |
| `humanizer` | Remove signs of AI-generated writing; make text sound human (MIT, credit: [@blader](https://github.com/blader/humanizer)) |

### Hooks

| Hook | Event | What it does |
|---|---|---|
| `git-commit-guard.js` | PreToolUse (Bash) | Guards risky `git commit` invocations |
| `gh-pr-guard.js` | PreToolUse (Bash) | Guards risky `gh pr` invocations |
| `auto-code-simplifier.js` | Stop | After edits, nudges a `code-simplifier` pass (agent from the required `code-simplifier` dependency) |
| `enforce-golang-check.js` | Stop | If Go source changed, requires `/golang-check` before finishing |
| `enforce-ts-check.js` | Stop | If TS source changed, requires `/ts-check` before finishing |

The `enforce-*` hooks pair with the bundled `golang-check` / `ts-check` skills, so they are self-contained. All hooks no-op quietly when a turn didn't touch relevant files.

## Dependencies & caveats

- **Required plugin dependency: `code-simplifier`** — a hard dependency, auto-installed with `claude-skills`. See [Setup → Required dependency](#2-required-dependency--code-simplifier) for the details and the bare-machine fix.
- **† Graph skills** (`debug-issue`, `explore-codebase`, `refactor-safely`, `review-changes`) require the **`code-review-graph` MCP server** (a public PyPI package). See [Setup → graph skills](#3-optional-graph-skills-code-review-graph) to install it; MCP servers can't be plugin dependencies, so this stays a documented prerequisite.

## Recommended plugins

Other Claude Code plugins I run alongside `claude-skills`. (`code-simplifier` isn't here — it's already a required dependency and installs automatically.)

They all live in Claude Code's built-in **`claude-plugins-official`** marketplace, so one command installs each:

```
/plugin install code-review@claude-plugins-official
/plugin install context7@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
/plugin install pr-review-toolkit@claude-plugins-official
/plugin install gopls-lsp@claude-plugins-official
/plugin install pyright-lsp@claude-plugins-official
/plugin install typescript-lsp@claude-plugins-official
```

| Plugin | What it does |
|---|---|
| `code-review` | Automated PR review with multiple agents + confidence scoring |
| `context7` | MCP server for up-to-date, version-specific library docs |
| `frontend-design` | Distinctive, production-grade frontend UI generation |
| `pr-review-toolkit` | PR-review agents — comments, tests, error handling, type design, quality |
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
