---
name: plan-and-implement-task
description: Implement one task end to end — planner (fable) drafts a plan read-only, the skill gates it with the user via the interactive plan-approval dialog, then lead-orchestrator (fable) implements it through subagents. Run it from plan mode. REQUIRES a request describing what to implement. Use when the user invokes /plan-and-implement-task or asks to plan and implement a feature end to end with the agent team.
argument-hint: "[what you want implemented]"
---

# Plan and Implement Task

Implement one task end to end through a team of agents: `planner` (fable) drafts the plan
read-only, YOU gate it with the user, `lead-orchestrator` (fable) runs the implementation,
`deep-reasoner` (opus) handles the hard thinking, `fast-worker` (sonnet) executes
mechanical work.

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

If the request above is empty, ask the user what they want implemented and STOP — do not
proceed without one.

## Flow

1. **Check the permission mode.** Step 3's gate is `ExitPlanMode`, which the harness
   rejects unless the session is in plan mode — so this skill is meant to be invoked
   **from plan mode**. If it is not, call `EnterPlanMode` (main-thread only; it throws in
   agent contexts). If that is unavailable or the user declines, fall back to the
   `AskUserQuestion` gate described in step 7 and say plainly that the richer approval
   dialog was unavailable. Never skip the gate because the tool was missing.

2. **Draft.** Spawn `claude-skills:planner` (`model: "fable"`, `run_in_background: false`)
   with a self-contained prompt — subagents see nothing of this conversation:
   - the request, verbatim;
   - the current working directory;
   - any constraints or context the user gave alongside the request.

   It returns the complete plan document as text. There is no file to read.

3. **Gate.** `ExitPlanMode` is a deferred tool and it takes **no plan parameter** in this
   build: it reads the plan from the plan file the harness designates in the plan-mode
   system message. So, in order:

   1. `ToolSearch({ query: "select:ExitPlanMode", max_results: 1 })` to load its schema.
   2. Write the planner's returned document verbatim to that designated plan file. In plan
      mode it is the one file you are allowed to write.
   3. Call `ExitPlanMode` with no arguments.

   The harness renders the approval dialog and owns the loop:
   - **Open questions** → if the planner had doubts, the plan's first section is
     `## Open questions`; the user answers by choosing "No, keep planning" and typing
     answers, which reach you as rejection feedback.
   - **Reject with feedback** → re-spawn `planner` with the previous plan plus the feedback
     verbatim, overwrite the same designated plan file, and call `ExitPlanMode` again.
     Repeat until approved. Rejection does not leave plan mode and the designated path is
     stable for the session, so this loop is safe to repeat.
   - **Approve** → implementation begins; approving with "auto-accept edits" lets it
     proceed without per-edit prompts.

4. **Save.** Only after approval, copy the approved plan into the project at
   `.claude/plans/<YYYY-MM-DD>-<slug>.md` (`date +%Y-%m-%d`; create the directory if
   needed). The order matters: before approval the only file you may write is the
   harness's designated plan file from step 3.

5. **Implement.** Spawn `claude-skills:lead-orchestrator` (`model: "fable"`,
   `run_in_background: false`) with the request verbatim, the working directory, and the
   approved plan path, stating that the plan is already user-approved so its Phase 1 is
   satisfied. Do NOT implement anything yourself — the lead owns the rest of the
   lifecycle: it executes the plan's task waves via `claude-skills:deep-reasoner` /
   `claude-skills:fast-worker` (parallel within a wave, max 5 concurrent; serial across
   waves), supervises them against the plan, and finishes with its own code review of the
   full change set.

6. **Relay.** When the lead returns, relay its final report to the user: outcome, plan file
   path, files changed, code-review findings and resolutions, success-checklist
   verification (with evidence), and deviations. Do not editorialize or re-verify — the
   report is the deliverable. If the lead reports unverified or failed checklist items,
   surface them plainly.

7. **Re-plan.** If the lead's final message starts with `REPLAN NEEDED`, it stopped
   mid-flight because reality contradicted the plan. Print the revised plan document it
   returned in full, then gate it with `AskUserQuestion`: *Approve revised plan* /
   *Revise (type notes)* / *Abort*.

   This gate is `AskUserQuestion`, not `ExitPlanMode`: approval in step 3 already took the
   session out of plan mode, so a second `ExitPlanMode` call would fail validation for the
   same reason this whole design exists. On approve, overwrite the plan file from step 4
   and re-spawn the lead with that path plus the lead's completed-work summary. On revise,
   hand the notes to `planner` and re-gate. Allow at most **two** re-plan rounds, then stop
   and report where it stalled.

## Notes

- Run this skill from **plan mode**. The gate lives in this skill's own thread and
  `ExitPlanMode` is only valid there while the session is in plan mode. (This is the
  opposite of the old guidance, which said to run from the default mode and blamed session
  mode for suppressing the dialog. Both halves were wrong: the planner's `permissionMode`
  was being discarded at load, so the session mode was never the cause.)
- Only the user can switch permission modes; the "switch to auto after approval" happens
  through the user's choice in the plan-approval dialog.
- The approved plan is saved to `.claude/plans/<date>-<slug>.md` in the current project.
