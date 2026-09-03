---
name: golang-check
description: USE WHEN reviewing, writing, or refactoring Go code and you want it checked against Go conventions — naming, type/API design (incl. accept interfaces/return structs), functions & signatures, declarations, errors, concurrency, gotchas, modernizers (Go 1.26+ new(expr) & other go fix rewrites), testing, structure, and doc comments. Dispatches one focused agent per guideline via the Workflow tool (falling back to a direct fan-out if Workflow is unavailable) and reports violations with file:line and fixes. Extend by dropping a new file into guidelines/.
model: opus
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

Unlike the old batched fan-out, **do not `Read` the guideline bodies here** — the orchestrator only needs filenames plus a few cheap facts per guideline, all obtainable without opening any file individually. Take **one glob-based command per fact**, not a per-file loop.

In every command below, `$G` stands for the **absolute** `guidelines/` directory you just resolved — substitute the real path when you run it. Your working directory is the user's repo, not this skill's directory, so a bare `guidelines/*.md` does not expand here. **Quote the fixed part of the path and leave the `*` unquoted** — `'$G/'*.md` — because a fully quoted glob stops expanding while an unquoted path breaks on a space.

1. **Line count**, via `wc -l '$G/'*.md`. This prints one line per file plus a trailing `total` line — **ignore the `total` line**, it is not a guideline. Parse each row as: the count is the **leading integer**, and the path is **everything after that first run of spaces** — do not split on whitespace, or a path such as `/Users/John Smith/…` gets cut in half. Each per-file count becomes that guideline's `lines` value, used later as a proof-of-read check on the agent that applies it — pass the same absolute path to that agent so both sides run the identical command against the identical file. Because the glob is absolute, `wc -l` prints absolute paths, which are exactly the `path` values you need below.
2. **First line + last non-empty line**, via one tab-delimited command with no header lines to strip:

   ```
   awk 'FNR==1{a[FILENAME]=$0} NF{b[FILENAME]=$0} END{for (f in a) printf "%s\t%s\t%s\n", f, a[f], b[f]}' '$G/'*.md
   ```

   Each row is `path <TAB> firstLine <TAB> lastNonEmptyLine` — split on tabs, since guideline bodies contain none. These two strings are **body anchors** for the proof-of-read: they make the checker prove it saw the file's contents, not merely that a command ran. Pass them through **verbatim** as `title` and `lastLine` — do not trim, re-title, or tidy them, and never substitute the filename. The script normalizes whitespace and letter case when it compares, so you do not need to. If you omit either, the script logs a `proof-of-read leg DISABLED` warning and falls back to the line count alone, which is the weaker gate this replaced.

   **Do not take `lines` from this command.** `awk` counts lines read while `wc -l` counts newlines; they disagree by one on a file with no trailing newline, and since the checker agent runs `wc -l`, that would make the guideline's gate permanently unmatchable. Item 1 is authoritative for `lines`.

**Version gate.** The first line collected in item 2 is also where a guideline declares a minimum Go version, as an HTML-comment marker — e.g. `<!-- requires-go-version: 1.26 -->`. Most guidelines' first line is just their `# Guideline: …` heading, which has no marker and gates nothing. Read the module's Go version from the `go` directive of the nearest `go.mod` (walk up from the in-scope files). **Skip the guideline entirely — do not include it below — when the module version is lower than required, or no `go.mod` declares a version.** For example, `modernizers.md` requires `1.26`; on a `go 1.25` module it is skipped. Note any version-skip in the Step 4 report so the user knows why it was omitted.

Skip a guideline only when it cannot apply to the scope (e.g. `testing.md` when no `*_test.go` files are in scope, or the user asked to exclude it).

**Files are scoped per guideline, not shared as one flat list.** With multiple Go modules, judge each file against its own module's `go.mod` — a guideline like `modernizers.md` should see only the files from modules that meet its version gate, not the whole changed-file set. For most guidelines with a single module, this is just the full Step 1 list.

Build the list you'll pass to the check:

```
guidelines = [
  {
    stem:     "naming",
    path:     "/abs/.../guidelines/naming.md",   # absolute; the same path the agent will wc -l
    lines:    24,                                # item 1 (wc -l) — NOT the awk row count
    title:    "# Guideline: Naming",             # item 2 field 2, verbatim
    lastLine: "- Single-letter names that ARE idiomatic for their scope (`i`, `r`, `w`, `b`, `ctx`, `tt` in tests).",
    files:    [ ... ],                           # in-scope files for THIS guideline
  },
  ...
]
```

### Step 3 — Run the check

**Primary path — `Workflow`:**

`Workflow` rejects a `scriptPath` it did not itself return unless the file sits under the working directory or a directory added to the session. When this skill is installed as a plugin its `workflow.js` lives under `~/.claude/plugins/cache/...`, which is neither, so passing that path directly fails with *"scriptPath must be a script path this tool returned, or a file you can already read"*. Copy it into the session scratchpad directory (the absolute path is given in your environment) and dispatch from there — not into the user's repo, where it would show up as an untracked file in their working tree. `workflow.js` sits **alongside this SKILL.md**, one level above the `guidelines/` directory resolved in Step 2 — derive it from that same `$G`, and substitute the real absolute paths for `$G` and `<scratchpad>` (the latter is the scratchpad directory named in your environment) before running the copy:

```bash
cp "$(dirname '$G')/workflow.js" "<scratchpad>/golang-check-workflow.js"
```

If the session declares no scratchpad directory, read `workflow.js` in full and pass its contents as `script` instead of `scriptPath` — that path has no directory dependency at all. This is the one file this skill may read into context (~435 lines): it is the script being executed, not a guideline body, so it does not reintroduce the reads Step 2 forbids.

```
Workflow({
  scriptPath: "<scratchpad>/golang-check-workflow.js",
  args: { guidelines, changeNote: "<one-line note of what changed>" },
})
```

Pass `args` as a real JSON object, not a JSON-encoded string. The script fans each guideline out to its own `claude-skills:go-idiom-checker` agent **pinned to `model: "opus"`** (a weaker inherited model degrades these checks invisibly — a shallow read returns `[]`, indistinguishable from a clean pass), capped at 4 concurrent (empirically necessary — see the comment in `workflow.js` for why), retries a guideline twice on a failed proof-of-read (line count **plus** first line **plus** last non-empty line — the two anchors are what make a head-only or file-never-opened read detectable), and returns `{ findings, unverified }` already sorted.

**Fallback path — direct fan-out — only if `Workflow` is unavailable:**

Dispatch each guideline to its own `claude-skills:go-idiom-checker` agent **with `model: "opus"`**, **at most 4 at a time, awaiting each batch before the next** (larger batches measurably raise the rate of derailed, hallucinated 0-tool-call responses). Each prompt must name its guideline by absolute path (Read it IN FULL — the fallback agent does need to open it here, since there is no script to hand it a pre-resolved path list), give the in-scope files for that guideline, apply only that one guideline, and end with this output contract as the entire final message — nothing before or after:

```json
{"file":"relative/path.go","line":42,"symbol":"NewStore","rule":"<guideline stem>","severity":"error|warning|info","confidence":"high|medium","description":"what is wrong, specifically","suggestedFix":"before -> after"}
```

Severity: `error` for correctness bugs (data races, leaks, typed-nil, slice aliasing), `warning` for idiom/convention violations, `info` for stylistic or forward-looking suggestions — unless the guideline body specifies its own mapping for a case (`modernizers.md` defaults to `info`). Confidence: `high` when the violation is unambiguous from the guideline's own criteria, `medium` when it depends on context the agent cannot see; there is no `low` — prefer silence.

A single JSON array, `[]` if nothing found. A healthy checker always Reads its guideline (**≥1 tool call**) and returns a JSON array. Treat a result as **derailed — NOT a clean pass** — when either:

- its output does not parse as a JSON array (prose, an apology, a fragment of instructions, "I don't have a task", an empty/near-empty message), **or**
- it made **0 tool calls** (it never opened its guideline or the target files).

Re-dispatch each derailed guideline, alone or in a small batch. If it still derails after 2 retries, report that guideline as **UNVERIFIED**. **Never accept a non-JSON or 0-tool-call response as `[]`** — a derailed check is a coverage gap, not a clean bill of health.

### Step 4 — Present results

1. Collect all `findings`, grouped by guideline (`rule`) and sorted by file then line within each group — the `Workflow` path returns this pre-sorted; for the fallback path, do the same sort yourself.
2. Present a numbered checklist of `file:line — symbol — description` with severity/confidence.
3. If there are no findings, report the code is clean against the current guidelines.
4. Always list any **UNVERIFIED** guidelines (from `unverified`, or from fallback retries) and any **version-skipped** guidelines from Step 2, so coverage gaps are explicit rather than silently read as a clean pass.
5. Check the run's `log` output for `proof-of-read leg DISABLED`, `UNVERIFIED (bad args)`, `worker threw`, or `dropped … finding(s)` and surface anything you find alongside the findings. Each of those means a check ran with a weakened gate, was skipped over a malformed args entry, or lost data — none of which the `findings` list alone will show you.

> **Reliability note.** Sub-agents receive large injected context attachments (a deferred-tool list plus the skill catalog, ~36 KB for `general-purpose`). Under high fan-out this occasionally makes a sub-agent ignore its task prompt and emit hallucinated system-prompt-like text with 0 tool calls instead of findings. Three mitigations, layered: (1) `claude-skills:go-idiom-checker` restricts the toolset so those attachments shrink, and the concurrency cap of 4 lowers the trigger rate — that cap is why **both** paths batch; (2) on the primary path the three-leg proof-of-read makes a derailed response fail the gate and be retried, because a schema-forced reply can still carry an invented line count but cannot invent the guideline's first and last lines; (3) on the fallback path the non-JSON/0-tool-call detector above catches what slips through. A derailed check is never silently counted as clean.

### Step 5 — Fixes (only when asked)

Do not modify code as part of the check. If the user asks to fix findings:

1. Apply each accepted finding with Edit.
2. After changing a return type or parameter type, check callers (`grep`/graph) and update them so the package still builds.
3. Verify with `go build ./...` (and `go vet ./...` if available) for the affected packages. **Report any remaining failures and fix them before declaring done** — these edits are yours, so leaving the package unbuildable is not an acceptable end state.
