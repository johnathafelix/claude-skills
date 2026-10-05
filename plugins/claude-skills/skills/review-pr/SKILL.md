---
name: review-pr
description: Review a teammate's GitHub PR end to end — runs the code-review workflow on it (13 opus finder angles, a gap sweep, adversarial verification; effort default high), posts every confirmed finding as an inline review comment, and approves the PR when there are no findings or only nits. Posts directly, with no confirmation step. Use when the user invokes /claude-skills:review-pr with a PR URL, or asks to review and approve a teammate's PR with this reviewer.
argument-hint: "<PR URL> [low|medium|high|xhigh|max]"
---

# Review PR

Take a teammate's PR from URL to a posted review: run the `code-review` workflow on it,
post the findings as inline comments, and approve it if nothing but nits remain.

**This skill posts to GitHub without asking.** Invoking it is the user's approval to
post a review under their account. It never edits code, pushes, merges, or resolves
threads.

**Dispatching is not finishing.** The review runs as a background `Workflow`. Do not end
the turn on its task ID — wait for the completion notification, then post and report.

## Step 1 — Parse the arguments

- Exactly one URL matching `https://github.com/<owner>/<repo>/pull/<number>` → `OWNER`,
  `REPO`, `PR_NUMBER`. Missing → stop and show usage.
- Optional `low` / `medium` / `high` / `xhigh` / `max` → `EFFORT`, default `high`.
- Anything else → stop and show usage:
  `/claude-skills:review-pr <https://github.com/<owner>/<repo>/pull/<n>> [low|medium|high|xhigh|max]`.

## Step 2 — Pre-checks

```bash
gh pr view <url> --json number,state,isDraft,author,headRefOid,title,baseRefName
gh api user --jq .login
gh api --paginate "repos/$OWNER/$REPO/pulls/$PR_NUMBER/reviews" \
  --jq '.[] | select(.user.login == "<me>") | .commit_id'
```

- `state` is not `OPEN` → stop: there is nothing to review or approve.
- One of your reviews already has `commit_id == headRefOid` → stop: this head was already
  reviewed, and a re-run would post duplicates. Say so, with the PR URL.
- `isDraft`, or `author.login` is you → `CAN_APPROVE = false` (GitHub rejects approving
  your own PR; a draft is not ready). Otherwise `CAN_APPROVE = true`.

Record `HEAD_SHA = headRefOid` — the review is pinned to it.

## Step 3 — Run the review

Read `../code-review/SKILL.md` (resolve it from this file's own location; do not
hardcode a home directory) and follow its **Steps 2b and 3** in PR mode with this URL and
`EFFORT`: same-repo check, temporary worktree, staged `workflow.js`, `Workflow` dispatch.
Its cleanup in 2b step 6 is unconditional — run it once the workflow finishes, before
posting anything.

Read `{ findings, findingCount, dimensionsUnverified }` from the completion
notification. Each finding has `file`, `line`, `severity` (`issue` / `nit`),
`dimension`, `description`, `suggestedFix`.

## Step 4 — Place each finding

GitHub accepts inline comments only on lines inside the PR's diff. Map them with the
helper next to this file:

```bash
gh api --paginate "repos/$OWNER/$REPO/pulls/$PR_NUMBER/files" \
  | python3 "<absolute dir of this SKILL.md>/scripts/diff-lines.py" > "<scratchpad>/review-pr-$PR_NUMBER-lines.json"
```

It prints `{ path: [commentable line numbers] }`. A finding whose `line` is in its
file's list becomes an inline comment. Every other finding goes in the review body under
**Outside this PR's diff**, as `` `file:line` `` followed by the comment text.

## Step 5 — Write the comments

The reader is a teammate in a narrow column next to their code. Plain English, reviewer
voice, at most 6 lines each:

- what is wrong, then the concrete trigger or cost, then the suggested fix — short code
  in backticks;
- prefix nits with `Nit: `;
- a finding merged from several angles is still one comment — fold its "Also flagged by"
  parts into one point instead of repeating them;
- no AI or Claude attribution, no "great catch" / "good point", no restating their code
  back at them, no internal angle names.

## Step 6 — Decide the review state

| Situation | Event | Posts |
|---|---|---|
| `dimensionsUnverified` non-empty | `COMMENT` | the comments; never approve when part of the review did not run |
| any `issue` | `COMMENT` | the comments |
| only nits, `CAN_APPROVE` | `APPROVE` | the nit comments |
| zero findings, `CAN_APPROVE` | `APPROVE` | no comments, empty body |
| zero findings, not `CAN_APPROVE` | — | nothing; report clean to the user |
| only nits, not `CAN_APPROVE` | `COMMENT` | the nit comments |

The review body is empty unless it carries **Outside this PR's diff**. Never mention
unverified angles or the reviewer's internals in the PR — tell the user instead.

## Step 7 — Post

Re-read `gh pr view <url> --json headRefOid --jq .headRefOid`. If it no longer equals
`HEAD_SHA`, the author pushed during the review: stop without posting and tell the user
to re-run.

Otherwise write the payload to the scratchpad (so newlines survive) and post one review:

```json
{ "commit_id": "<HEAD_SHA>", "event": "APPROVE|COMMENT", "body": "<body or empty>",
  "comments": [ { "path": "<file>", "line": <line>, "side": "RIGHT", "body": "<comment>" } ] }
```

```bash
gh api -X POST "repos/$OWNER/$REPO/pulls/$PR_NUMBER/reviews" --input "<scratchpad>/review-pr-$PR_NUMBER.json"
```

If GitHub rejects the post, report its error verbatim and do not retry with a different
event.

## Step 8 — Report to the user

- The decision and why, in one line (e.g. *Approved — 2 nits*, *Commented — 1 issue,
  3 nits*, *Not posted — head moved*).
- The review URL.
- One line per comment: link, severity, gist.
- Any **Outside this PR's diff** findings.
- Any `dimensionsUnverified`, stated plainly as not a clean pass and the reason the PR
  was not approved.
