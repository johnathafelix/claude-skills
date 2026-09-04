---
name: simplify-code
description: Simplify source code for clarity, consistency, and maintainability while preserving all functionality — removes needless complexity, redundant variables, and inconsistent style. Use PROACTIVELY before finishing a nontrivial code change or opening a PR — pass the files you changed. Skip it for a trivial one-line edit. Also use whenever the user asks to simplify, clean up, or refactor code for readability, or invokes /simplify-code.
model: sonnet
---

# Simplify Code

Dispatch the `code-simplifier:code-simplifier` subagent to review and simplify
source code, preserving all functionality.

## Workflow

1. **Determine scope**:
   - If the user named files or directories, use those.
   - Else if you were invoked right after writing/editing files this turn, use those files.
   - Else determine the base branch (`gh pr view --json baseRefName --jq '.baseRefName'`,
     falling back to `main`) and use `git diff origin/<base> --name-only --diff-filter=ACM`.

   If the scope is empty, report there is nothing to simplify and stop.

2. **Dispatch.** Launch the `code-simplifier:code-simplifier` subagent (via the `Agent`
   tool) with the exact file list from Step 1 and the instruction to preserve all
   functionality and not expand scope beyond that list.

3. **Report** its findings/diff summary to the user.
