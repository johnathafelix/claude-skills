---
name: ship-task
description: Ship one task end to end using the existing agent team — lead-orchestrator plans and implements via planner (fable) and fast-worker (sonnet), then a dedicated xhigh/opus code review runs, deep-reasoner (opus) designs an auto-approved fix plan, fast-worker applies it, deep-reasoner verifies, and the result is committed with a draft PR and description. REQUIRES a task description. Use when the user invokes /ship-task.
argument-hint: "[what you want shipped]"
---

# Ship Task

Take a task from description to an open, described PR through the existing agent team:
`lead-orchestrator` (fable) plans and implements via `planner` (fable) and `fast-worker`
(sonnet); a dedicated code review runs at xhigh effort on opus; `deep-reasoner` (opus)
designs an auto-approved fix plan; `fast-worker` applies it; `deep-reasoner` verifies;
then `/git-commit` → `/draft-pr` → `/update-pr-description` ship it.

**This skill spans many turns** — `lead-orchestrator`'s own plan-approval dialog, and a
backgrounded `Workflow` review. On any resume, re-read the plan files under
`.claude/plans/` referenced below rather than trusting what's still in context.

## The request

The request is: **$ARGUMENTS**

If the request above is empty, ask the user what they want shipped and STOP.

## Phase 0 — Preflight

1. `git branch --show-current`. If `main` or `master`, STOP and tell the user to create
   a feature branch first — `/draft-pr` in Phase 6 refuses to run from either, and
   finding that out after the whole pipeline runs would waste it.
2. `git status --porcelain` to snapshot pre-existing dirty files, for context if later
   diffs need to be attributed.
3. Determine `BASE_BRANCH`: `gh pr view --json baseRefName --jq '.baseRefName'`; if that
   fails (no PR yet), use `main`.

## Phase 1 — Plan and implement (delegate to `lead-orchestrator`)

Spawn `claude-skills:lead-orchestrator` with `model: "fable"` and
`run_in_background: false` (the `Agent` tool backgrounds by default — this call must
block, since Phase 2 needs the finished diff). Prompt is self-contained: the request
verbatim, the current working directory, and `BASE_BRANCH`. Do not plan or implement
anything yourself — the lead owns everything through its own Phase 4: it spawns
`claude-skills:planner` first (which presents the plan for approval via the interactive
`ExitPlanMode` dialog — that IS this pipeline's clarify-until-approved step), executes
the plan's waves via `fast-worker`/`deep-reasoner`, runs its own Phase 3 self-review, and
verifies its success checklist.

Read the lead's final message in full. Record:
- the plan file path (`.claude/plans/...`) — Phase 3 below hands it to `deep-reasoner`;
- the list of files changed.

If the lead reports an unresolved checklist item, do not treat that as fatal here —
Phase 2's dedicated review independently re-examines the same diff regardless.

## Phase 2 — Code review (nested `Workflow`, xhigh + opus)

Scout the diff inline first — the workflow script has no filesystem access. Union
tracked changes with untracked new files, the same trap `lead-orchestrator`'s own Phase 3
already accounts for ("plus untracked files the workers created"). On the common "add a
new module" case most of the new code is still untracked, so `--diff-filter=ACM` alone
would miss it and silently review the wrong subset:

```bash
git fetch origin $BASE_BRANCH
git diff origin/$BASE_BRANCH --name-only --diff-filter=ACM
git ls-files --others --exclude-standard
```

Dedupe the two lists into one `files` array.

If that combined list is empty, log that there is nothing to review and skip to Phase 5.

Otherwise dispatch:

```
Workflow({
  scriptPath: "<absolute dir of this SKILL.md>/workflow.js",
  args: { files: <the diff list>, baseBranch: BASE_BRANCH, changeNote: "<one-line summary of the lead's Outcome>", planPath: "<Phase 1 plan path>" },
})
```

Resolve `<absolute dir of this SKILL.md>` relative to this file's own location — do not
hardcode a home directory; the skill may run from `~/.claude/plugins/cache/...`. Pass
`args` as a real JSON object, not a JSON-encoded string.

**Dispatching is not finishing.** `Workflow` returns a task ID immediately and the run
completes in the background — do not close the turn on that ID. Wait for the completion
notification, then read its `{ findings, findingCount, dimensionsUnverified }`. If
`dimensionsUnverified` is non-empty, say so plainly when you eventually report to the
user — an unverified dimension is not the same as a clean pass on it.

If `findingCount` is 0, log that the review was clean and skip to Phase 5.

## Phase 3 — Fix plan (`deep-reasoner`, opus, auto-approved)

Spawn `claude-skills:deep-reasoner` with `model: "opus"` and `run_in_background: false`.
Give it: the confirmed findings from Phase 2 (file, line, description, suggestedFix,
dimension), the Phase 1 plan path for context on intended behavior, and an explicit
instruction to structure its output as **waves**, matching `lead-orchestrator`'s own
task-breakdown format so Phase 4 can execute it the same way:

```
### Wave N
**T1 — <one-line objective>**
- Files: <exact paths>
- Do: <what to change>
- Verify: <command and expected result>
```

Group independent fixes (disjoint files) into the same wave; serialize fixes that touch
the same file.

`deep-reasoner` is analysis-only and will not write files itself — write its returned
text to `.claude/plans/<YYYY-MM-DD>-<slug>-fixes.md` yourself. There is no approval gate
here by design: proceeding to Phase 4 immediately is the auto-approval the user asked
for.

## Phase 4 — Apply fixes (`fast-worker`, sonnet)

Execute the fixes plan's waves. **One wave = one message containing that wave's `Agent`
calls, every one with `run_in_background: false`.** This is the wave barrier: multiple
calls in one message give concurrency within the wave; `run_in_background: false` on
each is what stops wave N+1 from dispatching before wave N's files exist (the `Agent`
tool backgrounds by default). Cap at 5 concurrent, matching `lead-orchestrator`.

Each task:

```
Agent({ subagent_type: "claude-skills:fast-worker", model: "sonnet", run_in_background: false, prompt: `
Task: <task id and objective>
Plan: read <absolute fixes-plan path>, task <T-n> applies to you
Files: <exact paths to touch>
Conventions: <style/idiom constraints from the plan>
Done means: <verify command and expected result>
Report: files changed, verification output, deviations
` })
```

Supervise each result against the fixes plan — right files, verify command actually
passed. On a contradiction, stop the wave and report rather than improvising a
work-around.

## Phase 5 — Final check (`deep-reasoner`, opus)

Spawn `claude-skills:deep-reasoner` with `model: "opus"` and `run_in_background: false`,
analysis only. Give it: both plan file paths (Phase 1's implementation plan and Phase
3's fixes plan, if it exists), the confirmed findings list, and
`git diff origin/$BASE_BRANCH`. Ask for a per-item verdict, not a summary:

- every implementation-plan task: done / partial / missing
- every code-review finding: fixed / not fixed
- every success-checklist item from Phase 1: pass / fail, with evidence

If it reports any gap, run exactly **one** remediation pass
(`claude-skills:fast-worker`, `model: "sonnet"`, `run_in_background: false`) targeted at
the specific gaps, then re-run this same check once more. Do not loop beyond that.

**Guard:** if the second check still reports an item as outright **failed** (not
partial) after the remediation pass, STOP here — do not proceed to Phase 6. Report to
the user what failed and why, plainly, without committing broken work. A partial-but-
improving item does not trigger this guard.

## Phase 6 — Ship

Strictly serial — each step depends on the previous one:

1. `Skill({ skill: "claude-skills:git-commit", args: "<one-line hint summarizing the shipped change>" })`
2. `Skill({ skill: "claude-skills:draft-pr" })`
3. `Skill({ skill: "claude-skills:update-pr-description" })`

`draft-pr` needs the commit pushed first; `update-pr-description` needs the PR to exist
first.

## Final message to the user

Report: outcome, both plan file paths, files changed (implementation + fixes), the
code-review findings and how each was resolved (or "clean" / list any
`dimensionsUnverified`), the final check's per-item verdict, and the PR URL. If Phase 5's
guard stopped the pipeline before Phase 6, say so plainly instead of the PR URL.
