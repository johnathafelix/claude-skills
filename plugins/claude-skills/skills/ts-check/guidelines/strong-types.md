# The Stronger the Types, the Weaker the Bugs

Check changed code only. Read the following checklist in full. Extended examples and
trade-offs (consult only when ambiguous): `../references/strong-types.md`

## Checklist

- Treat `any` as a controlled exception. Enforce that new `any` cannot enter the codebase unnoticed by using both TypeScript compiler checks and type-aware ESLint rules.
- Whenever data comes from outside the type system -- JSON parsing, network responses, environment variables, localStorage, untyped code -- type it as `unknown` at the boundary, then narrow/validate it into a trusted domain type.
- If a function/class is meant to work for "any type," it should be **generic**, not typed with `any`. Generics preserve the caller's type information instead of collapsing to "unchecked."
- Replace "bag of `any`" event/state/response objects with discriminated unions (tagged unions) that TypeScript can narrow automatically, and add exhaustiveness checks to prevent unhandled cases.
- When you truly have dynamic keys, type them explicitly (keys and values). Avoid `any` values in maps/records; prefer `Record<string, unknown>` at the boundary or `Record<K, V>` with specific types. Use strict index-access options to prevent unsafe assumptions.
- If an exported named type already describes the shape you need, use it directly. Do not reach into a container type with an indexed-access query like `Container['field']` just to recover the element type of a field.
- Type assertions should be a last resort; they don't add runtime checks. Prefer constructs that preserve inference while checking compatibility (`satisfies`), or perform runtime checks and then narrow types (assertion functions / type guards).
- Replace `Function`, `(...args: any[]) => any`, and callback args typed as `any` with explicit call signatures (or carefully constrained generics).
- Treat thrown/rejected values as unknown. Narrow them before accessing properties like `.message`.
- When a dependency lacks typings or provides weak typings, don't compensate by using `any` everywhere. Introduce a typed boundary: local module declarations, wrapper layer, or contribute/fix types.
- Use built-in utility types (`Pick`, `Omit`, `Partial`, `Record`, `ReturnType`, `Awaited`, etc.) and -- when necessary -- mapped/conditional types to derive types rather than falling back to `any` for "type transformations." But keep type-level complexity readable.

## Exceptions and judgment

- Prefer the actual domain type when known; use `unknown` plus validation for genuinely untrusted data. A cast is not runtime validation.
- Avoid blind `any` → `unknown` replacements followed by double casts. Single `as T` can bridge safe inference limits; double casts are a documented last resort after restructuring fails.
- Isolated, documented, temporary `any` may be justified during migration, for missing dependency types, partial test mocks, or type-system limitations. Prefer a wrapper boundary; honor justified suppressions.
- Keep type transformations readable; do not replace a simple type with unnecessary generics or conditional types.

## Findings

Report concrete violations with code anchors and a precise suggested fix. Do not flag
pre-existing code or require project-wide tooling changes for an unrelated task.
