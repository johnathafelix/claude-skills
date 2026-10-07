---
name: ts-check
description: "Report TypeScript quality findings using two read-only opus reviewer groups and short decision checklists. Checks strong types, magic values, data-driven design, object parameters and redundant bindings. Use for /ts-check or a TypeScript quality review; fixes require authorization."
model: opus
---

# TypeScript Check

Report during the check; apply fixes only when requested. Invoking authorizes dispatch.

## Scope and rules

Prefer a supplied `changeManifestPath` and its patches. Otherwise use explicit files,
or resolve/fetch the PR base once and union tracked changed files with untracked additions.
Include `.ts`/`.tsx`; exclude `.d.ts`, dependencies, generated code and deleted files
from surviving-file checks. Removal/caller behavior is still code-review's responsibility.
With no git context use explicit files or non-recursive TypeScript files. Stop when empty.

Priority, highest first: **strong-types > no-magic-values > data-over-logic >
object-params > redundant-variable-inline**. Preserve that priority in findings/fixes.
Default groups: types (strong-types, object-params) and clarity (the other three).
Each compact guideline carries its rule checklist and exceptions. Examples, diagrams
and detailed trade-offs live in `references/`; consult them only for ambiguous cases.
Do not turn examples into unconditional rules or impose a DSL on low-variance code.
New guideline files still run even before a maintainer assigns a group.

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
{ guidelines: [{ stem: "strong-types" }, ...], files: ["src/store.ts"],
  baseBranch, changeNote, changeManifestPath, mode: "grouped" }
```

Findings retain file, line, rule, description, suggestedFix and numeric priority;
sort file → line → priority. Equivalent claims can be deduplicated, but separate defects
on the same line remain separate. These are candidates until independently challenged
by ship-task/review-pr. State coverage gaps alongside an empty report.

## Authorized fixes

Use code anchors; earlier edits invalidate later line numbers. Apply higher-priority
fixes first; reread and drop a lower-priority finding if the higher-priority fix made
it obsolete. Never force a stale edit. Run the project typecheck and applicable lint/
test commands (avoid introducing tooling). Reuse current matching evidence; resolve
failures introduced by edits and report any unverified rules before declaring done.
