---
name: compact-comments
description: Triage every comment added in the current PR — delete the ones that only restate the code, compact the rest into succinct, objective 1-2 line comments that keep the essence. Use PROACTIVELY right after you add or expand comments in source files — pass the files you just edited. Also use whenever the user asks to shorten, tighten, or compact comments, to remove redundant or obvious comments, or invokes /compact-comments. Scope is comments ADDED in the current PR; widen to pre-existing comments only when the user explicitly asks.
allowed-tools: Bash, Read, Edit, Grep, Glob
model: claude-sonnet
argument-hint: [files, or "all" for pre-existing comments too]
---

# Compact Comments

Give every comment added in this PR one of three verdicts — delete it, rewrite it short, or
leave it alone. A comment earns its lines by saying something the code cannot; one that
only narrates the code below it goes away entirely.

## Workflow

1. **Determine scope**:
   - If the user gave files, use those as the file list and skip the discovery commands
     below — but still resolve `$BASE_BRANCH`, because step 2 diffs against it either way.
     Passing files narrows *which files* are examined; it does not widen comment-level
     scope. This is the path self-invocation takes, so reading it the other way compacts
     the whole file instead of the change.
   - Else find the PR base and changed files:
     ```bash
     gh pr view --json baseRefName --jq '.baseRefName'   # fall back to `main` if this fails
     git fetch origin $BASE_BRANCH
     git diff origin/$BASE_BRANCH --name-only --diff-filter=ACM
     git ls-files --others --exclude-standard
     ```
     Dedupe the last two lists into one. The union matters: a brand-new file is
     untracked, so `--diff-filter=ACM` alone misses it — and a new file with verbose
     comments is the most common case this skill exists for.
   - Narrow to source files. Skip `.md`, `.json`, `.yaml`, `.txt`, lockfiles, `.claude/`,
     generated files (`*.pb.go`, `*.gen.*`, files whose first line is `Code generated`),
     `vendor/`, `node_modules/`, and OS temp paths.

2. **Find the added comments.** For each tracked file, `git diff origin/$BASE_BRANCH -U0
   -- <file>` and take the `+` lines that are comments. For untracked files, every
   comment in the file is new. If a comment block has any added line, the whole block is
   in scope — a two-line addition to an existing 6-line block brings all 8 lines in.

   **Every in-scope comment gets a verdict in step 4 — length is not a filter.** A
   one-line comment is examined exactly like a ten-line one. Brevity is not the same as
   worth: `// increment the counter` is short and still says nothing, and it is the case
   this skill most needs to catch.

   **Deletion applies only to a comment block that is entirely new.** A block pulled in by
   the expansion rule above is rewrite-only — it carries pre-existing lines this skill has
   no mandate to remove just because someone appended to it.

3. **Exemptions** — check these *before* deciding anything else. They are load-bearing;
   a wrong edit here breaks a build or a doc contract silently.

   **Never touch at all:**
   - License / copyright headers.
   - Directive comments: `//go:generate`, `//nolint`, `// eslint-disable*`,
     `// @ts-expect-error`, `// @ts-ignore`, `# type: ignore`, `# noqa`, `# pylint:`,
     `/* istanbul ignore */`, shebangs, `// prettier-ignore`, coverage/build pragmas.
   - `TODO`/`FIXME`/`HACK` carrying a ticket ref or an owner — exempt from deletion as
     well as from rewriting; the ticket is the payload.
   - Commented-out code — flag it in the report; don't rewrite it and don't delete it
     yourself, even though this skill now deletes. Dead code is often a deliberate stash,
     and that call belongs to whoever parked it.
   - Comments whose only content is already a tag block.
   - Anything outside the scope from step 2, unless the user explicitly asked to widen
     (e.g. `/compact-comments all`, which enables deletion across whole files and lifts
     the entirely-new-block restriction above). Never widen on self-invocation.

   **Never delete — compact only:**
   - Doc comments on exported/public symbols: godoc, `/** */` TSDoc/JSDoc, Python
     docstrings. Even one that only restates its signature stays — it is an API contract
     feeding `go doc`, IDE tooltips, and lint rules that require it. These still get the
     step-4 judgment — they simply cannot take the delete verdict; a redundant one routes
     to step 5 for compaction instead, and one already at its shortest is left alone.

4. **Triage — delete or rewrite.** For each in-scope comment step 3 did not place under
   *Never touch at all*, one test:

   > If this comment vanished, would a competent reader of the code below it lose
   > anything?

   **No → delete it.** Everything it says is already in the code:
   - Restates the statement below it: `// increment the counter` / `i++`, `// loop over
     the users` / `for _, u := range users`.
   - Restates an identifier that already says it: `// the user's email` / `userEmail`.
   - Narrates obvious structure: `// Step 1: validate the input` above `validate(input)`.
   - A decorative banner labelling an obvious block and nothing more.
   - Duplicates the comment or doc block directly above it.

   **Yes → rewrite it** per step 5, down to the shortest form that still carries what
   would have been lost. These always carry something the code does not:
   - *Why* it is done this way; a workaround and the upstream bug it dodges.
   - An invariant, a required ordering, a thread-safety or lifetime constraint.
   - Units, ranges, encodings, or where a magic value came from.
   - A non-obvious side effect, or a "this looks wrong but is deliberate" warning.
   - A reference to a spec, RFC, ticket, or external contract.

   **When genuinely unsure, rewrite — never delete.** A slightly redundant one-liner costs
   a reader a second; a deleted rationale costs the next person an afternoon.

   **Deletion hygiene:** remove the comment's full lines, including a delimiter left
   dangling (`/**`, `*/`) and a blank separator line the comment alone justified. Never
   leave an empty `/** */` husk or a doubled blank line behind.

5. **Rewrite rules**:
   - 1-2 lines. State why, or the non-obvious what. Where a comment says something real
     *and* restates the code, keep the real part and drop the restatement.
   - Drop narration ("This function will…", "First we…", "Note that…"), hedging, and
     rhetorical setup. Keep exact identifiers, numbers, units, and error strings.
   - Never drop `not`/`only`/`except` — the negation is usually the whole point.
   - Match the file's existing comment style and indentation (`//` stays `//`; a
     `/** */` block stays a block).
   - Doc comments: compact the prose summary only. `@param`/`@returns`/`@throws`/
     `@example` lines pass through byte-identical. A godoc comment keeps its
     `Name does X.` opening.
   - If a comment is genuinely load-bearing (an invariant, a workaround rationale, a
     subtle ordering guarantee), leaving it at 3-4 lines beats mangling it into
     nonsense — note that in the report instead of forcing it down.

6. **Apply and report.** Edit in place. One line per file, then every deletion spelled out
   — a deletion the user cannot see is a deletion they cannot veto:
   ```
   src/api/client.ts — 3 compacted (31 → 9 lines), 2 deleted
     deleted  src/api/client.ts:44  // increment the retry counter
     deleted  src/api/client.ts:88  // Step 2: send the request
   ```
   List anything deliberately left alone and why (exempt, load-bearing, expanded block).
   If nothing was in scope, say `no comments added in scope` and stop.

## Ordering with other automation

`auto-code-simplifier.js` (Stop hook) can trigger a `code-simplifier` pass after source
edits, and that pass can add or reword comments. If a code-simplifier pass is also
pending this turn, run it first — otherwise it can re-inflate what this skill just
compacted.
