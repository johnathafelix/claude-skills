#!/usr/bin/env python3
"""Watch production logs on a schedule: fetch, triage, investigate, challenge, ticket.

Runs outside the session that started it. Every TICK_SECONDS it finishes any run that
is still incomplete (a run stopped halfway resumes from its stage markers) and, when
the last fetched window is a full interval old, starts a new run for the logs since
then. One line per event goes to <workdir>/logs/<dd-MM-yyyy>.txt, appended, never
rewritten.

The loop exits, printing what happened, when the user has to know or act:

    exit 0   a run created tickets, a run failed, or an issue gave up after retries.
             Relay and start the loop again.
    exit 2   config missing or invalid, gcloud keeps failing, or the Linear connector
             is unavailable. Relay and do not restart.
    exit 3   another loop already watches this workdir.

    loop.py
"""
import fcntl
import sys
import time

import pipeline
from common import Stop, incomplete_runs, is_due, load_config, log, read_cursor

TICK_SECONDS = 60


def tick(config, now):
    """One pass: resume incomplete runs, then start a new one when due. Returns the runs touched."""
    runs = []
    for path in incomplete_runs(config["workdir"]):
        runs.append(pipeline.process(config, path))

    if not incomplete_runs(config["workdir"]) and is_due(read_cursor(config["workdir"]), now, config["interval"]):
        path = pipeline.create_run(config, now)
        log(config["workdir"], path.name, f"run started (interval {config['interval']}s, namespaces {', '.join(config['namespaces'])})")
        runs.append(pipeline.process(config, path))

    return runs


def main():
    try:
        config = load_config()
    except Stop as stop:
        print(stop)
        sys.exit(2)

    workdir = config["workdir"]
    workdir.mkdir(parents=True, exist_ok=True)
    lock = (workdir / "loop.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(f"another loop already watches {workdir}")
        sys.exit(3)

    print(f"watching {config['gcp_project']} every {config['interval'] // 60} min, log: {workdir / 'logs'}", flush=True)
    log(workdir, "", f"loop started: project {config['gcp_project']}, every {config['interval']}s")

    while True:
        try:
            runs = tick(config, time.time())
        except Stop as stop:
            log(workdir, "", f"stopped: {stop}")
            print(stop)
            sys.exit(2)

        alerts = [alert for run in runs for alert in run.alerts]
        if alerts:
            print(*alerts, sep="\n")
            sys.exit(0)

        time.sleep(TICK_SECONDS)


if __name__ == "__main__":
    main()
