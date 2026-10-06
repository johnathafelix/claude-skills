#!/usr/bin/env python3
"""Check every PR that review-requests watches and move its state files along.

A request is watched while `<ts>.url` exists and no review is running (`<ts>.tmp`)
or waiting to be finished (`<ts>.out`). `<ts>.head` holds the head the last review
or approval was on, `<ts>.reviews` how many reviews finished. For each request it
prints at most one line:

    due <ts> <sha> <url>       head moved and has not changed for the grace period
    final <ts> <sha> <url>     same as due, for the last allowed review, which approves
    approved <ts> <url>        head moved after the last allowed review; approved it, no review
    yours <ts> <url>           the user already reviewed the new head; it is taken as reviewed
    closed <ts> <state> <url>  PR merged or closed; only <ts>.done is left
    recovered <ts> <url>       a review whose process is gone; it will be retried
    error <ts> <url> <message> gh failed; it is tried again next pass

A new head is written to `<ts>.pending` with the time it was first seen, and becomes
due once it is still the head after the grace period. A newer push restarts the wait.
After the last allowed review a new head is approved right away, unless the PR is a
draft or the user's own, which GitHub refuses to approve. A head the user already
reviewed (by hand, or from another session) is neither reviewed nor approved again.

`<ts>` is the request's Slack ts, with `~<n>` added for the n-th PR of a request that
named more than one.

`<ts>.done` and `<ts>.skipped` markers older than `since` are deleted: the channel is
only read from `since` on, so nothing needs them.

    watch-prs.py <STATE dir> <grace seconds> <max reviews>
"""
import functools
import json
import pathlib
import re
import subprocess
import sys
import time


def read(path):
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        return ""


def finish(state, ts):
    for path in state.glob(f"{ts}.*"):
        path.unlink()

    (state / f"{ts}.done").touch()


def prune(state):
    since = read(state / "since")
    if not since:
        return

    for path in [*state.glob("*.done"), *state.glob("*.skipped")]:
        if float(path.stem.split("~")[0]) < float(since):
            path.unlink()


def error(ts, url, result):
    message = result.stderr.strip().splitlines()
    print(f"error {ts} {url} {message[-1] if message else result.returncode}")


@functools.cache
def my_login():
    user = subprocess.run(["gh", "api", "user", "--jq", ".login"], capture_output=True, text=True)

    return user.stdout.strip()


def pr_path(ts, url):
    """`repos/<owner>/<repo>/pulls/<number>`, or None (and an error line) for a bad URL."""
    pr = re.search(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)", url)
    if not pr:
        print(f"error {ts} {url} not a PR URL")
        return None

    return "repos/{}/{}/pulls/{}".format(*pr.groups())


def reviewed_by_me(ts, url, head):
    """True when one of the user's reviews is on `head`. A failed lookup counts as no:
    review-pr checks again before reviewing."""
    path = pr_path(ts, url)
    if not path:
        return False

    result = subprocess.run(
        ["gh", "api", "--paginate", f"{path}/reviews", "--jq", f'.[] | select(.user.login == "{my_login()}") | .commit_id'],
        capture_output=True,
        text=True,
    )

    return result.returncode == 0 and head in result.stdout.split()


def approve(ts, url, info):
    """Approve the head without a review. False when skipped or GitHub refused."""
    if info["isDraft"] or info["author"]["login"] == my_login():
        return False

    path = pr_path(ts, url)
    if not path:
        return False

    result = subprocess.run(
        [
            "gh", "api", "-X", "POST", f"{path}/reviews",
            "-f", "event=APPROVE",
            "-f", f"commit_id={info['headRefOid']}",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        error(ts, url, result)
        return False

    print(f"approved {ts} {url}")

    return True


def take_as_reviewed(state, ts, head):
    (state / f"{ts}.head").write_text(f"{head}\n")
    (state / f"{ts}.pending").unlink(missing_ok=True)


def recover(state, now):
    """A `.tmp` nobody holds open belongs to a review whose session is gone."""
    for tmp in state.glob("*.tmp"):
        held = subprocess.run(["lsof", "-t", str(tmp)], capture_output=True).returncode == 0
        if held or now - tmp.stat().st_mtime < 60:
            continue

        ts = tmp.stem
        for suffix in ("tmp", "err", "head"):
            (state / f"{ts}.{suffix}").unlink(missing_ok=True)

        (state / f"{ts}.retry").touch()
        print(f"recovered {ts} {read(state / f'{ts}.url')}")


def main():
    if len(sys.argv) != 4:
        sys.exit("usage: watch-prs.py <STATE dir> <grace seconds> <max reviews>")

    state = pathlib.Path(sys.argv[1])
    grace = int(sys.argv[2])
    max_reviews = int(sys.argv[3])
    now = int(time.time())

    prune(state)
    recover(state, now)

    for url_file in sorted(state.glob("*.url")):
        ts = url_file.stem
        if (state / f"{ts}.tmp").exists() or (state / f"{ts}.out").exists():
            continue

        url = read(url_file)
        pr = subprocess.run(
            ["gh", "pr", "view", url, "--json", "state,headRefOid,isDraft,author"],
            capture_output=True,
            text=True,
        )
        if pr.returncode != 0:
            error(ts, url, pr)
            continue

        info = json.loads(pr.stdout)
        if info["state"] in ("MERGED", "CLOSED"):
            finish(state, ts)
            print(f"closed {ts} {info['state'].lower()} {url}")
            continue

        head = info["headRefOid"]
        pending = state / f"{ts}.pending"
        if head == read(state / f"{ts}.head"):
            pending.unlink(missing_ok=True)
            continue

        reviews = int(read(state / f"{ts}.reviews") or 0)
        if reviews >= max_reviews:
            if reviewed_by_me(ts, url, head):
                take_as_reviewed(state, ts, head)
                print(f"yours {ts} {url}")
            elif approve(ts, url, info):
                take_as_reviewed(state, ts, head)

            continue

        seen_head, _, seen_at = read(pending).partition(" ")
        if seen_head != head:
            pending.write_text(f"{head} {now}\n")
            continue

        if now - int(seen_at) < grace:
            continue

        if reviewed_by_me(ts, url, head):
            take_as_reviewed(state, ts, head)
            print(f"yours {ts} {url}")
            continue

        kind = "final" if reviews == max_reviews - 1 else "due"
        print(f"{kind} {ts} {head} {url}")


if __name__ == "__main__":
    main()
