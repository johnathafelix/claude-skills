<!-- requires-go-version: 1.26 -->
# Guideline: Modernizers (Go 1.26+ via `go fix`)

Find code that still uses an older idiom where a newer Go language/library feature
expresses it better — the rewrites Go 1.26's `go fix` performs. The flagship is Go
1.26's `new(expr)` (pointer-from-a-value, replacing `strPtr`/`boolPtr`/`newInt` helpers
and `p := new(T); *p = v` sequences). These are *improvements*, not bugs, so default to
`info` severity — raise to `warning` only for the perf/correctness ones noted below.

**Gate:** this guideline runs only when the module targets **Go >= 1.26** (the
orchestrator enforces the `requires-go-version` marker above). Do not offer 1.26
features in a file that lowers itself with an explicit older `//go:build go1.NN` tag.

Extended examples + the full modernizer catalog (consult for before→after of each and
for edge cases): `~/.claude/skills/golang-check/references/modernizers.md`

## How to check

- **Preferred oracle — `go fix -diff`.** It is non-destructive: it prints a unified
  diff and writes nothing. First confirm `go version` >= 1.26.
  - Scope it to the in-scope files' package dirs, e.g. `go fix -diff ./internal/... ./pkg/...` (or `go fix -diff ./...`).
  - Findings taken straight from this diff are **`high`** confidence.
- Keep only hunks in the **in-scope file list**; convert absolute paths to repo-relative for `file`. Take line numbers from the diff's `@@` headers.
- **Ignore pure-formatting hunks** (tab/space alignment, gofmt-only) and the `fix: <name>: …` diagnostic lines. Report only *semantic* modernizations — formatting is the repo's gofmt/lint job.
- Attribute each change to its modernizer (catalog in the reference) and name it in `description` (e.g. "newexpr: replace boolPtr(true) with new(true)"). Keep `rule` = `modernizers`.
- To isolate one modernizer or cut formatting noise, use per-analyzer flags: `go fix -diff -newexpr ./...` (negate others with `-NAME=false`).
- **Never run `go fix` without `-diff`** — that rewrites files. This skill reports only.
- **Fallback** (toolchain < 1.26 or unavailable): pattern-match against the reference catalog and mark those findings **`medium`** confidence.

## Flag

- **`new(expr)` — flagship (`newexpr`).** Pointer-helper functions `func p(x T) *T { return &x }` (`strPtr`/`boolPtr`/`intPtr`/`newX`/`proto.Int64`-style) **and** their call sites → `new(v)`; the helper body → `return new(x)` with a `//go:fix inline` directive. Also `tmp := new(T); *tmp = v` and address-of-a-local-just-to-get-a-pointer patterns. After conversion the helper is usually dead — flag it for deletion unless it's part of a stable published API.
- **Other feature upgrades** (before→after in the reference): `any` (`interface{}`→`any`), `stringscut` (`strings.Index`+slice → `strings.Cut`), `stringscutprefix` (`HasPrefix`+`TrimPrefix` → `CutPrefix`), `minmax` (if/else clamp → `min`/`max`), `slicescontains`, `slicessort` (`sort.Slice` → `slices.Sort`), `forvar` (redundant `x := x` in a `range` loop), `rangeint` (`for i:=0;i<n;i++` → `for i := range n`), `reflecttypefor` (`reflect.TypeOf` → `reflect.TypeFor[T]()`), `mapsloop` (copy loop → `maps.Copy`/`Clone`/…), `stringsseq` (range over `Split`/`Fields` → `SplitSeq`/`FieldsSeq`), `testingcontext` (`context.WithCancel`+`defer cancel` in tests → `t.Context()`), `waitgroup` (`Add(1)`/`go`/`defer Done` → `wg.Go`), `fmtappendf` (`[]byte(fmt.Sprintf)` → `fmt.Appendf`).
- **Raise to `warning` (perf/correctness, not just style):** `stringsbuilder` (`+=` in a loop → `strings.Builder`; quadratic, DoS vector) and `hostport` (`fmt.Sprintf("%s:%d")` into `net.Dial` → `net.JoinHostPort`; breaks IPv6).

## Don't flag

- Pure formatting / gofmt-only diffs (alignment, spacing).
- Files with an explicit `//go:build go1.NN` constraint **below** a feature's minimum version — the feature isn't available there and `go fix` won't offer it either.
- `new(expr)` where the name `new` is locally shadowed by another declaration (unsafe — `go fix` skips it).
- Pointer helpers that are part of a **stable published API** — deleting them breaks external callers. At most `info`, and say so.
- `min`/`max` on floating-point operands (NaN semantics differ) — `minmax` already declines these.
- `maps.Clone` / `slices.Clone` swaps that change nil-vs-empty behavior — `go fix` is conservative here; don't force them.
- `omitempty`→`omitzero` in packages with `+kubebuilder` markers (behavior differs) — `go fix` declines; so should you.
- Generated files (`*.pb.go`, `*_gen.go`, `Code generated` header) — excluded by scope and skipped by `go fix`.
- Any rewrite that would only compile on a toolchain newer than the module's declared `go` version.
