# Guideline: Gotchas (Correctness Traps)

Subtle Go pitfalls that compile fine but misbehave at runtime. Each finding should name the concrete bug, not a style preference.

Extended examples (consult only for an ambiguous case): `~/.claude/skills/golang-check/references/gotchas.md`

## Flag

- **Variable shadowing:** `:=` in an inner block (`if`/`for`/`switch`) that silently redeclares an outer variable — especially `err`. If the inner assignment was meant to update the outer var, it should use `=`. Flag re-`:=` of `err` inside a block whose outer `err` is checked afterward.
- **Defer argument evaluation:** `defer f(x)` where `x` is expected to reflect its value at function exit — arguments are evaluated immediately. Use a closure `defer func(){ f(x) }()` to capture the final value.
- **Defer in a loop:** `defer` inside a `for` loop body that accumulates until the function returns (e.g. opening N files, deferring N closes). Extract the loop body into a function so each `defer` fires per iteration.
- **Slice append aliasing:** `append` to a sub-slice that has spare capacity, where the original and the result share a backing array and one's writes corrupt the other. Use a full slice expression `s[:len(s):len(s)]` or explicit `copy`.
- **Runes vs bytes:** `len(s)` used as a character/rune count, or indexing `s[i]` to read "characters" of a UTF-8 string. Use `range`/`utf8.RuneCountInString`.
- **String concatenation in a loop with `+=`** (O(n²)) → `strings.Builder` (with `Grow` when size known). Don't flag a few fixed concatenations.
- **Copy safety:** returning/accepting a struct with pointer fields across an API boundary without copying when external mutation would be a bug; not copying a slice/map at an API boundary where the caller could later mutate shared state. (Copying a struct that contains a `sync.Mutex`/no-copy type is owned by the `concurrency` guideline — don't flag it here.)
- **Fixed bit-width type without reason:** `int8`/`uint16`/`int32` etc. used for ordinary counters/indices where `int` is correct (silent-overflow risk). Don't flag widths required by a protocol, binary format, or measured performance need.
- **Typed-nil interface trap:** returning a typed nil pointer (`var p *T = nil; return p`) from a function whose return type is an **interface** — the interface is non-nil. Return an explicit `nil`.
- **Missing signal-boost comment:** code that intentionally does the opposite of the common pattern (e.g. checks `err == nil` to proceed, or a deliberately empty branch) with no comment flagging the inversion.

## Don't flag

- Narrow integer types justified by protocol/format/perf (with or without comment).
- `+` concatenation of a small fixed number of strings.
- Shadowing that is clearly intentional and local with no outer use afterward.
