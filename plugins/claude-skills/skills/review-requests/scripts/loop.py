#!/usr/bin/env python3
"""Watch the review-request channel: one pass every INTERVAL minutes, until something
needs the user.

Each pass finishes the reviews that are done, checks the reviewed PRs for new pushes
(watch-prs.py), reads the channel and starts reviews for new requests and re-reviews for
PRs that changed. Slack goes through slack.py, short headless sessions: one read per
pass, and one post when there are replies. Everything else is plain Python, so the
session that started the loop sees nothing until it exits.

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
import time

import slack

SCRIPTS = pathlib.Path(__file__).resolve().parent
STATE = pathlib.Path.home() / ".claude" / "review-requests"
MAX_RUNNING = 2
GRACE_SECONDS = 600
MAX_REVIEWS = 2
MAX_POST_ATTEMPTS = 2
MAX_SLACK_ERRORS = 3
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


class Pass:
    def __init__(self, config):
        self.config = config
        self.notes = []
        self.alerts = []
        self.tokens = 0

    def slack(self, call, *args):
        """Runs slack.read or slack.post, once more after 30s if the connector is not up yet."""
        reply = call(self.config["channel"], *args)
        if reply["status"] == "unavailable":
            time.sleep(30)
            reply = call(self.config["channel"], *args)

        usage = reply.get("usage", {})
        self.tokens += sum(
            usage.get(key) or 0
            for key in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens")
        )

        return reply

    def post_outbox(self):
        """Posts the queued replies. One still unconfirmed after MAX_POST_ATTEMPTS moves to
        outbox/failed, so a post that went out without a confirmation is not repeated."""
        posts = outbox_posts()
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
                result = json.loads(out.read_text()).get("result") or ""
            except json.JSONDecodeError:
                result = out.read_text()

            match = re.search(r"REVIEW_RESULT:\s*(\w+)", result)
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

            self.notes.append(f"{outcome} {url}")

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

        subprocess.run(
            ["bash", "-c", LAUNCH, "launch", str(STATE / ts), str(clone), str(SCRIPTS / "run-review.py"), url, *flag],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.notes.append(f"started {url}{' (approve)' if flag else ''}")

        return True

    def run(self):
        since = STATE / "since"
        if not since.exists():
            since.write_text(f"{time.time():.6f}\n")
            self.notes.append("watch started")
            return

        self.finish_reviews()
        rereviews = self.watch_prs()

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
            self.post_outbox()
            return

        errors.unlink(missing_ok=True)

        me = self.config["me"] or reply["me"]
        if not me:
            raise Stop("no Slack user ID: set REVIEW_REQUESTS_USER_ID in ~/.claude/settings.json")

        requests = []
        for message in sorted(reply["messages"], key=lambda m: float(m["ts"])):
            urls = list(dict.fromkeys(m.group(0) for u in message["pr_urls"] if (m := PR_URL.match(u))))
            if message["user"] == me or not urls:
                continue

            ts = message["ts"]
            keys = [ts] + [f"{ts}~{n}" for n in range(2, len(urls) + 1)]
            todo = [(key, url) for key, url in zip(keys, urls) if not any(STATE.glob(f"{key}.*"))]
            if todo:
                requests.append((len(todo) == len(urls), len(urls) > 1, todo))

        slots = MAX_RUNNING - len(list(STATE.glob("*.tmp")))
        waiting = 0
        for fresh, several, todo in requests:
            ack = "reviewing..." if fresh else None
            for key, url in todo:
                label = "{1}#{2}".format(*PR_URL.match(url).groups()) if several else ""
                if slots <= 0 or not self.start(key, url, [], ack, label):
                    waiting += 1
                    continue

                if (STATE / f"{key}.url").exists():
                    slots -= 1
                    ack = None

        for ts, url, flag in rereviews:
            if slots > 0 and self.start(ts, url, flag, labeled(ts, "reviewing...")) and (STATE / f"{ts}.url").exists():
                slots -= 1

        if waiting:
            self.notes.append(f"{waiting} request(s) waiting")
        else:
            since.write_text(f"{read_at}\n")

        self.post_outbox()


def load_config():
    channel = os.environ.get("REVIEW_REQUESTS_CHANNEL_ID", "")
    if not channel:
        raise Stop("set REVIEW_REQUESTS_CHANNEL_ID in ~/.claude/settings.json")

    interval = os.environ.get("REVIEW_REQUESTS_INTERVAL_MINUTES", "5")
    if not interval.isdigit() or int(interval) < 1:
        raise Stop("REVIEW_REQUESTS_INTERVAL_MINUTES must be a whole number of minutes, 1 or more")

    return {
        "channel": channel,
        "me": os.environ.get("REVIEW_REQUESTS_USER_ID", ""),
        "interval": int(interval),
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

    while True:
        current = Pass(config)
        try:
            current.run()
        except Stop as stop:
            log(f"stopped: {stop}")
            print(*current.alerts, stop, sep="\n")
            sys.exit(2)

        log(f"{'; '.join(current.notes + current.alerts) or 'idle'} [{current.tokens} tokens]")

        if current.alerts:
            print(*current.alerts, sep="\n")
            sys.exit(0)

        time.sleep(config["interval"] * 60)


if __name__ == "__main__":
    main()
