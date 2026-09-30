# Guideline: Assertions match what the test claims

A test's name (or `t.Run` subtest name, `it(...)` / `test(...)` description, table-case `name`) is a promise. The assertions inside must **actually establish** that promise. A test that claims one thing and asserts a weaker thing is incomplete, and it is worse than an honestly-named weak test because readers trust the name.

## How to check

For each changed or added test case:

1. Read the name and write down, in one sentence, what it claims to prove.
2. List every assertion the case actually makes (assert/require calls, `expect(...)`, mock expectations, `t.Errorf` conditions, panics expected).
3. Ask: **if the code under test were broken in exactly the way the name warns against, would any of these assertions fail?** If not, the test is incomplete.

Also read the code under test enough to know what the operation touches. A claim about "only" or "other records" needs a check on the things that should be unaffected.

## Patterns to flag

- **Scope claims without scope assertions.** `"deletes only the record with the given ID"` but the test never checks that other records still exist. `"updates the status field"` but never asserts the other fields are unchanged. `"filters by tenant"` but the fixture contains a single tenant.
- **Error claims that only check "an error happened".** `"returns ErrNotFound when the user is missing"` asserted with `assert.Error(err)` or `expect(fn).rejects.toThrow()` with no message/type. The wrong error passes.
- **Mutation claims that never read back.** `"persists the order"` where the test asserts the return value but never reloads from the store or checks the mock's recorded argument. `"increments the counter"` with no before/after comparison.
- **Ordering claims without order assertions.** `"returns results sorted by date"` checked with `assert.Len` / `toHaveLength` or `ElementsMatch` / `arrayContaining` (order-insensitive).
- **Idempotency / no-op claims not exercised.** `"does nothing when already processed"` where the "already processed" precondition is never set up, or the "nothing happened" part is never asserted (mock never checked for zero calls, store never re-read).
- **Negative claims tested by absence of failure.** `"does not call the notifier"` with no `AssertNotCalled` / `toHaveBeenCalledTimes(0)` / `.Times(0)` — the test passes trivially if the mock is permissive.
- **Table-driven cases whose name is not distinguishable by their assertions.** Two cases with different names and identical expected values are usually one of them mis-asserted.
- **Assertions on the test's own setup.** Asserting the value that the test itself put into the fixture, rather than what the code under test produced.

## What NOT to flag

- A test that is honestly named for what it asserts (`"returns no error"` with `assert.NoError`) — that belongs to the strictness guideline if the assertion is too weak, not here.
- Missing coverage of a scenario the name does not claim.
- Style of the assertion library, or preference for `require` over `assert`.

## What to report

- `line` — the line of the test case declaration (the `t.Run(...)`, `it(...)`, or table row). `endLine` — the last line of that case.
- `symbol` — the test function and case name, e.g. `TestRepo_Delete/"removes only the given id"`.
- `description` — the claim, then the gap: `"claims to delete only the given ID, but the only assertion is NoError; sibling rows are never checked."`
- `rationale` — the concrete bug this would let through: `"a DELETE with a missing WHERE clause passes this test."`
- `action` — the assertion to add, stated as code intent: `"seed a second row; after Delete(id1), assert Get(id2) still returns it."`
- `severity` — `error` when the missing assertion means the named failure mode is entirely undetected (the delete-everything case); `warning` when the test detects the failure partially (wrong error type, unordered check).
- `confidence` — `high` when the name makes an explicit claim the assertions cannot establish; `medium` when the name is vague and you inferred the claim.

Every finding here must quote the test name verbatim — the mismatch between name and assertion is the whole finding.
