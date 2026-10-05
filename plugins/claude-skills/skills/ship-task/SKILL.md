---
name: ship-task
description: Ship one task end to end using the existing agent team — planner (fable) drafts a plan that the skill gates with the user via the interactive plan-approval dialog, lead-orchestrator (opus) implements it via fast-worker (sonnet) and deep-reasoner (opus), then a dedicated xhigh/opus code review runs, deep-reasoner designs a fix plan the user approves, fast-worker applies it, deep-reasoner verifies, and the result is committed with a draft PR and description. Run it from plan mode. REQUIRES a task description. Use when the user invokes /ship-task.
argument-hint: "[what you want shipped]"
---

# Ship Task

Take a task from description to an open, described PR through the existing agent team:
`planner` (fable) drafts the plan and YOU gate it with the user; `lead-orchestrator`
(opus) implements it via `fast-worker` (sonnet) and `deep-reasoner` (opus); a dedicated
code review runs at xhigh effort on opus; `deep-reasoner` designs a fix plan
and YOU gate it; `fast-worker` applies it; `deep-reasoner` verifies; then `/git-commit` →
`/draft-pr` → `/update-pr-description` ship it; `/compact-comments` runs last.

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

1. `git branch --show-current`. If `main` or `master`, create a feature branch before
   anything else — `/draft-pr` in Phase 6 refuses to run from either, and finding that
   out after the whole pipeline runs would waste it. Pick the name:
   - **Linear ticket in the request** (an issue ID like `ENG-123` or a `linear.app/.../issue/...`
     URL): load `mcp__claude_ai_Linear__get_issue` via `ToolSearch`, fetch the issue, and
     use its `gitBranchName` verbatim.
   - **Otherwise**, or if the Linear lookup fails or returns no `gitBranchName`: derive
     `<type>/<slug>` from the request — `<type>` is the conventional-commit type that
     fits (`feat`, `fix`, `refactor`, `chore`, `docs`, …), `<slug>` is 3–6 lowercase
     kebab-case words capturing the task (e.g. `feat/add-csv-export-to-reports`).

   Run `git switch -c <name>` (uncommitted changes carry over). If the branch already
   exists: for a Linear name, `git switch <name>` — it is the same ticket's branch; for a
   derived name, append `-2`, `-3`, … until it is free. Tell the user the branch name in
   one line. Creating the branch is allowed in plan mode — it changes no file contents.
   Remember the branch you started on (`main` or `master`) as `ORIGIN_BRANCH`.
2. `git status --porcelain` to snapshot pre-existing dirty files, for context if later
   diffs need to be attributed.
3. Determine `BASE_BRANCH`: `gh pr view --json baseRefName --jq '.baseRefName'`; if that
   fails (no PR yet), use `ORIGIN_BRANCH` when step 1 created the branch, else `main`.
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

**1e — Implement, polling the lead.** Spawn `claude-skills:lead-orchestrator` with
`model: "opus"`, a `name` (use `lead`), and **in the background** (`run_in_background:
true` — the `Agent` tool backgrounds by default). Background is required here: you are
going to poll the lead, and a blocking `run_in_background: false` spawn would freeze this
thread until the lead finished, leaving no turn in which to poll or to notice a stall.
Phase 2 still gets the finished diff — you do not proceed to it until the poll loop below
sees the lead signal completion.

Self-contained prompt: the request verbatim, the current working directory, `BASE_BRANCH`,
the approved plan path from 1d (state that the plan is already user-approved so its Phase 1
is satisfied), and this instruction verbatim. Record the `agentId` the spawn returns:
address polls to `lead` by name, and fall back to that id if a name-addressed
`SendMessage` ever errors.

> You run in the background and I will poll you with `STATUS POLL` messages — answer each
> briefly and keep working. When you are fully done, `SendMessage` `main` your final report
> beginning with the line `IMPLEMENTATION COMPLETE` (or `REPLAN NEEDED` on the re-plan
> path). That message is what releases me.

The lead owns everything through its own Phase 4: it executes the plan's waves via
`fast-worker`/`deep-reasoner` (blocking on each wave with `run_in_background: false`), runs
its own Phase 3 self-review, and verifies its success checklist.

Then run this poll loop until the lead signals completion. Load the deferred tools first:
`ToolSearch({ query: "select:Monitor,SendMessage,TaskStop", max_results: 3 })`. If the
select does not return `TaskStop` (Task tools can be gated off by default on some models),
run the loop anyway — just stop acting on ticks once the lead completes; a stray persistent
heartbeat is harmless and ends with the session.

1. **Arm the heartbeat** — one persistent `Monitor` that ticks on a fixed cadence:

   ```
   Monitor({ command: "while true; do sleep 150; echo tick; done", description: "ship-task lead poll heartbeat", persistent: true })
   ```

   A `Monitor` survives a forgotten re-arm, unlike a one-shot background `sleep`; one tick
   every ~150s is well below Monitor's rate-limit auto-stop.

   Each tick and each lead message is a separate turn, so the stall guard needs **durable
   state**, not memory: keep a running log at `<scratchpad>/ship-task-poll-state.tsv` and
   append to it on every tick and every lead message. Without this a future turn has nothing
   to compare against and the guard silently never fires.

2. **On each `tick`**, in one turn:
   - Read ground truth. `git status --porcelain` is the guard's signal — it is fetch-free
     and reliable here. `git diff --stat origin/$BASE_BRANCH` and
     `git ls-files --others --exclude-standard` are for visibility only, and the diffstat may
     be stale until Phase 2's `git fetch` runs, so do not key the guard on it.
     ```bash
     git status --porcelain
     git ls-files --others --exclude-standard
     git diff --stat origin/$BASE_BRANCH   # visibility only; may be stale pre-fetch
     ```
   - Append one row to the state file: `TICK<TAB><epoch><TAB>files=<count of porcelain lines>`.
   - `SendMessage({ to: "lead", message: "STATUS POLL" })` — drives the lead forward if it
     is idle, and queues harmlessly if it is blocked inside a wave.

3. **On any message from the lead:** append `MSG<TAB><epoch><TAB><first line>` to the state
   file, then: if it begins `IMPLEMENTATION COMPLETE`, the run is done — `TaskStop` the
   heartbeat, record the files changed from that report, and go to **1g**. If it begins
   `REPLAN NEEDED`, `TaskStop` the heartbeat and go to **1f**. Anything else is an interim
   `STATUS:` line — keep polling. The lead's background task-completion notification is an
   equivalent "done" signal: if it arrives, `TaskStop` the heartbeat, use the final
   report the lead sent to `main`, and go to **1g**.

4. **Stall guard.** Read the state file. Escalate to the user **only** when the last **three
   `TICK` rows show an unchanged `files` count AND no `MSG` row falls after the third-from-
   last `TICK`** — then `TaskStop` the heartbeat and report the stall plainly, quoting the
   last status and the frozen file list. Never escalate on lead silence alone: silence
   during a long wave is normal, which is why an intervening `MSG` row resets the guard.

If the lead's final report flags an unresolved checklist item, do not treat that as fatal
here — Phase 2's dedicated review independently re-examines the same diff regardless.

**1f — Re-plan.** If the lead's message starts with `REPLAN NEEDED`, it stopped
mid-flight because reality contradicted the plan. Print the revised plan document it
returned to the user in full, then gate it with `AskUserQuestion`: *Approve revised plan*
/ *Revise (type notes)* / *Abort pipeline*.

This gate is `AskUserQuestion`, not `ExitPlanMode`: approval in 1b already took the
session out of plan mode, so a second `ExitPlanMode` call would fail validation for the
same reason this whole design exists. On approve, overwrite the plan file from 1d and
re-spawn the lead with that path plus the lead's completed-work summary, using the same
background-spawn and poll loop as 1e. On revise, hand the notes to `planner` and re-gate.
Allow at most **two** re-plan rounds, then stop and report where it stalled.

**1g — Quality checks + simplifier.** These are opt-in checks the harness no longer
runs on its own, so this skill runs them explicitly — the language checks scoped to the
language(s) the implementation actually touched, the test check over the whole change:

```bash
git diff origin/$BASE_BRANCH --name-only --diff-filter=ACM
git ls-files --others --exclude-standard
```

Dedupe into one changed-file list.

1. If any file matches `*.ts` or `*.tsx` (excluding `*.d.ts`), run
   `Skill({ skill: "claude-skills:ts-check", args: "<the matching files>" })`.
2. If any file matches `*.go` (excluding `vendor/` and generated files), run
   `Skill({ skill: "claude-skills:golang-check", args: "<the matching files>" })`.
3. Skip whichever check has no matching files — do not run `ts-check` on a Go-only
   change or `golang-check` on a TS-only one.
4. Run `Skill({ skill: "claude-skills:test-check", args: "<the full changed-file list>" })`
   once. It is not language-gated: it splits the given files into source and test files
   and judges the tests behind the change (coverage of new lines, assertion fidelity and
   strictness, DB integration, mock expectations). Pass the deduped list explicitly — its
   own `git diff` scope would miss the untracked files the workers created, the same trap
   Phase 2 guards against. Skip it only when the changed-file list contains no code at all
   (docs/config-only change). When its notification arrives, keep its confirmed `findings`
   as `TEST_FINDINGS` — Phase 3 plans fixes for them alongside the code-review findings.
5. After whichever of the three ran, run
   `Skill({ skill: "claude-skills:simplify-code", args: "<the full changed-file list>" })`
   once. The simplifier is not language-gated, so run it even when no check matched.

All three checks report only — they do not edit. `ts-check`/`golang-check` findings are
carried into the final message the same way Phase 2's `dimensionsUnverified` is carried;
nothing in this step auto-fixes them. `test-check` findings are different: they are
already independently verified, and each carries an `action`, so they are **acted on** —
`TEST_FINDINGS` feeds Phase 3's fix plan and Phase 5 checks each one as fixed / not fixed.
Still carry its `refuted`, `unchallenged`, and UNVERIFIED lists into the final message —
a finding it dropped or could not verify is part of the report, not noise.

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

If `findingCount` is 0 **and** `TEST_FINDINGS` from 1g is empty, log that the review was
clean and skip to Phase 5. If either list is non-empty, continue to Phase 3 with whichever
lists have entries — a clean code review does not skip the test fixes, and vice versa.

## Phase 3 — Fix plan (`deep-reasoner`, opus, user-approved)

Spawn `claude-skills:deep-reasoner` with `model: "opus"` and `run_in_background: false`.
Give it: the confirmed findings from Phase 2 (file, line, description, suggestedFix,
dimension), `TEST_FINDINGS` from 1g (file, line–endLine, rule, description, rationale,
action — the `action` is the fix to plan; for `coverage` findings it names the uncovered
ranges to write tests for), the Phase 1 plan path for context on intended behavior, and an
explicit instruction to structure its output as **waves**, matching `lead-orchestrator`'s own
task-breakdown format so Phase 4 can execute it the same way:

```
### Wave N
**T1 — <one-line objective>**
- Files: <exact paths>
- Do: <what to change>
- Verify: <command and expected result>
```

Group independent fixes (disjoint files) into the same wave; serialize fixes that touch
the same file. Test fixes must satisfy the guideline that raised them, not just silence
it: a `db-integration` finding is fixed by a test against a real engine (reuse the repo's
existing harness if the finding names one), an `assertion-strictness` finding by the
actual value or a typed matcher, a `mock-expectations` finding by asserting both halves,
a `coverage` finding by tests that exercise the named ranges with real assertions.

`deep-reasoner` is analysis-only and will not write files itself — write its returned
text to `.claude/plans/<YYYY-MM-DD>-<slug>-fixes.md` yourself.

**Gate it.** Print the fixes plan in full, followed by the findings it covers (file:line,
dimension, description), so the user can check it does not diverge from what the review
found. Then `AskUserQuestion`: *Approve fixes plan* / *Revise (type notes)* / *Skip
fixes*. This is `AskUserQuestion`, not `ExitPlanMode`, for the same reason as 1f.

- **Approve** — continue to Phase 4.
- **Revise** — re-spawn `deep-reasoner` with the same inputs plus the user's notes,
  overwrite the same fixes file, and gate again.
- **Skip fixes** — apply nothing; go straight to Phase 5 and record every finding and
  `TEST_FINDINGS` entry as *skipped by the user*.

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
3's fixes plan, if it exists), the confirmed findings list, `TEST_FINDINGS`, and
`git diff origin/$BASE_BRANCH`. Ask for a per-item verdict, not a summary:

- every implementation-plan task: done / partial / missing
- every code-review finding: fixed / not fixed
- every `test-check` finding: fixed / not fixed — "fixed" means the test now asserts or
  covers what the finding's `action` asked for, not merely that a test was touched
- every success-checklist item from Phase 1: pass / fail, with evidence

Findings the user skipped at the Phase 3 gate are not gaps: leave them out of the
verdict list, the remediation pass, and the guard below.

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

## Phase 7 — Compact comments

Runs last, after the PR exists, so no later phase can re-inflate what it trims. Skip it
if Phase 5's guard stopped the pipeline.

1. `Skill({ skill: "claude-skills:compact-comments" })` — no args: it diffs against the
   PR base itself, so its scope is every comment added in this PR.
2. If its report lists edited files, `Skill({ skill: "claude-skills:git-commit", args:
   "compact PR comments: <those files>" })` then `git push`. Pass exactly those files —
   `git status --porcelain` would also list pre-existing dirty files from Phase 0 and any
   untracked plan files, which this commit must not pick up. If it edited nothing, there
   is nothing to ship.

## Final message to the user

Report: outcome, both plan file paths, files changed (implementation + fixes), 1g's
`ts-check`/`golang-check` findings (or "clean"/"skipped, no matching files"), 1g's
`test-check` findings and how each was resolved (plus its refuted/unchallenged/UNVERIFIED
lists), the simplifier's summary, the code-review findings and how each was resolved (or
"clean" / list any `dimensionsUnverified`), the Phase 3 gate's outcome (approved /
revised / skipped — list skipped findings), the final check's per-item verdict, Phase 7's
compact-comments report (with its follow-up commit SHA, if any), and the PR URL. If
Phase 5's guard stopped the pipeline before Phase 6, say so plainly instead of the PR URL.
