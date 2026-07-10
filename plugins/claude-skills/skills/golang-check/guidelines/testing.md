# Guideline: Testing

Test structure, assertions, doubles, and reliability. Scope: `*_test.go` files (and benchmark files). If no test files are in scope, return no findings.

Extended examples (consult only for an ambiguous case): `../references/testing.md`

## Flag

### Table tests
- A table test whose cases need **different setup/mocking or conditional assertions inside the loop** — should be split into separate `Test...` funcs, not forced into one table.
- Table cases not run via `t.Run` (no subtest, so failures aren't isolated/named).
- Table struct fields where only some rows use a field (non-uniform logic) — sign the table is the wrong tool.
- Inputs/outputs not following the `give*`/`want*` convention is a minor nit — only mention if naming is actively confusing.

### Subtests & parallelism
- `t.Parallel()` in a subtest that then closes over a loop variable `tt` in a way unsafe for Go < 1.22 without shadowing (`tt := tt`). (Go 1.22+ is safe.)
- `t.Fatal`/`t.FailNow` called from a **spawned goroutine** inside a test (only legal on the test's own goroutine) → use `t.Error` + `return`. Note: `t.Parallel()` does not spawn a goroutine, so `t.Fatal` is fine there.

### Assertions
- `reflect.DeepEqual` used directly for comparing structs/slices → `require.Equal`/`assert.Equal`.
- Order-dependent slice equality where order shouldn't matter → `assert.ElementsMatch`.
- `require` vs `assert` misuse: error/nil-guard checks that should stop the test using `assert` (continues into a nil deref); independent value checks using `require` (hides later failures).
- **Exact string matching on error messages** → `errors.Is`/`errors.As`, or `require.ErrorContains` for a substring.
- `t.Helper()` missing in a helper that calls `t.Fatal`/asserts (failures report the wrong line). Conversely, `t.Helper()` in an assert-like wrapper that hides the failure's cause.

### Reliability & hygiene
- **`time.Sleep` used for synchronisation** in a test (flaky) → channels/WaitGroup/poll-with-deadline.
- Writing files to the **source directory** instead of `t.TempDir()`, or setting env without `t.Setenv()`.
- Test data in `init()` or package-level vars instead of scoped setup (`sync.Once` for expensive shared setup).
- Concurrent code tested without `-race` awareness — flag a concurrency-heavy test file with no mention of race testing only if clearly relevant.
- Asserting on `json.Marshal` output / serialization byte-for-byte (field-order dependent) → parse and compare semantically.

### Benchmarks
- Benchmark whose result isn't assigned to a package-level var (compiler may eliminate the work); missing `b.ResetTimer()` after heavy setup; using wall-clock instead of `b.N`/`b.Loop()`.

## Don't flag

- `t.Parallel()` on Go 1.22+ closing over `tt` (safe).
- Legitimate `assert` for independent soft checks; legitimate `require` for guards.
- Mocks/fakes/`Must` helpers that intentionally bend production rules.
