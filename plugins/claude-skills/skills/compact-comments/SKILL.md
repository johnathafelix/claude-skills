---
name: compact-comments
description: Compact verbose code comments into super succinct, objective 1-2 line comments that keep the essence. Use PROACTIVELY right after you add or expand comments in source files — pass the files you just edited. Also use whenever the user asks to shorten, tighten, or compact comments, or invokes /compact-comments. Scope is comments ADDED in the current PR; widen to pre-existing comments only when the user explicitly asks.
allowed-tools: Bash, Read, Edit, Grep, Glob
model: claude-sonnet
argument-hint: [files, or "all" for pre-existing comments too]
---

# Compact Comments

Rewrite verbose comments into short, objective 1-2 line comments that keep the essence
without the narration.

## Workflow

1. **Determine scope**:
   - If the user gave files, use those and skip the PR diff below.
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

   Only act on a block that is actually verbose: 3+ comment lines, or one line well past
   the file's own comment norm. Leave a short, already-succinct new comment alone.

3. **Rewrite rules**:
   - 1-2 lines. State why, or the non-obvious what. Drop restatement of the code below it.
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

4. **Never touch** — this list is load-bearing; a wrong edit here breaks a build or a
   doc contract silently:
   - License / copyright headers.
   - Directive comments: `//go:generate`, `//nolint`, `// eslint-disable*`,
     `// @ts-expect-error`, `// @ts-ignore`, `# type: ignore`, `# noqa`, `# pylint:`,
     `/* istanbul ignore */`, shebangs, `// prettier-ignore`, coverage/build pragmas.
   - `TODO`/`FIXME`/`HACK` carrying a ticket ref or an owner.
   - Commented-out code — flag it for deletion in the report, don't rewrite it.
   - Comments whose only content is already a tag block.
   - Anything outside the scope from step 2, unless the user explicitly asked to widen
     (e.g. `/compact-comments all`). Never widen on self-invocation.

5. **Apply and report.** Edit in place. One line per file:
   `path/to/file.ts — 4 comments compacted, 31 lines → 9`. List anything deliberately
   left alone and why (exempt, already succinct, load-bearing). If nothing qualified,
   say `no verbose comments added in scope` and stop.

## Ordering with other automation

`auto-code-simplifier.js` (Stop hook) can trigger a `code-simplifier` pass after source
edits, and that pass can add or reword comments. If a code-simplifier pass is also
pending this turn, run it first — otherwise it can re-inflate what this skill just
compacted.
