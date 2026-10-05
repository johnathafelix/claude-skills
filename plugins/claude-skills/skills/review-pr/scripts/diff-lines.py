#!/usr/bin/env python3
"""Print {path: [commentable RIGHT-side line numbers]} for a PR.

Reads the JSON stream of `gh api --paginate repos/<o>/<r>/pulls/<n>/files` on stdin.
A line is commentable when it is an added or context line in the PR's patch; GitHub
rejects inline review comments anywhere else.
"""

import json
import re
import sys

HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)")


def commentable_lines(patch):
    lines = set()
    line = 0

    for row in patch.split("\n"):
        hunk = HUNK.match(row)

        if hunk:
            line = int(hunk.group(1))

            continue

        if row.startswith("-") or row.startswith("\\"):
            continue

        lines.add(line)
        line += 1

    return lines


def main():
    decoder = json.JSONDecoder()
    raw = sys.stdin.read()
    pos = 0
    result = {}

    # `--paginate` concatenates one JSON array per page.
    while True:
        while pos < len(raw) and raw[pos].isspace():
            pos += 1

        if pos >= len(raw):
            break

        page, pos = decoder.raw_decode(raw, pos)

        for entry in page:
            result[entry["filename"]] = sorted(commentable_lines(entry.get("patch") or ""))

    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
