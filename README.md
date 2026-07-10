# claude-skills

My personal [Claude Code](https://claude.com/claude-code) skills and hooks, packaged as an installable plugin.

This repo is a **plugin marketplace** containing a single plugin, `claude-skills`, that bundles:

- **14 skills** — dev-workflow helpers for git, PRs, TDD, TypeScript/Go quality, REST API review, and code-graph navigation.
- **1 agent** — `go-idiom-checker`, the restricted sub-agent the `golang-check` skill fans out to.
- **5 hooks** — guardrails for safe commits/PRs and post-turn quality enforcement.

## Install

```
/plugin marketplace add johnathafelix/claude-skills
/plugin install claude-skills@claude-skills
```

Then restart Claude Code (or run `/plugin`) and the skills + hooks are active. To update later:

```
/plugin marketplace update claude-skills
```

## What's inside

### Skills

| Skill | What it does |
|---|---|
| `git-commit` | Commit staged/unstaged changes with conventional messages |
| `draft-pr` | Push unpushed commits and open a draft PR |
| `merge` | Merge the PR base into your branch, resolve conflicts, verify, push |
| `update-pr-description` | Regenerate a PR description from its commits |
| `grill-me` | Stress-test a plan or design with relentless questioning |
| `tdd` | Test-driven development (red-green-refactor) |
| `write-pending-unit-tests` | Write tests for files changed vs. the base branch |
| `golang-check` | Check Go code against Go conventions (fans out per-guideline) |
| `ts-check` | Run all TypeScript quality checks (strong types, no magic values, data over logic, redundant-variable inlining) on changed files — self-contained, fans out per-guideline |
| `check-rest-api-design` | Review a REST/HTTP API against design best practices |
| `debug-issue` | Systematically debug using graph-powered navigation † |
| `explore-codebase` | Navigate codebase structure via the knowledge graph † |
| `refactor-safely` | Plan/execute refactors using dependency analysis † |
| `review-changes` | Risk-aware code review via change detection + impact † |

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

- **Required plugin dependency: `code-simplifier`** (from the official `claude-plugins-official` marketplace). The `auto-code-simplifier.js` Stop hook drives its agent, so it's declared as a hard dependency in `plugin.json` and is **auto-installed** when you install `claude-skills`. This needs the `claude-plugins-official` marketplace to be registered — it's Claude Code's built-in official marketplace, so it's present by default; if it isn't, add it once with `claude plugin marketplace add anthropics/claude-plugins-official` (the plugin will tell you if it's missing).
- **† Graph skills** (`debug-issue`, `explore-codebase`, `refactor-safely`, `review-changes`) require the private **`code-review-graph` MCP server**. Without it they have nothing to call — install/configure that MCP first, or ignore these four skills. (MCP servers can't be plugin dependencies, so this stays a documented soft prerequisite.)

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
