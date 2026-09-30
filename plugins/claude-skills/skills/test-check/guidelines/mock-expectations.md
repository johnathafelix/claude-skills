# Guideline: Expected mocks are asserted called; unexpected calls fail

A mock that is configured but never verified is a stub, and a stub cannot fail. Every test that uses mocks must (1) **assert that each expected interaction happened**, with the expected arguments and count, and (2) **fail on any interaction it did not expect**. Both halves are required: the first catches "forgot to call", the second catches "called something extra" — an unexpected notifier call, a duplicate write, a cache invalidation that should not have fired.

## Framework mechanics

| Framework | Expected calls are asserted by | Unexpected calls fail when |
|---|---|---|
| **mockery** (`testify/mock`) | `m.EXPECT().Method(args).Return(...)` **plus** `m.AssertExpectations(t)` — with the `mockery` constructor `NewMockX(t)`, `AssertExpectations` is registered via `t.Cleanup` automatically; a hand-built `&MockX{}` needs the explicit call. `.Once()`, `.Times(n)` pin the count. | Always — `testify/mock` panics on a call with no matching expectation. But an expectation registered with `.Maybe()` or a wildcard `mock.Anything` on every argument lets anything through. |
| **testify/mock** without mockery | `m.On("Method", args)` + `m.AssertExpectations(t)` / `m.AssertCalled(t, ...)` / `m.AssertNumberOfCalls(t, "Method", n)` | Same as above. `m.AssertNotCalled(t, "Method")` makes "must not fire" explicit. |
| **gomock** | `ctrl := gomock.NewController(t)` — `ctrl.Finish()` is automatic via `t.Cleanup` on Go 1.14+; `.Times(n)` / default once. | Always — gomock fails on unexpected calls. `.AnyTimes()` on an expectation defeats the count check. |
| **jest / vitest** | `expect(fn).toHaveBeenCalledWith(...)`, `toHaveBeenCalledTimes(n)`, `toHaveBeenNthCalledWith` | Never by default — `jest.fn()` accepts anything silently. "Must not fire" needs `expect(fn).not.toHaveBeenCalled()` / `toHaveBeenCalledTimes(0)`. For a mocked module with several functions, each one that must stay silent needs its own `not.toHaveBeenCalled()`. |
| **sinon** | `sinon.assert.calledWith(spy, ...)`, `calledOnce`, `spy.callCount` | Never by default; `sinon.assert.notCalled(spy)`. `sinon.mock(obj).expects(...)` + `mock.verify()` gives both halves. |
| **Hand-rolled fakes** (struct with func fields, recorded-call slices) | Assertions on the recorded calls slice | Only if the fake records *all* calls and the test asserts the full list, or panics on unconfigured funcs. |

## Patterns to flag

- **Expectation with no verification.** `mock.On(...)` or `m.EXPECT()...` on a hand-constructed `&MockX{}` with no `AssertExpectations(t)` anywhere in the test (check `t.Cleanup`, helper functions, and `TestMain`). `jest.fn().mockResolvedValue(...)` with no `toHaveBeenCalled*` on it.
- **Return configured, call never asserted.** `jest.spyOn(api, 'fetch').mockResolvedValue(data)` where the test asserts the result but never that `fetch` was called with the right URL.
- **Count not pinned where it matters.** A write/send/charge expectation without `.Once()` / `.Times(1)` / `toHaveBeenCalledTimes(1)` in a scenario where a duplicate call is a bug.
- **Blanket `.Maybe()` / `.AnyTimes()`** applied to expectations the scenario definitely exercises — it turns an assertion into a stub.
- **No negative assertion for a collaborator that must not fire.** The test is named for a skip/no-op/failure path (`"does not send when disabled"`, `"rolls back on error"`) and the mock that should stay silent has no `AssertNotCalled` / `not.toHaveBeenCalled()` / `Times(0)`.
- **Permissive mock in jest/vitest with only a result assertion** — a module mocked with `jest.mock('../notifier')` where none of its functions are asserted, in a test whose behavior would change if they were called.
- **`AssertExpectations` on the wrong mock**, or on only one of several mocks constructed in the test.
- **Expectations set inside a helper but the mock instance returned is a different one** than the one injected into the code under test.

## What NOT to flag

- `mockery` mocks built with the generated `NewMockX(t)` constructor — `AssertExpectations` is wired through `t.Cleanup`. Verify the constructor is used before flagging its absence.
- gomock with `NewController(t)` on Go ≥ 1.14 — `Finish` is automatic.
- Stubs for pure data providers (a clock, a config loader) where whether they were called is genuinely irrelevant — but a finding is still due if the name of the test implies they should or should not have been called.
- Argument looseness (`mock.Anything`) — that belongs to the strictness guideline, not here, unless it is the mechanism defeating the "unexpected calls fail" half.

## What to report

- `line` — the mock construction or expectation line. `endLine` — the last line of the test case.
- `symbol` — test case name plus the mock and method: `TestOrderService_Cancel/"already cancelled" — notifierMock.Send`.
- `description` — which half is missing: `"notifierMock has .On(\"Send\", …).Return(nil) but no AssertExpectations, AssertCalled, or AssertNotCalled anywhere in the test; the mock is a &MockNotifier{} literal, not NewMockNotifier(t)."`
- `rationale` — the failure this hides: `"if Cancel stops calling Send, or calls it twice, this test still passes."`
- `action` — the concrete fix: `"construct with NewMockNotifier(t), or add notifierMock.AssertExpectations(t); pin with .Once()."` For a must-not-fire collaborator: `"add notifierMock.AssertNotCalled(t, \"Send\", mock.Anything, mock.Anything)."`
- `severity` — `error` when the unverified interaction is the behavior the test is named for; `warning` otherwise.
- `confidence` — `high` when you traced the mock's construction and found no verification path; `medium` when verification may happen in shared helpers you could not fully trace.

Both halves, every time: prove the expected call happened, and prove nothing else did.
