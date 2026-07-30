---
name: golang-check
description: USE WHEN reviewing, writing, or refactoring Go code and you want it checked against Go conventions — naming, type/API design (incl. accept interfaces/return structs), functions & signatures, declarations, errors, concurrency, gotchas, modernizers (Go 1.26+ new(expr) & other go fix rewrites), testing, structure, and doc comments. Dispatches one focused agent per guideline via the Workflow tool (falling back to a direct fan-out if Workflow is unavailable) and reports violations with file:line and fixes. Extend by dropping a new file into guidelines/.
---

# Go Idiom Check — Orchestrator

Check changed Go code against the project's Go design guidelines. Each guideline lives in its own file under `guidelines/` and is checked by its own agent, so the set of checks grows by adding files — not by editing this orchestrator.

**This skill reports; it does not edit by default.** Surface findings and let the user decide. Only apply fixes if the user explicitly asks (changing a return type or parameter type can ripple into callers).

**This skill dispatches its check via the `Workflow` tool.** Invoking `/golang-check` is your instruction to call it — no separate confirmation needed. **Dispatching is not the same as finishing:** `Workflow` returns a task ID immediately and the run completes in the background. Do not conclude the turn on that task ID — wait for the completion notification and present its `findings` / `unverified` before you stop, especially if this run was triggered by the `enforce-golang-check.js` Stop hook (it only blocks once per turn, so nothing else will catch a premature stop).

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

### Step 2 — Discover guidelines (do not read them)

List every `*.md` in the `guidelines/` directory that sits **alongside this SKILL.md**. Resolve that directory to an absolute path from this SKILL.md's own location — do **not** hardcode a home directory (the skill may be installed under `~/.claude/plugins/…`, not `~/.claude/skills/…`). You will pass these absolute paths through to the check in Step 3.

Unlike the old batched fan-out, **do not `Read` the guideline bodies here** — the orchestrator only needs filenames and two cheap facts per guideline, both obtainable without opening any file individually. Get both with **one glob-based command each**, not a per-file loop:

1. **Line count**, via `wc -l guidelines/*.md`. This prints one line per file plus a trailing `total` line — **ignore the `total` line**, it is not a guideline. Each per-file count becomes that guideline's `lines` value, used later as a proof-of-read check on the agent that applies it — pass the same absolute path to that agent so both sides run the identical command against the identical file.
2. **Version gate**, via `head -1 guidelines/*.md`, which prints an `==> path <==` header before each file's first line in one call. A guideline may declare a minimum Go version with an HTML-comment marker on that first line, e.g. `<!-- requires-go-version: 1.26 -->`; most guidelines' first line is just their `# Guideline: …` heading, which has no marker and gates nothing. Read the module's Go version from the `go` directive of the nearest `go.mod` (walk up from the in-scope files). **Skip the guideline entirely — do not include it below — when the module version is lower than required, or no `go.mod` declares a version.** For example, `modernizers.md` requires `1.26`; on a `go 1.25` module it is skipped. Note any version-skip in the Step 4 report so the user knows why it was omitted.

Skip a guideline only when it cannot apply to the scope (e.g. `testing.md` when no `*_test.go` files are in scope, or the user asked to exclude it).

**Files are scoped per guideline, not shared as one flat list.** With multiple Go modules, judge each file against its own module's `go.mod` — a guideline like `modernizers.md` should see only the files from modules that meet its version gate, not the whole changed-file set. For most guidelines with a single module, this is just the full Step 1 list.

Build the list you'll pass to the check:

```
guidelines = [
  { stem: "naming", path: "/abs/.../guidelines/naming.md", lines: 24, files: [...] },
  ...
]
```

### Step 3 — Run the check

**Primary path — `Workflow`:**

```
Workflow({
  scriptPath: "<absolute dir from Step 2>/workflow.js",
  args: { guidelines, changeNote: "<one-line note of what changed>" },
})
```

Pass `args` as a real JSON object, not a JSON-encoded string. The script fans each guideline out to its own `claude-skills:go-idiom-checker` agent, capped at 4 concurrent (empirically necessary — see the comment in `workflow.js` for why), retries a guideline twice on a failed proof-of-read, and returns `{ findings, unverified }` already sorted.

**Fallback path — direct fan-out — only if `Workflow` is unavailable:**

Dispatch each guideline to its own `claude-skills:go-idiom-checker` agent, **at most 4 at a time, awaiting each batch before the next** (larger batches measurably raise the rate of derailed, hallucinated 0-tool-call responses). Each prompt must name its guideline by absolute path (Read it IN FULL — the fallback agent does need to open it here, since there is no script to hand it a pre-resolved path list), give the in-scope files for that guideline, apply only that one guideline, and end with this output contract as the entire final message — nothing before or after:

```json
{"file":"relative/path.go","line":42,"symbol":"NewStore","rule":"<guideline stem>","severity":"error|warning|info","confidence":"high|medium","description":"what is wrong, specifically","suggestedFix":"before -> after"}
```

A single JSON array, `[]` if nothing found. Treat a result as **derailed — not a clean pass** — if it doesn't parse as a JSON array or the agent made 0 tool calls; re-dispatch derailed guidelines, and after 2 retries still derailing, report that guideline as **UNVERIFIED**.

### Step 4 — Present results

1. Collect all `findings`, grouped by guideline (`rule`) and sorted by file then line within each group — the `Workflow` path returns this pre-sorted; for the fallback path, do the same sort yourself.
2. Present a numbered checklist of `file:line — symbol — description` with severity/confidence.
3. If there are no findings, report the code is clean against the current guidelines.
4. Always list any **UNVERIFIED** guidelines (from `unverified`, or from fallback retries) and any **version-skipped** guidelines from Step 2, so coverage gaps are explicit rather than silently read as a clean pass.

### Step 5 — Fixes (only when asked)

Do not modify code as part of the check. If the user asks to fix findings:

1. Apply each accepted finding with Edit.
2. After changing a return type or parameter type, check callers (`grep`/graph) and update them so the package still builds.
3. Verify with `go build ./...` (and `go vet ./...` if available) for the affected packages; report anything still failing.
