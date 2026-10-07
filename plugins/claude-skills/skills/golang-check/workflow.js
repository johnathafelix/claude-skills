export const meta = {
  "name": "golang-check",
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
  "language": "Go",
  "agentType": "claude-skills:go-idiom-checker",
  "groups": {
    "correctness": [
      "errors",
      "concurrency",
      "gotchas"
    ],
    "api": [
      "type-design",
      "functions-and-signatures"
    ],
    "conventions": [
      "naming",
      "declarations",
      "structure",
      "doc-comments",
      "data-over-logic",
      "modernizers"
    ],
    "testing": [
      "testing"
    ]
  },
  "go": true,
  "perGuidelineFiles": true
})
