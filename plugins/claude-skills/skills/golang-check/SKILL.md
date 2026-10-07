---
name: golang-check
description: "Report Go idiom and correctness findings on changed code using related guideline groups and restricted read-only opus checkers. Preserves per-module version gates, severity and confidence. Use for /golang-check or a Go quality review; edits only when separately requested."
model: opus
---

# Go Check

Report only during the check. Invoking this skill authorizes its Workflow dispatch.
If fixes were requested, finish the report before applying the accepted fixes.

## Scope and applicable rules

Use supplied files/directories; if a `changeManifestPath` is supplied, use its task
patches and file list, including new/deleted paths. Otherwise resolve the PR base
(default main), fetch once and union tracked changes with untracked Go additions.
A deleted file still needs caller/removal review but is not a surviving-file idiom
check. Without git context, fall back to non-recursive Go files in the working directory.
Exclude vendor/generated code. Ordinarily exclude `_test.go`; include tests explicitly
requested by the caller or when the task supplied an explicit changed-test scope.
No surviving Go files means no idiom check; state that removal review remains separate.

Discover every `guidelines/*.md` via staging output. Do not preload references; Go's
checklists are already short. Resolve example paths against each guideline and consult
only an ambiguous case. Preserve the modernizer fallback catalog when required.

Version gates are in the first-line `<!-- requires-go-version: ... -->` marker.
Read the nearest owning `go.mod` for each file. Include gated rules only for modules
whose declared Go version meets the minimum; missing versions do not qualify. List
version skips explicitly. `modernizers` currently requires Go 1.26. Do not use the
installed toolchain version as the module version. `testing` sees test files only;
other rules see their applicable source/test files. New rules are checked individually
until assigned a group, rather than silently ignored.

Default groups: correctness (errors, concurrency, gotchas), API (type-design,
functions-and-signatures), conventions (naming, declarations, structure, doc-comments,
data-over-logic, modernizers), and testing when applicable.

## Stage and run

Resolve paths relative to this SKILL.md, never a hardcoded home directory. Do not read
all guideline bodies into the coordinator context. Stage into the session scratchpad:

```bash
node "<plugin>/scripts/stage-workflow.js" "<skill>/guidelines" "<skill>/workflow.js" "<scratchpad>/check-workflow.js"
```

This computes paths and proof anchors and inlines a shared runtime; the staged script
needs no imports. If no readable scratchpad exists, stage at a temporary path and pass
the staged contents as Workflow `script`. Never dispatch the unstaged source.
The script accepts an object or JSON args string. Default `mode: "grouped"`; request
`"individual"` for thorough isolated checks. Grouping preserves every applicable rule.
Restricted opus checkers share source reads within a group, at most four in flight.
Each rule requires line-count/first/last-line anchors; these detect missing or wrong
reads, not comprehension. Retry a failed rule once, retaining successful siblings.
Terminal API failures already retried by the harness do not trigger another loop.

Await the Workflow completion, not just its task ID. Results include `findings`,
`findingCount`, `unverified`, and `stats` (groups, checkCalls, verifierCalls, durationMs).
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
{ guidelines: [{ stem: "errors", files: ["internal/store.go"] }, ...],
  baseBranch, changeNote, changeManifestPath, mode: "grouped" }
```

Scopes remain per guideline; no flat file array can override a module version gate.
Findings retain file, line, symbol, rule, severity, confidence, description and
suggestedFix; sort rule → file → line. Error means correctness, warning convention,
info suggestion, unless the guideline specifies another mapping. These are checker
candidates; ship-task/review-pr challenge them independently before acting.

## Fixes when authorized

Apply accepted findings using quoted code anchors, not stale line numbers. Recheck
callers for signature changes. Run the project's affected-package build/vet commands
and required tests. Reuse current evidence when relevant inputs match; report remaining
failures and unverified rules. Do not declare done with a build broken by your edits.
