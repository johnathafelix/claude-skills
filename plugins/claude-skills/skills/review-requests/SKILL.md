---
name: review-requests
description: Watch a Slack channel for teammates' PR review requests and review each one with review-pr — replies "reviewing..." in the thread, runs review-pr in its own headless Claude Code session (at most 2 at a time), then replies with the outcome. Keeps watching each reviewed PR: re-reviews it once a new push has sat for 10 minutes, up to 3 reviews per PR, and stops when it is merged or closed. State lives in ~/.claude/review-requests, so a restarted session carries on. Uses the Slack connector already in Claude Code; only picks up messages posted after the watch started. Invoke once; it schedules itself to repeat every 5 minutes (configurable). Use when the user invokes /claude-skills:review-requests or asks to watch Slack for review requests.
argument-hint: ""
---

# Review requests

One pass over the review-request channel. The first pass schedules the rest: it creates
a session cron job that re-runs this skill every `INTERVAL` minutes, so invoking it once
is enough:

```
/claude-skills:review-requests
```

Each pass finishes the reviews that are done, checks the reviewed PRs for new pushes,
then starts reviews for new requests and re-reviews for PRs that changed. The reviews
themselves run in separate headless sessions, so this session only ever sees their
one-line results.

**This skill posts to Slack and GitHub without asking.** Starting the loop is the user's
approval to reply in the channel under their account, and to post reviews through
`review-pr`.

## Setup (once, by the user)

- **Slack connector** connected in Claude Code (`/mcp`). All Slack calls go through it.
- **Channel:** `REVIEW_REQUESTS_CHANNEL_ID` set in the `env` block of
  `~/.claude/settings.json`. Never write the channel ID or the user's Slack ID into this
  repo.
- **User ID (recommended):** `REVIEW_REQUESTS_USER_ID` in the same `env` block — the
  user's Slack ID, used only to skip their own messages.
- **Interval (optional):** `REVIEW_REQUESTS_INTERVAL_MINUTES` in the same `env` block,
  a whole number from 1 to 59. Default 5.
- **Local clones:** each PR's repo lives at `<REPOS_DIR>/<repo>`, and a missing one is
  cloned there on first use. `REPOS_DIR` is `REVIEW_REQUESTS_REPOS_DIR` if set, else
  `~/repos`.
- **Plugin up to date**, so the headless sessions can run `/claude-skills:review-pr`.

State lives in `~/.claude/review-requests`, outside any session.

## Step 1 — Load config and check Slack

```bash
echo "$REVIEW_REQUESTS_CHANNEL_ID"
echo "${REVIEW_REQUESTS_REPOS_DIR:-$HOME/repos}"
echo "${REVIEW_REQUESTS_INTERVAL_MINUTES:-5}"
echo "$REVIEW_REQUESTS_USER_ID"
```

No channel ID → stop: tell the user to set `REVIEW_REQUESTS_CHANNEL_ID` in
`~/.claude/settings.json`.

`ME`, the user's Slack ID: the fourth value if set. Otherwise take it from the Slack
connector's own tool descriptions, which state "Current logged in user's user_id is
U…". Never call `slack_read_user_profile` — it returns the user's whole profile (email,
phone) when only the ID is needed. Neither source gives an ID → stop the loop (below) and
tell the user to set `REVIEW_REQUESTS_USER_ID`.

Then check the connector, every pass: `slack_read_channel` with `channel_id: CHANNEL`,
`limit: 1`. Missing, failing, or asking to authenticate → **stop the loop**: `CronList`,
then `CronDelete` the job whose prompt contains `/claude-skills:review-requests` (in
dynamic `/loop` mode, `ScheduleWakeup` with `stop: true`). Tell the user the Slack
connector is not connected or cannot read the channel, to reconnect it with `/mcp`, and to
invoke this skill again. Reviews already running keep going; their results are picked up
by the next loop.

`INTERVAL` is the third value; anything other than a whole number from 1 to 59 → stop
and tell the user the allowed range.

Record `CHANNEL`, `REPOS_DIR`, `INTERVAL`, `ME` and `STATE = ~/.claude/review-requests`
(expanded to an absolute path). Never print `CHANNEL` or `ME` in a Slack message or a PR
comment.

## Step 1b — Keep the loop scheduled

`CronList`. If no job's prompt contains `/claude-skills:review-requests`, create one:

```
CronCreate({ cron: "*/<INTERVAL> * * * *", prompt: "/claude-skills:review-requests", recurring: true })
```

If one exists with a different schedule (the interval was changed), `CronDelete` it and
create the new one.

Tell the user the job ID, that the job lives only in this session (closing it pauses the
watch until the skill is invoked again), and that a recurring job expires after 7 days. Skip this when the pass runs under
a dynamic `/loop` (one paced with `ScheduleWakeup`), which already repeats it.

## Step 2 — Start time

`STATE` outlives the session. A later session picks up where the last one stopped: it
finishes or retries the reviews that were running, keeps re-reviewing watched PRs, and
reviews requests posted while no session was watching.

`STATE/since` holds the Slack timestamp the channel is read from. Step 4 moves it forward.

- Missing → this is the first watch: `mkdir -p STATE` and write `$(date +%s).000000` to
  it. Tell the user the watch started, then **STOP: this pass is over. Do not run Steps
  3–5.** Nothing older than now is picked up, so there is nothing to scan yet.
- Present → `SINCE` = its contents.

## Step 3 — Finish completed reviews

Count and list `STATE` files with `find`, never a shell glob — zsh errors with "no
matches found" when a glob matches nothing:

```bash
find "<STATE>" -name '*.out'            # completed reviews
find "<STATE>" -name '*.tmp' | wc -l    # running reviews
```

Each started review has, under `STATE`, `<ts>.url` (the PR URL), `<ts>.head` (the PR's
head when the review started) and, while it runs, `<ts>.tmp`. It becomes `<ts>.out`
when the headless session exits. For every `STATE/*.out`:

1. Parse it as JSON and find the line `REVIEW_RESULT: <outcome>` in `.result`. Bad JSON
   or no such line → `error`.
2. Reply in the request's thread with `slack_send_message` (`channel_id: CHANNEL`,
   `thread_ts: <ts>`):

| `REVIEW_RESULT` | Thread reply |
|---|---|
| `commented` | left some comments |
| `approved_nits` | left some nit comments, but approved! 🚀 |
| `approved` | approved! 🚀 |
| `no_findings` | done! 🚀 |
| `merged` | — |
| `closed` | — |
| `already_reviewed` | already reviewed this commit ✅ |
| `still_open` | earlier comments still open |
| `head_moved` | — |
| `error` | — |

3. Clean up:
   - `merged` / `closed` → delete the other `STATE/<ts>.*` files and write
     `STATE/<ts>.done`, so the request is never picked up again.
   - `head_moved` → delete `<ts>.out`, `<ts>.err` and `<ts>.head`, and write
     `STATE/<ts>.retry`. The PR stays watched: Step 3b marks it `due` once the new head
     settles, and Step 4 restarts it without a second "reviewing..." reply.
   - `error` → keep `<ts>.out` and `<ts>.err`, rename `<ts>.url` to `<ts>.failed`, and
     tell the user the PR URL, the last lines of `.result` and `.err`, and how to retry:
     rename `<ts>.failed` back to `<ts>.url`, delete `<ts>.out`, `<ts>.err` and
     `<ts>.head`, and create `<ts>.retry`. The thread still says "reviewing...", so the
     user follows up by hand.
   - `already_reviewed` → delete `<ts>.out` and `<ts>.err`. The PR stays watched.
   - Any other outcome → delete `<ts>.out` and `<ts>.err`, and add one to the count in
     `<ts>.reviews` (missing means 0). `<ts>.url` and `<ts>.head` stay, so Step 3b
     watches the PR for new pushes.

When a review's background task notifies that it finished, run this step right away
instead of waiting for the next pass.

## Step 3b — Watch reviewed PRs

```bash
"<absolute dir of this SKILL.md>/scripts/watch-prs.py" "<STATE>" 600 3
```

It checks every watched PR (a `<ts>.url` with no review running) with `gh` and prints
one line per PR that needs something:

- `due <ts> <sha> <url>` — the head moved past the last review and has not changed for
  10 minutes. Step 4 re-reviews it.
- `capped <ts> <url>` — the head moved after the PR's 3rd review, so it is not reviewed
  again. The script already deleted the request's files, leaving an empty `<ts>.done`.
  Reply `review limit reached, ping me if you need another look` in its thread.
- `closed <ts> <merged|closed> <url>` — the script already deleted the request's files,
  leaving an empty `<ts>.done`. Post nothing to Slack.
- `recovered <ts> <url>` — its review was running in a session that is gone (no process
  holds its `.tmp`). The script turned it into a retry, so it comes back as `due` once
  the head has been still for 10 minutes. Tell the user.
- `error <ts> <url> <message>` — `gh` failed; tell the user. It is checked again next
  pass.

It also deletes `.done` and `.skipped` markers older than `SINCE`: the channel is only
read from `SINCE` on, so nothing needs them.

The 10 minutes count from the pass that first saw the new head, and every newer push
restarts them, so a teammate pushing several commits in a row gets one re-review, 10 to
10 + `INTERVAL` minutes after the last push.

## Step 4 — Start new reviews and re-reviews

Record `READ_AT = $(date +%s).000000`, then read the channel with `slack_read_channel`
(`channel_id: CHANNEL`, `oldest: SINCE`, `response_format: detailed`), following
`next_cursor` until done. A message is a **new
request** when all hold:

- it is a top-level message (not a thread reply) and its author is not `ME`;
- its text contains `https://github.com/<owner>/<repo>/pull/<number>`;
- no `STATE/<ts>.*` file exists for it.

The `STATE` files are the only record of what was handled. That is enough, because only
messages after `SINCE` are read and every one of them that this watch handled has a file.

A **re-review** is a `due` line from Step 3b.

Running reviews = the number of `STATE/*.tmp` files. A `.tmp` left by a session that
crashed keeps counting; if one is older than 2 hours, tell the user. While fewer than
**2** are running, take new requests oldest first, then re-reviews oldest first — a
teammate who just asked goes ahead of a PR that only changed. The rest wait for a later
pass (Step 3b prints a waiting re-review as `due` again).

For each one taken:

1. **PR URL** — re-review: the URL on its `due` line. New request: the first PR URL in
   the message; if it has more, tell the user which ones were not reviewed.
2. **Still open?** — `gh pr view <url> --json state,headRefOid`. `state` is not `OPEN`
   → delete the other `STATE/<ts>.*` files and write `STATE/<ts>.done`. Post nothing to
   Slack: replying would revive an old thread and notify everyone in it. `gh` fails →
   tell the user and leave it for a later pass. Otherwise record `HEAD = headRefOid`.
3. **Clone** — `CLONE = REPOS_DIR/<repo>`.
   - `CLONE` does not exist → `gh repo clone <owner>/<repo> "<CLONE>"`, and tell the user
     it was cloned.
   - `gh repo view --json nameWithOwner --jq .nameWithOwner` run inside `CLONE` must
     equal `<owner>/<repo>` (case-insensitive).
   - The clone failed, or `CLONE` holds a different repo → delete the other
     `STATE/<ts>.*` files, write `STATE/<ts>.skipped`, tell the user why, and leave the
     Slack message untouched. Never delete or overwrite an existing `CLONE`.
4. **Acknowledge** — reply `reviewing...` in its thread. Skip this when
   `STATE/<ts>.retry` exists (it was already acknowledged); delete that file instead.
5. **Start** — write the URL to `STATE/<ts>.url`, `HEAD` to `STATE/<ts>.head`, delete
   `STATE/<ts>.pending`, then run with `Bash` `run_in_background: true`:

   ```bash
   { cd "<CLONE>" && "<absolute dir of this SKILL.md>/scripts/run-review.py" "<PR URL>"; } \
     > "<STATE>/<ts>.tmp" 2> "<STATE>/<ts>.err"; mv "<STATE>/<ts>.tmp" "<STATE>/<ts>.out"
   ```

   `run-review.py` runs `/claude-skills:review-pr` in its own headless session and waits
   for its `REVIEW_RESULT` line (plain `claude -p` would exit before the review's
   background Workflow finishes). Its context never enters this one; it gives up after 3
   hours.

Then, if no new request is left waiting for a slot, write `READ_AT` to `STATE/since`.
Every request posted before it now has a `STATE` file, so later passes need not read
that far back. While one is waiting, `SINCE` stays put so it is read again.

## Step 5 — Report

One short line: reviews finished (PR and outcome), reviews and re-reviews started, PRs no
longer watched (merged, closed or capped), reviews recovered, requests waiting for a free
slot, and anything skipped or failed. Nothing else — this runs every few minutes.
