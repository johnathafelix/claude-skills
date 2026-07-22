---
name: plan-and-implement-task
description: Implement one task end to end — plan first (read-only, with interactive user approval), then orchestrated implementation via subagents. REQUIRES a request describing what to implement. Use when the user invokes /plan-and-implement-task or asks to plan and implement a feature end to end with the agent team.
argument-hint: "[what you want implemented]"
---

# Plan and Implement Task

Implement one task end to end through a team of agents: `lead-orchestrator` (fable) runs the show, `planner` (fable, plan mode) produces a user-approved plan, `deep-reasoner` (opus) handles the hard thinking, `fast-worker` (sonnet) executes mechanical work.

## The request

The request is: **$ARGUMENTS**

If the request above is empty, ask the user what they want implemented and STOP — do not proceed without one.

## Flow

1. Spawn the `claude-skills:lead-orchestrator` agent (foreground, `run_in_background: false`) with this self-contained prompt:
   - the request, verbatim;
   - the current working directory;
   - any constraints or context the user gave alongside the request.

   Do NOT plan or implement anything yourself — the lead owns the entire lifecycle: it spawns `claude-skills:planner` first, then executes the plan's task waves via `claude-skills:deep-reasoner`/`claude-skills:fast-worker` (parallel within a wave, max 5 concurrent; serial across waves), supervises them against the plan, and finishes with its own code review of the full change set.

2. While the lead runs, the planner presents its plan to the user via the interactive plan-approval dialog:
   - **Open questions** → if the planner has doubts, its draft leads with an `## Open questions` section; the user answers by choosing "No, keep planning" and typing answers.
   - **Reject with feedback** → the planner adjusts and re-presents, repeating until the user confirms.
   - **Approve** → implementation begins; approving with "auto-accept edits" lets the implementation proceed without per-edit prompts.

   The approved plan is saved to `.claude/plans/<date>-<slug>.md` in the current project.

3. When the lead returns, relay its final report to the user: outcome, plan file path, files changed, code-review findings and resolutions, success-checklist verification (with evidence), and deviations. Do not editorialize or re-verify — the report is the deliverable. If the lead reports unverified or failed checklist items, surface them plainly.

## Notes

- Run this skill from the **default** permission mode. In `acceptEdits`, `auto`, or `bypassPermissions` the planner's enforced plan mode is overridden and the interactive approval dialog may not appear (the planner then returns the plan for review in its report instead).
- Only the user can switch permission modes; the "switch to auto after approval" happens through the user's choice in the plan-approval dialog.
