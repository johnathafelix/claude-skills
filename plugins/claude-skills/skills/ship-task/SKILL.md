---
name: ship-task
description: Ship one task end to end using the existing agent team — planner (fable) drafts a plan that the skill gates with the user via the interactive plan-approval dialog, lead-orchestrator (opus) implements it via fast-worker (sonnet) and deep-reasoner (opus), then a dedicated xhigh/opus code review runs, deep-reasoner designs an auto-approved fix plan, fast-worker applies it, deep-reasoner verifies, and the result is committed with a draft PR and description. Run it from plan mode. REQUIRES a task description. Use when the user invokes /ship-task.
argument-hint: "[what you want shipped]"
---

# Ship Task

Take a task from description to an open, described PR through the existing agent team:
`planner` (fable) drafts the plan and YOU gate it with the user; `lead-orchestrator`
(opus) implements it via `fast-worker` (sonnet) and `deep-reasoner` (opus); a dedicated
code review runs at xhigh effort on opus; `deep-reasoner` designs an auto-approved fix
plan; `fast-worker` applies it; `deep-reasoner` verifies; then `/git-commit` →
`/draft-pr` → `/update-pr-description` ship it.

**This skill spans many turns** — your own plan-approval dialog in Phase 1, and a
backgrounded `Workflow` review in Phase 2. On any resume, re-read the plan files under
`.claude/plans/` referenced below rather than trusting what's still in context.

**The approval gate is yours, not the planner's.** Subagents have no `ExitPlanMode` tool:
the harness discards `permissionMode` from plugin agent frontmatter, and it only grants
`ExitPlanMode` to an agent whose own definition declares plan mode. So `planner` returns
plan *text* and you present it. Do not delegate the gate downward — it will silently
degrade into "here is a plan, pending approval" with nothing gating it.

**This skill's phases supersede the harness's generic plan-mode workflow reminder.** Do
not run its Explore/Plan phases and do not call `ExitPlanMode` with a plan of your own —
the plan comes from `claude-skills:planner`.

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
4. Check the permission mode. Phase 1's gate is `ExitPlanMode`, which the harness rejects
   unless the session is in plan mode — so this skill is meant to be invoked **from plan
   mode**. If it is not, call `EnterPlanMode` (main-thread only; it throws in agent
   contexts) before Phase 1b. If that is unavailable or the user declines, fall back to
   the `AskUserQuestion` gate described in Phase 1f and say plainly that the richer
   approval dialog was unavailable. Never skip the gate because the tool was missing —
   that is the exact failure this design exists to prevent.

## Phase 1 — Plan, gate, implement

Do not research, plan, or implement anything yourself. You draft through `planner`, own
the approval dialog, and implement through `lead-orchestrator`.

**1a — Draft.** Spawn `claude-skills:planner` with `model: "fable"` and
`run_in_background: false`. Subagents see nothing of this conversation, so the prompt must
be self-contained: the request verbatim, the current working directory, and `BASE_BRANCH`.
It returns the complete plan document as text — there is no file to read.

**1b — Gate.** `ExitPlanMode` is a deferred tool and it takes **no plan parameter** in
this build: it reads the plan from the plan file the harness designates in the plan-mode
system message. So, in order:

1. `ToolSearch({ query: "select:ExitPlanMode", max_results: 1 })` to load its schema.
2. Write the planner's returned document verbatim to that designated plan file. In plan
   mode it is the one file you are allowed to write.
3. Call `ExitPlanMode` with no arguments.

The harness renders the approval dialog and owns the approve / auto-accept-edits /
reject-with-feedback loop.

**1c — Iterate.** On rejection with feedback, re-spawn `planner` with the previous plan
plus the feedback verbatim, overwrite the same designated plan file, and call
`ExitPlanMode` again. Repeat until approved. Rejection does not leave plan mode and the
designated path is stable for the session, so this loop is safe to run as many times as
the user wants. If the returned plan's first section is `## Open questions`, that is the
planner asking — the user answers by choosing "No, keep planning" and typing answers,
which reach you as rejection feedback.

**1d — Save.** Only after approval, copy the approved plan into the project at
`.claude/plans/<YYYY-MM-DD>-<slug>.md` (`date +%Y-%m-%d`; create the directory if needed).
The order matters: before approval the only file you may write is the harness's designated
plan file from 1b. Record this path — Phases 3 and 5 need it, and it is what the lead
reads.

**1e — Implement.** Spawn `claude-skills:lead-orchestrator` with `model: "opus"` and
`run_in_background: false` (the `Agent` tool backgrounds by default — this call must
block, since Phase 2 needs the finished diff). Self-contained prompt: the request
verbatim, the current working directory, `BASE_BRANCH`, and the approved plan path from
1d, stating that the plan is already user-approved so its Phase 1 is satisfied. The lead
owns everything through its own Phase 4: it executes the plan's waves via
`fast-worker`/`deep-reasoner`, runs its own Phase 3 self-review, and verifies its success
checklist.

Read the lead's final message in full and record the list of files changed. If it reports
an unresolved checklist item, do not treat that as fatal here — Phase 2's dedicated review
independently re-examines the same diff regardless.

**1f — Re-plan.** If the lead's final message starts with `REPLAN NEEDED`, it stopped
mid-flight because reality contradicted the plan. Print the revised plan document it
returned to the user in full, then gate it with `AskUserQuestion`: *Approve revised plan*
/ *Revise (type notes)* / *Abort pipeline*.

This gate is `AskUserQuestion`, not `ExitPlanMode`: approval in 1b already took the
session out of plan mode, so a second `ExitPlanMode` call would fail validation for the
same reason this whole design exists. On approve, overwrite the plan file from 1d and
re-spawn the lead with that path plus the lead's completed-work summary. On revise, hand
the notes to `planner` and re-gate. Allow at most **two** re-plan rounds, then stop and
report where it stalled.

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

Otherwise stage the script somewhere `Workflow` will accept, then dispatch.

`Workflow` rejects a `scriptPath` it did not itself return unless the file sits under the
working directory or a directory added to the session. When this skill is installed as a
plugin its `workflow.js` lives under `~/.claude/plugins/cache/...`, which is neither, so
passing that path directly fails with *"scriptPath must be a script path this tool
returned, or a file you can already read"*. Copy it into the session scratchpad
directory (the absolute path is given in your environment) and dispatch from there:

```bash
cp "<absolute dir of this SKILL.md>/workflow.js" "<scratchpad>/ship-task-workflow.js"
```

Do **not** copy it into the user's repo instead: an untracked file there would be picked
up by the diff scouting above and reviewed as if it were part of the change. If the
session declares no scratchpad directory, read `workflow.js` in full and pass its
contents as `script` instead of `scriptPath` — that path has no directory dependency at
all, at the cost of ~3k tokens in this context.

```
Workflow({
  scriptPath: "<scratchpad>/ship-task-workflow.js",
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
