# Guideline: Coverage of new or modified code

At least **80% of the lines added or modified on this branch** must be executed by the test suite. Coverage of the whole file or package is irrelevant here — a legacy file at 30% is fine if every line touched on this branch is covered, and a file at 95% fails if the new function is the uncovered 5%.

## Inputs you were given

- `changedRanges` — per source file, the 1-based line ranges added or modified relative to the base branch (from `git diff -U0`). Only these lines count.
- `coverageFile` — an absolute path to a coverage report. Read it with the parser that matches its format; never estimate coverage by reading tests.

## Reading the coverage file

| Format | How to tell | How to read it |
|---|---|---|
| Go `coverprofile` (`coverage.out`, `cover.out`) | first line is `mode: set|count|atomic` | Each line is `file:startLine.startCol,endLine.endCol numStatements count`. A block is covered when `count > 0`. Map blocks onto the changed ranges by line. `go tool cover -func=<file>` gives per-function totals as a cross-check, but per-line judgement comes from the raw blocks. |
| LCOV (`lcov.info`) | records start with `SF:` | `DA:<line>,<hits>` — covered when `hits > 0`. `SF:` names the file. |
| Istanbul JSON (`coverage-final.json`) | top-level object keyed by absolute file path | `statementMap` gives each statement's `start.line`/`end.line`; `s[<id>]` is its hit count. Covered when `> 0`. |
| Cobertura XML (`coverage.xml`) | `<coverage line-rate=…>` root | `<line number=… hits=…>` inside each `<class filename=…>`. |

Paths inside the report may be module-relative (Go: `module/path/file.go`), repo-relative, or absolute. Match on the longest common suffix with the changed file's path.

## What to compute

For every changed source file:

1. Collect its changed lines from `changedRanges`.
2. Drop lines that carry no executable statement — blank lines, comments, `package`/`import` lines, bare `}` or `)`, type/interface declarations, struct field lists, constant blocks. The coverage report already excludes these (they never appear as blocks/`DA:` entries), so a changed line that is absent from the report AND is non-executable is neither covered nor uncovered.
3. Of the executable changed lines, count covered vs uncovered.
4. Report one finding per **contiguous uncovered range**, not one per line, and one summary finding per file that falls below 80%.

## What to report

- **Below 80% per file** — `severity: warning`. `description` states the ratio (`"12 of 20 changed executable lines covered (60%)"`), `action` lists the uncovered ranges as `file:start-end` so the reader can jump to them.
- **A changed function or method with zero covered lines** — `severity: error`. New behavior with no test at all is the case this check exists for.
- **A changed error-handling branch left uncovered** (`if err != nil { return … }`, `catch`, `.catch(`) while the happy path is covered — `severity: warning`, even when the file is above 80% overall. Error paths are where untested code fails in production.
- **Changed file not present in the coverage report at all** while tests for the package ran — `severity: warning`, `description` says the file never executed under test.

Do **not** report:

- Files whose only changes are non-executable (imports, comments, type declarations, renamed identifiers with identical statements).
- Generated code, `main()` wiring, or files the user excluded.
- Anything about coverage of lines that were not changed on this branch.

## Rationale to include

The `rationale` field should say **why this specific gap matters**, not restate the 80% rule — e.g. "this branch is the only place the retry budget is decremented; an off-by-one here loops forever and nothing exercises it." Name the behavior that is untested, so the reader can decide whether to write a test or accept the gap.

## Confidence

- `high` when the coverage report and the diff agree unambiguously (the lines appear in the report with zero hits).
- `medium` when the report's path did not match cleanly and you inferred the file by suffix, or when you had to judge which lines are executable.

Lines executed only by a test that is skipped (`t.Skip`, `it.skip`, `xit`, `describe.skip`) count as uncovered even if the report shows hits from a different run — flag those separately if you can see the skip.
