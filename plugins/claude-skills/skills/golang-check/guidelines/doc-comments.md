# Guideline: Doc Comments

Documentation completeness and form for the exported surface. This is a focused, single-topic check.

Extended examples (consult only for an ambiguous case): `~/.claude/skills/golang-check/references/structure.md`

## Flag

- **Exported symbol with no doc comment.** Every exported `func`, type, `const`, `var`, and method should have a preceding doc comment.
- **Doc comment that doesn't start with the symbol's name.** `// Returns the user.` on `func User()` → `// User returns ...`. Godoc convention is `// Name ...`.
- **Not a complete, period-terminated sentence** (fragments, missing terminal punctuation) on exported symbols.
- **Stale doc comment after a signature/behaviour change** — when the change is visible in scope and the comment now contradicts the code (wrong param described, removed return mentioned, behaviour reversed). Updating the doc must happen in the same edit as the behaviour change.
- **Missing package comment** — a package with no `// Package x ...` comment in `doc.go` or the primary file. Low confidence for tiny/internal packages.

## Don't flag

- **Unexported symbols** — only require comments when behaviour is non-obvious; skip trivial ones.
- Test files, `main` packages' obvious internals, generated code.
- A correct doc comment that's merely terse.
