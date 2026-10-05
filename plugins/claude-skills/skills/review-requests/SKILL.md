---
name: review-requests
description: Watch a Slack channel for teammates' PR review requests and review each one with review-pr — replies "👀 reviewing..." in the thread, runs review-pr in its own headless Claude Code session (at most 2 at a time), then replies "✅ <outcome>". Uses the Slack connector already in Claude Code; only picks up messages posted after the watch started. Invoke once; it schedules itself to repeat every 10 minutes. Use when the user invokes /claude-skills:review-requests or asks to watch Slack for review requests.
argument-hint: ""
---

# Review requests

One pass over the review-request channel. The first pass schedules the rest: it creates
a session cron job that re-runs this skill every 10 minutes, so invoking it once is
enough:

```
/claude-skills:review-requests
```

Each pass finishes the reviews that are done, then starts reviews for new requests. The
reviews themselves run in separate headless sessions, so this session only ever sees
their one-line results.

**This skill posts to Slack and GitHub without asking.** Starting the loop is the user's
approval to reply in the channel under their account, and to post reviews through
`review-pr`.

## Setup (once, by the user)

- **Slack connector** connected in Claude Code (`/mcp`). All Slack calls go through it.
- **Channel:** `REVIEW_REQUESTS_CHANNEL_ID` set in the `env` block of
  `~/.claude/settings.json`. Never write the channel ID or the user's Slack ID into this
  repo.
- **Local clones:** each PR's repo lives at `<REPOS_DIR>/<repo>`, and a missing one is
  cloned there on first use. `REPOS_DIR` is `REVIEW_REQUESTS_REPOS_DIR` if set, else
  `~/repos`.
- **Plugin up to date**, so the headless sessions can run `/claude-skills:review-pr`.

## Step 1 — Load config and check Slack

```bash
echo "$REVIEW_REQUESTS_CHANNEL_ID"
echo "${REVIEW_REQUESTS_REPOS_DIR:-$HOME/repos}"
```

No channel ID → stop: tell the user to set `REVIEW_REQUESTS_CHANNEL_ID` in
`~/.claude/settings.json`.

Then check the connector, every pass:

1. `slack_read_user_profile` with no `user_id` and `response_format: detailed` → `ME`, its
   `User ID` (the concise format omits it).
2. `slack_read_channel` with `channel_id: CHANNEL`, `limit: 1`.

Either call missing, failing, or asking to authenticate → stop the loop (`CronList`, then
`CronDelete` the job whose prompt contains `/claude-skills:review-requests`; in dynamic
`/loop` mode, `ScheduleWakeup` with `stop: true`) and tell the user the Slack connector is
not connected or cannot read the channel, to reconnect it with `/mcp`, and to invoke this
skill again. Reviews already running keep
going; their results are picked up by the next loop.

Record `CHANNEL`, `REPOS_DIR`, `ME` and `STATE = <scratchpad>/review-requests`. Never
print `CHANNEL` or `ME` in a Slack message or a PR comment.

## Step 1b — Keep the loop scheduled

`CronList`. If no job's prompt contains `/claude-skills:review-requests`, create one:

```
CronCreate({ cron: "*/10 * * * *", prompt: "/claude-skills:review-requests", recurring: true })
```

Tell the user the job ID, that the job lives only in this session (closing it stops the
watch), and that a recurring job expires after 7 days. Skip this when the pass runs under
a dynamic `/loop` (one paced with `ScheduleWakeup`), which already repeats it.

## Step 2 — Start time

`STATE/since` holds the Slack timestamp the watch started at. The scratchpad belongs to
this session, so a new session starts a new watch.

- Missing → `mkdir -p STATE` and write `$(date +%s).000000` to it. Tell the user the watch
  started and end this pass: nothing older is picked up.
- Present → `SINCE` = its contents.

## Step 3 — Finish completed reviews

Each started review has, under `STATE`, `<ts>.url` (the PR URL) and, while it runs,
`<ts>.tmp`. It becomes `<ts>.out` when the headless session exits. For every
`STATE/*.out`:

1. Parse it as JSON and find the line `REVIEW_RESULT: <outcome>` in `.result`. Bad JSON
   or no such line → `error`.
2. Reply in the request's thread with `slack_send_message` (`channel_id: CHANNEL`,
   `thread_ts: <ts>`):

| `REVIEW_RESULT` | Thread reply |
|---|---|
| `commented` | ✅ i left some comments |
| `approved_nits` | ✅ approved, left some nit comments |
| `approved` | ✅ approved |
| `no_findings` | ✅ done |
| `merged` | ✅ already merged |
| `closed` | ✅ already closed |
| `already_reviewed` | ✅ already reviewed this commit |
| `head_moved` | — |
| `error` | — |

3. Clean up:
   - `head_moved` → delete the other `STATE/<ts>.*` files and write `STATE/<ts>.retry`,
     so Step 4 starts it again without a second "reviewing..." reply.
   - `error` → keep `<ts>.out` and `<ts>.err`, rename `<ts>.url` to `<ts>.failed`, and
     tell the user the PR URL, the last lines of `.result` and `.err`, and that deleting
     `STATE/<ts>.*` retries it. The thread still says "👀 reviewing...", so the user
     follows up by hand.
   - Any other outcome → delete the other `STATE/<ts>.*` files and write
     `STATE/<ts>.done`, so the request is never picked up again.

When a review's background task notifies that it finished, run this step right away
instead of waiting for the next pass.

## Step 4 — Start new reviews

Read the channel with `slack_read_channel` (`channel_id: CHANNEL`, `oldest: SINCE`,
`response_format: detailed`), following `next_cursor` until done. A message is a **new
request** when all hold:

- it is a top-level message (not a thread reply) and its author is not `ME`;
- its text contains `https://github.com/<owner>/<repo>/pull/<number>`;
- no `STATE/<ts>.*` file exists for it, other than `<ts>.retry`.

The `STATE` files are the only record of what was handled. That is enough, because only
messages after `SINCE` are read and every one of them that this watch handled has a file.

Running reviews = the number of `STATE/*.tmp` files. A `.tmp` left by a session that
crashed keeps counting; if one is older than 2 hours, tell the user. Take new requests
oldest first while fewer than **2** are running; the rest wait for a later pass.

For each request taken:

1. **PR URL** — the first PR URL in the message. If it has more, tell the user which ones
   were not reviewed.
2. **Clone** — `CLONE = REPOS_DIR/<repo>`.
   - `CLONE` does not exist → `gh repo clone <owner>/<repo> "<CLONE>"`, and tell the user
     it was cloned.
   - `gh repo view --json nameWithOwner --jq .nameWithOwner` run inside `CLONE` must
     equal `<owner>/<repo>` (case-insensitive).
   - The clone failed, or `CLONE` holds a different repo → write `STATE/<ts>.skipped`,
     tell the user why, and leave the Slack message untouched. Never delete or overwrite
     an existing `CLONE`.
3. **Acknowledge** — reply `👀 reviewing...` in its thread. Skip this when
   `STATE/<ts>.retry` exists (it was already acknowledged); delete that file instead.
4. **Start** — write the URL to `STATE/<ts>.url`, then run with `Bash`
   `run_in_background: true`:

   ```bash
   { cd "<CLONE>" && "<absolute dir of this SKILL.md>/scripts/run-review.py" "<PR URL>"; } \
     > "<STATE>/<ts>.tmp" 2> "<STATE>/<ts>.err"; mv "<STATE>/<ts>.tmp" "<STATE>/<ts>.out"
   ```

   `run-review.py` runs `/claude-skills:review-pr` in its own headless session and waits
   for its `REVIEW_RESULT` line (plain `claude -p` would exit before the review's
   background Workflow finishes). Its context never enters this one; it gives up after 3
   hours.

## Step 5 — Report

One short line: reviews finished (PR and outcome), reviews started, requests waiting for
a free slot, and anything skipped or failed. Nothing else — this runs every few minutes.
