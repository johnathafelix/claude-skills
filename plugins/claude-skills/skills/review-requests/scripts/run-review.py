#!/usr/bin/env python3
"""Run /claude-skills:review-pr on one PR in its own headless Claude Code session.

Plain `claude -p` exits as soon as the first turn ends, but review-pr dispatches its
review as a background Workflow and finishes in a later turn, when the completion
notification arrives. Holding stdin open in stream-json mode keeps the session alive
for those turns, so this waits until a turn ends with the REVIEW_RESULT line.

Run from the PR repo's clone. Prints {"result": "<last turn's text>"} on stdout.

    run-review.py <PR URL>
"""
import json
import subprocess
import sys
import threading

MARKER = "REVIEW_RESULT:"
TIMEOUT_SECONDS = 3 * 60 * 60


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: run-review.py <PR URL>")

    session = subprocess.Popen(
        [
            "claude", "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--permission-mode", "auto",
            "--permission-prompts", "none",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )

    timer = threading.Timer(TIMEOUT_SECONDS, session.kill)
    timer.start()

    prompt = f"/claude-skills:review-pr {sys.argv[1]}"
    session.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": prompt}}) + "\n")
    session.stdin.flush()

    result = ""
    for line in session.stdout:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        if event.get("type") != "result":
            continue

        result = event.get("result") or ""
        if MARKER in result:
            break

    timer.cancel()
    session.stdin.close()

    try:
        session.wait(timeout=60)
    except subprocess.TimeoutExpired:
        session.kill()

    if MARKER not in result:
        result += f"\n(session ended without {MARKER}; exit code {session.returncode})"

    print(json.dumps({"result": result}))


if __name__ == "__main__":
    main()
