---
name: golang-check
description: USE WHEN reviewing, writing, or refactoring Go code and you want it checked against Go conventions — naming, type/API design (incl. accept interfaces/return structs), functions & signatures, declarations, errors, concurrency, gotchas, modernizers (Go 1.26+ new(expr) & other go fix rewrites), testing, structure, and doc comments. Fans out one focused sub-agent per guideline (in parallel) and reports violations with file:line and fixes. Extend by dropping a new file into guidelines/.
---

# Go Idiom Check — Orchestrator

Check changed Go code against the project's Go design guidelines. Each guideline lives in its own file under `guidelines/` and is checked by its own sub-agent, so the set of checks grows by adding files — not by editing this orchestrator.

**This skill reports; it does not edit by default.** Surface findings and let the user decide. Only apply fixes if the user explicitly asks (changing a return type or parameter type can ripple into callers).

## Procedure

### Step 1 — Determine scope

Pick the set of Go files to check:

1. If the user named files, directories, or a repo, use those.
2. Otherwise determine the base branch and diff against it:
   - `gh pr view --json baseRefName --jq '.baseRefName'` — if a PR exists, use that base; else fall back to `main`.
   - `git fetch origin <base>` then `git diff origin/<base> --name-only --diff-filter=ACM`.
3. If there is no git context or no changed files, fall back to `*.go` in the current working directory (non-recursive).

Filter the result to `*.go` files and **exclude**: `vendor/`, generated files (`*.pb.go`, `*_gen.go`, `*.gen.go`, files whose first line contains `Code generated`), and — unless the user says otherwise — `*_test.go`.

If the filtered list is empty, report that there is nothing to check and stop.

### Step 2 — Load guidelines

List every `*.md` in the `guidelines/` directory that sits **alongside this SKILL.md** and Read each one. Resolve that directory to an absolute path from this SKILL.md's own location — do **not** hardcode a home directory (the skill may be installed under `~/.claude/plugins/…`, not `~/.claude/skills/…`); you will need that absolute path again in Step 3 to pass each guideline file to its sub-agent. Each file is a self-contained rule spec — a cohesive group of closely-related checks (e.g. `errors.md`, `concurrency.md`, `type-design.md`) — and its full text is handed to one sub-agent in Step 3. The set is discovered dynamically: drop in a new `.md` and it becomes another parallel sub-agent with no change here.

Extended examples for each guideline live in the `references/` directory alongside this SKILL.md; sub-agents consult them only for ambiguous cases.

Skip a guideline only when it cannot apply to the scope (e.g. `testing.md` when no `*_test.go` files are in scope, `doc-comments.md`/`testing.md` if the user asked to exclude them).

**Version-gated guidelines:** a guideline may declare a minimum Go version with an HTML-comment marker on its first line, e.g. `<!-- requires-go-version: 1.26 -->`. Before launching such a guideline, read the module's Go version from the `go` directive of the nearest `go.mod` (walk up from the in-scope files; with multiple modules, judge each file against its own module). **Skip the guideline — do not spawn its sub-agent — when the module version is lower than required, or no `go.mod` declares a version.** For example, `modernizers.md` requires `1.26` (its checks rewrite code to Go 1.26 features like `new(expr)`); on a `go 1.25` module it is skipped entirely. Note any version-skip in the Step 4 report so the user knows why it was omitted.

### Step 3 — Launch sub-agents (batched, one guideline each)

Dispatch each guideline to its own sub-agent with `subagent_type: claude-skills:go-idiom-checker` — a read-only, restricted-tool agent whose minimal injected context makes it far less likely to derail than `general-purpose` (see the reliability note in Step 4).

**Concurrency: launch at most 4 sub-agents at a time, awaiting each batch before starting the next.** Large fan-outs (10+ at once) measurably raise the rate at which a sub-agent ignores its prompt and returns hallucinated boilerplate with 0 tool calls instead of findings; small batches sharply reduce it.

Each sub-agent's prompt must:

1. Name its guideline file by **absolute path** and instruct it to Read the file IN FULL — pass the path, not a summary or paraphrase. (A guideline may cite an extended-examples file as `../references/<name>.md`; that path is relative to the guideline file, so resolve it against the absolute guideline path you passed.)
2. Give the in-scope file list from Step 1 plus a one-line note of what changed (focus the check on the changed lines).
3. Apply **only** that one guideline; read-only, never edit; report only findings it is confident about (prefer silence over a shaky flag).
4. **End the prompt with the output contract** (put it last, for recency): the entire final message must be a single JSON array — `[]` if nothing is found, otherwise objects shaped as below, with nothing before or after.

```json
{
  "file": "relative/path.go",
  "line": 42,
  "symbol": "NewStore",
  "rule": "<guideline filename stem, e.g. type-design>",
  "severity": "error | warning | info",
  "confidence": "high | medium",
  "description": "what is wrong, specifically",
  "suggestedFix": "concrete fix, ideally as before -> after"
}
```

Severity: `error` for correctness bugs (data races, leaks, typed-nil, slice aliasing), `warning` for idiom/convention violations, `info` for low-confidence or stylistic suggestions. Pass each sub-agent its guideline's filename stem to use as `rule`.

One guideline per sub-agent keeps each context focused. With more guidelines than the batch cap of 4, run successive batches until all are dispatched.

### Step 4 — Validate, retry, merge, present

**4a. Validate each result; retry derailments.** A healthy checker always Reads its guideline (≥1 tool call) and returns a JSON array. Treat a result as **derailed — NOT a clean pass** — when either:

- its output does not parse as a JSON array (prose, an apology, a fragment of instructions, "I don't have a task", an empty/near-empty message), **or**
- it made **0 tool calls** (it never opened its guideline or the target files).

Re-dispatch each derailed guideline (Step 3), alone or in a small batch. If it still derails after 2 retries, report that guideline as **UNVERIFIED** in the final output. **Never accept a non-JSON or 0-tool-call response as `[]`** — a derailed check is a coverage gap, not a clean bill of health.

**4b. Merge and present.**

1. Collect every *validated* sub-agent's findings into one list.
2. Present a numbered checklist of `file:line — symbol — description` with severity/confidence, grouped by guideline and sorted by file then line within each group.
3. If every validated sub-agent returned empty, report the code is clean against the current guidelines. Always list any **UNVERIFIED** (retry-exhausted) or version-skipped guidelines so coverage gaps are explicit.

> **Reliability note.** Sub-agents receive large injected context attachments (a deferred-tool list + the skill catalog, ~36 KB for `general-purpose`). Under high fan-out this occasionally makes a sub-agent ignore its task prompt and emit hallucinated system-prompt-like text with 0 tool calls instead of findings. Two mitigations, layered: (1) `subagent_type: claude-skills:go-idiom-checker` restricts the toolset so those attachments shrink, and small batches (Step 3) lower the trigger rate; (2) the derailment detector + retry (4a) catches whatever still slips through, so a derailed check is never silently counted as clean.

### Step 5 — Fixes (only when asked)

Do not modify code as part of the check. If the user asks to fix findings:

1. Apply each accepted finding with Edit.
2. After changing a return type or parameter type, check callers (`grep`/graph) and update them so the package still builds.
3. Verify with `go build ./...` (and `go vet ./...` if available) for the affected packages; report anything still failing.
