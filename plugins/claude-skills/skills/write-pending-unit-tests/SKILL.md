---
name: write-pending-unit-tests
description: Write unit tests for files changed on the current branch compared to the PR base branch (or main). Uses existing tests as style reference and aims for 100% coverage.
---

Follow these steps precisely:

## 1. Determine the base branch

Before comparing changes, determine the correct base branch to diff against:

1. Check if a PR exists for the current branch: `gh pr view --json baseRefName --jq '.baseRefName'`
2. If a PR exists, use the returned base branch name (e.g. `develop`, `feature/parent`, etc.)
3. If no PR exists (command fails), fall back to `main`

Store the result as `BASE_BRANCH` and use `origin/$BASE_BRANCH` for all subsequent diff/log commands.

## 2. Identify changed files

Run `git fetch origin $BASE_BRANCH` first to ensure we have the latest remote base, then run `git diff origin/$BASE_BRANCH --name-only --diff-filter=ACM` to get the list of files that were added, changed, or modified on this branch compared to the base branch. Filter out test files themselves — you only care about source files.

## 3. Study existing test style

Before writing any tests, find existing test files in the repository and read several of them. Pay close attention to:
- Test framework and assertion library used
- File naming conventions (e.g. `*.test.ts`, `*.spec.ts`, `*_test.go`)
- Directory structure (co-located vs separate `__tests__` folder)
- Setup/teardown patterns
- Mocking patterns and preferred mocking libraries
- How fixtures and test data are organized
- Import style and conventions

Match this style exactly in the tests you write.

## 4. Write unit tests

For each changed/added source file, write unit tests aiming for 100% code coverage. Rules:
- If a line requires excessive mocking or setup that makes the test overly complex, skip covering that line — pragmatism over dogma.
- Keep comments at a bare minimum. Only add a comment when it is genuinely required to understand what the code is doing. Do not add comments that merely restate the code.
- Follow the existing test style and patterns you observed in step 3.

## 5. Run all tests and fix failures

After writing your tests, run the **full test suite** (not just the new test files). For any failures:
- If a test is failing because of an **intended change** in the source code (i.e. the source behavior was deliberately changed on this branch), update the test to match the new expected behavior.
- Otherwise, assume the existing tests are correct and fix the source code instead.
- If you're unsure whether a failure is due to an intended change or a bug, ask the user before making changes.

Repeat this fix-and-rerun loop up to **5 iterations**. If failures remain after 5 iterations, stop immediately and report:
- The number of iterations attempted
- Each still-failing test: test file path, test name, and the failure reason/error message
- A brief diagnosis of why the failures could not be resolved

Do not attempt further fixes beyond iteration 5.
