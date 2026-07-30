export const meta = {
  name: 'golang-check',
  description: 'Check Go files against golang-check guidelines, one read-only agent per guideline',
  phases: [{ title: 'Check', detail: 'one read-only agent per guideline, capped at 4 concurrent' }],
}

// Empirically derived (see golang-check/SKILL.md): fanning out all guidelines at
// once produced malformed sub-agent responses, some misreported as prompt
// injection. Capping at 4 concurrent fixed it. Raise only with evidence.
const CONCURRENCY = 4

const RETRIES = 2

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings', 'guidelineLineCount'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'symbol', 'rule', 'severity', 'confidence', 'description', 'suggestedFix'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          symbol: { type: 'string' },
          rule: { type: 'string' },
          severity: { type: 'string', enum: ['error', 'warning', 'info'] },
          confidence: { type: 'string', enum: ['high', 'medium'] },
          description: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
      },
    },
    // Proof-of-read: must be obtained by running `wc -l` on the guideline file,
    // never by the agent counting lines itself (LLMs are unreliable at that even
    // right after reading the content — verified empirically during planning).
    guidelineLineCount: { type: 'integer' },
  },
}

function prompt(g, changeNote) {
  return `Apply exactly ONE Go guideline to the files listed below. Nothing else.

Guideline file (read this IN FULL, absolute path): ${g.path}

Target files in scope for this guideline:
${g.files.map(f => `- ${f}`).join('\n')}

What changed: ${changeNote || 'no change note provided — review the files as given'}

Rules:
- Apply ONLY the guideline named above. Focus on the changed lines described; do not flag pre-existing, unrelated code.
- If the guideline cites an extended-examples file as "../references/<name>.md", that path is relative to the guideline file — resolve it against the absolute path above, not against the repo root or your working directory.
- Report only findings you are confident about; prefer silence over a shaky flag.
- Use "${g.stem}" as the rule value on every finding.

Proof-of-read (required — do not skip this):
Run \`wc -l ${g.path}\` via Bash and report the integer from its stdout as guidelineLineCount.
Do NOT count lines yourself by reading the file — run the command and report exactly the number it prints (not the filename, not the padding).`
}

async function check(g, changeNote) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const r = await agent(prompt(g, changeNote), {
      label: `check:${g.stem}${attempt ? `:retry${attempt}` : ''}`,
      phase: 'Check',
      schema: FINDINGS_SCHEMA,
      agentType: 'claude-skills:go-idiom-checker',
    })

    if (r && r.guidelineLineCount === g.lines) return r

    log(`${g.stem}: proof-of-read mismatch on attempt ${attempt + 1}/${RETRIES + 1}`)
  }

  log(`${g.stem}: UNVERIFIED after ${RETRIES + 1} attempts`)

  return null
}

// Worker pool, not chunked parallel() batches: a fixed number of lanes each pull
// the next guideline as they free up, so a slow guideline never blocks an idle
// lane the way a chunk-of-4 barrier would. Retries run inside a lane, so
// in-flight agents never exceed CONCURRENCY even while retrying.
async function pool(items, worker) {
  const results = new Array(items.length)
  let next = 0

  async function lane() {
    while (next < items.length) {
      const i = next++

      try {
        results[i] = await worker(items[i])
      } catch {
        results[i] = null
      }
    }
  }

  await parallel(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => lane))

  return results
}

phase('Check')

// Some callers/harnesses deliver `args` JSON-encoded as a string instead of the
// documented object (verified empirically: the same object literal, passed the
// documented way, still arrived here as a string). Parse defensively rather than
// trust the caller.
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args

// An empty/missing guidelines list is never legitimate here — Step 1 of SKILL.md
// already stops on an empty file list, and Step 2 always emits at least one
// guideline or the skill has already bailed. Fail loud rather than silently
// checking nothing and letting the caller report a false "clean" result.
const guidelines = parsedArgs.guidelines
if (!Array.isArray(guidelines) || guidelines.length === 0) {
  throw new Error('golang-check workflow received no guidelines to check — verify the Step 2 args payload')
}

const changeNote = parsedArgs.changeNote

const results = await pool(guidelines, g => check(g, changeNote))

const findings = []
const unverified = []

for (let i = 0; i < guidelines.length; i++) {
  const r = results[i]

  if (r) {
    findings.push(...r.findings)
  } else {
    unverified.push(guidelines[i].stem)
  }
}

findings.sort((a, b) => {
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  return a.line - b.line
})

return { findings, unverified: unverified.sort() }
