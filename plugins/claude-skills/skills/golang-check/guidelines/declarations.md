# Guideline: Declarations & Literals

Local value construction: variable declaration style, slices, maps, struct literals, enums. Statement-level idioms only.

Extended examples (consult only for an ambiguous case): `../references/idioms.md`

## Flag

- **Wrong declaration form.** `var s = "hello"` (use `:=` for initialisation) or `x := 0` purely to get a zero value (use `var x int`). Top-level: prefer `var` and omit the type when obvious.
- **Slices**
  - `s == nil` / `s != nil` used to test emptiness → `len(s) == 0`.
  - Initialising an empty slice as `[]T{}` when `var s []T` (nil slice) would do — unless JSON encoding needs `[]` not `null` (then `[]T{}` is correct; don't flag).
  - Building a slice of known size without pre-allocation (`var s []T` then appending N times in a loop) → `make([]T, 0, n)`.
- **Maps:** using a map literal for programmatically-populated data, or `make(map[K]V)` without a capacity hint when the size is known (`make(map[K]V, n)`).
- **Struct literals**
  - **Positional (unkeyed) struct literals** for structs with more than ~1 field → use field names: `User{"a", 30}` → `User{Name: "a", Age: 30}`.
  - `new(T)` where `&T{}` reads better.
  - Explicitly setting fields to their zero value in a literal without a documenting reason (noise).
- **Enums:** `iota` starting at 0 for a status/kind enum where the zero value has no meaningful "unset/zero" case → start at `iota + 1` so the zero value is distinguishable. Don't flag when the zero value is intentionally meaningful (e.g. a real default).

## Don't flag

- `[]T{}` when a nearby comment or JSON tag shows non-nil is intentional.
- Positional literals for 1-field structs or well-known 2-field pairs where keys add no clarity (rare — prefer keyed).
- `iota` at 0 when zero is a deliberate, documented default.
