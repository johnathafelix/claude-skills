---
name: ts-check
description: Run all TypeScript quality checks (strong types, no magic values, data over logic, redundant-variable inlining) on changed files and report violations with file:line and fixes. Dispatches one focused read-only agent per guideline via the Workflow tool (falling back to a direct fan-out if Workflow is unavailable). USE WHEN working with TypeScript code and you want a comprehensive quality pass.
---

# TypeScript Quality Check — Orchestrator

Check changed TypeScript code against the project's quality guidelines. Each check is a self-contained rule spec under `guidelines/`, so this skill has no dependency on any other skill.

**This skill reports; it does not edit by default.** Surface findings and let the user decide. Only apply fixes if the user explicitly asks — Step 5 is opt-in.

**This skill dispatches its check via the `Workflow` tool.** Invoking `/ts-check` is your instruction to call it — no separate confirmation needed. **Dispatching is not the same as finishing:** `Workflow` returns a task ID immediately and the run completes in the background. Do not conclude the turn on that task ID — wait for the completion notification and present its `findings` / `unverified` before you stop, especially if this run was triggered by the `enforce-ts-check.js` Stop hook (it only blocks once per turn, so nothing else will catch a premature stop).

## Procedure

### Step 1 — Determine base branch and scope

First, determine the correct base branch to diff against:

1. Check if a PR exists for the current branch: `gh pr view --json baseRefName --jq '.baseRefName'`
2. If a PR exists, use the returned base branch name (e.g. `develop`, `feature/parent`, etc.)
3. If no PR exists (command fails), fall back to `main`

Store the result as `BASE_BRANCH` and use `origin/$BASE_BRANCH` for subsequent diff commands.

Then identify the TypeScript files to analyse. Use the same scope for all sub-checks:

- If the user specified files or directories, use those.
- Otherwise, run `git fetch origin $BASE_BRANCH` then use `git diff origin/$BASE_BRANCH --name-only --diff-filter=ACM` filtered to `*.ts` and `*.tsx` files.
- If there are no changed files, fall back to the files in the current working directory (non-recursive).

Filter the result and **exclude**: `*.d.ts` (declaration/generated), `node_modules/`, `*.gen.ts` / `*.gen.tsx`, anything under `.claude/`, and OS temp trees. **Tests are IN scope** — do not exclude `*.test.ts` / `*.spec.ts`.

If the scope is empty, report that there is nothing to check and stop.

### Step 2 — Discover guidelines (do not read them)

The 4 checks live in the `guidelines/` directory that sits **alongside this SKILL.md**. Resolve that directory to an absolute path from this SKILL.md's own location — do **not** hardcode a home directory (the skill may be installed under `~/.claude/plugins/…`, not `~/.claude/skills/…`).

**Do not `Read` the guideline bodies here.** They total ~2,400 lines across the 4 files; the old version of this skill read all of them into this context so it could paste them verbatim into each sub-agent. Each checker agent now Reads its own guideline from the absolute path you pass it. *This is the single biggest win of this design — do not reintroduce the reads.*

Get each guideline's line count with **one** command: `wc -l guidelines/*.md`. Ignore the trailing `total` line — it is not a guideline. Each per-file count becomes that guideline's `lines`, used as a proof-of-read check on the agent that applies it; pass that agent the same absolute path so both sides run the identical command against the identical file.

There is no version gate for ts-check (unlike golang-check) — none of the 4 guidelines declare a minimum version, so there is nothing to check or skip here.

The guideline set is a **fixed four, in priority order** — that order drives fix-conflict resolution in Step 5:

1. `strong-types.md`
2. `no-magic-values.md`
3. `data-over-logic.md`
4. `redundant-variable-inline.md`

**Drift check:** if `wc -l guidelines/*.md` surfaces a file not in that list, report it as unranked and unchecked rather than silently ignoring it or guessing a priority.

Build the two args you'll pass to the check:

```
files = [ <the Step 1 list> ]              # one flat list, shared by all 4 checks

guidelines = [                              # ORDER IS PRIORITY — do not reorder
  { stem: "strong-types",              path: "<abs>/guidelines/strong-types.md",              lines: <from wc -l> },
  { stem: "no-magic-values",           path: "<abs>/guidelines/no-magic-values.md",           lines: <from wc -l> },
  { stem: "data-over-logic",           path: "<abs>/guidelines/data-over-logic.md",            lines: <from wc -l> },
  { stem: "redundant-variable-inline", path: "<abs>/guidelines/redundant-variable-inline.md",  lines: <from wc -l> },
]
```

### Step 3 — Run the check

**Primary path — `Workflow`:**

```
Workflow({
  scriptPath: "<absolute dir from Step 2>/workflow.js",
  args: { guidelines, files, changeNote: "<one-line note of what changed>" },
})
```

Pass `args` as a real JSON object, not a JSON-encoded string. The script fans each guideline out to its own `claude-skills:ts-quality-checker` agent, capped at 4 concurrent, retries a guideline twice on a failed proof-of-read, and returns `{ findings, findingCount, unverified, priorityOrder }` — `findings` already sorted by file → line → priority, and each finding stamped with its guideline's `priority` rank (1 = `strong-types`, 4 = `redundant-variable-inline`).

**Fallback path — direct fan-out — only if `Workflow` is unavailable:**

Dispatch each guideline to its own `claude-skills:ts-quality-checker` agent — the **same restricted agent** used by the primary path, not `general-purpose`, so the read-only guarantee holds even without the script — **at most 4 at a time, awaiting each batch before the next**. Each prompt must name its guideline by absolute path (Read it IN FULL — the fallback agent does need to open it here, since there is no script to hand it a pre-resolved path list), give the in-scope files, apply only that one guideline, and end with this output contract as the entire final message — nothing before or after:

```json
{"file":"relative/path.ts","line":42,"rule":"<guideline stem>","description":"what is wrong, specifically","suggestedFix":"before -> after"}
```

A single JSON array, `[]` if nothing found. Treat a result as **derailed — not a clean pass** — if it doesn't parse as a JSON array or the agent made 0 tool calls; re-dispatch derailed guidelines, and after 2 retries still derailing, report that guideline as **UNVERIFIED**. There is no schema to force a proof-of-read count on this path, so this weaker non-JSON/0-tool-call detector is what you have — don't try to retrofit the `wc -l` proof-of-read into prose.

**On this path you must assign `priority` yourself**, from the Step 2 list order (1 = `strong-types` … 4 = `redundant-variable-inline`) — nothing stamps it automatically the way the script does.

### Step 4 — Consolidate and present findings

1. Use the returned `findings` as-is (already sorted file → line → priority on the primary path; sort it yourself the same way on the fallback path). Do not re-sort by rule name.
2. Where several findings share a `file:line`, combine into one action item listing every rule, keeping the lowest-`priority` rule first — that's the one that wins in Step 5.
3. Present as a numbered checklist. State the count and check it against `findingCount` as a sanity check on the script's own aggregation (they come from the same `return` statement, so a mismatch means a script bug, not a truncated transport — if the finding count seems too low for a large diff, read the run's own `tasks/<id>.output` file directly rather than trusting only the notification text).
4. **Always list `unverified` explicitly as a coverage gap, never a clean pass.** An UNVERIFIED guideline was never actually applied, so it contributed zero findings — do not report the code as clean against it. If `findings` is empty *and* `unverified` is empty, the code is clean against all four guidelines.

### Step 5 — Fixes (only when asked)

Do not modify code as part of the check. If the user asks to fix findings:

1. Apply each accepted finding with Edit. If a fix for one rule conflicts with another (e.g., a magic-string enum creation affects a data-over-logic refactor), resolve using the finding's stamped `priority` (lower number wins) — in human-readable terms: **strong-types > no-magic-values > data-over-logic > redundant-variable-inline** (type safety first, then naming, then structure, then cosmetic inlining last).
2. **Line numbers go stale as you edit — anchor on code, not on `line`.** Every finding's `line` was measured against the pre-edit file, and the first Edit in a file invalidates every later line number in it. Locate each edit by the code quoted in `suggestedFix`. Applying findings within one file in descending line order helps, but doesn't fully solve this: a higher-priority fix can change or remove the exact code a lower-priority finding's `suggestedFix` quotes, so the anchor can vanish even applying strictly bottom-to-top. **This is expected, not an error** — when an anchor no longer matches after a higher-priority edit, re-read the file, re-evaluate whether the finding still applies, and drop it if the higher-priority fix already resolved or invalidated it. Never force-apply a stale fix by line number alone.
3. Verify with `npx tsc --noEmit` (if a tsconfig exists) and the project's lint command if present (`npm run lint` or similar); report anything still failing. Restate any `unverified` guidelines in this same summary so the coverage gap stays visible alongside the verification result.
4. Mark each item done.
