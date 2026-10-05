#!/usr/bin/env python3
"""Check every PR that review-requests watches and move its state files along.

A request is watched while `<ts>.url` exists and no review is running (`<ts>.tmp`)
or waiting to be finished (`<ts>.out`). `<ts>.head` holds the head the last review
started on, `<ts>.reviews` how many reviews finished. For each request it prints at
most one line:

    due <ts> <sha> <url>       head moved and has not changed for the grace period
    capped <ts> <url>          head moved after the last allowed review; only <ts>.done is left
    closed <ts> <state> <url>  PR merged or closed; only <ts>.done is left
    recovered <ts> <url>       a review whose process is gone; it will be retried
    error <ts> <url> <message> gh failed; nothing changed

A new head is written to `<ts>.pending` with the time it was first seen, and becomes
due once it is still the head after the grace period. A newer push restarts the wait.

`<ts>.done` and `<ts>.skipped` markers older than `since` are deleted: the channel is
only read from `since` on, so nothing needs them.

    watch-prs.py <STATE dir> <grace seconds> <max reviews>
"""
import json
import pathlib
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
        if float(path.stem) < float(since):
            path.unlink()


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
            ["gh", "pr", "view", url, "--json", "state,headRefOid"],
            capture_output=True,
            text=True,
        )
        if pr.returncode != 0:
            message = pr.stderr.strip().splitlines()
            print(f"error {ts} {url} {message[-1] if message else pr.returncode}")
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

        if int(read(state / f"{ts}.reviews") or 0) >= max_reviews:
            finish(state, ts)
            print(f"capped {ts} {url}")
            continue

        seen_head, _, seen_at = read(pending).partition(" ")
        if seen_head != head:
            pending.write_text(f"{head} {now}\n")
            continue

        if now - int(seen_at) >= grace:
            print(f"due {ts} {head} {url}")


if __name__ == "__main__":
    main()
