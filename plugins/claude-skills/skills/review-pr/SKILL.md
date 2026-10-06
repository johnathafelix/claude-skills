---
name: review-pr
description: Review a teammate's GitHub PR end to end — runs the code-review workflow on it (15 opus finder angles, a gap sweep, adversarial verification; effort default high, or REVIEW_PR_EFFORT) plus golang-check / ts-check by language and test-check, posts every confirmed finding as an inline review comment, and approves the PR when there are no findings or only nits. On a re-review it skips findings it already reported, and never approves while one of those issues is still in the code, unless the author replied declining it. With `approve` it posts its comments and approves whatever it finds. Posts directly, with no confirmation step. Use when the user invokes /claude-skills:review-pr with a PR URL, or asks to review and approve a teammate's PR with this reviewer.
argument-hint: "<PR URL> [low|medium|high|xhigh|max] [approve]"
---

# Review PR

Take a teammate's PR from URL to a posted review: run the `code-review` workflow on it,
plus `golang-check` / `ts-check` for its language and `test-check`, post the findings as
inline comments, and approve it if nothing but nits remain.

**This skill posts to GitHub without asking.** Invoking it is the user's approval to
post a review under their account. It never edits code, pushes, merges, or resolves
threads. It does install the PR's dependencies and run its test suite inside a temporary
worktree, for `test-check` coverage.

**Dispatching is not finishing.** The review runs as a background `Workflow`. Do not end
the turn on its task ID — wait for the completion notification, then post and report.

## Step 1 — Parse the arguments

- Exactly one URL matching `https://github.com/<owner>/<repo>/pull/<number>` → `OWNER`,
  `REPO`, `PR_NUMBER`. Missing → stop and show usage.
- Optional `low` / `medium` / `high` / `xhigh` / `max` → `EFFORT`. Not given → the
  value of `echo "${REVIEW_PR_EFFORT:-high}"`, which the user can set in the `env` block
  of `~/.claude/settings.json`. That value must be one of the five levels; anything else
  → stop and tell the user the allowed values.
- Optional `approve` → `FORCE_APPROVE = true`, default `false`. Step 6 then approves
  whatever the review finds. `review-requests` passes it on a PR's last review, so a
  teammate is not blocked forever.
- Anything else → stop and show usage:
  `/claude-skills:review-pr <https://github.com/<owner>/<repo>/pull/<n>> [low|medium|high|xhigh|max] [approve]`.

## Step 2 — Pre-checks

```bash
gh pr view <url> --json number,state,isDraft,author,headRefOid,title,baseRefName
gh api user --jq .login
gh api --paginate "repos/$OWNER/$REPO/pulls/$PR_NUMBER/reviews" \
  --jq '.[] | select(.user.login == "<me>") | {commit_id, body}'
```

- `state` is not `OPEN` → stop: there is nothing to review or approve.
- One of your reviews already has `commit_id == headRefOid` → stop: this head was already
  reviewed, and a re-run would post duplicates. Say so, with the PR URL.
- `isDraft`, or `author.login` is you → `CAN_APPROVE = false` (GitHub rejects approving
  your own PR; a draft is not ready). Otherwise `CAN_APPROVE = true`.

Record `HEAD_SHA = headRefOid` — the review is pinned to it.

If you have earlier reviews on this PR, fetch your inline comments too, with your
replies and the PR author's (`<author>` = `author.login`) replies in those threads. An outdated comment has no `line`,
so fall back to `original_line`:

```bash
gh api --paginate "repos/$OWNER/$REPO/pulls/$PR_NUMBER/comments" \
  --jq '.[] | select(.user.login == "<me>" or (.user.login == "<author>" and .in_reply_to_id != null))
        | {id, in_reply_to_id, user: .user.login, path, line: (.line // .original_line), body}'
```

Record `PRIOR`: your comments, each with the author's replies in its thread (a reply's
`in_reply_to_id` is the thread's first comment), plus the **Outside this PR's diff**
entries in your review bodies. It is empty on a first review.

## Step 2b — Find the local clone

The review needs a local clone of `OWNER/REPO`. `CLONE` is the first of these where
`gh repo view --json nameWithOwner --jq .nameWithOwner`, run inside it, equals
`OWNER/REPO` (case-insensitive):

1. The current directory.
2. `<REPOS_DIR>/<REPO>`, where `REPOS_DIR` is `echo "${REVIEW_REQUESTS_REPOS_DIR:-$HOME/repos}"`.
   If it does not exist, `gh repo clone <OWNER>/<REPO> "<REPOS_DIR>/<REPO>"` and tell the
   user it was cloned.

Neither matches, or the clone failed → stop and tell the user why, naming both paths.
Never delete or overwrite an existing directory.

The shell's working directory resets between calls when `CLONE` is outside the session's
working directory, so never rely on a `cd` from an earlier call. Every command that
`code-review` Step 2b runs in the repo — the same-repo check, `git fetch`,
`git worktree add`, and the step 6 cleanup — runs as `cd "<CLONE>" && …` in a single Bash
call.

## Step 3 — Run the code review

Read `../code-review/SKILL.md` (resolve it from this file's own location; do not
hardcode a home directory) and follow its **Steps 2b and 3** in PR mode with this URL and
`EFFORT`: same-repo check, temporary worktree `$WT`, staged `workflow.js`, `Workflow`
dispatch. **Hold its cleanup (2b step 6)** until Steps 3b and 3c are done too — they
need the worktree. Cleanup is still unconditional: run it before posting, even when
something failed.

Read `{ findings, findingCount, dimensionsUnverified }` from the completion
notification. Each finding has `file`, `line`, `severity` (`issue` / `nit`),
`dimension`, `description`, `suggestedFix`.

## Step 3b — Language checks and test-check

Start these right after dispatching Step 3, so they run alongside it. Split the PR's
changed files:

- `*.go` → `Skill({ skill: "claude-skills:golang-check", args: "<those files>" })`
- `*.ts` / `*.tsx` → `Skill({ skill: "claude-skills:ts-check", args: "<those files>" })`
- every changed file → `Skill({ skill: "claude-skills:test-check", args: "<all of them>" })`

Skip a language check that has no matching files. Pass every file as an **absolute path
under `$WT`**. Their instructions run in this context, so while following them:

- run every shell command they prescribe inside the worktree (`cd "$WT" && …`);
- `BASE_BRANCH` is the PR base, and any diff they compute uses `origin/$BASE...HEAD` (for
  `test-check`'s `changedRanges` too);
- `test-check` coverage: run the suite inside `$WT` with the report written to the
  scratchpad. Never skip it for missing dependencies. If `$WT` has a `package.json` but
  no `node_modules`, install first, in `$WT`: `yarn install --frozen-lockfile` when
  `yarn.lock` exists, `npm ci` when `package-lock.json` exists, `npm install` otherwise.
  Coverage is UNVERIFIED only when the install or the suite itself fails — with that
  error as the reason;
- skip their present-to-user steps and post nothing from them — keep the raw results for
  Step 3c.

Strip the `$WT/` prefix from every file path they return.

## Step 3c — Normalize and verify

Bring every source into the code-review finding shape
`{ file, line, severity, description, suggestedFix, dimension }`:

| Source | `severity` | `description` | `suggestedFix` | `dimension` |
|---|---|---|---|---|
| `test-check` `findings` | `error` → `issue`, else `nit` | description + rationale | action | `test-check/<rule>` |
| `golang-check` | `error` → `issue`, else `nit` | description | suggestedFix | `golang-check/<rule>` |
| `ts-check` | `nit` | description | suggestedFix | `ts-check/<rule>` |

`test-check` already verified its findings. Its `unchallenged` items are not posted —
report them to the user. Its `refuted` items are dropped.

`golang-check` and `ts-check` findings are not verified yet. Dispatch the same staged
`code-review` workflow in verify-only mode, with each finding also carrying
`dimensionLabel` (e.g. `"Go idiom: errors"`):

```
Workflow({ scriptPath: "<scratchpad>/code-review-workflow.js",
  args: { verifyOnly: [<normalized golang/ts findings>], files, baseBranch: BASE, effort: EFFORT, repoDir: WT, diffCommand: "git -C <WT> diff origin/<BASE>...HEAD" } })
```

Keep only the findings it returns. Then run the worktree cleanup, and combine all three
sets — code review, verified language checks, test-check — merging any that share
`file:line`: one finding, every dimension listed, the higher severity, each source's text
kept.

## Step 3d — Skip what you already reported

Drop a finding when a `PRIOR` entry on the same file reports the same problem. Match on
the problem, not the line number: lines shift between pushes. A finding that only looks
like an earlier one (a different trigger or a different fix) stays.

A dropped finding is **addressed** when the author replied in its thread, after your
last comment there, declining the change or explaining why the code stays as it is. A
reply that agrees or promises a fix ("will do", "good catch") does not count.

`STILL_OPEN` = the dropped findings with severity `issue` that are not addressed. They
are still in the code, so they block approval in Step 6. They are not posted again,
since your earlier comment is still on the PR. From here on, "findings" means only the
ones left.

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

## Step 5b — Humanize the comments

Run `Skill({ skill: "claude-skills:humanizer" })` once over every drafted comment and
the review body, passed together and labeled by `file:line` so each rewrite maps back to
its comment. Then replace each draft with its rewritten text.

Use only humanizer's pattern removal (AI vocabulary, em-dash overuse, rule of three,
negative parallelisms, inflated or hedged phrasing). Skip its "personality and soul"
guidance: a teammate's review comment gets no added opinions, humor, first-person
asides, or reactions. Do not ask the user anything, and skip its draft/audit output.
Keep only the final text.

The rewrite must not change meaning. Keep every one of these exactly as drafted: code in
backticks, identifiers, file paths, line numbers, numbers, the `Nit: ` prefix, the
**Outside this PR's diff** heading, and each comment's issue/fix content. If a rewrite
drops or alters any of them, keep the draft for that comment. Comments stay at most 6
lines.

## Step 6 — Decide the review state

**Something did not run** when any of these hold: the code review's
`dimensionsUnverified` is non-empty; a `golang-check` or `ts-check` guideline is
UNVERIFIED; the verify-only run's `dimensionsUnverified` is non-empty; or a `test-check`
`unverified` guideline is anything other than `coverage`. Coverage not running (e.g. the
install or the suite failed) does **not** count — report it to the user, but it does
not block approval.

The first row that matches decides:

| Situation | Event | Posts |
|---|---|---|
| `FORCE_APPROVE`, `CAN_APPROVE` | `APPROVE` | every comment, issues and nits, even when something did not run or `STILL_OPEN` is not empty |
| something did not run | `COMMENT` | the comments; never approve when part of the review did not run |
| any `issue` | `COMMENT` | the comments |
| `STILL_OPEN` not empty, no findings | — | nothing; your earlier comments are still on the PR |
| `STILL_OPEN` not empty, only nits | `COMMENT` | the nit comments; never approve while an earlier issue is still open |
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
- Which checks ran (code review, `golang-check` / `ts-check`, `test-check`) and whether
  coverage was measured — with the reason if not.
- Anything that did not run, stated plainly as not a clean pass and the reason the PR
  was not approved (or, with `FORCE_APPROVE`, that it was approved anyway).
- `test-check` `unchallenged` items (not posted), and how many language-check findings
  the verifier refuted.
- How many findings were skipped as already reported, and one line per `STILL_OPEN`
  issue.

End every run, including one that stopped early, with this as its last line so a caller
(e.g. `review-requests`) can read the outcome:

```
REVIEW_RESULT: <outcome>
```

| Outcome | When |
|---|---|
| `approved` | posted `APPROVE` with no comments |
| `approved_nits` | posted `APPROVE` with nit comments |
| `approved_comments` | posted `APPROVE` with at least one `issue` comment (only with `approve`) |
| `commented` | posted `COMMENT` |
| `no_findings` | zero findings, not `CAN_APPROVE`; nothing posted |
| `still_open` | `STILL_OPEN` not empty and no findings; nothing posted |
| `merged` / `closed` | Step 2 found the PR `MERGED` / `CLOSED` |
| `already_reviewed` | Step 2 found a review of yours on this head |
| `head_moved` | Step 7 found the head moved; nothing posted |
| `error` | anything else that stopped the run, including a rejected post |
