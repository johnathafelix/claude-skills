# Guideline: Functions & Signatures

The shape of functions and constructors: parameters, context, results, and configuration APIs. (Interface/concrete choices for params are covered by `type-design`; error wrapping by `errors` — don't duplicate those here.)

Extended examples (consult only for an ambiguous case): `../references/idioms.md`

## Flag

- **`os.Exit`/`log.Fatal`/`log.Fatalf` outside `main()`** (or outside a top-level CLI entry). Library and helper code must return errors, never exit the process.
- **Missing `defer` for cleanup** of resources that are opened then used: `resp.Body`, `rows`, `*os.File`, locks. Flag a resource acquired without a `defer x.Close()`/`Unlock()` near acquisition.
- **`context.Context` not the first parameter** — `func Foo(a int, ctx context.Context)` → ctx first.
- **`context.Context` stored in a struct field** — pass it through call chains instead.
- **`context.Context` inside an option/config struct** — must be a separate parameter.
- **`context.Background()`/`context.TODO()` used below the top level** — acceptable only in `main()` or test setup; flag deep in library code (should accept `ctx` from caller).
- **Named result parameters used only to enable naked returns**, or that merely repeat the type (`func f() (err error)` with naked `return`). Named results are fine when they document caller obligations or disambiguate multiple same-typed returns.
- **Long-running method naming:** a method that blocks until completion should be `Run`; one that returns immediately and spawns an internal goroutine should be `Start` and accept `ctx` first. Flag a `Start` that blocks, or a goroutine-spawning method named `Run`.
- **Async-by-default API:** a library function that spawns goroutines internally when it could be synchronous and let the caller add concurrency. Prefer synchronous; flag gratuitous internal concurrency in a general-purpose function.

## Configuration patterns (3+ optional params)

For constructors with 3+ optional parameters, flag a long positional parameter list (`New(a, b, c, d, e)` where most are optional) — should use an **option struct** or **functional options**.

- Prefer option struct when most callers set several options or options are shared across functions.
- Prefer functional options when most callers need zero options, there are many options, or options need validation; use the interface form (`type Option interface{ apply(*options) }`) and have options accept parameters (`FailFast(true)`), not encode presence as signal (`EnableFailFast()`).
- Never put `context.Context` in an option struct (see above).

## Don't flag

- `main()`/CLI entrypoints calling `os.Exit`/`log.Fatal` — that's their job.
- Functions with 1–2 params, or where positional args are clearly fine.
- Test helpers spawning goroutines for the test.
