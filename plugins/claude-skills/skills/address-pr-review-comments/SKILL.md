---
name: address-pr-review-comments
description: Address PR review comments end to end, verification first — a fable verifier checks every comment against the codebase (widening to sibling repos for cross-system contracts) and an adversarial challenger attacks each verdict, the user settles anything the code cannot, `planner` (fable) drafts a fix plan that the skill gates with the user, `lead-orchestrator` (opus) implements it, a dedicated xhigh/opus code review runs on the new code, `deep-reasoner` designs an auto-approved fix plan, `fast-worker` applies it, then the work is committed to the same branch and a short reply is posted in each review thread — the fix, or why the reviewer's reasoning does not hold. Run it from plan mode. Use when the user invokes /address-pr-review-comments.
argument-hint: "[review comments to address, or empty to fetch them from the PR]"
---

# Address PR Review Comments

Take a PR's review comments from "someone left feedback" to "fixed, pushed, and answered"
— but **verify before you build**. Review comments are often right about the code and
wrong about the assumption behind it. Implementing a reviewer's mistake writes their
mistake into the codebase, so nothing gets planned until it survives verification.

The pipeline: fetch the unresolved threads → a fable verifier per comment (plus an
adversarial challenger on every verdict) → ask the user about anything the code cannot
settle → `planner` (fable) drafts a fix plan and YOU gate it → `lead-orchestrator`
(opus) implements → xhigh/opus code review on the new code → `deep-reasoner` fix plan →
`fast-worker` applies → `/git-commit` → push → `/update-pr-description` → one short reply
per thread.

Everything happens on the **current branch and its existing PR**. This skill never
creates a branch and never creates a PR.

**This skill spans many turns** — your own gates, and two backgrounded `Workflow` runs.
On any resume, re-read the plan files under `.claude/plans/` referenced below rather than
trusting what's still in context.

**The approval gates are yours, not a subagent's.** Subagents have no `ExitPlanMode` and
no `AskUserQuestion`: the harness discards `permissionMode` from plugin agent frontmatter,
and it only grants `ExitPlanMode` to an agent whose own definition declares plan mode. So
`planner` returns plan *text* and you present it, and the verifier returns *questions* and
you ask them. Do not delegate a gate downward — it will silently degrade into "here is a
plan, pending approval" with nothing gating it.

**This skill's phases supersede the harness's generic plan-mode workflow reminder.** Do
not run its Explore/Plan phases and do not call `ExitPlanMode` with a plan of your own —
plans come from `claude-skills:planner`, except on the rebuttal-only path in Phase 9.

## The input

The input is: **$ARGUMENTS**

If it is non-empty, treat it as the review comments the user wants addressed — but still
run the Phase 1 fetch, because pasted text carries no thread ID and one has to be
recovered before any reply can be posted.

If it is empty, fetch every unresolved review thread from the PR. That is the normal case.

## Phase 0 — Preflight

1. `git branch --show-current`. If `main` or `master`, STOP — that is not a PR branch.
2. Resolve the PR:
   `gh pr view --json number,url,state,baseRefName,headRefName,author`.
   If there is no PR, STOP and tell the user to open one first. If `state` is not `OPEN`,
   STOP — do not push to a merged or closed PR. Record `PR_NUMBER`, `PR_URL`,
   `BASE_BRANCH` (`baseRefName`) and `PR_AUTHOR` (`author.login`).
3. Assert `headRefName` equals the current branch. If it does not, STOP: you are not on
   the branch this PR would push to.
4. Staleness check, **read-only**: compare local `HEAD` against
   `git ls-remote origin <current branch>`. Use `ls-remote`, not a fetch — the session is
   in plan mode here and fetching writes to `.git`. If the remote is ahead, STOP and point
   the user at `/merge`. Finding this out after the whole pipeline runs would waste it.
5. `git status --porcelain` to snapshot pre-existing dirty files, for attributing later
   diffs.
6. Resolve the sibling-repo search root:
   `SIBLING_ROOT="${SIBLING_REPOS_ROOT:-$(dirname "$(git rev-parse --show-toplevel)")}"`.
   Resolve `ORG` from `gh repo view --json owner --jq .owner.login`.
7. Check the permission mode. Phase 4's gate is `ExitPlanMode`, which the harness rejects
   unless the session is in plan mode — so this skill is meant to be invoked **from plan
   mode**. If it is not, call `EnterPlanMode` (main-thread only; it throws in agent
   contexts) before Phase 4. If that is unavailable or the user declines, fall back to an
   `AskUserQuestion` gate and say plainly that the richer approval dialog was unavailable.
   Never skip a gate because the tool was missing.

## Phase 1 — Collect the review threads

Fetch threads with GraphQL. REST `pulls/{n}/comments` has no `isResolved` field, so it
cannot tell you what is still open:

```bash
gh api graphql -f query='
query($owner:String!,$repo:String!,$num:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$num){
      reviewThreads(first:100){
        nodes{
          id isResolved isOutdated path line
          comments(first:50){ nodes{ databaseId author{login} body createdAt diffHunk } }
        }
      }
      reviews(first:50){ nodes{ author{login} state body } }
    }
  }
}' -F owner=<owner> -F repo=<repo> -F num=$PR_NUMBER
```

Build the working set:

- Keep threads with `isResolved == false`. Keep them **even when `isOutdated`** — the code
  moved but the concern may still stand; flag them as outdated so the verifier judges the
  code as it exists now.
- Flatten each thread's comments into one `body` string (`@login: text`, in order), and
  truncate `diffHunk` to ~40 lines. The workflow script has no filesystem access, so
  everything it needs travels in `args`.
- **Already-answered guard.** Because this skill never resolves threads, nothing on GitHub
  marks one as handled — so a second invocation would re-verify and double-reply to every
  thread. Skip any thread whose **last** comment author is `PR_AUTHOR` or the current user
  (`gh api user --jq .login`). A thread where the reviewer replied *after* our reply has a
  reviewer as its last author, so it correctly re-enters the pipeline. Comments passed in
  `$ARGUMENTS` bypass this filter — an explicit request overrides the heuristic.
- **Pasted comments.** For each comment in `$ARGUMENTS`, match it back to a fetched thread
  by substring to recover its real thread ID. An unmatched one is still verified and fixed,
  but its reply is printed for the user in the final message instead of posted — there is
  no thread to post it to.

**Out of scope: review-level summary bodies** (`reviews.nodes[].body`). They are not
anchored to a line, have no thread to reply into, and — because the already-answered guard
keys on a thread's last comment author — nothing would stop a re-run from posting a
duplicate. Inline threads are what this skill addresses. If a review summary raises
something substantive, mention it in the final message so the user can decide, but do not
verify or reply to it.

If the working set is empty, STOP and report that there is nothing unresolved to address.

**Fan-out cap.** Phase 2 spawns one fable verifier per thread. If the working set exceeds
**10** threads, list them and confirm with `AskUserQuestion` before dispatching — the same
threshold `investigate-issue` uses before touching more than 10 repos.

## Phase 2 — Verify (nested `Workflow`, fable + adversarial challenge)

**Stage the script first.** `Workflow` rejects a `scriptPath` it did not itself return
unless the file sits under the working directory or a directory added to the session.
Installed as a plugin, this skill's scripts live under `~/.claude/plugins/cache/...`,
which is neither, so passing that path directly fails with *"scriptPath must be a script
path this tool returned, or a file you can already read"*. Copy the script into the
session scratchpad directory (the absolute path is given in your environment) and
dispatch from there — never into the user's repo, whose working tree this skill inspects
with `git ls-files --others` in Phase 6:

```bash
cp "<absolute dir of this SKILL.md>/verify-workflow.js" "<scratchpad>/verify-workflow.js"
```

If the session declares no scratchpad directory, read the script in full and pass its
contents as `script` instead of `scriptPath` — that has no directory dependency at all.

```
Workflow({
  scriptPath: "<scratchpad>/verify-workflow.js",
  args: { threads: [...], siblingRoot: SIBLING_ROOT, org: ORG, baseBranch: BASE_BRANCH, prNumber: PR_NUMBER },
})
```

Each entry in `threads` must have exactly these keys — the script reads them by name:

```
{ id, path, line, isOutdated, diffHunk, body }
```

`id` is the GraphQL `reviewThreads.nodes[].id` (the reply mutation needs it back in Phase
9), and `body` is the flattened conversation from Phase 1.

Resolve `<absolute dir of this SKILL.md>` from this file's own location and normalize it
to an absolute path — do not hardcode a home directory; the skill runs from
`~/.claude/plugins/cache/...`. Pass `args` as a real JSON object, not a JSON-encoded string.

Each thread gets a verifier that reads the real code, widens to a sibling repo only when
the comment turns on a cross-system contract, and returns one of `valid` / `invalid` /
`question` / `needs-user-input`. Every verdict then gets an independent challenger whose
job is to attack it. The challenger's resolution is deliberately asymmetric: a refuted
`invalid` or `question` becomes `valid` (an unneeded fix is cheap), while a refuted `valid`
becomes `needs-user-input` (a disagreement about changing code is the user's call).

**Dispatching is not finishing.** `Workflow` returns a task ID immediately and the run
completes in the background — do not close the turn on that ID. Wait for the completion
notification, then read `{ verdicts, counts, unverified, unchallenged }`. Carry
`unverified` and `unchallenged` to the final message; an unchallenged verdict is not the
same as a confirmed one.

## Phase 2b — Clarify with the user

For every `needs-user-input` verdict, ask the user with `AskUserQuestion`, quoting the
reviewer's comment and the verifier's `userQuestion`. Batch at most **4 questions per
call** (the tool's cap) and loop if there are more.

Then re-dispatch the same workflow with only those threads plus
`userAnswers: { "<threadId>": "<the user's answer>" }`. **One round only** — a verdict that
comes back `needs-user-input` a second time is reported to the user as unresolved and takes
no code change.

⚠️ **Merge the second run into the first; do not replace it.** The re-dispatch is scoped to
a subset, so its `verdicts` and `counts` cover only that subset. Merge by `threadId` —
second-run verdicts replace their round-1 entries, every other round-1 verdict carries
forward unchanged — then recompute `counts` over the merged set. Reading the second run's
`counts` directly would tell Phase 3 that nothing is `valid` and silently drop every fix
found in round 1.

## Phase 3 — Branch

If `counts.valid` is 0, there is nothing to build: skip Phases 4–8 entirely and go to
Phase 9 on its **rebuttal-only** path. Running a planner over an empty task list is exactly
the failure this branch prevents.

⚠️ **The two paths need different gates, and the wrong one deadlocks the skill.** Phase 0
put the session in plan mode, and the only thing that leaves it is Phase 4's
`ExitPlanMode`. Phase 9 posts a GraphQL mutation, which plan mode forbids.

- **Code-change path** (`counts.valid >= 1`): plan mode ends at Phase 4. Phase 9 gates with
  `AskUserQuestion`. A second `ExitPlanMode` after approval fails validation.
- **Rebuttal-only path** (`counts.valid == 0`): still in plan mode. Phase 9 writes the
  drafted replies to the harness's designated plan file and gates with `ExitPlanMode` —
  one call that both confirms the replies and makes the mutation legal.

## Phase 4 — Fix plan, gated by you

**4a — Draft.** Spawn `claude-skills:planner` with `model: "fable"` and
`run_in_background: false`. Subagents see nothing of this conversation, so the prompt must
be self-contained: every `valid` verdict with its reviewer comment, reasoning, evidence and
`proposedFix`; the current working directory; `BASE_BRANCH`; and `PR_NUMBER`. State
explicitly that **the plan must be scoped to these review comments only** — no adjacent
refactors, no drive-by improvements. It returns the plan document as text; there is no file
to read.

**4b — Gate.** `ExitPlanMode` is a deferred tool and takes **no plan parameter** in this
build: it reads the plan from the file the harness designates in the plan-mode system
message. So, in order:

1. `ToolSearch({ query: "select:ExitPlanMode", max_results: 1 })` to load its schema.
2. Write the planner's document verbatim to that designated plan file. In plan mode it is
   the one file you may write.
3. Call `ExitPlanMode` with no arguments.

**4c — Iterate.** On rejection with feedback, re-spawn `planner` with the previous plan plus
the feedback verbatim, overwrite the same file, and call `ExitPlanMode` again. Repeat until
approved. If the plan's first section is `## Open questions`, that is the planner asking —
the user answers by choosing "No, keep planning" and typing answers, which reach you as
rejection feedback.

**4d — Save.** Only after approval, copy the plan to
`.claude/plans/<YYYY-MM-DD>-pr-<PR_NUMBER>-review-fixes.md` (`date +%Y-%m-%d`; create the
directory if needed). Record this path — Phases 6 and 7 need it.

## Phase 5 — Implement, polling the lead (`lead-orchestrator`, opus)

Spawn `claude-skills:lead-orchestrator` with `model: "opus"`, a `name` of `lead`, and **in
the background** (`run_in_background: true` — the `Agent` tool backgrounds by default).
Background is required so you can poll it; a blocking spawn would freeze this thread with
no turn in which to poll or notice a stall. Phase 6 still gets the finished diff — you do
not proceed to it until the poll loop below sees the lead signal completion.

Self-contained prompt: the approved plan path from 4d, the current working directory,
`BASE_BRANCH`, a note that the plan is already user-approved so its own Phase 1 is
satisfied, and this instruction verbatim. Record the `agentId` the spawn returns and fall
back to it if a `to: "lead"` send errors.

> You run in the background and I will poll you with `STATUS POLL` messages — answer each
> briefly and keep working. When you are fully done, `SendMessage` `main` your final report
> beginning with the line `IMPLEMENTATION COMPLETE` (or `REPLAN NEEDED` on the re-plan
> path). That message is what releases me.

Then poll until the lead signals completion. Load the deferred tools first:
`ToolSearch({ query: "select:Monitor,SendMessage,TaskStop", max_results: 3 })`. If the
select does not return `TaskStop` (Task tools can be gated off on some models), run the loop
anyway and just stop acting on ticks once the lead completes — a stray heartbeat is harmless
and ends with the session. The stall guard needs **durable state** (each tick is a separate
turn): keep a log at `<scratchpad>/address-pr-poll-state.tsv` and append to it on every tick
and lead message.

- **Arm a heartbeat:**
  `Monitor({ command: "while true; do sleep 150; echo tick; done", description: "address-pr lead poll heartbeat", persistent: true })`.
- **On each `tick`:** read `git status --porcelain` (the guard's fetch-free signal;
  `git diff --stat origin/$BASE_BRANCH` is visibility only and may be stale until Phase 6's
  fetch), append `TICK<TAB><epoch><TAB>files=<porcelain line count>` to the state file, then
  `SendMessage({ to: "lead", message: "STATUS POLL" })`.
- **On a lead message:** append `MSG<TAB><epoch><TAB><first line>` to the state file. If it
  begins `IMPLEMENTATION COMPLETE`, `TaskStop` the heartbeat, record the files changed, and
  go to Phase 6. Beginning `REPLAN NEEDED`: `TaskStop` the heartbeat and take the re-plan
  branch below. Anything else is an interim `STATUS:` line — keep polling. The lead's
  background task-completion notification is an equivalent "done" signal.
- **Stall guard:** escalate to the user only when the last three `TICK` rows show an
  unchanged `files` count AND no `MSG` row falls after the third-from-last `TICK` — never on
  lead silence alone.

If the lead's final report flags an unresolved checklist item, that is not fatal here —
Phase 6 re-examines the same diff regardless.

If the lead's message starts with `REPLAN NEEDED`, print the revised plan it returned in
full and gate it with `AskUserQuestion` (*Approve revised plan* / *Revise (type notes)* /
*Abort*). This gate is `AskUserQuestion`, not `ExitPlanMode` — approval in 4b already left
plan mode. On approve, overwrite the plan file from 4d and re-spawn the lead with the same
background-spawn and poll loop above. Allow at most **two** re-plan rounds, then stop and
report where it stalled.

## Phase 6 — Code review (nested `Workflow`, xhigh + opus)

This reviews the code the pipeline just wrote, not the reviewer's comments.

Scout the diff inline first — the workflow script has no filesystem access. Union tracked
changes with untracked new files; on the "add a new module" case most new code is still
untracked, so `--diff-filter=ACM` alone would silently review the wrong subset:

```bash
git fetch origin $BASE_BRANCH
git diff origin/$BASE_BRANCH --name-only --diff-filter=ACM
git ls-files --others --exclude-standard
```

Dedupe into one `files` array. If it is empty, log that there is nothing to review and skip
to Phase 8.

Otherwise dispatch `ship-task`'s reviewer — it is already generic over its args, so this
skill reuses it rather than carrying a second copy:

Stage it in the scratchpad the same way as Phase 2 — the plugin-cache path is rejected by
`Workflow` on its own:

```bash
cp "<absolute dir of this SKILL.md>/../ship-task/workflow.js" "<scratchpad>/ship-task-workflow.js"
```

```
Workflow({
  scriptPath: "<scratchpad>/ship-task-workflow.js",
  args: { files: <the diff list>, baseBranch: BASE_BRANCH, changeNote: "<one-line summary of what was fixed>", planPath: "<Phase 4d plan path>" },
})
```

Normalize the source path to an absolute one before the `cp` rather than leaving `..` for
the runtime to resolve. Wait for the completion notification, then read
`{ findings, findingCount, dimensionsUnverified }`. Report any `dimensionsUnverified`
plainly later — an unverified dimension is not a clean pass on it. If `findingCount` is 0,
log a clean review and skip to Phase 8.

## Phase 7 — Fix the review findings

**7a — Fix plan (`deep-reasoner`, opus, auto-approved).** Spawn
`claude-skills:deep-reasoner` with `model: "opus"` and `run_in_background: false`. Give it
the confirmed findings (file, line, description, suggestedFix, dimension) and the Phase 4d
plan path, and require wave-structured output:

```
### Wave N
**T1 — <one-line objective>**
- Files: <exact paths>
- Do: <what to change>
- Verify: <command and expected result>
```

Group independent fixes (disjoint files) into one wave; serialize fixes touching the same
file. `deep-reasoner` is analysis-only, so write its returned text to
`.claude/plans/<YYYY-MM-DD>-pr-<PR_NUMBER>-review-fixes-followup.md` yourself. There is no
approval gate here by design.

**7b — Apply (`fast-worker`, sonnet).** **One wave = one message containing that wave's
`Agent` calls, every one with `run_in_background: false`.** That is the wave barrier:
multiple calls in one message give concurrency within the wave, and
`run_in_background: false` is what stops wave N+1 from dispatching before wave N's files
exist. Cap at 5 concurrent.

```
Agent({ subagent_type: "claude-skills:fast-worker", model: "sonnet", run_in_background: false, prompt: `
Task: <task id and objective>
Plan: read <absolute followup-plan path>, task <T-n> applies to you
Files: <exact paths to touch>
Conventions: <style/idiom constraints from the plan>
Done means: <verify command and expected result>
Report: files changed, verification output, deviations
` })
```

Supervise each result against the plan — right files, verify command actually passed. On a
contradiction, stop the wave and report rather than improvising a work-around.

**7c — Final check (`deep-reasoner`, opus).** Analysis only. Give it both plan paths, the
confirmed findings, the `valid` verdicts from Phase 2, and `git diff origin/$BASE_BRANCH`.
Ask for a per-item verdict, not a summary:

- every `valid` review comment: addressed / partially addressed / not addressed
- every code-review finding: fixed / not fixed
- every success-checklist item from Phase 4: pass / fail, with evidence

On any gap, run exactly **one** remediation pass (`claude-skills:fast-worker`,
`model: "sonnet"`, `run_in_background: false`) targeted at the specific gaps, then re-run
this check once. Do not loop beyond that.

**Guard:** if the second check still reports an item as outright **failed** (not partial),
STOP — do not commit, do not push, do not post replies. Report what failed and why. Posting
"fixed in `<sha>`" for something that is not fixed is worse than posting nothing.

## Phase 8 — Ship to the same branch

Strictly serial:

1. `Skill({ skill: "claude-skills:git-commit", args: "<one-line hint: addressed PR review comments>" })`
2. `git push` to the current branch. **Never** `/draft-pr` — the PR already exists.
3. `Skill({ skill: "claude-skills:update-pr-description" })`

Record the pushed short SHA (`git rev-parse --short HEAD`); the replies cite it.

## Phase 9 — Reply in each thread

Draft one reply per thread that reached a settled verdict — `valid`, `invalid`, or
`question`. A thread still `needs-user-input` after Phase 2b, or listed in `unverified`,
gets **no reply at all**: it appears only in the final message. There is nothing truthful
to say in a thread nobody actually judged, and a placeholder reply in front of a human
reviewer is worse than silence.

The reviewer reads these in a narrow column next to their own comment, so **≤4 lines
each**. Complete, but nothing they have to wade through.

- **Fixed** — what changed, `file:line`, and the short SHA.
  > Fixed in `a1b2c3d`. `parseConfig` now returns an error instead of a zero value when the
  > file is missing — `internal/config/config.go:42`.
- **Rebuttal** — evidence first, conclusion second. This is the case the user cares most
  about, so it must be checkable, not assertive.
  > `client.go:88` already normalizes the path before the call, so the double-slash case
  > can't reach this branch. Leaving as is.
- **Question** — answer it directly, with the file reference that supports the answer.
- **Cross-system** — cite the sibling repo explicitly, e.g. *`orders-api/openapi.yaml:214`
  defines `status` as a string enum, so the SDK's int is wrong.*

Banned: "great catch", "good point", restating their comment back at them, hedging,
emoji, and any Claude/AI attribution. `hooks/gh-pr-guard.js` only inspects
`gh pr create` / `gh pr edit`, so it will **not** catch attribution on this path — the rule
is yours to keep.

Render every draft grouped by thread, then gate once using the path chosen in Phase 3:

- **Code-change path** — `AskUserQuestion`: *Post all* / *Edit first* / *Skip posting*. On
  *Edit first*, apply the user's changes and re-render before posting.
- **Rebuttal-only path** — write the drafts to the harness's designated plan file and call
  `ExitPlanMode`. On rejection with feedback, re-draft, overwrite the same file, and call
  it again, exactly as in 4c: rejection does not leave plan mode and the designated path is
  stable for the session, so the loop is safe to repeat until the user approves.

Post each reply by thread ID. Write the body to a scratch file first so newlines survive:

```bash
gh api graphql -f query='
mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId, body:$body}){
    comment{ url }
  }
}' -f threadId="$THREAD_ID" -f body="$(cat <reply file>)"
```

For pasted comments that never matched a thread, print the reply in the final message
instead — do not guess a thread, and do not fall back to `gh pr comment`, which posts to
the conversation tab where the reviewer will not see it next to their comment.

**Never call `resolveReviewThread`.** Resolving is the reviewer's call, and it is the only
signal the already-answered guard in Phase 1 leaves them.

## Final message to the user

A table, one row per thread: reviewer comment (truncated), verdict, what was done, reply
URL. Then: both plan file paths, the files changed, the code-review findings and how each
was resolved (or "clean"), the short SHA, and `PR_URL`.

State plainly, without burying it: any `unverified` or `unchallenged` thread from Phase 2,
any verdict still `needs-user-input` after Phase 2b, any `dimensionsUnverified` from Phase
6, and any reply that could not be posted. If Phase 7's guard stopped the pipeline, say
that instead of reporting a commit.
