#!/usr/bin/env python3
"""Run /claude-skills:review-pr on one PR in its own headless Claude Code session.

Plain `claude -p` exits as soon as the first turn ends, but review-pr dispatches its
review as a background Workflow and finishes in a later turn, when the completion
notification arrives. Holding stdin open in stream-json mode keeps the session alive
for those turns, so this waits until a turn ends with the REVIEW_RESULT line.

The coordinator defaults to sonnet (REVIEW_PR_COORDINATOR_MODEL overrides it).
Review/check/challenge agents still explicitly use opus. The plugin containing this
script is loaded directly, avoiding a stale installed copy when run from a checkout.

Run from the PR repo's clone. Prints {"result": "<last turn's text>", "model_usage": {...},
"turn_usages": [...]} on stdout: model_usage is the session's running total per model,
subagents included, and turn_usages holds each turn's usage (main agent only), which
alone tells the cache TTL.
`approve` is passed on to review-pr, which then approves whatever it finds.

    run-review.py <PR URL> [fast|standard|thorough] [low|medium|high|xhigh|max] [approve] [full]
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import threading

MARKER = "REVIEW_RESULT:"
PROFILES = {"fast", "standard", "thorough"}
EFFORTS = {"low", "medium", "high", "xhigh", "max"}


def command(arguments):
    if not arguments or not re.fullmatch(r"https://github.com/[^/\s]+/[^/\s]+/pull/\d+", arguments[0]):
        raise ValueError("Expected a GitHub PR URL")
    seen = set()
    for arg in arguments[1:]:
        group = "profile" if arg in PROFILES else "effort" if arg in EFFORTS else arg
        if arg not in PROFILES | EFFORTS | {"approve", "full"} or group in seen:
            raise ValueError("Unknown or repeated review argument")
        seen.add(group)
    plugin = pathlib.Path(__file__).resolve().parents[3]
    return [
        "claude", "-p", "--model", os.environ.get("REVIEW_PR_COORDINATOR_MODEL", "sonnet"),
        "--plugin-dir", str(plugin), "--input-format", "stream-json",
        "--output-format", "stream-json", "--verbose",
        "--permission-mode", "auto", "--permission-prompts", "none",
    ]


def finished(result):
    return bool(re.search(r"^REVIEW_RESULT: (approved|approved_nits|approved_comments|commented|no_findings|still_open|merged|closed|already_reviewed|head_moved|error)\s*$", result.strip().splitlines()[-1] if result.strip() else ""))


def main():
    try:
        argv = command(sys.argv[1:])
    except ValueError as e:
        sys.exit(f"{e}; usage: run-review.py <PR URL> [profile] [effort] [approve] [full]")
    try:
        timeout = int(os.environ.get("REVIEW_PR_TIMEOUT_SECONDS", "2700"))
        if timeout < 1:
            raise ValueError()
    except ValueError:
        sys.exit("REVIEW_PR_TIMEOUT_SECONDS must be a positive whole number")

    session = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )

    timer = threading.Timer(timeout, session.kill)
    timer.start()

    prompt = "/claude-skills:review-pr " + " ".join(sys.argv[1:])
    session.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": prompt}}) + "\n")
    session.stdin.flush()

    result = ""
    model_usage = {}
    turn_usages = []
    for line in session.stdout:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        if event.get("type") != "result":
            continue

        result = event.get("result") or ""
        model_usage = event.get("modelUsage") or model_usage
        turn_usages.append(event.get("usage") or {})
        if finished(result):
            break

    timer.cancel()
    session.stdin.close()

    try:
        session.wait(timeout=60)
    except subprocess.TimeoutExpired:
        session.kill()
        session.wait()

    if not finished(result):
        result += f"\n(session ended without {MARKER}; exit code {session.returncode})"

    print(json.dumps({"result": result, "model_usage": model_usage, "turn_usages": turn_usages}))


if __name__ == "__main__":
    main()
