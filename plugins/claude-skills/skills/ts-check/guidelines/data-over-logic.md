# Data Over Logic: Practical Rules for Data-Driven Design in TypeScript

Check changed code only. Read the following checklist in full. Extended examples and
trade-offs (consult only when ambiguous): `../references/data-over-logic.md`

## Checklist

- Put business/product variability (policy) in data; keep the interpreter/execution engine (mechanism) stable and generic.
- Your declarative data format is a public API. Define its structure and constraints explicitly (schema + documentation), and keep the engine and schema in sync.
- Every "instruction" node in your declarative data should be a **tagged** (discriminated) union with a clear discriminator field (`kind`, `type`, etc.).
- Treat declarative data as **untrusted input**: validate it *immediately when loaded*, normalize it into a canonical internal representation, and fail fast with actionable errors.
- Make your interpreter **deterministic**: it should transform input facts + declarative data into a **plan/effects** (data). Apply the effects in a separate, explicit execution step.
- Your declarative format must be **bounded**. Do **not** embed arbitrary code (strings executed via `eval`, dynamic `Function`, or serialized functions) inside configuration/rules.
- If the system must grow, it should grow via **explicit extension registries** (new `Cond.kind`, new `Action.type`, plugin interface), not scattered `if (rule.id === ...)` exceptions.
- Every non-trivial declarative format must be **versioned**, and you must support migration (or multi-version readers) explicitly.
- Every evaluation should be traceable: which rule matched, which conditions passed/failed, and which effects were produced.
- Rule/config changes must go through **the same discipline as code**: version control, review, validation, automated tests, and controlled promotion.
- Do expensive work once: parse, validate, normalize, compile into a fast internal representation. Evaluate using compiled artifacts.
- Only push logic into data when there is real, recurring variability or multi-tenant/product configurability. Otherwise, keep the logic imperative and explicit.

## Exceptions and judgment

- Apply selectively (DOL-12): recurring policy variability or configurability justifies tables/registries. A single branch, fixed algorithm, or low-variance code does not justify a DSL.
- Preserve ordering, short-circuiting, side effects, error paths and type safety when suggesting a table or reducer. A switch is valid when it is clearer.
- Versioning, audit traces, compilation and extension registries apply to non-trivial declarative systems, not every lookup object.
- Do not suggest replacing imperative code merely because a data-driven representation is possible. Name the recurring variability or duplication it resolves.

## Findings

Report concrete violations with code anchors and a precise suggested fix. Do not flag
pre-existing code or require project-wide tooling changes for an unrelated task.
