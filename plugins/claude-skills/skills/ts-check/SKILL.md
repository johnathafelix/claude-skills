---
name: ts-check
description: Run all TypeScript quality checks (strong types, no magic values, data over logic) on changed files and fix every issue found. USE WHEN working with TypeScript code and you want a comprehensive quality pass.
---

# TypeScript Quality Check — Orchestrator

Run three TypeScript quality analyses in parallel, collect their findings, then apply all fixes in one pass.

## Procedure

### Step 1 — Determine base branch and scope

First, determine the correct base branch to diff against:

1. Check if a PR exists for the current branch: `gh pr view --json baseRefName --jq '.baseRefName'`
2. If a PR exists, use the returned base branch name (e.g. `develop`, `feature/parent`, etc.)
3. If no PR exists (command fails), fall back to `main`

Store the result as `BASE_BRANCH` and use `origin/$BASE_BRANCH` for subsequent diff commands.

Then identify the TypeScript files to analyse. Use the same scope for all three sub-checks:

- If the user specified files or directories, use those.
- Otherwise, run `git fetch origin $BASE_BRANCH` then use `git diff origin/$BASE_BRANCH --name-only --diff-filter=ACM` filtered to `*.ts` and `*.tsx` files.
- If there are no changed files, fall back to the files in the current working directory (non-recursive).

### Step 2 — Load rules from source skills

Read the three skill definition files to get the **latest** rules:

1. `~/.claude/skills/ts-strong-types/SKILL.md`
2. `~/.claude/skills/ts-no-magic-values/SKILL.md`
3. `~/.claude/skills/ts-data-over-logic/SKILL.md`

Use the Read tool to fetch all three in parallel. The full content of each file will be passed verbatim to its corresponding subagent in Step 3.

### Step 3 — Launch four subagents in parallel

Spawn **four** Agent calls **in the same message** (parallel), one per check. Each agent must:

1. Receive the full rules text loaded from its SKILL.md in Step 2.
2. Receive the list of in-scope files from Step 1.
3. Read those files.
4. Apply the rules to find violations.
5. Return a structured list of findings: `{ file, line, rule, description, suggestedFix }`.

**Do NOT make edits inside the subagents — they only analyse and report.**

#### Subagent A — Strong Types

Pass the full content of `ts-strong-types/SKILL.md` as the rules.

#### Subagent B — No Magic Strings

Pass the full content of `ts-no-magic-values/SKILL.md` as the rules.

#### Subagent C — Data Over Logic

Pass the full content of `ts-data-over-logic/SKILL.md` as the rules.

#### Subagent D — Redundant Variable Inlining

Pass the following rules inline (no external SKILL.md):

**Rule: Inline variables that are declared and immediately returned.**

When a local variable is declared and its only use is the very next `return` statement (no reads, no re-assignments, no further references), inline it into the `return`.

Examples:

```ts
// ❌ Redundant binding
const exportedWorkflow = await this.buildExportWorkflow(workflowId);
return exportedWorkflow;

// ✅ Inlined
return await this.buildExportWorkflow(workflowId);
```

```ts
// ❌ Redundant binding
const result = computeThing(input);
return result;

// ✅ Inlined
return computeThing(input);
```

**Do NOT inline when:**
- The variable is referenced anywhere else (logged, passed to another call, used in a `finally`, etc.).
- The variable has an explicit type annotation that is load-bearing for readability or type-narrowing (e.g., `const x: SpecificType = ...; return x;` where removing the annotation would lose information). In that case, keep the binding.
- The declaration and return are separated by other statements that could change meaning if reordered.
- Inlining would harm debuggability in a way the author clearly intended (e.g., a name that documents intent for a complex expression). Prefer inlining unless the name adds real value beyond the function name itself.

**Return findings as:** `{ file, line, rule: 'redundant-variable-inline', description, suggestedFix }` where `suggestedFix` shows the inlined `return` statement.

### Step 4 — Merge and deduplicate findings

After all three agents return:

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
