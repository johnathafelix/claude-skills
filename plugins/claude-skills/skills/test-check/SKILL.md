---
name: test-check
description: Checks the tests for code changed on the current branch — coverage of new/modified lines (≥80%), assertions that actually prove what the test name claims, assertion strictness (mock.Anything as last resort), database operations covered by real-engine integration tests, and mock expectations asserted both ways. Dispatches one focused read-only opus agent per guideline via the Workflow tool, then independently verifies every finding with an adversarial opus agent before reporting. Report only — never modifies files. Use PROACTIVELY before opening a PR that adds or changes tests, or when asked whether the tests are good enough; also runs directly via /test-check. Extend by dropping a new file into guidelines/.
model: opus
---

# Test Check — Orchestrator

Check the tests behind a branch's changes against the project's test-quality guidelines. Each guideline lives in its own file under `guidelines/` and is checked by its own agent; every finding is then challenged by an independent verifier before it reaches the user. The set of checks grows by adding files — not by editing this orchestrator.

**This skill reports; it never edits.** It produces a report of what to cover, what to assert, and why — the user acts on it. Do not write tests, do not touch source, do not stage or commit anything, even if asked in the same breath — finish the report first and let the user ask separately.

**This skill dispatches its check via the `Workflow` tool.** Invoking `/test-check` is your instruction to call it — no separate confirmation needed. **Dispatching is not the same as finishing:** `Workflow` returns a task ID immediately and the run completes in the background. Do not conclude the turn on that task ID — wait for the completion notification and present its `findings` / `refuted` / `unverified` / `unchallenged` before you stop.

## Procedure

### Step 1 — Determine scope

1. Determine the base branch: `gh pr view --json baseRefName --jq '.baseRefName'` — if a PR exists, use that base; else fall back to `main`. Store it as `BASE_BRANCH`.
2. `git fetch origin $BASE_BRANCH`, then `git diff origin/$BASE_BRANCH --name-only --diff-filter=ACM`. If the user named files or directories, use those instead.
3. Split the list:
   - `testFiles` — `*_test.go`, `*.test.*`, `*.spec.*`, anything under `__tests__/`, `test/`, `tests/`, `testdata/`, `fixtures/`.
   - `sourceFiles` — everything else that is code, **excluding** `vendor/`, `node_modules/`, generated files (`*.pb.go`, `*_gen.go`, `*.gen.go`, `*.generated.*`, files whose first line contains `Code generated`), lockfiles, and pure config/docs.
4. Collect the changed line ranges for the source files, so the coverage check knows which lines are "new or modified":

   ```bash
   git diff -U0 origin/$BASE_BRANCH -- <sourceFiles> | awk '/^\+\+\+ b\//{f=substr($0,7)} /^@@/{split($3,a,/[+,]/); n=(a[3]==""?1:a[3]); if(n>0) printf "%s:%d-%d\n", f, a[2], a[2]+n-1}'
   ```

   Keep the output as one newline-separated string, `path:start-end` per hunk — that is `changedRanges`.

If both `sourceFiles` and `testFiles` are empty, report that there is nothing to check and stop. If only `testFiles` is empty, continue: the coverage and DB-integration guidelines can still find changed code with no tests at all.

### Step 1b — Locate or generate the coverage report

The coverage guideline judges from a report, never from reading tests. Find one, or make one:

1. Look for an existing report, newest first: `coverage.out`, `cover.out`, `coverage/lcov.info`, `lcov.info`, `coverage/coverage-final.json`, `coverage.xml`. Use it only if it is newer than the last commit on the branch (`git log -1 --format=%ct` vs `stat -f %m` / `stat -c %Y`); a stale report describes code that no longer exists.
2. If none is current, generate one **into the scratchpad directory named in your environment, never into the repo**:
   - Go: `go test ./... -coverprofile=<scratchpad>/test-check/coverage.out -covermode=atomic` from the module root (one run per module if there are several; concatenate profiles after the first `mode:` line).
   - Jest: `npx jest --coverage --coverageDirectory=<scratchpad>/test-check/coverage --coverageReporters=json,lcov`.
   - Vitest: `npx vitest run --coverage --coverage.reportsDirectory=<scratchpad>/test-check/coverage --coverage.reporter=json --coverage.reporter=lcov`.
   - Other stacks: use the project's own coverage script from `package.json` / `Makefile` if one exists, redirecting output to the scratchpad where the tool allows.
3. Record `coverageFile` as the absolute path. If the suite fails to run, or no coverage tooling exists, set `coverageFile` to `""` and keep the reason — the coverage guideline is reported as **UNVERIFIED** with that reason in Step 4, and the other four checks still run.

Running the suite is the one non-read-only thing this skill does, and it writes only to the scratchpad. If the suite is known to be slow or needs infrastructure (containers, credentials) that is not up, say so and proceed with `coverageFile: ""` rather than blocking on it.

### Step 2 — Discover guidelines (do not read them)

List every `*.md` in the `guidelines/` directory that sits **alongside this SKILL.md**. Resolve that directory to an absolute path from this SKILL.md's own location — do **not** hardcode a home directory (the skill may be installed under `~/.claude/plugins/…`, not `~/.claude/skills/…`). You will pass these absolute paths through to the check in Step 3.

**Do not `Read` the guideline bodies here** — the orchestrator only needs filenames plus a few cheap facts per guideline, all obtainable without opening any file individually. Take **one glob-based command per fact**, not a per-file loop.

In every command below, `$G` stands for the **absolute** `guidelines/` directory you just resolved — substitute the real path when you run it. Your working directory is the user's repo, not this skill's directory, so a bare `guidelines/*.md` does not expand here. **Quote the fixed part of the path and leave the `*` unquoted** — `'$G/'*.md` — because a fully quoted glob stops expanding while an unquoted path breaks on a space.

1. **Line count**, via `wc -l '$G/'*.md`. This prints one line per file plus a trailing `total` line — **ignore the `total` line**, it is not a guideline. Parse each row as: the count is the **leading integer**, and the path is **everything after that first run of spaces** — do not split on whitespace, or a path such as `/Users/John Smith/…` gets cut in half. Each per-file count becomes that guideline's `lines` value, used later as a proof-of-read check on the agent that applies it — pass the same absolute path to that agent so both sides run the identical command against the identical file.
2. **First line + last non-empty line**, via one tab-delimited command with no header lines to strip:

   ```
   awk 'FNR==1{a[FILENAME]=$0} NF{b[FILENAME]=$0} END{for (f in a) printf "%s\t%s\t%s\n", f, a[f], b[f]}' '$G/'*.md
   ```

   Each row is `path <TAB> firstLine <TAB> lastNonEmptyLine` — split on tabs, since guideline bodies contain none. These two strings are **body anchors** for the proof-of-read: they make the checker prove it saw the file's contents, not merely that a command ran. Pass them through **verbatim** as `title` and `lastLine` — do not trim, re-title, or tidy them, and never substitute the filename. The script normalizes whitespace and letter case when it compares. If you omit either, the script logs a `proof-of-read leg DISABLED` warning and falls back to the line count alone, which is the weaker gate this replaced.

   **Do not take `lines` from this command.** `awk` counts lines read while `wc -l` counts newlines; they disagree by one on a file with no trailing newline, and since the checker agent runs `wc -l`, that would make the guideline's gate permanently unmatchable. Item 1 is authoritative for `lines`.

**Which guidelines to dispatch.** All of them, with two exceptions:

- `coverage` — dispatch only when `coverageFile` is non-empty. When it is empty, do **not** dispatch it; list it as UNVERIFIED in Step 4 with the Step 1b reason. (Dispatching it without a report would return `[]`, which reads as a clean pass.)
- Any guideline the user explicitly asked to skip.

Build the list you'll pass to the check:

```
guidelines = [
  {
    stem:     "assertion-fidelity",
    path:     "/abs/.../guidelines/assertion-fidelity.md",   # absolute; the same path the agent will wc -l
    lines:    58,                                            # item 1 (wc -l) — NOT the awk row count
    title:    "# Guideline: Assertions match what the test claims",   # item 2 field 2, verbatim
    lastLine: "Every finding here must quote the test name verbatim — …",  # item 2 field 3, verbatim
  },
  ...
]
```

### Step 3 — Run the check

**Primary path — `Workflow`:**

`Workflow` rejects a `scriptPath` it did not itself return unless the file sits under the working directory or a directory added to the session. When this skill is installed as a plugin its `workflow.js` lives under `~/.claude/plugins/cache/...`, which is neither, so passing that path directly fails with *"scriptPath must be a script path this tool returned, or a file you can already read"*. Copy it into the session scratchpad directory (the absolute path is given in your environment) and dispatch from there — not into the user's repo, where it would show up as an untracked file in their working tree. `workflow.js` sits **alongside this SKILL.md**, one level above the `guidelines/` directory resolved in Step 2 — derive it from that same `$G`, and substitute the real absolute paths for `$G` and `<scratchpad>` before running the copy:

```bash
cp "$(dirname '$G')/workflow.js" "<scratchpad>/test-check-workflow.js"
```

If the session declares no scratchpad directory, read `workflow.js` in full and pass its contents as `script` instead of `scriptPath` — that path has no directory dependency at all. This is the one file this skill may read into context: it is the script being executed, not a guideline body, so it does not reintroduce the reads Step 2 forbids.

```
Workflow({
  scriptPath: "<scratchpad>/test-check-workflow.js",
  args: {
    guidelines,
    sourceFiles,      # from Step 1, repo-relative paths
    testFiles,        # from Step 1
    changedRanges,    # from Step 1 item 4, one "path:start-end" per line
    coverageFile,     # from Step 1b, absolute path or ""
    baseBranch: BASE_BRANCH,
    changeNote: "<one-line note of what changed>",
  },
})
```

Pass `args` as a real JSON object, not a JSON-encoded string. The script runs two stages as a pipeline: **Check** fans each guideline out to its own `claude-skills:test-checker` agent **pinned to `model: "opus"`** (a weaker inherited model degrades these checks invisibly — a shallow read returns `[]`, indistinguishable from a clean pass), retries a guideline twice on a failed proof-of-read (line count **plus** first line **plus** last non-empty line); **Verify** then hands every finding to a fresh `test-checker` agent in verify mode, prompted to refute it by reading the real code. At most 4 agents are in flight across both stages (empirically necessary — see the comment in `workflow.js`). It returns `{ findings, refuted, unverified, unchallenged, findingCount }`, findings already sorted rule → file → line.

**Fallback path — direct fan-out — only if `Workflow` is unavailable:**

1. Dispatch each guideline to its own `claude-skills:test-checker` agent **with `model: "opus"`**, **at most 4 at a time, awaiting each batch before the next**. Each prompt must open with `MODE: check`, name its guideline by absolute path (Read it IN FULL), give `sourceFiles`, `testFiles`, `changedRanges`, `coverageFile`, `baseBranch`, apply only that one guideline, and end with this output contract as the entire final message — nothing before or after:

   ```json
   {"file":"relative/path_test.go","line":42,"endLine":58,"symbol":"TestRepo_Delete/\"removes only the given id\"","rule":"<guideline stem>","severity":"error|warning|info","confidence":"high|medium","description":"what is wrong, specifically","rationale":"the defect this lets through","action":"what to add or change"}
   ```

   A single JSON array, `[]` if nothing found. A healthy checker always Reads its guideline (**≥1 tool call**) and returns a JSON array. Treat a result as **derailed — NOT a clean pass** — when either its output does not parse as a JSON array (prose, an apology, a fragment of instructions, an empty message), **or** it made **0 tool calls**. Re-dispatch each derailed guideline, alone or in a small batch. If it still derails after 2 retries, report that guideline as **UNVERIFIED**. **Never accept a non-JSON or 0-tool-call response as `[]`.**

2. For every finding, dispatch one `claude-skills:test-checker` agent **with `model: "opus"`**, prompt opening with `MODE: verify`, containing the finding's fields and the guideline path, asking it to attack the finding and return `{"confirmed":true|false,"reason":"..."}` as its entire final message. At most 4 at a time. `confirmed: false` → move the finding to `refuted` with the reason; no usable verdict after one retry → keep the finding and list it under `unchallenged`.

### Step 4 — Present results

The output is a report the user acts on. Every item must say **where**, **what is wrong**, **why it matters**, and **what to do**.

1. Group `findings` by guideline (`rule`), sorted file → line within each group (the `Workflow` path returns this pre-sorted; on the fallback path, sort it yourself).
2. Under each group, present a numbered list. One item per finding:

   ```
   N. `file:line[-endLine]` — symbol  [severity/confidence]
      What: <description>
      Why:  <rationale>
      Do:   <action>
   ```

   For `coverage` findings, the `action` already lists the uncovered ranges as `file:start-end` — keep them verbatim; they are the lines to cover.
3. State the total and check it against `findingCount` (they come from the same `return`, so a mismatch is a script bug, not truncation — read the run's own output file rather than trusting only the notification text).
4. If `findings` is empty and `unverified` is empty, report that the tests are clean against all guidelines that ran.
5. Then, always, in this order — none of these is optional, and none reads as a clean pass:
   - **Refuted** — each entry from `refuted` as `file:line — rule — refuter's reason`, one line each. These were flagged and then knocked down; the user should know what was considered and why it was dropped.
   - **Unchallenged** — findings whose verifier returned nothing. They are in `findings` too; mark them so the user knows they carry one opinion, not two.
   - **UNVERIFIED guidelines** — from `unverified`, plus `coverage` when Step 1b produced no report (with the reason). A guideline that never ran contributed zero findings; do not report the code as clean against it.
6. Check the run's `log` output for `proof-of-read leg DISABLED`, `UNVERIFIED (bad args)`, `worker threw`, `verifier budget exhausted`, `verifier threw`, or `dropped … finding(s)` and surface anything you find alongside the findings. Each means a check ran with a weakened gate, was skipped over a malformed args entry, or lost data — none of which the `findings` list alone will show you.

Do not offer to fix, write tests, or apply the actions — the report is the deliverable. If the user then asks for changes, that is a new task outside this skill.

> **Reliability note.** Sub-agents receive large injected context attachments (a deferred-tool list plus the skill catalog). Under high fan-out this occasionally makes a sub-agent ignore its task prompt and emit hallucinated system-prompt-like text with 0 tool calls instead of findings. Mitigations, layered: (1) `claude-skills:test-checker` restricts the toolset so those attachments shrink, and the concurrency cap of 4 lowers the trigger rate — that cap is why **both** paths batch, and why verifiers share it; (2) on the primary path the three-leg proof-of-read makes a derailed check fail the gate and be retried; (3) the verify stage catches a plausible-but-wrong finding that a derailed or over-eager checker produced — a refuted finding is reported as refuted, not silently dropped; (4) on the fallback path the non-JSON/0-tool-call detector catches what slips through. A derailed check is never silently counted as clean, and an unverified finding is never presented as verified.
