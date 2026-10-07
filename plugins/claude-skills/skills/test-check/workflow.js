export const meta = {
  "name": "test-check",
  "description": "Grouped read-only checks with bounded retries",
  "phases": [
    {
      "title": "Check"
    },
    {
      "title": "Verify"
    }
  ]
}

const GUIDELINE_META = null

// GROUPED_CHECK_RUNTIME

return await runGroupedChecks({
  "language": "test quality",
  "agentType": "claude-skills:test-checker",
  "groups": {
    "behavior": [
      "coverage",
      "db-integration"
    ],
    "assertions": [
      "assertion-fidelity",
      "assertion-strictness",
      "mock-expectations"
    ]
  },
  "test": true
})
