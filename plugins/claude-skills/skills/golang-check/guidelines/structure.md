# Guideline: Project & File Structure

Package layout, imports, and intra-file organisation. Some of this is judged per file; package-layout findings are lower confidence without the whole tree — say so.

Extended examples (consult only for an ambiguous case): `~/.claude/skills/golang-check/references/structure.md`

## Flag

### Packages & layout
- Server/internal logic that is part of no public API but lives outside `internal/` (should be under `internal/` for free refactoring) — low confidence from a single file; mention as a suggestion.
- Package named with uppercase or underscores (`userStore`, `user_store`) — overlaps with `naming`; defer to `naming` for the name itself, here only flag the **directory/package-file mismatch** (file says `package foo` in directory `bar/`).
- A `cmd/` subdirectory not declaring `package main`.

### Imports
- Import block **not split into two groups** (stdlib, then everything else) separated by a blank line.
- Import **aliases used when there's no name conflict** (alias only to resolve conflicts).
- **Blank import** (`import _ "x"`) outside a `main` package or test.
- **Dot import** (`import . "x"`) outside a test file.

### Function & file organisation
- Within a file, declarations badly out of conventional order: types/consts/vars → constructor (`New...`) → exported methods (grouped by receiver) → unexported methods → utilities; roughly caller-before-callee. Flag a constructor placed after the methods it builds, or exported/unexported methods interleaved randomly. Low-to-medium confidence — only when clearly disorganised.
- Source file **not kebab-case** (`userService.go`, `user_service.go` → `user-service.go`).
- A single feature **scattered across many files** or many unrelated types crammed into one file (judgement call — only when obvious).

### Backward-incompatible changes
- A diff that **changes an exported signature/behaviour AND adds new functionality in the same change** — breaking changes should be staged (add new → migrate callers → remove old) as separate commits. Only flag when the change set is visible.

## Don't flag

- Flat package layout in a small project (starting flat is correct).
- Single import group when there are only stdlib imports.
- Aliases that genuinely resolve a conflict.
