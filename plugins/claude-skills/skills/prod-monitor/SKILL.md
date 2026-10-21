---
name: prod-monitor
description: "Watch production logs on GCP on a schedule: fetch the watched namespaces' warnings and errors, triage them with opus, find the probable root cause and a fix per issue in the source code (read-only, kubectl inspection allowed), challenge every finding independently, then open Linear tickets assigned to the user. Resumable, journaled under a workdir, production kept read-only by a hook. Invoke once to start the session's background watch."
argument-hint: ""
---

# Prod monitor

Starts the watch: a background Python loop that every interval reads the last window of
Cloud Logging entries for the configured namespaces and turns the issues in them into
Linear tickets, each with a probable root cause, a proposed fix and an independent
challenge of both. Invoke it once:

```
/claude-skills:prod-monitor
```

The loop runs outside this session: Python for the schedule, the log fetch and the
bookkeeping; one headless Claude Code session per model step. This session hears from
the loop only when it exits.

**This skill creates Linear tickets without asking.** Starting the loop is the user's
approval to create tickets in the configured team and project, assigned to them. It
never changes production: every session it starts runs with the `prod-guard` hook
active, which denies mutating `kubectl`, `gcloud`, `helm`, `gsutil` and infrastructure
commands, destructive `git` commands, and any file write outside the run's own
directories. With `PROD_MONITOR_OPEN_PRS=1` it also pushes fix branches and opens
draft PRs for confirmed findings; that is off by default.

## Setup (once, by the user)

All values go in the `env` block of `~/.claude/settings.json`. Never write them into
this repo.

Required:

- `PROD_MONITOR_GCP_PROJECT`: the GCP project whose logs are read.
- `PROD_MONITOR_NAMESPACES`: comma-separated Kubernetes namespaces the user is
  responsible for; only their entries are read (`resource.labels.namespace_name`).
- `PROD_MONITOR_REPOS_DIR`: the directory holding every repository checked out. The
  agents read code from detached worktrees under `<workdir>/worktrees`, never from
  these working copies.
- `PROD_MONITOR_LINEAR_TEAM` and `PROD_MONITOR_LINEAR_PROJECT`: where tickets go,
  by name (as the Linear connector resolves them).
- `PROD_MONITOR_WORKDIR`: where runs, logs, reports and worktrees are stored.

Optional:

- `PROD_MONITOR_LINEAR_LABELS`: comma-separated label names put on every ticket;
  unset or empty means no labels. Names are resolved to their Linear IDs when the loop
  starts (case-insensitive, exact name, cached in `<workdir>/linear-labels.json`); a
  name that does not exist stops the loop with exit 2 before any ticket is attempted,
  unless `PROD_MONITOR_LINEAR_CREATE_LABELS=1`, in which case the loop creates it in the
  team (exact configured name, default color, no group) and logs that it did.
- `PROD_MONITOR_INTERVAL`: `30m`, `1h`, `2h`, ... Default `1h`.
- `PROD_MONITOR_MIN_SEVERITY` (default `WARNING`), `PROD_MONITOR_EXTRA_FILTER` (a
  Cloud Logging clause ANDed to the query), `PROD_MONITOR_LOG_LIMIT` (default 5000
  entries per run, shared evenly across the slices) and
  `PROD_MONITOR_FETCH_SLICE_MINUTES` (default 5: the window is read slice by slice and
  each slice keeps its newest entries up to its share, so truncation never hides the
  start of the hour).
- `PROD_MONITOR_CONTEXT_BEFORE_MINUTES` (default 5), `PROD_MONITOR_CONTEXT_AFTER_MINUTES`
  (default 1) and `PROD_MONITOR_CONTEXT_LIMIT` (default 500): how much all-severity
  context is fetched around each issue's sample entries for the investigators.
- `PROD_MONITOR_MAX_PARALLEL` (default 3: how many finding or challenge sessions run at once; it bounds the token burn rate, not the total per run),
  `PROD_MONITOR_SESSION_TIMEOUT_SECONDS` (default 1800),
  `PROD_MONITOR_SKIP_TTL_HOURS` (default 24: how long a rejected, inconclusive or
  failed issue is left alone before it is investigated again).
- Models and efforts: `PROD_MONITOR_TRIAGE_MODEL`/`_EFFORT` (opus, medium),
  `PROD_MONITOR_FINDINGS_MODEL`/`_EFFORT` (opus, high),
  `PROD_MONITOR_CHALLENGE_MODEL`/`_EFFORT` (opus, high),
  `PROD_MONITOR_LINEAR_MODEL` (sonnet), `PROD_MONITOR_PR_MODEL`/`_EFFORT` (opus,
  medium).
- `PROD_MONITOR_OPEN_PRS=1`: also open a draft PR per confirmed ticket.

Also needed: the Google Cloud SDK (`gcloud`) logged in with access to the project's
logs, `kubectl` with a context that can read the namespaces (for pod inspection), the
Linear connector connected in Claude Code (`/mcp`), and the plugin up to date.
Optional: a Datadog MCP server (the `datadog` plugin from the official marketplace, or
the claude.ai Datadog connector). When one is configured, the investigating and
challenging sessions use its read-only tools for traces, error rates, latency and log
analytics; without one they rely on Cloud Logging and `kubectl`.

## Step 1 — Start the loop

Run with `Bash`, `run_in_background: true`:

```bash
python3 "<absolute dir of this SKILL.md>/scripts/loop.py"
```

Tell the user the watch is running, that the daily log is
`<PROD_MONITOR_WORKDIR>/logs/<dd-MM-yyyy>.txt`, that each run's reports land in
`<PROD_MONITOR_WORKDIR>/tickets/<dd-MM-yyyy>/`, and that the loop lives only in this
session: closing the session stops it (a run in progress resumes when the skill is
invoked again).

If it exits at once with code 3, a loop from this or another session already watches
that workdir. Tell the user and stop.

## Step 2 — When the loop exits

The background task's output says why. Relay it to the user in a few lines, then:

- **Exit 0**: a run created tickets (relay the ticket list and the report path), a run
  failed at a stage after three attempts, or an issue was given up after three
  attempts. Start the loop again (Step 1, without the intro).
- **Exit 2**: the config is missing or invalid, `gcloud` kept failing (not logged in,
  no access, not installed) or the Linear connector is unavailable. Do not restart.
  Tell the user what to fix (`~/.claude/settings.json`, `gcloud auth login`, or
  reconnect with `/mcp`) and invoke the skill again; the interrupted run resumes.
- **Any other exit code**: the loop crashed. Relay the last lines of its output and do
  not restart; the user decides.

## How a run works

Every `TICK` (60 s) the loop first finishes any incomplete run, then, when the end of
the last fetched window is a full interval old, starts a new run for the logs since
then (a gap longer than a day is not caught up: the run reads one interval). A run is
`<workdir>/<dd-MM-yyyy-HH-mm>/` and goes through these stages; each leaves
`state/<stage>.done`, per-issue steps leave one JSON file per issue, so a stopped loop
redoes only what has no result yet:

| Stage | Model | Output |
|---|---|---|
| fetch | none (`gcloud logging read` per slice, severity ≥ WARNING, the namespaces) | the window is read in `PROD_MONITOR_FETCH_SLICE_MINUTES` slices, each keeping its newest share of `PROD_MONITOR_LOG_LIMIT`, so a noisy hour is sampled evenly; `gcp-logs/logs.json`, `slices.json` (per-slice counts and which hit their cap), `digest.md` (deterministic grouping by service, severity and normalized message) |
| triage | opus, medium, only on what is new | groups whose log signature a known issue remembered are folded out first (`triage/known-groups.json`) and listed as recurrences; the session classifies the rest from `triage/digest.md`, and is skipped when nothing is new. Writes `triage/triage.md`, `issues.json` (service, severity, fingerprint, actionable), `plan.json` (investigate / known / ignore) |
| context | none (`gcloud logging read`, every severity, INFO included) | `triage/issues/<issue>.context.md` + `.json`: the entries from the same pods or traces as the issue's samples, from `PROD_MONITOR_CONTEXT_BEFORE_MINUTES` before the first sample to `PROD_MONITOR_CONTEXT_AFTER_MINUTES` after the last, oldest first, up to `PROD_MONITOR_CONTEXT_LIMIT` |
| findings | opus, high, one session per issue, in parallel | first a sonnet duplicate check against known issues that appeared after this run's triage (another run's tickets, a retry); a match becomes a recurrence instead of an investigation. Then `findings/<issue>.md` + `.json`: evidence, probable root cause, proposed fix, confidence |
| challenge | opus, high, one session per finding | `challenged-findings/<issue>.md` + `.json`: confirmed, partially_confirmed or rejected, with corrections |
| tickets | sonnet relay, one Linear `save_issue` per confirmed or partially confirmed finding | the same duplicate check once more for the findings about to be ticketed; `tickets/<issue>.json`; `<workdir>/known-issues.json` remembers the fingerprint and ticket |
| prs (opt-in) | opus, medium | `prs/<issue>.json`: a draft PR from a worktree under `<workdir>/worktrees` |
| report | none | `<workdir>/tickets/<dd-MM-yyyy>/<run>.md` and `report.md`: tickets created, issues investigated without a ticket, recurrences, noise |

A failed session is retried on the next tick, three times; then the issue is recorded as
failed and the run goes on. A fetch that fails three times stops the loop (exit 2)
because `gcloud` itself needs the user. `<workdir>/known-issues.json` remembers every ticketed or
skipped issue with its fingerprint and the log signatures (namespace, service,
normalized message) of its digest groups. On the next run those groups are folded out
before triage, so the model only sees new lines, and the issue is listed as a
recurrence with its ticket; a known issue the model recognizes by fingerprint is
skipped the same way, and its new signatures are remembered too. Rejected, inconclusive and failed issues are left alone for
`PROD_MONITOR_SKIP_TTL_HOURS`. Known issues that appear after a run's triage (another
run's tickets, a retried ticket) are checked by a sonnet session before the run
investigates and again before it tickets: an issue judged the same problem is counted as
a recurrence of that ticket, its signatures are remembered under it, and no second ticket
is created (`triage/dedupe-<stage>.json` keeps the answer).

Every session's event stream is kept in `<run>/sessions/<stage>.log`. Everything the
loop does is appended to `<workdir>/logs/<dd-MM-yyyy>.txt`, one file per day, never
rewritten.

Investigating sessions get `Bash`, `Read`, `Grep`, `Glob`, `Write` and `ToolSearch`,
with `PROD_MONITOR_GUARD=1` so the hook keeps production and the user's checkouts
read-only, and `PROD_MONITOR_WRITABLE` limited to the stage's output directory and
`<workdir>/worktrees`. They start from the issue's all-severity context file, read code from detached
worktrees of `origin/<default>`, may run `gcloud logging read` for anything the
context window misses and read-only `kubectl` on the pods. The Datadog MCP servers are
allowed for them, and the hook denies every Datadog tool that is not a read (search,
get, list, aggregate, analyze, load, ask).
The Linear relay session has only the `save_issue` tool, no hooks and no skills, and
receives the ticket text as data.
