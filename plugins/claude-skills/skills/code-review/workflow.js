export const meta = {
  name: 'code-review',
  description: 'opus code review: one finder per angle, adversarial verification per finding, then a gap sweep',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Sweep' }],
}

// Shared by /claude-skills:code-review, /ship-task and /address-pr-review-comments.
// Why not the built-in /code-review: a pipeline cannot invoke a slash command, and the
// Agent tool has `model` but no `effort`. Only agent() calls in a Workflow can pin both,
// so every call below does. Angles and sweep are adapted from the built-in's max recipe.
const MODEL = 'opus'
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// Verified empirically in an earlier session (see project memory): `args` has arrived
// as a JSON-encoded STRING even when passed as a genuine object literal at the call
// site. Parse defensively regardless of what the tool docs say the shape should be.
let parsedArgs

if (typeof args === 'string') {
  try {
    parsedArgs = JSON.parse(args)
  } catch (e) {
    throw new Error(
      `code-review workflow could not parse its args string as JSON — ${(e && e.message) || e}; ` +
        `first 200 chars: ${args.slice(0, 200)}`,
    )
  }
} else {
  parsedArgs = args
}

if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
  throw new Error(
    `code-review workflow received args of type ${Array.isArray(parsedArgs) ? 'array' : typeof parsedArgs} — ` +
      'expected an object with { files, baseBranch, changeNote, planPath }',
  )
}

// An empty files list is never legitimate here — the skill's own preflight already
// stops on an empty diff. Fail loud rather than silently reviewing nothing and letting
// the caller read that as a clean pass.
const files = parsedArgs.files

if (!Array.isArray(files) || files.length === 0) {
  throw new Error('code-review workflow received no target files — verify the skill body passed a non-empty diff')
}

const baseBranch = typeof parsedArgs.baseBranch === 'string' && parsedArgs.baseBranch.trim() ? parsedArgs.baseBranch.trim() : 'main'
const changeNote = typeof parsedArgs.changeNote === 'string' ? parsedArgs.changeNote : ''
const planPath = typeof parsedArgs.planPath === 'string' ? parsedArgs.planPath : ''

// Fail loud on a typo rather than silently reviewing at the wrong level.
const EFFORT = parsedArgs.effort === undefined ? 'high' : parsedArgs.effort

if (!EFFORT_LEVELS.includes(EFFORT)) {
  throw new Error(`code-review workflow received effort ${JSON.stringify(EFFORT)} — expected one of ${EFFORT_LEVELS.join(', ')}`)
}

// Set only when reviewing a checkout other than the session's working directory (a PR worktree).
const repoDir = typeof parsedArgs.repoDir === 'string' ? parsedArgs.repoDir.trim() : ''

// Set by review-pr to verify findings from other checkers (golang-check, ts-check): skips
// the finders and the sweep, and runs only the adversarial verifier on these.
const verifyOnly = Array.isArray(parsedArgs.verifyOnly) ? parsedArgs.verifyOnly : null
const diffCommand = typeof parsedArgs.diffCommand === 'string' && parsedArgs.diffCommand.trim() ? parsedArgs.diffCommand.trim() : `git diff origin/${baseBranch}`

// Inline, not a guidelines/ directory — this isn't an extensible rule set; YAGNI.
// `kind: 'bug'` findings state a concrete failure; `kind: 'cost'` ones state a concrete cost.
const DIMENSIONS = [
  {
    key: 'line-scan',
    label: 'line-by-line diff scan',
    kind: 'bug',
    prompt: 'Read every hunk line by line, then read the enclosing function of each hunk — bugs in unchanged lines of a touched function are in scope (the change re-exposes or fails to fix them). For every line ask: what input, state, timing, or platform makes this line wrong? Look for inverted or wrong conditions, off-by-one, null/undefined dereference, missing `await`, falsy-zero checks, wrong-variable copy-paste, and unescaped regex metacharacters.',
  },
  {
    key: 'removed-behavior',
    label: 'removed behavior',
    kind: 'bug',
    prompt: 'For every line the diff deletes or replaces, name the invariant or behavior it enforced, then search the new code for where that invariant is re-established. If you cannot find it, that is a finding: a removed guard, a dropped error path, a narrowed validation, a deleted test that covered a real case.',
  },
  {
    key: 'cross-file',
    label: 'cross-file callers and callees',
    kind: 'bug',
    prompt: 'For each function the diff changes, find its callers (Grep for the symbol) and check whether the change breaks any call site: a new precondition, a changed return shape, a new exception, a timing or ordering dependency. Also check callees: does a parallel change in the same diff make a call unsafe?',
  },
  {
    key: 'language-pitfalls',
    label: 'language and framework pitfalls',
    kind: 'bug',
    prompt: 'Scan for the classic pitfalls of the diff\'s language and framework — for example JS falsy-zero, `==` coercion, closure-captured loop variables; Python mutable default args, late-binding closures; Go nil-map writes, range-variable capture; SQL injection; timezone/DST drift; float equality. Flag any instance the diff introduces.',
  },
  {
    key: 'wrapper-proxy',
    label: 'wrapper and proxy correctness',
    kind: 'bug',
    prompt: 'When the diff adds or modifies a type that wraps another (cache, proxy, decorator, adapter), check that every method routes to the wrapped instance and not back through a registry, session, or global — e.g. a caching provider holding a `delegate` field that resolves IDs via `session.get(...)` instead of `delegate.get(...)` re-enters the cache or recurses. Also check that the wrapper forwards every method its callers actually use. Return nothing if the diff touches no wrapper.',
  },
  {
    key: 'error-handling',
    label: 'error handling & silent failures',
    kind: 'bug',
    prompt: 'Look for swallowed errors, empty catch blocks, inappropriate fallback values that mask real failures, and error paths that log but do not actually handle the problem. For each catch / `if err != nil` / recover the diff adds or changes, name the concrete errors it could hide. Also flag: `?.` / `??` / `_ =` / an ignored `err` that silently skips work which can fail; retries that exhaust without surfacing the failure; fallback chains with no stated reason; a fallback to a mock, stub, or fake outside test code; a catch that skips cleanup or resource release; an error handled locally that should propagate to the caller. A log line missing the context to act on it (which operation, which IDs) is a nit.',
  },
  {
    key: 'type-invariants',
    label: 'type invariants',
    kind: 'bug',
    prompt: 'For each type the diff adds or changes, name its invariants, then flag any constructor, exported/public field, or mutator that lets an invalid instance exist — internals exposed for mutation, no validation at construction, a mutator that skips a check another one enforces, an invariant that relies on every caller doing the right thing. State the concrete invalid state and how it is reached. Return nothing if the diff adds or changes no type.',
  },
  {
    key: 'security',
    label: 'security',
    kind: 'bug',
    prompt: 'Look for injection risks, unsafe deserialization, secrets or credentials committed in plaintext, missing authorization checks, and unsafe use of user input.',
  },
  {
    key: 'tests',
    label: 'tests & coverage',
    kind: 'cost',
    prompt: 'Judge behavioral coverage, not line coverage. Look for missing tests on new behavior, tests that do not actually assert the behavior they claim to, edge cases the plan calls for that have no corresponding test, untested error paths, missing negative cases for new validation, and untested concurrent or async behavior. A test so coupled to implementation details that a harmless refactor would break it is a nit. Severity: a missing test that could hide data loss, a security hole, or a failure is an issue; an edge case is a nit; below that, do not report.',
    refute: 'Refute a finding that asks for tests on trivial getters/setters or pass-through code, or whose scenario existing tests already cover (cite the test).',
  },
  {
    key: 'reuse',
    label: 'reuse',
    kind: 'cost',
    prompt: 'Flag new code that duplicates a helper the codebase already has — Grep shared/utility modules and files adjacent to the change, and name the existing helper to call instead.',
  },
  {
    key: 'simplification',
    label: 'simplification',
    kind: 'cost',
    prompt: 'Flag unnecessary complexity the diff adds: redundant or derivable state, copy-paste with slight variation, deep nesting, nested ternaries (prefer if/else or switch), dead code left behind, and code compacted so far it hurts clarity. Name the simpler form that does the same job.',
    refute: 'Refute a finding whose simpler form would remove a useful abstraction or merge concerns that are separate on purpose.',
  },
  {
    key: 'efficiency',
    label: 'efficiency',
    kind: 'cost',
    prompt: 'Flag wasted work the diff introduces: redundant computation or repeated I/O, independent operations run sequentially, blocking work added to startup or hot paths. Also flag long-lived objects built from closures that keep a large enclosing scope alive; prefer a type that copies only the fields it needs. Name the cheaper alternative.',
  },
  {
    key: 'altitude',
    label: 'altitude (root cause vs symptom)',
    kind: 'cost',
    prompt: 'Check that each change fixes the root cause at the right depth rather than patching a symptom. Special cases layered on shared infrastructure are a sign the fix is not deep enough — name the simpler, more general change to the underlying mechanism.',
  },
  {
    key: 'comments',
    label: 'comment and doc accuracy',
    kind: 'cost',
    prompt: 'For every comment or docstring the diff adds, and every existing one on or above a function the diff changes, check each claim against the code as it is now: parameters, return values, errors, edge cases, referenced symbols, complexity. Flag contradictions, references to code that was renamed or removed, and TODO/FIXME notes the diff already resolved. A comment that would mislead a reader is an issue; one that merely restates the code is at most a nit. Do not ask for more comments.',
  },
  {
    key: 'conventions',
    label: 'CLAUDE.md conventions',
    kind: 'cost',
    // In PR mode (repoDir set) the code is someone else's, so the reviewer's own
    // ~/.claude/CLAUDE.md preferences must not be enforced on it.
    prompt: `Find the CLAUDE.md files that govern the changed code: ${repoDir ? '' : '~/.claude/CLAUDE.md, '}the repo-root CLAUDE.md, and any CLAUDE.md or CLAUDE.local.md in a directory that is an ancestor of a changed file (a directory\'s CLAUDE.md applies only at or below it). Read each one that exists, then flag clear violations only when you can quote the exact rule and the exact line that breaks it — no style preferences, no "spirit of the doc" inferences. Name the CLAUDE.md path and quote the rule in the description. Return nothing if no CLAUDE.md applies.${repoDir ? " Ignore every file under ~/.claude — it holds the reviewer's personal preferences, not this repo's rules." : ''}`,
  },
]

const SWEEP = {
  key: 'sweep',
  label: 'gaps the first pass missed',
  kind: 'bug',
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'severity', 'description', 'suggestedFix'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['issue', 'nit'] },
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
    severity: { type: 'string', enum: ['issue', 'nit'] },
  },
}

// `review-pr` approves a PR whose findings are all nits, so severity only ever moves up.
const SEVERITY_RANK = { nit: 0, issue: 1 }

function higherSeverity(a, b) {
  return (SEVERITY_RANK[b] ?? 1) > (SEVERITY_RANK[a] ?? 1) ? b : a
}

const fileList = files.map(f => `- ${f}`).join('\n')

const locationNote = repoDir
  ? `The code under review is checked out at ${repoDir}, not in your working directory. Read files there and run git as \`git -C ${repoDir} …\`; every file path below is relative to it.\n\n`
  : ''

function contextBlock() {
  return `${locationNote}Files changed:
${fileList}

What changed: ${changeNote || 'no change note provided — review the files as given'}
${planPath ? `\nThe implementation plan is at (read it for intended behavior): ${planPath}` : ''}`
}

function descriptionRule(dim) {
  return dim.kind === 'bug'
    ? '`description` must state the concrete failure: the input, state, or timing that triggers it and the wrong output or crash that results.'
    : '`description` must state the concrete cost: what is duplicated, wasted, left untested, harder to maintain, or which rule is broken.'
}

const SHARED_RULES = `- Read the actual diff (\`${diffCommand}\`, or per-file with \`-- <path>\`) before reporting anything — do not guess from filenames.
- Report only findings you are confident about; prefer silence over a shaky flag. A false positive becomes a wasted fix cycle.
- \`line\` is the 1-based line number in the file as it exists now in the code under review.
- \`suggestedFix\` must quote enough surrounding code (before -> after) that the fix can be located without relying on the line number alone.
- \`severity\`: "issue" for wrong behavior, a crash, data loss, a security hole, a test gap that would let a regression through, a broken CLAUDE.md rule, or docs/comments that point readers at the wrong code. "nit" only when it has no effect on behavior or correctness — small duplication, naming, comment wording, a simpler equivalent form. When unsure, use "issue".`

function findPrompt(dim) {
  return `Review the change against origin/${baseBranch} for exactly ONE angle: ${dim.label}.

${contextBlock()}

Focus: ${dim.prompt}

Rules:
- Look ONLY at this angle. Do not report findings that belong to a different angle.
- ${descriptionRule(dim)}
${SHARED_RULES}

Return {"findings": []} if you find nothing for this angle — an empty array is a valid, expected result, not a failure.`
}

function sweepPrompt(confirmed) {
  const known = confirmed.length
    ? confirmed.map(f => `- ${f.file}:${f.line} [${f.dimension}] ${f.description}`).join('\n')
    : '- (none)'

  return `You are a fresh reviewer sweeping for gaps in a code review of the change against origin/${baseBranch}.

${contextBlock()}

Already confirmed by the first pass:
${known}

Re-read the diff and the enclosing functions looking ONLY for defects not already listed. Do not re-derive or re-confirm anything above — your job is gaps. Focus on what a first pass tends to miss: moved or extracted code that dropped a guard or anchor; second-tier footguns (a default evaluated once, \`hash()\` non-determinism, a lock scope that shrank, predicate methods with side effects); setup/teardown asymmetry in tests; config defaults flipped.

Rules:
- Report at most 8 findings, each a defect not already on the list.
- ${descriptionRule(SWEEP)}
${SHARED_RULES}

Return {"findings": []} if you find no gaps.`
}

function verifyPrompt(f, dim) {
  return `Try to REFUTE this code-review finding. Default to refuted: true if you are not certain it is real.

Angle: ${dim.label}
File: ${f.file}
Line: ${f.line}
Severity claimed: ${f.severity}
Claim: ${f.description}
Suggested fix: ${f.suggestedFix}

${locationNote}Read the actual file content at that location, and the diff (\`${diffCommand}\`), before judging.

Refute (refuted: true) if: the code does not do what the claim says (quote the actual line); the problem is provably impossible (show the type, constant, or invariant); it is already handled in this diff (cite the guard); the line number does not correspond to the described code; for an issue, the fix would not change behavior; for a nit, the stated cost (duplication, naming, wording) is not actually there.${dim.refute ? ` ${dim.refute}` : ''}

Do not refute merely because the trigger depends on runtime state when that state is realistic — concurrency races, nil/undefined on a rare but reachable path, falsy-zero treated as missing, an off-by-one on a boundary the code does not exclude, partial failures. Confirm (refuted: false) only if you independently verified the problem exists as described.

If you confirm a "nit" that actually affects behavior or correctness, set severity: "issue". Never downgrade an "issue" to a nit; omit severity to keep the claimed one.`
}

// Verifies every finding concurrently, one adversarial agent each, with no cap.
async function verifyAll(findings, dim) {
  if (findings.length === 0) return []

  const verdicts = await parallel(
    findings.map(f => () =>
      agent(verifyPrompt(f, dim), {
        label: `verify:${dim.key}:${f.file}:${f.line}`,
        phase: 'Verify',
        model: MODEL,
        effort: EFFORT,
        schema: VERDICT_SCHEMA,
      }),
    ),
  )

  const confirmed = []

  // Index-paired with `findings`: parallel() resolves a thrown thunk to `null` in place.
  for (let i = 0; i < verdicts.length; i++) {
    const verdict = verdicts[i]
    const f = findings[i]

    // A missing verdict is NOT a refutation — treating it as one would silently delete
    // a real finding. Log it and drop it from both lists instead of guessing.
    if (!verdict) {
      log(`${dim.key}: verifier for ${f.file}:${f.line} returned no result (user skip or terminal API error) — dropped, not auto-confirmed or auto-refuted`)

      continue
    }

    if (verdict.refuted === false) {
      confirmed.push({ ...f, severity: higherSeverity(f.severity, verdict.severity ?? f.severity), dimension: dim.key })
    }
  }

  return confirmed
}

// agent() returns null only on user-skip or a terminal API error the harness already
// retried — not on "found nothing." Treat null as unverified, never as a clean pass.
function readFindings(result, dim) {
  if (result === null || result === undefined) {
    log(`${dim.key}: UNVERIFIED — agent returned no result (user skip or terminal API error)`)

    return null
  }

  if (!Array.isArray(result.findings)) {
    log(`${dim.key}: UNVERIFIED — result had no findings array`)

    return null
  }

  return result.findings
}

const findings = []
const dimensionsUnverified = []

async function review() {
  phase('Find')

  // Pipeline, not parallel+barrier: each angle's findings verify while other angles are
  // still finding — no cross-angle dependency justifies waiting for all finders.
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
    async (result, dim) => {
      const found = readFindings(result, dim)

      if (found === null) return { confirmed: [], unverified: true }

      return { confirmed: await verifyAll(found, dim), unverified: false }
    },
  )

  // Index-paired with DIMENSIONS: a stage that throws drops that pipeline item to `null`,
  // and without the index we'd lose which angle vanished.
  for (let i = 0; i < DIMENSIONS.length; i++) {
    const dim = DIMENSIONS[i]
    const r = reviewed[i]

    if (!r) {
      log(`${dim.key}: UNVERIFIED — pipeline stage threw for this angle`)
      dimensionsUnverified.push(dim.key)

      continue
    }

    if (r.unverified) {
      dimensionsUnverified.push(dim.key)

      continue
    }

    for (const f of r.confirmed) findings.push(f)
  }

  phase('Sweep')

  // Runs after every angle so it can see the full confirmed list and hunt only for gaps.
  try {
    const sweepResult = await agent(sweepPrompt(findings), {
      label: 'find:sweep',
      phase: 'Sweep',
      model: MODEL,
      effort: EFFORT,
      schema: FINDINGS_SCHEMA,
    })

    const found = readFindings(sweepResult, SWEEP)

    if (found === null) {
      dimensionsUnverified.push(SWEEP.key)
    } else {
      for (const f of await verifyAll(found, SWEEP)) findings.push(f)
    }
  } catch (e) {
    log(`sweep: UNVERIFIED — ${(e && e.message) || e}`)
    dimensionsUnverified.push(SWEEP.key)
  }
}

// One verifier group per source dimension, so each verifier sees the checker's rule.
async function verifyGiven() {
  phase('Verify')

  const groups = new Map()

  for (const f of verifyOnly) {
    const key = typeof f.dimension === 'string' && f.dimension ? f.dimension : 'external'

    if (!groups.has(key)) {
      groups.set(key, { dim: { key, label: f.dimensionLabel || key }, items: [] })
    }

    groups.get(key).items.push({ ...f, severity: f.severity === 'nit' ? 'nit' : 'issue' })
  }

  const results = await parallel([...groups.values()].map(g => () => verifyAll(g.items, g.dim)))
  const keys = [...groups.keys()]

  for (let i = 0; i < results.length; i++) {
    if (!results[i]) {
      log(`${keys[i]}: UNVERIFIED — verification threw for this group`)
      dimensionsUnverified.push(keys[i])

      continue
    }

    for (const f of results[i]) findings.push(f)
  }
}

if (verifyOnly) {
  await verifyGiven()
} else {
  await review()
}

// Angles overlap (a stale doc pointer is both a line-scan and a conventions finding), so
// merge confirmed findings on the same file:line. Each angle's text is kept, since two
// angles can flag different defects on one line.
const merged = new Map()

for (const f of findings) {
  const key = `${f.file}:${f.line}`
  const first = merged.get(key)

  if (!first) {
    merged.set(key, { ...f })

    continue
  }

  first.dimension += `, ${f.dimension}`
  first.severity = higherSeverity(first.severity, f.severity)
  first.description += `\n\nAlso flagged by ${f.dimension}: ${f.description}`
  first.suggestedFix += `\n\n(${f.dimension}) ${f.suggestedFix}`
}

const deduped = [...merged.values()].sort((a, b) => {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  return a.line - b.line
})

return {
  findings: deduped,
  findingCount: deduped.length,
  dimensionsUnverified: dimensionsUnverified.sort(),
}
