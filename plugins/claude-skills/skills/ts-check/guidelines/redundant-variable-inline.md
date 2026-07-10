# Redundant Variable Inlining

**Rule: Inline variables that are declared and immediately returned.**

When a local variable is declared and its only use is the very next `return` statement (no reads, no re-assignments, no further references), inline it into the `return`.

Examples:

```ts
// ❌ Redundant binding
const exportedWorkflow = await this.buildExportWorkflow(workflowId);
return exportedWorkflow;

// ✅ Inlined
return await this.buildExportWorkflow(workflowId);
```

```ts
// ❌ Redundant binding
const result = computeThing(input);
return result;

// ✅ Inlined
return computeThing(input);
```

**Do NOT inline when:**
- The variable is referenced anywhere else (logged, passed to another call, used in a `finally`, etc.).
- The variable has an explicit type annotation that is load-bearing for readability or type-narrowing (e.g., `const x: SpecificType = ...; return x;` where removing the annotation would lose information). In that case, keep the binding.
- The declaration and return are separated by other statements that could change meaning if reordered.
- Inlining would harm debuggability in a way the author clearly intended (e.g., a name that documents intent for a complex expression). Prefer inlining unless the name adds real value beyond the function name itself.

**Return findings as:** `{ file, line, rule: 'redundant-variable-inline', description, suggestedFix }` where `suggestedFix` shows the inlined `return` statement.
