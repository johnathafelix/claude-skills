---
name: code-review
description: "Review local changes or a GitHub PR with grouped opus finders and bounded independent challenge batches. Fast and standard profiles reduce fan-out; thorough uses all 15 angles plus a sweep. Reports findings and explicit coverage gaps; never edits or posts."
argument-hint: "[fast|standard|thorough] [low|medium|high|xhigh|max] [PR URL]"
---

# Code Review

Review a change and report what is wrong with it. The review itself is `workflow.js`
next to this file — the same script `/ship-task` and `/address-pr-review-comments` run.
Those skills turn its findings into a fix plan; this skill only reports them.

**This skill reports; it never edits.** No fix plan, no edits, no commits, no PR
comments — even if asked in the same breath. Finish the report and let the user ask
separately.

**Dispatching is not finishing.** `Workflow` returns a task ID immediately and the run
completes in the background. Do not end the turn on that ID — wait for the completion
notification, then report.

## Step 1 — Parse the arguments

Split the arguments on whitespace. Tokens may come in any order:

- `fast`, `standard`, `thorough` → `PROFILE`. Default `standard`.
- `low`, `medium`, `high`, `xhigh` or `max` → `EFFORT`. Default `medium` for fast/standard, `high` for thorough.
- A URL matching `https://github.com/<owner>/<repo>/pull/<number>` → PR mode, with
  `OWNER`, `REPO`, `PR_NUMBER`.
- Anything else → stop and show usage:
  `/claude-skills:code-review [fast|standard|thorough] [low|medium|high|xhigh|max] [https://github.com/<owner>/<repo>/pull/<n>]`.

The model is always opus; the effort sets how hard every agent thinks.

## Step 2a — Local mode (no URL)

Review the current branch's changes, committed or not, against its PR base:

```bash
BASE_BRANCH=$(gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null || echo main)
git fetch origin "$BASE_BRANCH"
MERGE_BASE=$(git merge-base "origin/$BASE_BRANCH" HEAD)
git diff "$MERGE_BASE" --no-renames --name-only --diff-filter=ACMD
git ls-files --others --exclude-standard
```

Dedupe the two lists into `files` — the union matters, because a brand-new file is
untracked and `--diff-filter=ACMD` alone misses it. If `files` is empty, report that there
is nothing to review and stop.

Workflow args: `{ files, baseBranch: BASE_BRANCH, profile: PROFILE, effort: EFFORT,
repoDir: <absolute repo root>, diffCommand: "git diff <MERGE_BASE>" }`, substituting the pinned merge-base SHA. This
includes working-tree changes without reviewing unrelated commits added to the base.

## Step 2b — PR mode (URL given)

Review the PR's head in a temporary worktree, so the user's branch and working tree are
never touched.

1. **Same repo only.** `gh repo view --json nameWithOwner --jq '.nameWithOwner'` must equal
   `OWNER/REPO` (case-insensitive). If not, stop: *"Run this from a checkout of
   OWNER/REPO."*
2. **PR facts.** `gh pr view <url> --json number,title,state,baseRefName,headRefOid` →
   `BASE`, `TITLE`, `STATE`, `HEAD_SHA`.
3. **Worktree** under the scratchpad directory named in your environment:

   ```bash
   WT="<scratchpad>/code-review-pr-$PR_NUMBER"
   git fetch origin "$BASE" "pull/$PR_NUMBER/head:code-review-pr-$PR_NUMBER"
   git worktree add --detach "$WT" "code-review-pr-$PR_NUMBER"
   ```

   `pull/<n>/head` also covers PRs opened from forks. If the branch or worktree already
   exists from an earlier interrupted run, run the cleanup in step 6 first, then retry.
4. **Files.** `git -C "$WT" diff --no-renames --name-only --diff-filter=ACMD "origin/$BASE...HEAD"`.
   Three dots: only the PR's own changes, not what landed on the base since it branched.
   Empty → report nothing to review, clean up, and stop. If `STATE` is `MERGED`, say why:
   the PR's commits are already in `origin/<BASE>`, so there is no diff left to review.
5. Workflow args:
   `{ files, baseBranch: BASE, profile: PROFILE, effort: EFFORT, repoDir: WT, diffCommand: "git -C <WT> diff origin/<BASE>...HEAD", changeNote: "PR #<n>: <TITLE>" }`
   with `<WT>` and `<BASE>` substituted.
6. **Always clean up** once the workflow finishes — also when it failed or was stopped:

   ```bash
   git worktree remove --force "$WT"
   git branch -D "code-review-pr-$PR_NUMBER"
   ```

## Step 3 — Dispatch

`Workflow` rejects a `scriptPath` outside the working directory or an added directory, and
this skill's own directory is usually the plugin cache. Use the exact session scratchpad
path declared by the harness, not an arbitrary mktemp directory or a path under .git.
Stage the script there first; staging inlines its shared input helpers:

```bash
node "<plugin>/scripts/stage-workflow.js" - "<absolute dir of this SKILL.md>/workflow.js" "<scratchpad>/code-review-workflow.js"
```

Resolve the directory from this file's own location — do not hardcode a home directory.
If the session declares no readable scratchpad, stage at a temporary path and pass the
**staged contents** as Workflow `script`; never dispatch that temporary scriptPath.

```
Workflow({ scriptPath: "<scratchpad>/code-review-workflow.js", args: <Step 2 args> })
```

Pass `args` as a real JSON object, not a JSON-encoded string. Wait for the completion
notification, then read `{ findings, findingCount, dimensionsUnverified, unchallenged, rejectedFindings, refuted, dimensionsSkipped, stats }`.

The default `nitPolicy: "material"` limits each finder to two nits with concrete
maintenance/testing cost. It does not limit correctness issues or discard existing
claims before challenge. Set `nitPolicy: "all"` only for an explicitly requested style
audit; thorough controls review depth, not the volume of style suggestions.

## Step 4 — Report

Open with one line: the target (local changes vs `origin/<base>`, or `<PR URL>` @
`<HEAD_SHA short>`), the effort, and the confirmed count (`stats.confirmed`). Report
unchallenged claims separately; `findingCount` also includes them.

Then confirmed (`verified: true`) findings, issues before nits, sorted file → line
within each severity (the workflow returns them pre-sorted):

```
N. `file:line` [dimension · severity]
   What: <description>
   Fix:  <suggestedFix>
```

In PR mode, paths are relative to the repo root, not to the worktree. Equivalent claims
use a canonical symbol/invariant/trigger claimKey and are deduplicated before verification; distinct defects at the same
line remain separate. Each finding carries its originating dimensions. `severity` is `issue` or `nit` (no effect on
behavior or correctness); list issues before nits.

If `dimensionsUnverified` is non-empty, list those angles under **Not verified** and say
plainly that an unverified angle is not a clean pass. Always report `unchallenged` claims (including budget overflow), refutation counts and
`dimensionsSkipped` for the selected profile. With zero findings and no gaps, say the
review is clean for that profile, not for omitted dimensions. Report rejectedFindings
with their validationErrors separately from unchallenged claims; a malformed claim
has not reached a verifier. Workflow stats report call counts and confirmed count.
Read compact timing evidence without loading the metadata's embedded scripts/prompts:

```bash
node "<plugin>/scripts/workflow-metrics.js" "<Transcript dir returned by Workflow>"
```

The helper returns harness durationMs and phaseAgentSpansMs (first agent start to last
agent finish per phase, including overlapping agents). Missing timing is null, not zero.
These spans exclude coordinator overhead. Never use wall clocks inside a Workflow.

End there. Do not offer a fix plan or start fixing.
