export const meta = {
  "name": "ts-check",
  "description": "Grouped read-only checks with bounded retries",
  "phases": [
    {
      "title": "Check"
    }
  ]
}

const GUIDELINE_META = null

// GROUPED_CHECK_RUNTIME

return await runGroupedChecks({
  "language": "TypeScript",
  "agentType": "claude-skills:ts-quality-checker",
  "groups": {
    "types": [
      "strong-types",
      "object-params"
    ],
    "clarity": [
      "no-magic-values",
      "data-over-logic",
      "redundant-variable-inline"
    ]
  },
  "priority": [
    "strong-types",
    "no-magic-values",
    "data-over-logic",
    "object-params",
    "redundant-variable-inline"
  ]
})
