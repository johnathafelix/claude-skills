---
name: code-review
description: Review code changes and report findings — never plans or applies fixes. Runs 15 focused finder angles (line scan, removed behavior, cross-file callers, language pitfalls, wrappers, error handling, type invariants, security, tests, reuse, simplification, efficiency, altitude, comment accuracy, CLAUDE.md conventions) plus a gap sweep, every agent on opus, then verifies each finding with an adversarial opus agent. Reviews the current branch's changes against its PR base by default, or a teammate's GitHub PR when given its URL. Accepts an effort level (low / medium / high / xhigh / max, default high). Use when the user invokes /claude-skills:code-review or asks to review their changes or a PR with this reviewer.
argument-hint: "[low|medium|high|xhigh|max] [PR URL]"
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

- `low`, `medium`, `high`, `xhigh` or `max` → `EFFORT`. Default `high`.
- A URL matching `https://github.com/<owner>/<repo>/pull/<number>` → PR mode, with
  `OWNER`, `REPO`, `PR_NUMBER`.
- Anything else → stop and show usage:
  `/claude-skills:code-review [low|medium|high|xhigh|max] [https://github.com/<owner>/<repo>/pull/<n>]`.

The model is always opus; the effort sets how hard every agent thinks.

## Step 2a — Local mode (no URL)

Review the current branch's changes, committed or not, against its PR base:

```bash
BASE_BRANCH=$(gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null || echo main)
git fetch origin "$BASE_BRANCH"
git diff "origin/$BASE_BRANCH" --name-only --diff-filter=ACM
git ls-files --others --exclude-standard
```

Dedupe the two lists into `files` — the union matters, because a brand-new file is
untracked and `--diff-filter=ACM` alone misses it. If `files` is empty, report that there
is nothing to review and stop.

Workflow args: `{ files, baseBranch: BASE_BRANCH, effort: EFFORT }`.

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
4. **Files.** `git -C "$WT" diff --name-only --diff-filter=ACM "origin/$BASE...HEAD"`.
   Three dots: only the PR's own changes, not what landed on the base since it branched.
   Empty → report nothing to review, clean up, and stop. If `STATE` is `MERGED`, say why:
   the PR's commits are already in `origin/<BASE>`, so there is no diff left to review.
5. Workflow args:
   `{ files, baseBranch: BASE, effort: EFFORT, repoDir: WT, diffCommand: "git -C <WT> diff origin/<BASE>...HEAD", changeNote: "PR #<n>: <TITLE>" }`
   with `<WT>` and `<BASE>` substituted.
6. **Always clean up** once the workflow finishes — also when it failed or was stopped:

   ```bash
   git worktree remove --force "$WT"
   git branch -D "code-review-pr-$PR_NUMBER"
   ```

## Step 3 — Dispatch

`Workflow` rejects a `scriptPath` outside the working directory or an added directory, and
this skill's own directory is usually the plugin cache. Copy the script into the
scratchpad first:

```bash
cp "<absolute dir of this SKILL.md>/workflow.js" "<scratchpad>/code-review-workflow.js"
```

Resolve the directory from this file's own location — do not hardcode a home directory.
If the session declares no scratchpad, read `workflow.js` in full and pass it as `script`.

```
Workflow({ scriptPath: "<scratchpad>/code-review-workflow.js", args: <Step 2 args> })
```

Pass `args` as a real JSON object, not a JSON-encoded string. Wait for the completion
notification, then read `{ findings, findingCount, dimensionsUnverified }`.

## Step 4 — Report

Open with one line: the target (local changes vs `origin/<base>`, or `<PR URL>` @
`<HEAD_SHA short>`), the effort, and the finding count.

Then every finding, sorted file → line (the workflow returns them pre-sorted):

```
N. `file:line` [dimension · severity]
   What: <description>
   Fix:  <suggestedFix>
```

In PR mode, paths are relative to the repo root, not to the worktree. A finding several
angles confirmed on the same line arrives already merged: its dimension lists every angle,
and each angle's description and fix are kept. `severity` is `issue` or `nit` (no effect on
behavior or correctness); list issues before nits.

If `dimensionsUnverified` is non-empty, list those angles under **Not verified** and say
plainly that an unverified angle is not a clean pass. With zero findings and nothing
unverified, say the review is clean.

End there. Do not offer a fix plan or start fixing.
