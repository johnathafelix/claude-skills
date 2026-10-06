---
name: review-requests
description: Watch a Slack channel for teammates' PR review requests and review each one with review-pr — replies "reviewing..." in the thread, runs review-pr in its own headless Claude Code session (at most 2 at a time), then replies with the outcome. Keeps watching each reviewed PR: re-reviews it once a new push has sat for 10 minutes, up to 2 reviews per PR; the 2nd review always approves, and every later push is approved without a review. Stops when the PR is merged or closed. Runs as a background Python loop (every 5 minutes, configurable) that reaches Slack through short headless sessions, so this session's context does not grow while it watches. State lives in ~/.claude/review-requests, so a restarted session carries on. Uses the Slack connector already in Claude Code; only picks up messages posted after the watch started. Use when the user invokes /claude-skills:review-requests or asks to watch Slack for review requests.
argument-hint: ""
---

# Review requests

Starts the watch: a background Python loop that runs one pass every `INTERVAL` minutes.
Invoke it once:

```
/claude-skills:review-requests
```

Each pass finishes the reviews that are done, checks the reviewed PRs for new pushes,
then starts reviews for new requests and re-reviews for PRs that changed. All of it
runs outside this session: Python for the logic, a short headless Claude Code session
(haiku, Slack tools only) for each Slack read or post, and a headless session per
review. This session hears from the loop only when it exits.

**This skill posts to Slack and GitHub without asking.** Starting the loop is the user's
approval to reply in the channel under their account, and to post reviews through
`review-pr`.

## Setup (once, by the user)

- **Slack connector** connected in Claude Code (`/mcp`).
- **Channel:** `REVIEW_REQUESTS_CHANNEL_ID` set in the `env` block of
  `~/.claude/settings.json`. Never write the channel ID or the user's Slack ID into this
  repo.
- **User ID (recommended):** `REVIEW_REQUESTS_USER_ID` in the same `env` block — the
  user's Slack ID, used only to skip their own messages. Unset, the headless Slack
  session reads it from the connector.
- **Interval (optional):** `REVIEW_REQUESTS_INTERVAL_MINUTES`, a whole number of
  minutes, 1 or more. Default 5.
- **Review effort (optional):** `REVIEW_PR_EFFORT` — `low`, `medium`, `high`, `xhigh`
  or `max`. Default `high`. The review sessions inherit it, and `review-pr` reads it.
- **Local clones:** each PR's repo lives at `<REPOS_DIR>/<repo>`, and a missing one is
  cloned there on first use. `REPOS_DIR` is `REVIEW_REQUESTS_REPOS_DIR` if set, else
  `~/repos`.
- **Plugin up to date**, so the review sessions can run `/claude-skills:review-pr`.

## Step 1 — Start the loop

Run with `Bash`, `run_in_background: true`:

```bash
"<absolute dir of this SKILL.md>/scripts/loop.py"
```

Tell the user the watch is running, that its log is `~/.claude/review-requests/log`
(one line per pass), and that it lives only in this session: closing the session stops
the loop (running reviews keep going) until the skill is invoked again.

If it exits at once with code 3, a loop from this or another session is already
watching. Tell the user and stop.

## Step 2 — When the loop exits

The background task's output says why. Relay it to the user in a few lines, then:

- **Exit 0** — something the user should know: a review failed (with the PR, the last
  lines of its output, and how to retry), a review whose process was gone and will be
  retried, a request skipped because its repo could not be cloned or the clone holds a
  different repo, a repo that was cloned, a request that named more than one PR (only
  the first is reviewed), or a reply Slack never confirmed (moved to
  `STATE/outbox/failed`; it may or may not have been posted). Start the loop again
  (Step 1, without the intro).
- **Exit 2** — the config is missing or invalid, the Slack connector is not connected,
  or the channel read failed 3 passes in a row. Do not restart. Tell the user to fix it
  (`~/.claude/settings.json`, or reconnect with `/mcp`) and invoke the skill again.
  Reviews already running keep going; the next loop picks up their results.
- **Any other exit code** — the loop crashed. Relay the last lines of its output and do
  not restart; the user decides.

## How a pass works

State lives in `~/.claude/review-requests` (`STATE`), outside any session, so a later
loop finishes or retries the reviews that were running, keeps re-reviewing watched PRs,
and reviews requests posted while nothing was watching. Requests are keyed by their
Slack timestamp `<ts>`.

1. **Start time** — `STATE/since` holds the Slack timestamp the channel is read from.
   Missing → the first pass writes now and does nothing else, so nothing older is
   picked up.
2. **Finish completed reviews** — a running review writes `<ts>.tmp`, renamed to
   `<ts>.out` when its session exits. The `REVIEW_RESULT: <outcome>` line in it picks
   the thread reply:

   | `REVIEW_RESULT` | Thread reply |
   |---|---|
   | `commented` | left some comments |
   | `approved_nits` | left some nit comments, but approved! 🚀 |
   | `approved_comments` | left some comments, but approved to unblock you 🚀 |
   | `approved` | approved! 🚀 |
   | `no_findings` | done! 🚀 |
   | `already_reviewed` | already reviewed this commit ✅ |
   | `still_open` | earlier comments still open |
   | `merged` / `closed` / `head_moved` | — |

   `merged` / `closed` leave only `<ts>.done`. `head_moved` turns into a retry with no
   second "reviewing...". No `REVIEW_RESULT` line → `<ts>.url` becomes `<ts>.failed`
   and the loop exits to tell the user. Every other outcome adds one to `<ts>.reviews`.
3. **Watch reviewed PRs** — `scripts/watch-prs.py` (see its docstring) re-reviews a PR
   once a new head has sat for 10 minutes, with `approve` on the 2nd review; approves
   every later push right away with no review (reply: approved the new changes to
   unblock you 🚀); forgets merged and closed PRs without posting; and recovers reviews
   whose process is gone.
4. **New requests** — a top-level message after `since`, not by the user, with a
   `https://github.com/<owner>/<repo>/pull/<number>` URL, and no `STATE/<ts>.*` file
   yet. New requests go first, then re-reviews, oldest first, while fewer than 2
   reviews run. Each one: a PR that is no longer open is marked done with no reply; the
   clone is checked (or cloned); "reviewing..." is posted unless it is a retry; then
   `scripts/run-review.py` runs `/claude-skills:review-pr` in its own headless session,
   detached from the loop. `since` moves forward once no new request is left waiting.

Slack replies go through an outbox (`STATE/outbox`). An entry is deleted once Slack
confirms the post, retried on the next pass if not, and moved to `STATE/outbox/failed`
after 2 tries so an unconfirmed post is never repeated. A failed Slack read never moves
`since`, and neither does an incomplete one: the model only makes the read calls, and
Python parses their raw results itself and checks that every page was fetched. The
session that reads the channel cannot post, and the one that posts never
sees the channel, so a crafted message cannot make it post.
