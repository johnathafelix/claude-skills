#!/usr/bin/env python3
"""Watch review requests through the Claude Slack connector, with idle backoff.

Local completion/queue checks run every 30 seconds; GitHub watches every minute.
Connector reads use INTERVAL, backing off during inactivity. Persist queued requests
before advancing the Slack cursor, so a full queue never repeatedly reads old messages.
Posts are batched, and only run when replies exist.

One line per pass goes to STATE/log. The loop exits, printing what happened, when the
user has to know or act:

    exit 0   a review failed, a review was recovered, a request was skipped, a repo was
             cloned, or a reply could not be confirmed.
             Relay and start the loop again.
    exit 2   config missing or invalid, the Slack connector is unavailable, or the
             channel read failed MAX_SLACK_ERRORS passes in a row. Relay and do not
             restart.
    exit 3   another loop already watches STATE.

Every PR in a request is reviewed on its own. Its state files are keyed by the
message's Slack ts for the first PR, and `<ts>~2`, `<ts>~3`, … for the others. A
request with more than one PR gets one "reviewing..." and then one reply per PR, each
starting with the PR's `<repo>#<number>` (kept in `<key>.label`).

    loop.py
"""
import fcntl
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time

import slack

SCRIPTS = pathlib.Path(__file__).resolve().parent
STATE = pathlib.Path.home() / ".claude" / "review-requests"
MAX_RUNNING = 2
GRACE_SECONDS = 600
MAX_REVIEWS = 2
MAX_POST_ATTEMPTS = 2
MAX_POST_BATCH = 8
MAX_SLACK_ERRORS = 3
TICK_SECONDS = 30
WATCH_SECONDS = 60
PR_URL = re.compile(r"https://github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)")

REPLIES = {
    "commented": "left some comments",
    "approved_nits": "left some nit comments, but approved! 🚀",
    "approved_comments": "left some comments, but approved to unblock you 🚀",
    "approved": "approved! 🚀",
    "no_findings": "done! 🚀",
    "already_reviewed": "already reviewed this commit ✅",
    "still_open": "earlier comments still open",
    "merged": None,
    "closed": None,
    "head_moved": None,
}

# Starts one review in the background and returns, so the review outlives the loop and
# is never its child: $1 is the STATE/<ts> prefix, $2 the clone, the rest the
# run-review.py command line.
LAUNCH = 'p=$1; shift; ( { cd "$1" && shift && "$@"; } > "$p.tmp" 2> "$p.err"; mv "$p.tmp" "$p.out" ) &'


class Stop(Exception):
    pass


def read(path):
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        return ""


def gh(*args, cwd=None):
    return subprocess.run(["gh", *args], capture_output=True, text=True, cwd=cwd)


def last_line(text):
    lines = text.strip().splitlines()

    return lines[-1] if lines else ""


def write_json(path, value):
    with tempfile.NamedTemporaryFile("w", prefix=".queue-", dir=path.parent, delete=False) as f:
        json.dump(value, f)
        temporary = f.name
    os.replace(temporary, path)


def forget(ts, keep):
    """Delete every STATE/<ts>.* file and leave only the `keep` marker."""
    for path in STATE.glob(f"{ts}.*"):
        path.unlink()

    (STATE / f"{ts}.{keep}").touch()


def thread_of(key):
    return key.split("~")[0]


def labeled(key, text):
    label = read(STATE / f"{key}.label")

    return f"{label}: {text}" if label else text


def queue_reply(ts, text):
    outbox = STATE / "outbox"
    outbox.mkdir(exist_ok=True)
    (outbox / f"{ts}-{time.time_ns()}.json").write_text(json.dumps({"thread_ts": ts, "text": text, "attempts": 0}))


def outbox_posts():
    return [
        {"id": path.stem, **json.loads(path.read_text())}
        for path in sorted((STATE / "outbox").glob("*.json"))
    ]


def cache_ttls(usage):
    """The TTLs ("5m", "1h") of the cache writes in one API usage block."""
    writes = usage.get("cache_creation") or {}
    return {ttl for ttl in ("5m", "1h") if writes.get(f"ephemeral_{ttl}_input_tokens")}


def token_summary(tokens, reads, writes, ttls):
    """Token counts for a log line; the TTL is that of the cache writes, when any."""
    ttl = f", {'+'.join(sorted(ttls))} TTL" if ttls else ""
    return f"{tokens} tokens, {reads} cache reads, {writes} cache writes{ttl}"


def review_usage(report):
    """Token counts of a review session, every model and subagent included, from run-review.py."""
    models = (report.get("model_usage") or {}).values()
    if not models:
        return ""

    reads = sum(m.get("cacheReadInputTokens") or 0 for m in models)
    writes = sum(m.get("cacheCreationInputTokens") or 0 for m in models)
    tokens = reads + writes + sum((m.get("inputTokens") or 0) + (m.get("outputTokens") or 0) for m in models)
    ttls = set().union(*(cache_ttls(usage) for usage in report.get("turn_usages") or []))

    return f" (review: {token_summary(tokens, reads, writes, ttls)})"


class Pass:
    def __init__(self, config):
        self.config = config
        self.notes = []
        self.alerts = []
        self.tokens = 0
        self.cache_reads = 0
        self.cache_writes = 0
        self.cache_ttls = set()
        self.slack_read = False
        self.new_requests = 0

    def slack(self, call, *args):
        """Runs slack.read or slack.post, once more after 30s if the connector is not up yet."""
        for attempt in range(2):
            reply = call(self.config["channel"], *args)
            usage = reply.get("usage", {})
            self.tokens += sum(usage.get(key) or 0 for key in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
            self.cache_reads += usage.get("cache_read_input_tokens") or 0
            self.cache_writes += usage.get("cache_creation_input_tokens") or 0
            self.cache_ttls |= cache_ttls(usage)
            if reply["status"] != "unavailable" or attempt:
                return reply
            time.sleep(30)

    def usage(self):
        return f"[{token_summary(self.tokens, self.cache_reads, self.cache_writes, self.cache_ttls)}]"

    def post_outbox(self):
        """Posts the queued replies. One still unconfirmed after MAX_POST_ATTEMPTS moves to
        outbox/failed, so a post that went out without a confirmation is not repeated."""
        posts = outbox_posts()[:MAX_POST_BATCH]
        if not posts:
            return

        reply = self.slack(slack.post, [{k: p[k] for k in ("id", "thread_ts", "text")} for p in posts], STATE)
        sent = {s["id"] for s in reply["sent"]}
        if reply["status"] != "ok":
            self.notes.append(f"posting failed: {reply['detail']}")

        for p in posts:
            path = STATE / "outbox" / f"{p['id']}.json"
            if p["id"] in sent:
                path.unlink(missing_ok=True)
                continue

            attempts = p.get("attempts", 0) + 1
            if attempts < MAX_POST_ATTEMPTS:
                path.write_text(json.dumps({"thread_ts": p["thread_ts"], "text": p["text"], "attempts": attempts}))
                continue

            failed = STATE / "outbox" / "failed"
            failed.mkdir(exist_ok=True)
            path.rename(failed / path.name)
            self.alerts.append(
                f'reply "{p["text"]}" in thread {p["thread_ts"]} not confirmed after {attempts} tries '
                f"({reply['detail'] or 'no ts returned'}); it may or may not have been posted. Moved to {failed}"
            )

    def finish_reviews(self):
        for out in sorted(STATE.glob("*.out")):
            ts = out.stem
            url = read(STATE / f"{ts}.url")

            try:
                report = json.loads(out.read_text())
            except json.JSONDecodeError:
                report = {"result": out.read_text()}

            result = report.get("result") or ""

            match = re.search(r"^REVIEW_RESULT:\s*(\w+)\s*$", result.strip().splitlines()[-1] if result.strip() else "")
            outcome = match.group(1) if match and match.group(1) in REPLIES else "error"

            if outcome == "error":
                (STATE / f"{ts}.failed").write_text(f"{url}\n")
                (STATE / f"{ts}.url").unlink(missing_ok=True)
                self.alerts.append(
                    f"review failed: {url}\n"
                    f"  result: {last_line(result)}\n"
                    f"  stderr: {last_line(read(STATE / f'{ts}.err'))}\n"
                    f"  retry: in {STATE} rename {ts}.failed to {ts}.url, delete {ts}.out, {ts}.err and {ts}.head, create {ts}.retry"
                )
                continue

            if REPLIES[outcome]:
                queue_reply(thread_of(ts), labeled(ts, REPLIES[outcome]))

            self.notes.append(f"{outcome} {url}{review_usage(report)}")

            if outcome in ("merged", "closed"):
                forget(ts, "done")
                continue

            for suffix in ("out", "err"):
                (STATE / f"{ts}.{suffix}").unlink(missing_ok=True)

            if outcome == "head_moved":
                (STATE / f"{ts}.head").unlink(missing_ok=True)
                (STATE / f"{ts}.retry").touch()
            elif outcome != "already_reviewed":
                reviews = STATE / f"{ts}.reviews"
                reviews.write_text(f"{int(read(reviews) or 0) + 1}\n")

    def watch_prs(self):
        """Runs watch-prs.py and returns its due/final lines as (ts, url, flag)."""
        watch = subprocess.run(
            [sys.executable, SCRIPTS / "watch-prs.py", STATE, str(GRACE_SECONDS), str(MAX_REVIEWS)],
            capture_output=True,
            text=True,
        )
        if watch.returncode != 0:
            self.notes.append(f"watch-prs failed: {last_line(watch.stderr)}")

        rereviews = []
        for line in watch.stdout.splitlines():
            kind, ts, *rest = line.split(" ", 3)
            if kind in ("due", "final"):
                rereviews.append((ts, rest[1], ["approve"] if kind == "final" else []))
            elif kind == "approved":
                queue_reply(thread_of(ts), labeled(ts, "approved the new changes to unblock you 🚀"))
                self.notes.append(line)
            elif kind == "recovered":
                self.alerts.append(f"review process gone, it will be retried: {rest[0]}")
            else:
                self.notes.append(line)

        return rereviews

    def start(self, ts, url, flag, ack, label=""):
        """Starts a review of the PR keyed `ts`, replying `ack` in its thread first (unless
        it is a retry). False when it could not, and the request should wait."""
        owner, repo, _ = PR_URL.match(url).groups()

        pr = gh("pr", "view", url, "--json", "state,headRefOid")
        if pr.returncode != 0:
            self.notes.append(f"gh failed, retried next pass: {url}: {last_line(pr.stderr)}")
            return False

        info = json.loads(pr.stdout)
        if info["state"] != "OPEN":
            forget(ts, "done")
            self.notes.append(f"{info['state'].lower()} {url}")
            return True

        clone = self.config["repos_dir"] / repo
        if not clone.exists():
            cloned = gh("repo", "clone", f"{owner}/{repo}", str(clone))
            if cloned.returncode != 0:
                forget(ts, "skipped")
                self.alerts.append(f"skipped {url}: clone failed: {last_line(cloned.stderr)}")
                return True

            self.alerts.append(f"cloned {owner}/{repo} into {clone}")

        name = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner", cwd=clone)
        if name.stdout.strip().lower() != f"{owner}/{repo}".lower():
            forget(ts, "skipped")
            self.alerts.append(f"skipped {url}: {clone} does not hold {owner}/{repo}")
            return True

        retry = STATE / f"{ts}.retry"
        if retry.exists():
            retry.unlink()
        elif ack:
            queue_reply(thread_of(ts), ack)

        if label:
            (STATE / f"{ts}.label").write_text(f"{label}\n")

        (STATE / f"{ts}.url").write_text(f"{url}\n")
        (STATE / f"{ts}.head").write_text(f"{info['headRefOid']}\n")
        (STATE / f"{ts}.pending").unlink(missing_ok=True)
        (STATE / f"{ts}.queued").unlink(missing_ok=True)

        subprocess.run(
            ["bash", "-c", LAUNCH, "launch", str(STATE / ts), str(clone), str(SCRIPTS / "run-review.py"), url, *flag],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.notes.append(f"started {url}{' (approve)' if flag else ''}")

        return True

    def discover(self, messages, me):
        """Persist just PR URLs/labels before advancing since; no message prose."""
        for message in sorted(messages, key=lambda m: float(m["ts"])):
            urls = list(dict.fromkeys(m.group(0) for u in message["pr_urls"] if (m := PR_URL.match(u))))
            if message["user"] == me or not urls:
                continue
            ts = message["ts"]
            keys = [ts] + [f"{ts}~{n}" for n in range(2, len(urls) + 1)]
            fresh = not any(any(STATE.glob(f"{key}.*")) for key in keys)
            for key, url in zip(keys, urls):
                if any(STATE.glob(f"{key}.*")):
                    continue
                label = "{1}#{2}".format(*PR_URL.match(url).groups()) if len(urls) > 1 else ""
                write_json(STATE / f"{key}.queued", {"url": url, "label": label, "ack": fresh})
                self.new_requests += 1

    def start_queued(self, slots):
        for path in sorted(STATE.glob("*.queued")):
            if slots <= 0:
                break
            request = json.loads(path.read_text())
            ts = path.stem
            if not self.start(ts, request["url"], [], "reviewing..." if request["ack"] else None, request["label"]):
                continue
            if (STATE / f"{ts}.url").exists():
                slots -= 1
                # One acknowledgement per multi-PR message, including when requests
                # wait across several connector reads or a loop restart.
                for sibling in STATE.glob(f"{thread_of(ts)}*.queued"):
                    if thread_of(sibling.stem) != thread_of(ts):
                        continue
                    data = json.loads(sibling.read_text())
                    data["ack"] = False
                    write_json(sibling, data)
        waiting = len(list(STATE.glob("*.queued")))
        if waiting:
            self.notes.append(f"{waiting} request(s) waiting")
        return slots

    def run(self, read_channel=True, watch=True):
        since = STATE / "since"
        if not since.exists():
            since.write_text(f"{time.time():.6f}\n")
            self.notes.append("watch started")
            return

        self.finish_reviews()
        # Deliver completed reviews before a connector read can block this pass.
        # Retry an unconfirmed post only on the next pass, never twice in one tick.
        posted = bool(outbox_posts())
        if posted:
            self.post_outbox()
        rereviews = self.watch_prs() if watch else []

        if read_channel:
            self.read_requests(since)

        slots = MAX_RUNNING - len(list(STATE.glob("*.tmp")))
        slots = self.start_queued(slots)
        for ts, url, flag in rereviews:
            if slots > 0 and self.start(ts, url, flag, labeled(ts, "reviewing...")) and (STATE / f"{ts}.url").exists():
                slots -= 1
        if not posted:
            self.post_outbox()

    def read_requests(self, since):
        self.slack_read = True

        read_at = f"{time.time():.6f}"
        reply = self.slack(slack.read, read(since), STATE, not self.config["me"])
        if reply["status"] == "unavailable":
            raise Stop(f"Slack connector unavailable: {reply['detail']}")

        errors = STATE / "slack-errors"
        if reply["status"] != "ok":
            count = int(read(errors) or 0) + 1
            if count >= MAX_SLACK_ERRORS:
                errors.unlink()
                raise Stop(f"Slack read failed {count} passes in a row: {reply['detail']}")

            errors.write_text(f"{count}\n")
            self.notes.append(f"Slack read failed, retried next pass: {reply['detail']}")
            return

        errors.unlink(missing_ok=True)

        me = self.config["me"] or reply["me"]
        if not me:
            raise Stop("no Slack user ID: set REVIEW_REQUESTS_USER_ID in ~/.claude/settings.json")
        self.config["me"] = me  # Connector discovery is needed only once per loop.
        self.discover(reply["messages"], me)
        since.write_text(f"{read_at}\n")


class Schedule:
    """Separate cheap local ticks from expensive connector reads."""
    def __init__(self, config):
        self.base = config["interval"] * 60
        self.maximum = config["max_idle_interval"] * 60
        self.delay = self.base
        self.read_at = 0
        self.watch_at = 0

    def due(self, now):
        return now >= self.read_at, now >= self.watch_at

    def advance(self, now, current, watched, busy):
        if watched:
            self.watch_at = now + WATCH_SECONDS
        active = busy or current.new_requests or any(n.startswith(("started ", "head_moved ", "approved ", "commented ")) for n in current.notes)
        if active or current.alerts or (STATE / "slack-errors").exists():
            self.delay = self.base
            self.read_at = min(self.read_at or now + self.base, now + self.base)
        elif current.slack_read:
            self.delay = min(self.maximum, self.delay * 2)
        if current.slack_read:
            self.read_at = now + self.delay


def load_config():
    channel = os.environ.get("REVIEW_REQUESTS_CHANNEL_ID", "")
    if not channel:
        raise Stop("set REVIEW_REQUESTS_CHANNEL_ID in ~/.claude/settings.json")

    interval = os.environ.get("REVIEW_REQUESTS_INTERVAL_MINUTES", "5")
    if not interval.isdigit() or int(interval) < 1:
        raise Stop("REVIEW_REQUESTS_INTERVAL_MINUTES must be a whole number of minutes, 1 or more")
    maximum = os.environ.get("REVIEW_REQUESTS_MAX_IDLE_INTERVAL_MINUTES", str(max(30, int(interval))))
    if not maximum.isdigit() or int(maximum) < int(interval):
        raise Stop("REVIEW_REQUESTS_MAX_IDLE_INTERVAL_MINUTES must be a whole number >= INTERVAL")

    return {
        "channel": channel,
        "me": os.environ.get("REVIEW_REQUESTS_USER_ID", ""),
        "interval": int(interval),
        "max_idle_interval": int(maximum),
        "repos_dir": pathlib.Path(os.environ.get("REVIEW_REQUESTS_REPOS_DIR") or pathlib.Path.home() / "repos").expanduser(),
    }


def log(line):
    with (STATE / "log").open("a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")


def main():
    try:
        config = load_config()
    except Stop as stop:
        print(stop)
        sys.exit(2)

    STATE.mkdir(parents=True, exist_ok=True)
    lock = (STATE / "loop.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(f"another loop already watches {STATE}")
        sys.exit(3)

    print(f"watching every {config['interval']} min, log: {STATE / 'log'}", flush=True)
    schedule = Schedule(config)

    while True:
        current = Pass(config)
        read_channel, watch = schedule.due(time.monotonic())
        try:
            current.run(read_channel, watch)
        except Stop as stop:
            log(f"stopped: {stop}")
            print(*current.alerts, stop, sep="\n")
            sys.exit(2)

        busy = bool(list(STATE.glob("*.tmp")) or list(STATE.glob("*.queued")))
        schedule.advance(time.monotonic(), current, watch, busy)
        if current.slack_read or current.notes or current.alerts or current.tokens:
            log(f"{'; '.join(current.notes + current.alerts) or 'idle'} {current.usage()} next Slack read in {max(0, int(schedule.read_at - time.monotonic()))}s")

        if current.alerts:
            print(*current.alerts, sep="\n")
            sys.exit(0)

        time.sleep(TICK_SECONDS)


if __name__ == "__main__":
    main()
