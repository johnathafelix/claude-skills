# Go Modernizers (`go fix`, Go 1.26+)

Go 1.26 shipped a completely rewritten `go fix` built on the Go analysis framework
(the same framework behind `go vet` and `gopls`). It runs a suite of **modernizers** —
analyzers that spot older idioms and rewrite them to use newer language/library
features. They exist because newer Go releases added ways to express common patterns
more clearly, safely, or efficiently, and a lot of existing code (and a lot of
LLM-generated code trained on older corpora) still uses the old form.

These are *opportunities for improvement*, not bug reports. Every fix is designed to be
safe to apply without changing correctness, performance, or style — so findings are
low-risk, and most warrant `info`/`warning` severity rather than `error`.

## Version gating — why this check only runs on Go >= 1.26

A modernizer only offers a fix in a file that is allowed to use the feature. The
effective Go version of a file is determined by:

1. the `go` directive in the enclosing `go.mod` (e.g. `go 1.26.0`), or
2. a per-file `//go:build go1.NN` build constraint.

`go fix` will not insert `new(expr)` (a 1.26 feature) into a file whose effective
version is below 1.26, and likewise for every other modernizer's minimum version.
Because the flagship of this guideline is `new(expr)` and the rewritten `go fix`
engine itself is a 1.26 tool, the whole check is gated on the **module** declaring
`go >= 1.26`. Below that, skip it entirely. (A file that *lowers* itself with an
explicit older `//go:build go1.25` constraint is the rare exception — don't flag
1.26 features there.)

## Flagship: `new(expr)` (Go 1.26)

Historically `new`'s only argument was a **type**: `new(string)` allocates a zeroed
`string` and returns `*string`. In Go 1.26, `new` accepts **any value** and returns a
pointer to a fresh variable initialized to that value:

```go
// Before — allocate, then assign
ptr := new(string)
*ptr = "go1.25"

// Go 1.26 — one expression
ptr := new("go1.26")
```

This kills the ubiquitous `xPtr`/`newX` helper. Such helpers are everywhere in code
that uses `*T` to mean "optional `T`" — JSON, protobuf (`proto.Int64`, `proto.String`,
…), config structs:

```go
// Before — helper needed to get a pointer inside an expression
type RequestJSON struct {
    URL      string
    Attempts *int // optional
}

func newInt(x int) *int { return &x }

data, _ := json.Marshal(&RequestJSON{URL: url, Attempts: newInt(10)})

// Go 1.26 — helper unnecessary
data, _ := json.Marshal(&RequestJSON{URL: url, Attempts: new(10)})
```

The `newexpr` analyzer does two things:

1. Rewrites the helper itself into an inlinable wrapper:
   ```go
   //go:fix inline
   func newInt(x int) *int { return new(x) }
   ```
   The `//go:fix inline` directive lets the separate `inline` analyzer replace calls.
2. Rewrites each **call site** directly: `use(newInt(123))` → `use(new(123))`.

After running it, the `newInt`-style helpers are usually **dead** and can be deleted —
unless they are part of a stable published API (then removing them breaks external
callers). A remaining call may be left unfixed when it would be unsafe, e.g. when the
name `new` is **locally shadowed** by another declaration. `deadcode` / the `-newexpr`
run help you find the now-unused helpers.

Real example (this repo's `userStatusFilters`):

```go
// Before — boolPtr helper + calls
func boolPtr(b bool) *bool { return &b }

var userStatusFilters = map[string]*bool{
    userStatusAll:      nil,
    userStatusActive:   boolPtr(true),
    userStatusInactive: boolPtr(false),
}

// Go 1.26 — new(expr) inline; boolPtr deleted
var userStatusFilters = map[string]*bool{
    userStatusAll:      nil,
    userStatusActive:   new(true),
    userStatusInactive: new(false),
}
```

## Full modernizer catalog

Run `go tool fix help` to list what the installed toolchain ships, and
`go tool fix help <name>` for one analyzer's full docs and edge cases. As of Go 1.26:

### Feature upgrades (the "modernizers")

| Analyzer | Since | Rewrite |
|---|---|---|
| `newexpr` | 1.26 | `func p(x T) *T { return &x }` + `p(v)` → `new(v)`; helper body → `return new(x)` |
| `any` | 1.18 | `interface{}` → `any` |
| `stringscut` | 1.18 | `i := strings.Index(s, sep); if i >= 0 { s[:i] }` → `strings.Cut` (also `IndexByte`, `bytes`) |
| `fmtappendf` | 1.19 | `[]byte(fmt.Sprintf(...))` → `fmt.Appendf(nil, ...)` (also `Sprint`/`Sprintln`) |
| `stringscutprefix` | 1.20 | `HasPrefix(s,p)` + `TrimPrefix(s,p)` → `CutPrefix` (and `CutSuffix`; `bytes` too) |
| `minmax` | 1.21 | `if a < b { x=a } else { x=b }` → `x = min(a, b)` (skips floats — NaN) |
| `slicescontains` | 1.21 | membership loop → `slices.Contains` / `slices.ContainsFunc` |
| `slicessort` | 1.21 | `sort.Slice(s, func(i,j) bool { return s[i]<s[j] })` → `slices.Sort(s)` (basic types) |
| `forvar` | 1.22 | redundant `x := x` at top of a `range` loop → removed (1.22 per-iteration vars) |
| `rangeint` | 1.22 | `for i := 0; i < n; i++` → `for i := range n` (loop var & limit not mutated) |
| `reflecttypefor` | 1.22 | `reflect.TypeOf(T(0))` (static type) → `reflect.TypeFor[T]()` |
| `mapsloop` | 1.23 | `for k,v := range x { m[k]=v }` → `maps.Copy`/`Insert`/`Clone`/`Collect` |
| `omitzero` | 1.24 | `omitempty` on a **struct-typed** field → `omitzero` or remove (no-op as written) |
| `stringsseq` | 1.24 | `for range strings.Split(...)` → `strings.SplitSeq` (also `Fields`/`FieldsSeq`, `bytes`) |
| `testingcontext` | 1.24 | `ctx, cancel := context.WithCancel(context.Background()); defer cancel()` in tests → `t.Context()` |
| `waitgroup` | 1.25 | `wg.Add(1); go func(){ defer wg.Done(); … }()` → `wg.Go(func(){ … })` |
| `stringsbuilder` | 1.10 | repeated `s += …` (with at least one in a loop) → `strings.Builder` |
| `stditerators` | — | `for i:=0; i<x.Len(); i++ { x.At(i) }` → `for e := range x.All()` (std types) |

Notes on the trickier ones (from `go tool fix help`):

- **`stringsbuilder`** — targets the quadratic `+=`-in-a-loop pattern, which is a real
  performance bug and a DoS vector. Requires `s` to be a local (not global/param),
  every reference before the final uses to be `+=`, and at least one `+=` in a loop.
  Report these as `warning`, not `info`.
- **`omitzero`** — `omitempty` on a struct field does nothing for `encoding/json`.
  The fix offers *remove* or *switch to `omitzero`* (Go 1.24; omits when the struct is
  zero — a **behavior change**). `go fix` refuses to touch packages containing
  `+kubebuilder` markers, which reinterpret the tag.
- **`mapsloop`** — the `maps.Clone` variant is applied conservatively because `Clone`
  preserves source-map nilness, a subtle change if the old code treated nil differently.
- **`testingcontext`** — only when `cancel` isn't used for anything else.
- **`minmax`** — never on floats (NaN handling differs).

### Also in the suite (hygiene / correctness, not feature upgrades)

| Analyzer | Rewrite |
|---|---|
| `hostport` | `fmt.Sprintf("%s:%d", host, port)` fed to `net.Dial` → `net.JoinHostPort` (fixes IPv6) |
| `plusbuild` | remove obsolete `// +build` lines (superseded by `//go:build`) |
| `buildtag` | check `//go:build` / `// +build` directives |
| `inline` | apply `//go:fix inline` directives (source-level inliner; the self-service preview) |

`hostport` is a genuine correctness fix (the `%s:%d` form breaks with IPv6 hosts) —
treat it as `warning`/`error`, not a stylistic nudge.

## Running `go fix`

`go fix` takes package patterns like `go build`/`go vet`:

```bash
go fix ./...              # apply every fix, in place (WRITES FILES)
go fix -diff ./...        # PREVIEW: print a unified diff, write nothing  ← use this to check
go fix -newexpr ./...     # run only the newexpr modernizer
go fix -any=false ./...   # run everything except `any`
go tool fix help          # list installed analyzers
go tool fix help newexpr  # full docs + edge cases for one analyzer
```

- **`-diff` is non-destructive** — it prints the diff and leaves files untouched. This
  is what a report-only check uses. `go fix` *without* `-diff` rewrites your tree.
- On success `go fix` **silently updates** files and **discards any fix to a generated
  file** (the right fix there is to the generator).
- Its `-diff` output also carries **gofmt/alignment normalization** and per-analyzer
  `fix: <name>: …` diagnostic lines. Alignment-only hunks are not modernizations —
  ignore them; that's the repo's `gofmt`/lint job.
- **Applying is a separate, deliberate step.** Start from a clean git state so the diff
  is only `go fix` edits, and consider committing the most prolific analyzer (e.g.
  `-any`) as its own change to ease review.

### Synergy — run it twice

Fixes compose. Applying one can unlock another:

```go
x := f()
if x < 0   { x = 0 }
if x > 100 { x = 100 }
// minmax → x := max(f(), 0) with the second clause; rerun → x := min(max(f(), 0), 100)
```

Different analyzers chain too (e.g. `stringsbuilder` then a `Fprintf` merge). Running
`go fix` to a fixed point (usually twice) catches these.

### Build-configuration coverage

Each run analyzes one build configuration. For code with heavy `GOOS`/`GOARCH` build
tags, run more than once for coverage:

```bash
GOOS=linux   GOARCH=amd64 go fix ./...
GOOS=darwin  GOARCH=arm64 go fix ./...
GOOS=windows GOARCH=amd64 go fix ./...
```

## After applying: cleanups you may need to do by hand

- **Unused helpers.** After `newexpr`, `xPtr`/`newX` helpers are typically dead.
  Delete them (unless part of a stable public API); `deadcode` finds them.
- **Unused imports.** A common *semantic conflict* is a fix making an import unused.
  `go fix` runs a final pass to remove those automatically.
- **Other semantic conflicts.** Two textually independent fixes can together leave a
  local variable unused (a compile error) — rare, but they surface as build failures,
  so they're hard to miss. Fix by hand.
- **Syntactic conflicts.** Overlapping edits are reconciled with a three-way merge;
  conflicting fixes are discarded with a warning to run again.

## Why fixers are conservative (context for false positives)

Fixers are meant to be applied in bulk with only cursory review, so they err toward
*not* rewriting when a change could alter behavior in an edge case. Example: a proposed
modernizer replacing `append([]string{}, s...)` with `slices.Clone(s)` was **dropped**
from the suite because `Clone` returns `nil` for an empty input while the append form
returns a non-nil empty slice — a subtle behavior change. So if `go fix` declines to
rewrite something that "looks" modernizable, assume there's a reason; don't hand-force it.
