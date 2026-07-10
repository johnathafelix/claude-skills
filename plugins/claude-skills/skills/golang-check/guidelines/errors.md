# Guideline: Error Handling

Creation, wrapping, matching, and control flow of errors. This is the only guideline that checks error semantics.

Extended examples (consult only for an ambiguous case): `~/.claude/skills/golang-check/references/errors.md`

## Flag

### Core
- **Discarded errors:** `_ = doThing()` or ignoring a returned `error` you didn't deliberately drop. (Deliberate `_ =` on a deferred `Close` is acceptable — see Defer below.)
- **Handle-once violation:** logging an error AND returning it (double handling). Log-and-degrade, or wrap-and-return — not both.
- **`panic` for ordinary failures.** Return an error instead. Panic only for truly irrecoverable states. (`MustXxx` exception below.)
- **`==` / direct type assertion on a possibly-wrapped error** → use `errors.Is` / `errors.As`.

### Creation (match against the decision)
- No match needed, static msg → `errors.New("...")`.
- No match needed, dynamic msg → `fmt.Errorf("file %q missing", name)`.
- Caller must match, static → exported `var ErrXxx = errors.New(...)`.
- Caller must match, dynamic → custom error type with `Error()`, matched via `errors.As`.
- Flag a sentinel returned bare without wrapping (caller forced into `==`); wrap so `errors.Is` works.

### Error strings
- Flag capitalised error strings or trailing punctuation: `errors.New("Not found.")` → `errors.New("not found")`. They compose into chains.
- Flag `"failed to "` / `"error "` prefixes in wrap context: `fmt.Errorf("failed to get user: %w", err)` → `fmt.Errorf("get user: %w", err)`.

### Wrapping
- Flag `%v` for an error that callers should be able to unwrap → use `%w`. (Use `%v` only when the underlying error is an implementation detail you intentionally hide.)
- Flag `%w` placed mid-string when it could be at the end (chain reads newest→oldest).
- Flag redundant context that repeats what the wrapped error already says.

### Other
- **In-band errors:** returning a sentinel value (`-1`, `""`, `nil`) to signal failure instead of `(T, error)` or `(T, bool)`.
- **`MustXxx`** used outside package-init or test helpers (e.g. in a request handler / runtime path).
- **Type assertion without comma-ok:** `s := val.(string)` → `s, ok := val.(string)`.
- **Defer errors:** a deferred `f.Close()`/`rows.Close()`/`resp.Body.Close()` whose error is silently dropped — propagate it (when no prior error) or make the ignore explicit with `_ =`.
- **Error flow:** the happy path nested inside `else` after an error check, or errors not returned early. Errors indented, happy path flat at minimum indentation.

## Structured errors

If the project already uses a structured error package (e.g. golib/e), flag inconsistent fallback to `fmt.Errorf` where the structured API (`ErrNotFound.Wrap(err)`, `e.NewFrom("ctx", err)`) should be used. Don't introduce it where the project doesn't use it.

## Don't flag

- `error` being an interface (that's correct).
- `panic` in genuinely unrecoverable init, or `MustXxx` in init/tests.
- Deliberate `_ =` on a deferred close where the error truly doesn't matter.
