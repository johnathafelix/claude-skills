# Guideline: Type & API Design

How types, interfaces, receivers, and package-level state are designed.

Extended examples (consult only for an ambiguous case): `../references/idioms.md`

## Accept interfaces, return structs (highest signal)

Accept the minimal behaviour you need (an interface), return concrete structs (or pointers).

- **Flag return side (high confidence):** a function whose declared return type is an **interface** while the body only ever returns **one concrete type** (every `return` is `&fooImpl{}`/`fooImpl{}`) and the interface is not an external contract. Strongest signal: exported constructors (`NewX`, `OpenX`) returning an interface. Fix: return the concrete type; callers needing an abstraction define their own consumer-side interface.
- **Flag accept side (medium confidence, conservative):** a parameter typed as a concrete type when only a small method subset is used AND substitution helps testing — I/O, network, filesystem, time/clock, DB/SDK client. Special case: a function that takes a **filename/path and opens it** itself, when it could accept `io.Reader`/`io.Writer` and let the caller open. Fix: accept a minimal interface (often `io.Reader` already fits).
- **Do NOT flag (accept side):** plain data/value/config/DTO/request-response structs passed concretely. Abstracting them adds noise.

### NEVER flag (return side exceptions)

1. `error` returns — `error` is an interface by design.
2. **Polymorphic factories** — returns ≥2 different concrete types by input/config (correctly returns an interface).
3. **Standard/contract interfaces as the real abstraction** — `io.Reader/Writer/Closer`, `http.Handler`, `sort.Interface`, `fmt.Stringer`, `context.Context`, `net.Conn`.
4. Returning an interface to **satisfy an externally-defined interface** (driver/plugin/registry API).
5. **Generics** already provide the flexibility.
6. `any`/`interface{}` for genuinely heterogeneous data.
7. **Test files** (`*_test.go`).

## Interfaces

- **Premature interface.** Flag an interface with a single implementation defined alongside its implementer purely "for mocking" / future-proofing. Interfaces belong consumer-side, defined where used.
- **Pointer to interface.** Flag `*MyInterface` in any signature/field — interfaces are already reference types.
- **Large interfaces.** Flag interfaces with many methods (»3) where a smaller one would do; prefer 1–3 method interfaces.
- **Missing compile-time check** is a nit, not a violation — only mention if the file clearly intends to implement a known interface and got it subtly wrong.

## Receivers (pointer vs value)

- **Flag mixed receiver types** on the same type (some methods value, some pointer) — pick one.
- **Flag value receiver** when the method mutates the receiver, or the receiver contains a `sync.Mutex`/`sync.WaitGroup` or is large → should be pointer.
- **Flag pointer to map/func/chan** parameters or receivers (`*map[K]V`, `*chan T`) — already reference types.

## Embedding

- Flag embedding in **exported/public API structs** when the promoted method set is not clearly intentional (it commits the API to every exported method of the inner type, including future ones). Prefer a named field. (Embedding in `internal/` is lower risk — don't flag there unless clearly wrong.) Embedded `sync.Mutex`/`sync.WaitGroup` is owned by the `concurrency` guideline — don't flag it here.

## Zero-value & type preferences

- Flag a constructor that exists only to set fields to their zero values (the zero value is already usable — `var buf bytes.Buffer`). Only write constructors when non-zero defaults are required.
- Flag `interface{}` where `any` should be used (Go 1.18+).
- Flag pointless type aliases that add no semantics (`type MyString string` used as a plain string). Don't flag aliases that add type safety (`type UserID string`).

## Global state

- Flag libraries (non-`main` packages) that force **global mutable state** instead of instance-based APIs. A package-level singleton holding mutable state, mutated by exported functions, in an importable library → flag. Convenience globals are acceptable only as a thin proxy over an instance API and only in binaries. Logically-constant or stateless globals are fine.
