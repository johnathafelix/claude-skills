---
name: ts-check
description: Run all TypeScript quality checks (strong types, no magic values, data over logic) on changed files and fix every issue found. USE WHEN working with TypeScript code and you want a comprehensive quality pass.
---

# TypeScript Quality Check — Orchestrator

Run the TypeScript quality analyses in parallel, collect their findings, then apply all fixes in one pass. Each check is a self-contained rule spec under `guidelines/`, so this skill has no dependency on any other skill.

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

If the scope is empty, report that there is nothing to check and stop.

### Step 2 — Load guidelines

Every check lives in its own file in the `guidelines/` directory that sits **alongside this SKILL.md**. Resolve that directory to an absolute path from this SKILL.md's own location — do **not** hardcode a home directory (the skill may be installed under `~/.claude/plugins/…`, not `~/.claude/skills/…`).

Read all four guideline files, in this **priority order** (it drives fix-conflict resolution in Step 5):

1. `guidelines/strong-types.md`
2. `guidelines/no-magic-values.md`
3. `guidelines/data-over-logic.md`
4. `guidelines/redundant-variable-inline.md`

The full text of each file is passed verbatim to its corresponding sub-agent in Step 3.

### Step 3 — Launch one sub-agent per guideline (parallel)

Spawn one `general-purpose` Agent call per guideline **in the same message** (parallel). Each agent must:

1. Receive the full rules text of its guideline from Step 2.
2. Receive the list of in-scope files from Step 1, with a one-line note of what changed (focus the check on the changed lines).
3. Read those files.
4. Apply **only** that one guideline to find violations; report only findings it is confident about (prefer silence over a shaky flag).
5. Return a structured list of findings: `{ file, line, rule, description, suggestedFix }`, where `rule` is the guideline's filename stem (e.g. `strong-types`, `redundant-variable-inline`).

**Do NOT make edits inside the sub-agents — they only analyse and report.**

### Step 4 — Merge and deduplicate findings

After all agents return:

1. Merge all findings into a single list, sorted by file then line number.
2. Deduplicate — if two checks flag the same line, keep both rules but combine into one action item.
3. Present the consolidated list to the user as a numbered checklist.

### Step 5 — Apply fixes

For each finding in the consolidated list:

1. Read the target file (if not already in context).
2. Apply the suggested fix using the Edit tool.
3. If a fix for one rule conflicts with another (e.g., magic-string enum creation affects a data-over-logic refactor), resolve in this priority order: **strong-types > no-magic-values > data-over-logic > redundant-variable-inline** (type safety first, then naming, then structure, then cosmetic inlining last).
4. Mark the item as done.

### Step 6 — Verify

After all edits:

1. Run `npx tsc --noEmit` (if a tsconfig exists) to confirm no type errors were introduced.
2. If the project has a lint command (`npm run lint` or similar), run that too.
3. Report any remaining errors and fix them before declaring done.
