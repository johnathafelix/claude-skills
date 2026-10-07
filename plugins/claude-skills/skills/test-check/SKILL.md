---
name: test-check
description: "Report test quality for changed behavior: measured changed-line coverage, assertion fidelity/strictness, real-engine DB integration and mock expectations. Uses two read-only opus groups and bounded independent challenge batches. Use for /test-check or before shipping changed code/tests."
model: opus
---

# Test Check

Report only; never edit source/tests during checking. Invoking authorizes dispatch and
planned coverage generation. The caller handles authorized fixes after the report.

## Scope and coverage evidence

Prefer a supplied task manifest and its added-line ranges. Otherwise resolve the PR
base, fetch once, union tracked changes and untracked additions, then get source hunks
with `git diff -U0`. New files have all executable lines in scope. Deleted files need
behavior/removal review; do not try to measure coverage of removed lines.
Split sourceFiles and testFiles (`_test.go`, `.test.*`, `.spec.*`, test/tests/__tests__).
Exclude generated/vendor/dependency code and pure docs/config. Empty source AND tests
means no check. No changed tests still permits finding changed behavior with no tests.

Use measured coverage, never estimate it by reading tests. Reuse a supplied report
only with evidence identifying its command/configuration/dependency inputs and matching
repository snapshot. Last-commit time/report mtime is insufficient for a dirty tree.
If uncertain, fingerprint all tracked/unignored files with `task-manifest.js snapshot`.
Store the fingerprint and command beside a newly generated report outside the repo.
A report becomes stale when relevant source, tests, test config or dependencies change.

If no valid report exists, run the project's planned coverage command once, with output
in scratchpad. Prefer affected packages/projects when that measures every changed source
file; broaden only for uncovered scope or a stated cross-package risk. Typical commands:
Go `go test <affected packages> -coverprofile=<scratchpad>/coverage.out -covermode=atomic`;
Jest/Vitest use the existing runner's coverage flags and scratchpad output directory.
Do not install new tooling as a side effect. Required infrastructure unavailable or
suite failed: coverage is UNVERIFIED with the reason; other test guidelines still run.
Omit `coverage` from dispatched rules when no valid coverageFile exists, and carry the
UNVERIFIED entry in the caller report. Exclude it explicitly only if coverage does not
apply (for example documentation or purely non-executable code).

Default groups: behavior (coverage, db-integration), assertions (assertion-fidelity,
assertion-strictness, mock-expectations). Preserve each guideline's exceptions, including
context matchers, auto-registered mock assertions and connection-loss DB mocks.

## Stage and run

Resolve paths relative to this SKILL.md, never a hardcoded home directory. Do not read
all guideline bodies into the coordinator context. Stage into the exact session
scratchpad declared by the harness; an arbitrary temporary directory is not readable:

```bash
node "<plugin>/scripts/stage-workflow.js" "<skill>/guidelines" "<skill>/workflow.js" "<scratchpad>/check-workflow.js"
```

This computes paths and proof anchors and inlines a shared runtime; the staged script
needs no imports. If no readable scratchpad exists, stage at a temporary path and pass
the staged contents as Workflow `script`, never that temporary scriptPath. Never dispatch
the unstaged source. Pass repoDir as the absolute checkout root; paths normalize to
repo-relative form before scope validation. Paths outside the checkout remain invalid.
Standalone checks retain all style rules; pipelines pass nitPolicy: "material" to limit
each pass to two nits with concrete cost, preserving correctness findings.
The script accepts an object or JSON args string. Default `mode: "grouped"`; request
`"individual"` for thorough isolated checks. Grouping preserves every applicable rule.
Restricted opus checkers share source reads within a group, at most four in flight.
Each rule requires line-count/first/last-line anchors; these detect missing or wrong
reads, not comprehension. Retry a failed rule once, retaining successful siblings.
Terminal API failures already retried by the harness do not trigger another loop.

Await the Workflow completion, not just its task ID. Results include `findings`,
`findingCount`, `unverified`, `rejectedFindings` with validationErrors, and `stats`
(groups, checkCalls, verifierCalls). Read elapsed duration from completed Workflow
metadata via scripts/workflow-metrics.js with the returned Transcript dir; phase agent
spans exclude coordinator overhead. Missing timing is null, never a fabricated zero.
Always surface unverified rules and skipped rules with reasons. Empty findings with
an unverified rule is incomplete, never a clean pass. Keep full reports in scratchpad
and present concise actionable findings in context.

If Workflow is unavailable, dispatch the same restricted checkers with the same rule
groups and file scopes, at most four in flight. Require every guideline to be read and
structured findings with proof anchors for each rule. Retry malformed/missing output
once for failed rules only; report remaining rules UNVERIFIED. Do not return to an
uncapped per-rule/per-finding fallback. Individual mode is an explicit depth choice.

Workflow args:

```text
{ guidelines: [{ stem: "coverage" }, ...], sourceFiles, testFiles, changedRanges,
  coverageFile, repoDir, baseBranch, changeNote, changeManifestPath, mode: "grouped",
  verify: true }
```

Default verification challenges up to four claims per fresh checker, at most eight
verifier calls and four agents in flight. Each claim requires its own verdict/reason;
missing verdicts and excess candidates are `unchallenged` and `verified: false`, never
dropped. Return fields also include `refuted`, `unchallenged`, `verificationDeferred`.
A pipeline may set `verify: false` **only** when it routes candidates to its own
independent challenger (ship-task combines language/test/code-review claims). Label
that output candidates, not confirmed findings. Do not verify the same candidate twice.
Fallback challenges use the same four-claim/eight-call bounds and explicit gap reporting.

Present confirmed issues with file/range, test symbol, severity/confidence, description,
rationale and action; preserve uncovered ranges in actions. Summarize refuted claims
with reasons and expose unchallenged/unverified lists. Zero findings is a clean check
only when every applicable rule completed and required claims were challenged.
