# Scoped Jest coverage

Use an object CommonJS Jest config (`.js`/`.cjs`) and the existing Jest runner, preserving
project setup, transforms and teardown. For other config formats/runners use their
normal bounded command with --expected-sources; do not strip integration setup.

Write a plan outside the repo. Paths are relative to the pinned repository:

```json
{
  "runner": ["yarn", "jest", "--runInBand", "--no-watchman"],
  "config": "packages/service/jest.config.js",
  "sourceFiles": ["packages/service/src/client.ts", "packages/service/src/guard.ts"],
  "testFiles": ["packages/service/test/client.test.ts"]
}
```

Runner is the command that accepts Jest arguments, not a shell string. If it needs a
build step, use a tracked verification command first. Every source/test must belong to
the supplied workspace; use a separate plan per workspace. Include every executable
source in the review scope, including callers whose changed behavior is being reviewed.

```bash
python3 "<review-pr>/scripts/coverage.py" --repo "<pinned repo>" --cwd "<workspace>" \
  --out "<artifacts>/coverage" --report "<artifacts>/coverage/coverage-final.json" \
  --jest-plan "<artifacts>/jest-plan.json"
```

Launch once as a tracked background command. The helper generates collectCoverageFrom
as a config array and runs exact test paths; no variable-length CLI source parsing.
Read result.json after completion. Success requires report entries for every expected
source; zero hits remain measurable uncovered code. Missing entries are a scope gap,
not a clean result, and are never cached. The output directory is locked against a
duplicate run. Status names the current phase and its timeout; await task notifications
instead of looping over pgrep. Private-registry/network failure ends this attempt.
