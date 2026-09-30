# Guideline: Assertions are as strict as the value allows

Prefer the **actual value**. When the actual value is genuinely unknowable at assertion time, assert its **type or shape**. Wildcards (`mock.Anything`, `expect.anything()`, `gomock.Any()`, `sinon.match.any`) are a last resort for values that truly change every run or would need excessive mocking to pin down — and when used, the finding should be able to say why.

## The ladder, strictest first

1. **Exact value** — `assert.Equal(t, "order-42", got.ID)`, `expect(res.status).toBe(201)`, `.EXPECT().Save(ctx, wantOrder)`.
2. **Structural match with the volatile parts pinned by type** — `mock.MatchedBy(func(o Order) bool { return o.ID == "order-42" && !o.CreatedAt.IsZero() })`, `expect.objectContaining({ id: 'order-42', createdAt: expect.any(Date) })`.
3. **Type only** — `mock.AnythingOfType("*service.Order")`, `expect.any(String)`, `gomock.AssignableToTypeOf(...)`. Acceptable when the value is a fresh UUID, a timestamp, a context, or a generated token.
4. **Wildcard** — `mock.Anything`, `expect.anything()`, `gomock.Any()`. Acceptable only for `context.Context` arguments and values that would require replicating the implementation to compute.

Flag anything sitting lower on the ladder than the value permits.

## Patterns to flag

- **Wildcard on a business value.** `.EXPECT().Charge(mock.Anything, mock.Anything)` where the amount and customer are known from the test's own fixture. `toHaveBeenCalledWith(expect.anything())` for a payload the test constructed.
- **Type-only where the value is known.** `AnythingOfType("string")` for an ID the test itself set.
- **Existence-only assertions on rich values.** `assert.NotNil(t, got)`, `expect(result).toBeTruthy()`, `expect(result).toBeDefined()` as the sole check on a struct, slice, or object. The wrong object passes.
- **Error presence without identity.** `assert.Error(t, err)` / `expect(...).rejects.toThrow()` with no `ErrorIs`, `ErrorAs`, `EqualError`, or message/type matcher — when the code under test has more than one error path.
- **Length or emptiness instead of content.** `assert.Len(t, got, 2)` / `toHaveLength(2)` with no check on what the two items are.
- **Substring or regex when the full string is deterministic.** `assert.Contains(t, msg, "failed")` on a message the code builds from fixed parts.
- **`NoError` as the only assertion** on an operation that returns a value or mutates state.
- **`Maybe()` / optional expectations** on a mock call the scenario definitely triggers — this belongs partly to the mock-expectations guideline; flag it here only when it is used to dodge asserting the argument.
- **Snapshot assertions** (`toMatchSnapshot`) on small, hand-constructable values — the snapshot hides what is actually being promised.

## What NOT to flag

- `mock.Anything` / `gomock.Any()` for a `context.Context` parameter.
- `expect.any(Date)` / `AnythingOfType("time.Time")` for a timestamp the code stamps with `time.Now()`.
- Type matches for freshly generated IDs, tokens, nonces.
- A wildcard where pinning the value would require re-implementing a hash, a serializer, or a large nested object graph — but say in the finding *why you looked and let it pass* only if the reader would otherwise question it. Otherwise silence.
- Assertions in helper functions that are exercised strictly elsewhere.

## What to report

- `line` — the assertion or mock expectation line. `endLine` — same line unless the expectation spans several.
- `symbol` — the test case name and the matcher, e.g. `TestCharge/"happy path" — .EXPECT().Charge(mock.Anything, mock.Anything)`.
- `description` — what is loose and what the stricter form would be: `"second argument is mock.Anything, but the amount (1999) and currency are fixed by the fixture on line 41."`
- `rationale` — the defect it would let through: `"a charge for the wrong amount, or for the wrong customer, still passes."`
- `action` — the concrete replacement, stated as code intent: `"expect Charge(mock.Anything, ChargeRequest{Amount: 1999, Currency: "BRL", CustomerID: cust.ID})."` Where the exact value is impossible, propose the type-level or `MatchedBy` alternative.
- `severity` — `warning` by default; `error` when the loose assertion is the *only* assertion guarding a payment, deletion, authorization, or other irreversible effect.
- `confidence` — `high` when the exact value is visible in the test's own fixture; `medium` when it would come from code you inferred.

Prefer silence over flagging a wildcard whose value genuinely cannot be pinned without excessive mocking — the guideline is "strict as the value allows", not "never use Anything".
