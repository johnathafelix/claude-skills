# Data Over Logic (Go)

When branches differ only in a value they return, the branch structure is noise and the
real content is a key→value table. Separate the two: keep the *data* in a `map` (or
slice) and let a single lookup replace the branching. Code shrinks, the mapping is
visible at a glance, and adding a case is a one-line data edit instead of a new control
path. The flip side — arms that carry real *logic* (side effects, differing control
flow) — stay as a `switch`; forcing those into data hurts.

## Canonical example: status code → sentinel error

A `switch` that maps HTTP status codes to sentinel errors is pure data wearing control
flow:

```go
// Before — every arm just picks a sentinel
switch upstreamStatusCode(err) {
case http.StatusNotFound:
    return fmt.Errorf("%w: %w", sentinels.notFound, err)
case http.StatusConflict:
    if sentinels.conflict != nil {
        return fmt.Errorf("%w: %w", sentinels.conflict, err)
    }
    return fmt.Errorf("%w: %w", sentinels.upstreamFailed, err)
case http.StatusBadRequest, http.StatusUnprocessableEntity:
    return fmt.Errorf("%w: %w", sentinels.invalidRequest, err)
default:
    return fmt.Errorf("%w: %w", sentinels.upstreamFailed, err)
}
```

```go
// After — the mapping is data; one wrap at the end
sentinel := map[int]error{
    http.StatusNotFound:            sentinels.notFound,
    http.StatusConflict:            sentinels.conflict,
    http.StatusBadRequest:          sentinels.invalidRequest,
    http.StatusUnprocessableEntity: sentinels.invalidRequest,
}[upstreamStatusCode(err)]

if sentinel == nil {
    sentinel = sentinels.upstreamFailed
}

return fmt.Errorf("%w: %w", sentinel, err)
```

Two things to notice:

- **The default falls out for free.** A missing key yields the map's zero value (`nil`
  for an `error`), so `if sentinel == nil { … }` handles both the `default` arm *and*
  the old `conflict != nil` special case — a nil `sentinels.conflict` simply flows to
  `upstreamFailed`. The map form subsumes the guard.
- **A case list becomes repeated keys** (`StatusBadRequest` and
  `StatusUnprocessableEntity` both map to `invalidRequest`).

## Prefer a package-level table for static maps

The inline `map[int]error{…}[key]` above **allocates and populates a new map on every
call**. That's fine on a cold path (error classification), but for anything hot, build
the table once at package scope and read from it with the comma-ok idiom:

```go
var sentinelByStatus = map[int]error{
    http.StatusNotFound:            sentinels.notFound,
    http.StatusConflict:            sentinels.conflict,
    http.StatusBadRequest:          sentinels.invalidRequest,
    http.StatusUnprocessableEntity: sentinels.invalidRequest,
}

func classify(err error) error {
    sentinel, ok := sentinelByStatus[upstreamStatusCode(err)]
    if !ok {
        sentinel = sentinels.upstreamFailed
    }

    return fmt.Errorf("%w: %w", sentinel, err)
}
```

Comma-ok (`v, ok :=`) is the precise default check: it distinguishes "key absent" from
"key present with a zero value", which a bare `== nil` cannot. Use it when a stored value
could legitimately be the zero value.

(A package-level `var` map is only safe as a lookup table if it is treated as read-only
after init — never mutated at runtime — since maps aren't safe for concurrent writes.)

## When to keep the `switch`

Data-over-logic applies only to *value selection*. Keep branching when:

- **Arms carry logic** — side effects, several statements, loops, early returns with
  different shapes, or error wrapping that varies structurally per case.
- **Type switch** — `switch v := x.(type)` dispatches on dynamic type, not a key.
- **Conditions or ranges** — `case n > 100:`, or `case a, b:` mixed with guards;
  `fallthrough`; or cases whose evaluation order matters.
- **Few arms** (~2–3) — a map adds an allocation and a layer of indirection for no real
  readability gain.
- **Hot path relying on a jump table** or on a linter's exhaustiveness check
  (`exhaustive`) over an enum — don't trade that for a per-call map literal. If a table
  fits, it must be package-level.
- **Value depends on more than one input** — a single map key would be contrived.
- **Per-key values are expensive/lazy** — a table builds them all eagerly.

## Rule of thumb

If you can rewrite the branch as `table[key]` (with a default) and lose nothing, it was
data. If the rewrite forces you to smuggle logic into the values (closures per case, side
effects), it was logic — leave the `switch`.
