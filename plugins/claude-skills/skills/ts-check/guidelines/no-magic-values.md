# Avoid Magic Values — Use Strongly Typed Constants, Registries, and Types

Check changed code only. Read the following checklist in full. Extended examples and
trade-offs (consult only when ambiguous): `../references/no-magic-values.md`

## Checklist

- Any literal encoding policy (limits, thresholds, default timeouts, base probabilities) or repeated more than once should be a named constant.
- Families of related string/number tokens (HTTP headers, event names, error codes, CSS class names) should be grouped into a registry object. `as const` prevents widening and makes object properties readonly.
- Inputs representing a finite set (status, role, plan type, currency code subset) should use literal unions derived from registries, not bare `string`.
- "If X then Y" rules where X is from a finite set should use a lookup table. Pair with `satisfies` for complete coverage checks.
- Replace "bag of `any`" variant objects with discriminated unions using a shared literal property (e.g., `kind`, `type`) and enforce exhaustiveness with `never`.
- Use enums when values must exist at runtime for iteration, reverse mapping, or consumption by non-TypeScript code. Prefer string enums for readable runtime values (numeric enums can be opaque). Avoid `const enum` (toolchain pitfalls with single-file transpilers).
- Use `satisfies` to ensure "complete and only" keys in central maps/config while preserving precise literals. Catches misspelled keys and missing entries at compile time.
- Values used in multiple modules or across layers (timeouts, retry policy, API endpoints, feature toggles) should live in a central typed config module, not scattered as literals.
- Base URLs, credentials, region settings, environment mode, and tunables that differ between dev/stage/prod should be parsed from environment variables into types at startup. Follows the Twelve-Factor App methodology.
- Repeated arithmetic like `60 * 60 * 1000` should use semantic helper functions to make intent explicit.
- When mixing values would be costly (currency, milliseconds vs seconds) or you need invariants (non-empty IDs, positive money), use branded types with constructor validation.
- Strings with a structure (resource paths, "prefix:suffix" keys, message IDs, versioned routes) should use template literal types to make them compile-time checked.
- User-facing text and translation keys used in multiple places should use a typed key registry instead of bare strings.
- Values that must match an external spec exactly (HTTP methods, OAuth grant types, webhook event names) should be centrally defined with literal unions or enums.
- Code that hard-codes endpoints, credentials, filesystem paths, "real" clients, or clock/randomness should inject those dependencies instead.
- Gradual rollouts, A/B tests, kill switches, and risky features should use feature flags, not hard-coded booleans or "temporary switches."
- Enable `@typescript-eslint/no-magic-numbers` (extends core ESLint rule with TypeScript-specific support for enum members, numeric literal types, readonly class properties). Add tests for mappings/registries so additions are deliberate.

## Exceptions and judgment

- Do not extract every incidental literal: ordinary indices, 0/1/-1, obvious local values and one-off text need no registry merely because they are literals.
- A literal union or `as const` object may provide runtime values without an enum. Use the simplest representation that meets the actual consumers' needs.
- Centralize genuine shared policy and environment differences; avoid a global configuration layer or dependency injection solely to remove one harmless literal.
- Branded types, flags, i18n registries and schema tooling apply where the domain needs them. Give concrete evidence of mixed units, repeated policy or missing validation.

## Findings

Report concrete violations with code anchors and a precise suggested fix. Do not flag
pre-existing code or require project-wide tooling changes for an unrelated task.
