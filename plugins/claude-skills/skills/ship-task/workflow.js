export const meta = {
  name: 'ship-task-review',
  description: 'xhigh/opus code review: one finder per dimension, adversarial verification per finding',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

// This script exists for exactly one reason: `effort` (xhigh) is only settable on this
// hook's agent() calls — the Agent tool has `model` but no `effort`, and the built-in
// /code-review workflow has no effort override either. Every agent() call below pins
// both explicitly; that pin is the entire point of not using the built-in reviewer.
const MODEL = 'opus'
const EFFORT = 'xhigh'

// Verifiers run one per finding, adversarially, at opus+xhigh — the most expensive
// agents in this pipeline. Finders are unbounded (report what you find), so without a
// cap here, 5 finders returning 8 findings each is 45 opus/xhigh agents from a single
// /ship-task run. Cap the total across all dimensions combined and log what's dropped
// — silent truncation would read as "verified everything" when it didn't.
const MAX_VERIFIERS = 10

// Verified empirically in an earlier session (see project memory): `args` has arrived
// as a JSON-encoded STRING even when passed as a genuine object literal at the call
// site. Parse defensively regardless of what the tool docs say the shape should be.
let parsedArgs

if (typeof args === 'string') {
  try {
    parsedArgs = JSON.parse(args)
  } catch (e) {
    throw new Error(
      `ship-task-review workflow could not parse its args string as JSON — ${(e && e.message) || e}; ` +
        `first 200 chars: ${args.slice(0, 200)}`,
    )
  }
} else {
  parsedArgs = args
}

if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
  throw new Error(
    `ship-task-review workflow received args of type ${Array.isArray(parsedArgs) ? 'array' : typeof parsedArgs} — ` +
      'expected an object with { files, baseBranch, changeNote, planPath }',
  )
}

// An empty files list is never legitimate here — the skill's own preflight already
// stops on an empty diff. Fail loud rather than silently reviewing nothing and letting
// the caller read that as a clean pass.
const files = parsedArgs.files

if (!Array.isArray(files) || files.length === 0) {
  throw new Error('ship-task-review workflow received no target files — verify the skill body passed a non-empty diff')
}

const baseBranch = typeof parsedArgs.baseBranch === 'string' && parsedArgs.baseBranch.trim() ? parsedArgs.baseBranch.trim() : 'main'
const changeNote = typeof parsedArgs.changeNote === 'string' ? parsedArgs.changeNote : ''
const planPath = typeof parsedArgs.planPath === 'string' ? parsedArgs.planPath : ''

// One-off, 5-dimension review — inline, not a guidelines/ directory. Unlike ts-check /
// golang-check this isn't an extensible rule set someone adds to over time; YAGNI.
const DIMENSIONS = [
  {
    key: 'correctness',
    label: 'correctness & bugs',
    prompt: 'Look for logic errors, off-by-one mistakes, wrong conditionals, broken assumptions between functions, and edge cases the code does not handle.',
  },
  {
    key: 'error-handling',
    label: 'error handling & silent failures',
    prompt: 'Look for swallowed errors, empty catch blocks, inappropriate fallback values that mask real failures, and error paths that log but do not actually handle the problem.',
  },
  {
    key: 'security',
    label: 'security',
    prompt: 'Look for injection risks, unsafe deserialization, secrets or credentials committed in plaintext, missing authorization checks, and unsafe use of user input.',
  },
  {
    key: 'tests',
    label: 'tests & coverage',
    prompt: 'Look for missing tests on new behavior, tests that do not actually assert the behavior they claim to, and edge cases the plan calls for that have no corresponding test.',
  },
  {
    key: 'cleanup',
    label: 'cleanup & simplification',
    prompt: 'Look for dead code, needless duplication, over-engineered abstractions for single-use code, and code that could be meaningfully simpler without losing functionality.',
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'description', 'suggestedFix'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          description: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

function findPrompt(dim) {
  return `Review the diff between the current branch and origin/${baseBranch} for exactly ONE dimension: ${dim.label}.

Files changed:
${files.map(f => `- ${f}`).join('\n')}

What changed: ${changeNote || 'no change note provided — review the files as given'}
${planPath ? `\nThe implementation plan is at (read it for intended behavior): ${planPath}` : ''}

Focus: ${dim.prompt}

Rules:
- Look ONLY at this dimension. Do not report findings that belong to a different dimension (e.g. do not flag style nitpicks here if your dimension is security).
- Read the actual diff (\`git diff origin/${baseBranch}\` or per-file diffs) before reporting anything — do not guess from filenames.
- Report only findings you are confident about; prefer silence over a shaky flag. These findings feed an auto-approved fix plan with no human review of the findings list itself, so a false positive becomes a wasted fix cycle.
- \`line\` is the 1-based line number in the file as it exists now on this branch.
- \`suggestedFix\` must quote enough surrounding code (before -> after) that the fix can be located without relying on the line number alone.

Return {"findings": []} if you find nothing for this dimension — an empty array is a valid, expected result, not a failure.`
}

function verifyPrompt(f, dim) {
  return `Try to REFUTE this code-review finding. Default to refuted: true if you are not certain it is real.

Dimension: ${dim.label}
File: ${f.file}
Line: ${f.line}
Claim: ${f.description}
Suggested fix: ${f.suggestedFix}

Read the actual file content at that location before judging. Refute (refuted: true) if: the code does not actually do what the claim says, the "bug" is intentional/already handled elsewhere, the line number does not correspond to the described code, or the fix would not actually change behavior. Confirm (refuted: false) only if you independently verified the problem exists as described.`
}

phase('Find')

// Claimed synchronously (no await between check and increment) by the verify stage
// below, across whichever dimensions happen to be running concurrently in the
// pipeline — JS is single-threaded, so this is race-free without a lock.
let verifiersClaimed = 0

const reviewed = await pipeline(
  DIMENSIONS,
  dim =>
    agent(findPrompt(dim), {
      label: `find:${dim.key}`,
      phase: 'Find',
      model: MODEL,
      effort: EFFORT,
      schema: FINDINGS_SCHEMA,
    }),
  (result, dim) => {
    // agent() returns null only on user-skip or a terminal API error the harness
    // already retried — not on "found nothing." Treat null as unverified for this
    // dimension rather than silently treating it as a clean pass.
    if (result === null || result === undefined) {
      log(`${dim.key}: UNVERIFIED — agent returned no result (user skip or terminal API error)`)
      return { dim, findings: [], unverified: true }
    }

    if (!Array.isArray(result.findings)) {
      log(`${dim.key}: UNVERIFIED — result had no findings array`)
      return { dim, findings: [], unverified: true }
    }

    return { dim, findings: result.findings, unverified: false }
  },
  ({ dim, findings, unverified }) => {
    if (unverified || findings.length === 0) return { dim, confirmed: [], unverified }

    // Claim from the shared cross-dimension budget synchronously (no await yet), so
    // two dimensions racing through this stage at once cannot both see room and
    // together blow past MAX_VERIFIERS.
    const toVerify = []
    const dropped = []

    for (const f of findings) {
      if (verifiersClaimed < MAX_VERIFIERS) {
        verifiersClaimed++
        toVerify.push(f)
      } else {
        dropped.push(f)
      }
    }

    if (dropped.length > 0) {
      log(
        `${dim.key}: verifier budget exhausted (cap ${MAX_VERIFIERS} shared across all dimensions) — ` +
          `${dropped.length} finding(s) NOT verified and dropped: ${dropped.map(f => `${f.file}:${f.line}`).join(', ')}`,
      )
    }

    if (toVerify.length === 0) return { dim, confirmed: [], unverified: false }

    // Every fresh finding verified concurrently by an independent adversarial pass —
    // this stage runs for dimension A while dimension B may still be in the Find
    // stage above (pipeline, not parallel+barrier): no cross-dimension dependency
    // justifies waiting for all 5 finders before verification starts.
    return parallel(
      toVerify.map(f => () =>
        agent(verifyPrompt(f, dim), {
          label: `verify:${dim.key}:${f.file}:${f.line}`,
          phase: 'Verify',
          model: MODEL,
          effort: EFFORT,
          schema: VERDICT_SCHEMA,
        }).then(v => ({ f, verdict: v })),
      ),
    ).then(verdicts => {
      const confirmed = []

      // Index-paired with toVerify rather than reading verdicts[i].f: parallel()
      // resolves a thrown thunk to `null` in place, so `entry` can be null here even
      // though toVerify[i] is always the real finding.
      for (let i = 0; i < verdicts.length; i++) {
        const entry = verdicts[i]
        const f = toVerify[i]

        // A verifier that returned null (user-skip or terminal API error) or threw
        // is NOT the same as "refuted" — treating it as refuted would silently
        // delete a real finding with no trace. Log it and drop it from BOTH lists
        // instead of auto-confirming or auto-refuting a claim nobody actually judged.
        if (!entry || !entry.verdict) {
          log(`${dim.key}: verifier for ${f.file}:${f.line} returned no result (user skip or terminal API error) — dropped, not auto-confirmed or auto-refuted`)

          continue
        }

        if (entry.verdict.refuted === false) confirmed.push({ ...f, dimension: dim.key })
      }

      return { dim, confirmed, unverified: false }
    })
  },
)

const findings = []
const dimensionsUnverified = []

// Index-paired with DIMENSIONS rather than iterating `reviewed` directly: a stage
// that throws drops that pipeline item to `null` (per the Workflow contract), and
// without the index we'd lose which dimension vanished — it would disappear from
// both `findings` and `dimensionsUnverified` with no trace at all.
for (let i = 0; i < DIMENSIONS.length; i++) {
  const dim = DIMENSIONS[i]
  const r = reviewed[i]

  if (!r) {
    log(`${dim.key}: UNVERIFIED — pipeline stage threw for this dimension`)
    dimensionsUnverified.push(dim.key)

    continue
  }

  if (r.unverified) {
    dimensionsUnverified.push(dim.key)

    continue
  }

  for (const f of r.confirmed) findings.push(f)
}

findings.sort((a, b) => {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  return a.line - b.line
})

return {
  findings,
  findingCount: findings.length,
  dimensionsUnverified: dimensionsUnverified.sort(),
}
