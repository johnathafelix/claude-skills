---
name: ts-check
description: Run all TypeScript quality checks (strong types, no magic values, data over logic, object params over positional args, redundant-variable inlining) on changed files and report violations with file:line and fixes. Dispatches one focused read-only agent per guideline via the Workflow tool (falling back to a direct fan-out if Workflow is unavailable). Use PROACTIVELY before finishing a nontrivial TypeScript change or opening a PR — pass the changed files; skip it for a trivial edit. Also runs directly via /ts-check.
model: opus
---

# TypeScript Quality Check — Orchestrator

Check changed TypeScript code against the project's quality guidelines. Each check is a self-contained rule spec under `guidelines/`, so this skill has no dependency on any other skill.

**This skill reports; it does not edit by default.** Surface findings and let the user decide. Only apply fixes if the user explicitly asks — Step 5 is opt-in.

**This skill dispatches its check via the `Workflow` tool.** Invoking `/ts-check` is your instruction to call it — no separate confirmation needed. **Dispatching is not the same as finishing:** `Workflow` returns a task ID immediately and the run completes in the background. Do not conclude the turn on that task ID — wait for the completion notification and present its `findings` / `unverified` before you stop.

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

**Do not `Read` the guideline bodies here.** They total ~2,400 lines across the 4 files; the old version of this skill read all of them into this context so it could paste them verbatim into each sub-agent. Each checker agent now Reads its own guideline from the absolute path the staged script hands it. *This is the single biggest win of this design — do not reintroduce the reads.*

Stage the check's script instead: one command copies `workflow.js` into the session scratchpad and injects every guideline's proof-of-read anchors (absolute path, `wc -l` line count, first line, last non-empty line), computed from the files themselves. **Never compute or hand-copy those anchors yourself** — a single mistyped character in a long last line fails the gate and reports the guideline UNVERIFIED.

`$G` stands for the **absolute** `guidelines/` directory you just resolved, and `<scratchpad>` for the scratchpad directory named in your environment — substitute the real paths before running:

```bash
node "$(dirname '$G')/../../scripts/stage-workflow.js" '$G' "$(dirname '$G')/workflow.js" "<scratchpad>/ts-check-workflow.js"
```

It prints one `stem <TAB> absolute path <TAB> first line` row per guideline; the fallback path in Step 3 uses that path. Stage into the scratchpad, not the user's repo, where it would show up as an untracked file. If the session declares no scratchpad directory, stage to a `mktemp` path instead.

There is no version gate for ts-check (unlike golang-check) — none of the 5 guidelines declare a minimum version, so there is nothing to check or skip here.

The guideline set is a **fixed five, in priority order** — that order drives fix-conflict resolution in Step 5:

1. `strong-types.md`
2. `no-magic-values.md`
3. `data-over-logic.md`
4. `object-params.md`
5. `redundant-variable-inline.md`

**Drift check:** if the staging command prints a stem not in that list, report it as unranked and unchecked rather than silently ignoring it or guessing a priority.

Build the two args you'll pass to the check:

```
files = [ <the Step 1 list> ]              # one flat list, shared by all 4 checks

guidelines = [                              # keep this order; see the note below
  { stem: "strong-types" },                 # stem only; the staged script holds path + anchors
  { stem: "no-magic-values" },
  { stem: "data-over-logic" },
  { stem: "object-params" },
  { stem: "redundant-variable-inline" },
]
```

**Order is informational on the primary path.** The `Workflow` script derives each finding's `priority` from its own canonical list, keyed by `stem`, so a mis-ordered array can no longer silently invert the ranking — it logs the disagreement instead. Keep the canonical order anyway: **the fallback path still assigns `priority` by hand from it** (Step 3), and a guideline whose stem the script does not recognise is ranked last with a warning.

### Step 3 — Run the check

**Primary path — `Workflow`:**

Dispatch the script staged in Step 2. `Workflow` rejects a `scriptPath` it did not itself return unless the file sits under the working directory or a directory added to the session, which is why it is staged into the scratchpad rather than passed from the plugin cache. If you staged to a `mktemp` path (no scratchpad), read that staged file in full and pass its contents as `script` instead of `scriptPath`. This is the one file this skill may read into context (~475 lines): it is the script being executed, not a guideline body, so it does not reintroduce the reads Step 2 forbids. Never dispatch the unstaged `workflow.js` — it stops with "copied, not staged".

```
Workflow({
  scriptPath: "<scratchpad>/ts-check-workflow.js",
  args: { guidelines, files, changeNote: "<one-line note of what changed>" },
})
```

Pass `args` as a real JSON object, not a JSON-encoded string. The script fans each guideline out to its own `claude-skills:ts-quality-checker` agent **pinned to `model: "opus"`** (a weaker inherited model degrades these checks invisibly — a shallow read returns `[]`, indistinguishable from a clean pass), capped at 4 concurrent, retries a guideline twice on a failed proof-of-read (line count **plus** first line **plus** last non-empty line — the two anchors are what make a head-only or file-never-opened read detectable), and returns `{ findings, findingCount, unverified }` — `findings` already sorted by file → line → priority, and each finding stamped with its guideline's `priority` rank (1 = `strong-types`, 5 = `redundant-variable-inline`).

**Fallback path — direct fan-out — only if `Workflow` is unavailable:**

Dispatch each guideline to its own `claude-skills:ts-quality-checker` agent **with `model: "opus"`** — the **same restricted agent** used by the primary path, not `general-purpose`, so the read-only guarantee holds even without the script — **at most 4 at a time, awaiting each batch before the next**. Each prompt must name its guideline by absolute path (Read it IN FULL — the fallback agent does need to open it here, since there is no script to hand it a pre-resolved path list), give the in-scope files, apply only that one guideline, and end with this output contract as the entire final message — nothing before or after:

```json
{"file":"relative/path.ts","line":42,"rule":"<guideline stem>","description":"what is wrong, specifically","suggestedFix":"before -> after"}
```

A single JSON array, `[]` if nothing found. Treat a result as **derailed — not a clean pass** — if it doesn't parse as a JSON array or the agent made 0 tool calls; re-dispatch derailed guidelines, and after 2 retries still derailing, report that guideline as **UNVERIFIED**. There is no schema to force a proof-of-read count on this path, so this weaker non-JSON/0-tool-call detector is what you have — don't try to retrofit the `wc -l` proof-of-read into prose.

**On this path you must assign `priority` yourself**, from the Step 2 list order (1 = `strong-types` … 5 = `redundant-variable-inline`) — nothing stamps it automatically the way the script does.

### Step 4 — Consolidate and present findings

1. Use the returned `findings` as-is (already sorted file → line → priority on the primary path; sort it yourself the same way on the fallback path). Do not re-sort by rule name.
2. Where several findings share a `file:line`, combine into one action item listing every rule, keeping the lowest-`priority` rule first — that's the one that wins in Step 5.
3. Present as a numbered checklist. State the count and check it against `findingCount` as a sanity check on the script's own aggregation (they come from the same `return` statement, so a mismatch means a script bug, not a truncated transport — if the finding count seems too low for a large diff, read the run's own `tasks/<id>.output` file directly rather than trusting only the notification text).
4. **Always list `unverified` explicitly as a coverage gap, never a clean pass.** An UNVERIFIED guideline was never actually applied, so it contributed zero findings — do not report the code as clean against it. If `findings` is empty *and* `unverified` is empty, the code is clean against all four guidelines.
5. Check the run's `log` output for `proof-of-read leg DISABLED`, `UNVERIFIED (bad args)`, `worker threw`, `not in the known priority list`, or `dropped … finding(s)` and surface anything you find alongside the findings. Each of those means a check ran with a weakened gate, was skipped over a malformed args entry, was mis-ranked, or lost data — none of which the `findings` list alone will show you.

### Step 5 — Fixes (only when asked)

Do not modify code as part of the check. If the user asks to fix findings:

1. Apply each accepted finding with Edit. If a fix for one rule conflicts with another (e.g., a magic-string enum creation affects a data-over-logic refactor), resolve using the finding's stamped `priority` (lower number wins) — in human-readable terms: **strong-types > no-magic-values > data-over-logic > object-params > redundant-variable-inline** (type safety first, then naming, then structure, then signature shape, then cosmetic inlining last).
2. **Line numbers go stale as you edit — anchor on code, not on `line`.** Every finding's `line` was measured against the pre-edit file, and the first Edit in a file invalidates every later line number in it. Locate each edit by the code quoted in `suggestedFix`. Applying findings within one file in descending line order helps, but doesn't fully solve this: a higher-priority fix can change or remove the exact code a lower-priority finding's `suggestedFix` quotes, so the anchor can vanish even applying strictly bottom-to-top. **This is expected, not an error** — when an anchor no longer matches after a higher-priority edit, re-read the file, re-evaluate whether the finding still applies, and drop it if the higher-priority fix already resolved or invalidated it. Never force-apply a stale fix by line number alone.
3. Verify with `npx tsc --noEmit` (if a tsconfig exists) and the project's lint command if present (`npm run lint` or similar). **Report any remaining errors and fix them before declaring done** — these edits are yours, so leaving the build or lint broken is not an acceptable end state. Restate any `unverified` guidelines in this same summary so the coverage gap stays visible alongside the verification result.
4. Mark each item done.
