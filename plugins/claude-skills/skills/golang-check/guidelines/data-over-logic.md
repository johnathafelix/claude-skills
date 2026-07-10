# Guideline: Data Over Logic (prefer tables/maps over branching)

Flag branching that only *selects a value by a key*: a `switch` or if/else-if chain
whose every arm does nothing but return or assign a constant/simple value keyed off one
expression. That branch structure is noise — the real content is a key→value table, so
express it as a `map`/slice lookup. Keep branching when arms carry real logic.

**Go caveat (bake into every suggestion):** a *static* table belongs in a package-level
`var` built once, not rebuilt as a map literal on every call — an inline literal
allocates per invocation. Suggest hoisting to package scope for hot paths; an inline
literal is acceptable only on a cold path where locality aids readability.

Extended examples + the allocation/default patterns: `../references/data-over-logic.md`

## Flag

- **Value-selecting `switch`:** `switch x { case a: return V1; case b: return V2; …; default: return VD }` where every arm only produces a constant/simple value with no other logic → a `map[K]V` lookup plus a default via comma-ok or nil-check. (The status-code→sentinel-error switch is the canonical case.)
- **if/else-if chain on the same variable** compared to constants, each returning/assigning a value → same map treatment.
- **Parallel switches / duplicated case lists** in several functions that all key off the same enum → one shared package-level table each function reads from (DRY).
- **Rebuilt-every-call map literal** used as a lookup inside a function body → hoist to a package-level `var` when keys and values are static.
- **Case list mapping to one value** (`case a, b, c: return V`) → repeated keys in the map (`a: V, b: V, c: V`), which also removes ordering assumptions.

## Don't flag

- Arms that do more than select a value: side effects, multiple statements, loops, early returns with differing structure, error wrapping whose shape varies per arm.
- **Type switches** (`switch v := x.(type)`) — not a value map.
- Cases with conditions/ranges (`case n > 100:`), `fallthrough`, or where evaluation order is load-bearing.
- Small switches (~2–3 arms) where a map adds allocation/indirection for no readability win.
- A `switch` kept deliberately for compiler jump-table perf or linter exhaustiveness on a hot path — don't replace it with a **per-call map-literal allocation**; only a package-level table is acceptable there.
- Selection that depends on **multiple inputs** (not a single key) — a map key would be contrived; a switch/if reads better.
- Values that must be computed lazily or have differing init cost per key (a table would eagerly build them all).
