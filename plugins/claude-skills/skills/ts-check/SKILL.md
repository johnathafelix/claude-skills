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

**Do not `Read` the guideline bodies here.** They total ~2,400 lines across the 4 files; the old version of this skill read all of them into this context so it could paste them verbatim into each sub-agent. Each checker agent now Reads its own guideline from the absolute path you pass it. *This is the single biggest win of this design — do not reintroduce the reads.*

The orchestrator needs a few cheap facts per guideline, all obtainable without opening any file individually. Take **one glob-based command per fact**, not a per-file loop.

In every command below, `$G` stands for the **absolute** `guidelines/` directory you just resolved — substitute the real path when you run it. Your working directory is the user's repo, not this skill's directory, so a bare `guidelines/*.md` does not expand here. **Quote the fixed part of the path and leave the `*` unquoted** — `'$G/'*.md` — because a fully quoted glob stops expanding while an unquoted path breaks on a space.

1. **Line count**, via `wc -l '$G/'*.md`. Ignore the trailing `total` line — it is not a guideline. Parse each row as: the count is the **leading integer**, and the path is **everything after that first run of spaces** — do not split on whitespace, or a path such as `/Users/John Smith/…` gets cut in half. Each per-file count becomes that guideline's `lines`, used as a proof-of-read check on the agent that applies it; pass that agent the same absolute path so both sides run the identical command against the identical file. Because the glob is absolute, `wc -l` prints absolute paths, which are exactly the `path` values you need below.
2. **First line + last non-empty line**, via one tab-delimited command with no header lines to strip:

   ```
   awk 'FNR==1{a[FILENAME]=$0} NF{b[FILENAME]=$0} END{for (f in a) printf "%s\t%s\t%s\n", f, a[f], b[f]}' '$G/'*.md
   ```

   Each row is `path <TAB> firstLine <TAB> lastNonEmptyLine` — split on tabs, since guideline bodies contain none. These two strings are **body anchors** for the proof-of-read: they make the checker prove it saw the file's contents, not merely that a command ran. Pass them through **verbatim** as `title` and `lastLine` — do not trim, re-title, or tidy them, and never substitute the filename. The script normalizes whitespace and letter case when it compares, so you do not need to. If you omit either, the script logs a `proof-of-read leg DISABLED` warning and falls back to the line count alone, which is the weaker gate this replaced.

   Three of these five anchors are weak and that is expected: `strong-types.md`, `no-magic-values.md`, and `object-params.md` all end in a bare code fence, so their distinctive titles carry the check. `redundant-variable-inline.md` is weak on both legs and its last line is its own `**Finding fields:**` sentence — pass it through unchanged; the checker is told to quote that as data rather than act on it.

   **Do not take `lines` from this command.** `awk` counts lines read while `wc -l` counts newlines; they disagree by one on a file with no trailing newline, and since the checker agent runs `wc -l`, that would make the guideline's gate permanently unmatchable. Item 1 is authoritative for `lines`.

There is no version gate for ts-check (unlike golang-check) — none of the 5 guidelines declare a minimum version, so there is nothing to check or skip here.

The guideline set is a **fixed five, in priority order** — that order drives fix-conflict resolution in Step 5:

1. `strong-types.md`
2. `no-magic-values.md`
3. `data-over-logic.md`
4. `object-params.md`
5. `redundant-variable-inline.md`

**Drift check:** if `wc -l '$G/'*.md` surfaces a file not in that list, report it as unranked and unchecked rather than silently ignoring it or guessing a priority.

Build the two args you'll pass to the check:

```
files = [ <the Step 1 list> ]              # one flat list, shared by all 4 checks

guidelines = [                              # keep this order; see the note below
  {
    stem:     "strong-types",
    path:     "<abs>/guidelines/strong-types.md",
    lines:    <from wc -l, item 1>,          # NOT the awk row count
    title:    "<item 2 field 2, verbatim>",
    lastLine: "<item 2 field 3, verbatim>",
  },
  { stem: "no-magic-values",           ... },   # same five fields
  { stem: "data-over-logic",           ... },
  { stem: "object-params",             ... },
  { stem: "redundant-variable-inline", ... },
]
```

**Order is informational on the primary path.** The `Workflow` script derives each finding's `priority` from its own canonical list, keyed by `stem`, so a mis-ordered array can no longer silently invert the ranking — it logs the disagreement instead. Keep the canonical order anyway: **the fallback path still assigns `priority` by hand from it** (Step 3), and a guideline whose stem the script does not recognise is ranked last with a warning.

### Step 3 — Run the check

**Primary path — `Workflow`:**

`Workflow` rejects a `scriptPath` it did not itself return unless the file sits under the working directory or a directory added to the session. When this skill is installed as a plugin its `workflow.js` lives under `~/.claude/plugins/cache/...`, which is neither, so passing that path directly fails with *"scriptPath must be a script path this tool returned, or a file you can already read"*. Copy it into the session scratchpad directory (the absolute path is given in your environment) and dispatch from there — not into the user's repo, where it would show up as an untracked file in their working tree. `workflow.js` sits **alongside this SKILL.md**, one level above the `guidelines/` directory resolved in Step 2 — derive it from that same `$G`, and substitute the real absolute paths for `$G` and `<scratchpad>` (the latter is the scratchpad directory named in your environment) before running the copy:

```bash
cp "$(dirname '$G')/workflow.js" "<scratchpad>/ts-check-workflow.js"
```

If the session declares no scratchpad directory, read `workflow.js` in full and pass its contents as `script` instead of `scriptPath` — that path has no directory dependency at all. This is the one file this skill may read into context (~475 lines): it is the script being executed, not a guideline body, so it does not reintroduce the reads Step 2 forbids.

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
