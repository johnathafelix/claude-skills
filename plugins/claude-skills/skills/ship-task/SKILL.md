---
name: ship-task
description: "Implement an approved task, run scoped quality checks and independent review, fix in-scope issues, verify, commit and open a draft PR. Chooses fast, standard or thorough execution based on risk. Use when the user invokes /ship-task with a task description."
argument-hint: "[fast|standard|thorough] [what you want shipped]"
---

# Ship Task

Request: **$ARGUMENTS**

If empty, ask for the task and stop. This invocation authorizes the shipping pipeline;
respect any narrower user instruction (for example, prepare only, no push).
The main thread owns approval and completion. Never finish merely because an Agent or
Workflow dispatch returned a task ID. Wait for its result and inspect coverage gaps.

## 1. Preflight and choose a profile

Read applicable project instructions. Record branch, HEAD and `git status --porcelain`.
Keep pre-existing changes separate from this task, including already staged hunks.
Resolve the PR base with `gh pr view --json baseRefName --jq '.baseRefName'`; otherwise
use the originating main/master branch, or the repo's default branch. Fetch that base
once; retain its resolved SHA for any branch comparison during this run.

On main/master, create a feature branch. For a Linear ticket use its `gitBranchName`
when available; otherwise derive `<type>/<3-6-word-slug>`. Never silently switch to an
existing branch with unrelated work. Report the selected branch briefly.

Honor an explicit profile. Otherwise select and state:

| Profile | Suitable task | Implementation | Review |
|---|---|---|---|
| fast | Small, clear change with a known verification command; no concurrency, auth, data migration or public contract risk | Main thread or one sonnet fast-worker | Two grouped opus passes, medium effort |
| standard | Ordinary feature or fix, possibly across several files | One fable planner; main thread coordinates sonnet workers | Three grouped opus passes, medium effort |
| thorough | Concurrency, security, migration, subtle shared invariants, broad API change, or explicit request | Planner plus sonnet lead; opus for difficult reasoning | Five grouped passes plus bounded fresh sweep, high effort |

Fast still checks the applicable language and tests and independently challenges
findings. Escalate the profile when investigation reveals a material risk; explain why.
A profile is a depth choice, not a claim that omitted angles ran.

## 2. Plan and approval

For fast, draft a short plan yourself. For standard/thorough, call
`claude-skills:planner` (`model: "fable"`, `run_in_background: false`) once with the
request, repo, profile, baseline dirt and intended scope. Ask for a concise plan with
exact files, implementation tasks, verification commands and material risks. Thorough
can use detailed waves. Do not demand architecture boilerplate for a local edit.

Include this authorization in the initial plan:

> After implementation, fix independently confirmed issues that prevent this task
> from meeting its approved behavior, within the same scope. Allow one remediation
> batch and one final correction. Nits are optional unless explicitly requested.
> A new dependency, behavior change beyond the request, destructive action or scope
> expansion requires a revised decision from the user.

When the user already approved a concrete plan covering this work, reuse it and its
actual authorization. Do not assume an older approval includes new scope or publishing.
Otherwise the main thread presents the plan. In plan mode load `ExitPlanMode`, write
the plan to the harness-designated plan file, then call it with no arguments. Subagents
cannot own this gate. If unavailable, present the concrete plan and use AskUserQuestion,
explaining the unavailable gate. On rejection incorporate the feedback and re-present.

After approval, save the plan in the session scratchpad (or use the already approved
project plan). Keep run artifacts outside the repo. Resolve helper paths relative to
this SKILL.md; never hardcode a home directory. Before any implementation edits:

```bash
node "<plugin>/scripts/task-manifest.js" init "<repo>" "<scratchpad>/ship-task" "<base>" ".claude/plans"
```

The helper pins the initial HEAD and snapshots pre-existing dirty/untracked content.
`manifest.json` contains only changes made since that baseline, including additions,
deletions, modes and symlinks. Its per-file patches and changed ranges are the shared
review scope. Do not reset the baseline after edits or commits. Unsupported submodules
or an unavailable baseline must be handled explicitly, never silently excluded.
Historical blobs are read in one batch and unchanged patches reused. Refresh once per
edited snapshot; the full repository fingerprint still detects changes in test/config
inputs and pre-existing dirt.

## 3. Implement, clean up, capture evidence

Fast: implement directly or dispatch one `claude-skills:fast-worker` (sonnet).
Standard: coordinate tasks directly; use workers only for distinct useful work packages.
Thorough: dispatch `claude-skills:lead-orchestrator` with `model: "sonnet"`, approved plan,
profile, manifest/helper locations and the watchdog instructions in `references/watchdog.md`.
Use `run_in_background: true`; tell it explicitly to send `main` its completion report.
Use opus deep-reasoner only for a difficult decision; a second opinion needs a concrete
unresolved question. Disjoint files can run concurrently; dependent tasks run in order.

Pass workers the relevant plan section, files, conventions and verification command.
Require a concise report: changed files, command/results, relevant input hashes,
deviations and unresolved issues. Cap correction of an off-plan worker at one attempt;
if unresolved, report the blocker rather than spawning an indefinite loop.

Perform one integration/conformance pass at worker boundaries. The lead does not also
run the full review pipeline. Reuse passing worker verification only when the command,
configuration, dependency inputs and relevant files still match. An unchanged task diff
alone does not prove a test is current if other inputs changed.

Run simplification once when the implementation has non-trivial new logic, confined
to task patches. Skip it for docs, formatting and already simple edits. Then run
`/compact-comments` on task-added comments, passing the manifest path; preserve its
exemptions. These are editing passes, so they happen **before** review and verification.
Do not repeat them after shipping. Refresh after edits:

```bash
node "<plugin>/scripts/task-manifest.js" refresh "<scratchpad>/ship-task"
```

## 4. Scoped checks and independent review

Use the manifest's paths and patches, not a fresh branch-wide file discovery. Deleted
files remain in review scope; language checkers inspect surviving code and callers.
Exclude generated/vendor files from language checks and list relevant exclusions.

Run applicable `golang-check` / `ts-check` and `test-check`, passing
`changeManifestPath`, explicit repo-relative file lists, repoDir, profile, baseline and
`nitPolicy: "material"`. Stage checker scripts
with `scripts/review-dispatch.js` (see code-review Step 3); it builds exact payloads and
inlines the shared runtime and guideline anchors.
Use the exact session scratchpad declared by the harness, not an arbitrary temp directory.
Without a readable scratchpad, pass staged contents as Workflow script instead of scriptPath.
Use `mode: "grouped"` for all pipeline profiles; retain every applicable rule in its group.
Go retains per-rule file scopes and per-module Go-version gates. Do not read guideline
bodies into the coordinator context; checker agents read their short checklists.

Tests own measured coverage, assertion fidelity/strictness, DB integration and mock
expectations. Obtain coverage with the planned test command where applicable; reuse
it only with matching command/configuration and a matching repository snapshot.
Do not generate a second whole-suite coverage run if valid evidence already exists.
Unavailable coverage is UNVERIFIED with a reason, never a clean pass.
For fresh Jest evidence use review-pr's [generated-config plan](../review-pr/references/jest-coverage.md).
For other runners pass --expected-sources to its coverage helper; every scoped source
needs report evidence. Start non-coverage test guidelines alongside language checks.
Await one tracked coverage task; do not restart failed installs or search/wait by PID.
For this pipeline, run test-check with `verify: false`; these are **candidates**, handed
to the following independent review together with language findings. Standalone
test-check retains independent verification. Attach guideline paths, coverage path,
original rule/severity, and a precise `suggestedFix` (test `action`) to candidates.
Map concrete correctness/regression issues to `issue`; convention/style suggestions
are `nit`. The challenger may raise severity, never lower an issue.
Use description/suggestedFix for implementer candidates too; summary/failure_scenario
are accepted aliases. Malformed candidates remain in rejectedFindings with validationErrors.
Report these as gaps, distinct from unchallenged verdicts; never silently drop them.

Save checker results and write these core args to `<artifacts>/review-args.json`:

```text
{
  files: <all task paths>, baseBranch: <base>, profile: <selected profile>,
  repoDir: <absolute repo root>, nitPolicy: "material",
  changeNote: <one-line intent>, planPath: <approved plan>,
  changeManifestPath: "<scratchpad>/ship-task/manifest.json",
  externalFindings: <implementer candidates, if any>,
  coverageUnverified: <reason only when coverage unavailable>,
  coveredDimensions: <["tests"] only if test-check and measured coverage completed; else []>
}
```

```bash
node "<plugin>/scripts/review-dispatch.js" code-review "<artifacts>/review-args.json" "<artifacts>/core" \
  --check "ts-check=<TS result JSON>" --check "test-check=<test result JSON>" \
  --scratchpad "<declared scratchpad>"
```

Pass all applicable Go/module/test results as --check entries; omit absent checks.
Use the same helper for each checker with its args JSON and a distinct artifact directory.
Omit --scratchpad if none is declared/readable. Submit the exact dispatchPath object to
Workflow; never trim scripts or try temp scriptPath first. Build/dispatch core once,
after checker candidates exist. Input gaps and a compact evidence index are attached.

The script deduplicates equivalent claims before challenging them, preserves distinct
issues at one location, batches up to four claims per independent verifier, and caps
verification at eight calls with at most four agents in flight. Thorough's fresh sweep
has a 12-read/search-call budget; incomplete work remains a gap.
Missing/malformed verdicts and budget overflow remain explicitly unchallenged. Do not
fix them as confirmed, count them as clean, or start unbounded retries. Report the gap
and request a targeted decision only if shipping cannot proceed without resolving it.

Keep full results in the scratchpad; carry counts and actionable issues in context.
Language/test UNVERIFIED rules, review dimensionsUnverified, dimensionsSkipped,
refuted and unchallenged entries must remain visible in the eventual report.

## 5. Bounded remediation and final verification

For independently confirmed **issues**, apply the plan's authorized remediation in
one batch. Main thread or fast-worker can use a short action list; do not commission
another comprehensive plan or ask again for routine fixes already approved. A truly
new scope/behavior decision goes to the user with the concrete proposed change.
Nits do not block shipping unless the user requested them.

Refresh the manifest after remediation. Recheck only changed rules/areas and affected
commands; preserve still-valid results for unchanged inputs. Independently verify the
actual fixes together in one focused pass where inspection adds value. Do not spawn
one verifier per checklist item. Allow one final correction, then rerun the commands
it invalidates, and inspect the corrected hunks before marking them reviewed.
Persistent issues or required verification failures stop shipping.

Record evidence outside the repo: each command, exit status, output path, relevant
files/configuration/dependency inputs, repositorySnapshot and review manifest revision.
A conservative whole-repository fingerprint is available via `task-manifest.js snapshot`;
use it if the relevant-input dependency set is uncertain. Never reuse coverage/tests
based only on report modification time or last commit time. Explicitly report tests
that could not run. Do not repeat passed commands without changed inputs or new concern.

## 6. Commit and open the draft PR

Confirm the final manifest revision matches the reviewed patch and verification
inputs. With zero task changes, report that fact and stop without creating a commit.
Resolve any remaining required gaps before shipping; user-approved exceptions must be
explicit in the report and PR. Prepare the PR body once: behavior, key change, validation
and material limits. Save it as `<scratchpad>/ship-task/pr-body.md`.

Invoke `/git-commit` with the manifest-owned paths and this restriction: stage task
changes only; preserve pre-existing staged/unstaged work. Never use blanket `git add`.
A baselineDirty path contains mixed ownership: use a reviewed task-only hunk staging
method that preserves the existing index, or obtain a concrete decision on the overlap.
Do not automatically include the whole dirty file. Confirm the staged diff contains
only task hunks before committing. Do not modify source after final verification.

Invoke `/draft-pr` with the base and the prepared body file. It pushes and creates or
updates the draft once; skip `/update-pr-description` when the body was already supplied.
Respect the session's existing publishing authorization and any prepare-only constraint.

Final report: outcome, PR URL (or prepared state), verification result, material gaps,
profile and actual agent calls from workflow stats. Read elapsed duration from completed
Workflow metadata with scripts/workflow-metrics.js (see code-review Step 4). Phase
agent spans exclude coordinator overhead; missing times are null. Sandbox scripts
cannot use wall clocks; do not invent zero durations. Do not estimate
billed tokens from partial subagent notifications. Keep detailed evidence at the
artifact paths; avoid repeating every clean check in prose.
