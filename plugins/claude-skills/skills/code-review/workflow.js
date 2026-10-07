export const meta = {
  name: 'code-review',
  description: 'Grouped opus review with bounded independent verification; thorough mode adds a sweep',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Sweep' }],
}

// Shared by /claude-skills:code-review, /ship-task and /address-pr-review-comments.
// Why not the built-in /code-review: a pipeline cannot invoke a slash command, and the
// Agent tool has `model` but no `effort`. Only agent() calls in a Workflow can pin both,
// so every call below does. Angles and sweep are adapted from the built-in's max recipe.
const MODEL = 'opus'
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
// REVIEW_INPUT_RUNTIME

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
const repoDir = typeof parsedArgs.repoDir === 'string' ? parsedArgs.repoDir.trim() : ''
const files = Array.isArray(parsedArgs.files) ? parsedArgs.files.map(f => reviewPath(f, repoDir)) : null

if (!Array.isArray(files) || files.length === 0 || files.some(f => !f)) {
  throw new Error('code-review requires non-empty target files inside repoDir; absolute paths require the checkout root')
}

const baseBranch = typeof parsedArgs.baseBranch === 'string' && parsedArgs.baseBranch.trim() ? parsedArgs.baseBranch.trim() : 'main'
const changeNote = typeof parsedArgs.changeNote === 'string' ? parsedArgs.changeNote : ''
const planPath = typeof parsedArgs.planPath === 'string' ? parsedArgs.planPath : ''

// Fail loud on a typo rather than silently reviewing at the wrong level.
const profile = parsedArgs.profile || 'standard'
if (!['fast', 'standard', 'thorough'].includes(profile)) throw new Error('profile must be fast, standard or thorough')
const EFFORT = parsedArgs.effort === undefined ? (profile === 'thorough' ? 'high' : 'medium') : parsedArgs.effort

if (!EFFORT_LEVELS.includes(EFFORT)) {
  throw new Error(`code-review workflow received effort ${JSON.stringify(EFFORT)} — expected one of ${EFFORT_LEVELS.join(', ')}`)
}

const nitInstructions = reviewNitPolicy(parsedArgs.nitPolicy)

// Set by review-pr to verify findings from other checkers (golang-check, ts-check): skips
// the finders and the sweep, and runs only the adversarial verifier on these.
const verifyOnly = Array.isArray(parsedArgs.verifyOnly) ? parsedArgs.verifyOnly : null
for (const key of ['verifyOnly', 'externalFindings']) {
  if (parsedArgs[key] !== undefined && !Array.isArray(parsedArgs[key])) throw new Error(`${key} must be an array`)
}
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
        required: ['file', 'line', 'severity', 'description', 'suggestedFix', 'claimKey'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['issue', 'nit'] },
          description: { type: 'string' },
          suggestedFix: { type: 'string' },
          dimension: { type: 'string' },
          claimKey: { type: 'string' },
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
${parsedArgs.reviewContextPath ? `Review scope and previous complete review: ${parsedArgs.reviewContextPath}. If incremental, review the new delta, search callers/callees affected by changed symbols, and expand into unchanged PR functions where a changed contract or dependency can alter behavior. Recheck prior claims independently; do not assume an old finding is still true. The fullDiffCommand in that context is available when intent or dependency scope is unclear.` : ''}
${planPath ? `\nImplementation plan (consult the relevant section when intent is ambiguous): ${planPath}` : ''}
${parsedArgs.changeManifestPath ? `Task manifest: ${parsedArgs.changeManifestPath}. Read its per-file patches. They are authoritative, including additions, deletions and pre-existing dirty baselines; do not rediscover a branch-wide diff.` : ''}`
}

function descriptionRule(dim) {
  return dim.kind === 'bug'
    ? '`description` must state the concrete failure: the input, state, or timing that triggers it and the wrong output or crash that results.'
    : '`description` must state the concrete cost: what is duplicated, wasted, left untested, harder to maintain, or which rule is broken.'
}

const SHARED_RULES = `- If a task manifest is supplied, read its patches instead of the branch diff. Otherwise read the actual diff (\`${diffCommand}\`, or per-file with \`-- <path>\`) before reporting anything — do not guess from filenames.
- Keep distinct defects separate, even on the same line. Set claimKey to "<enclosing symbol>:<violated invariant>:<trigger>". Use code identifiers and concrete states, not angle names, severity, suggested fixes or prose wording. Equivalent claims must use the same key; different triggers/invariants must use different keys.
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

Already reported by the first pass (candidates, not yet challenged):
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

${locationNote}Read the actual file content at that location and ${parsedArgs.changeManifestPath ? `the task manifest ${parsedArgs.changeManifestPath} and its patches` : `the diff (\`${diffCommand}\`)`} before judging.

Refute (refuted: true) if: the code does not do what the claim says (quote the actual line); the problem is provably impossible (show the type, constant, or invariant); it is already handled in this diff (cite the guard); the line number does not correspond to the described code; for an issue, the fix would not change behavior; for a nit, the stated cost (duplication, naming, wording) is not actually there.${dim.refute ? ` ${dim.refute}` : ''}

Do not refute merely because the trigger depends on runtime state when that state is realistic — concurrency races, nil/undefined on a rare but reachable path, falsy-zero treated as missing, an off-by-one on a boundary the code does not exclude, partial failures. Confirm (refuted: false) only if you independently verified the problem exists as described.

If you confirm a "nit" that actually affects behavior or correctness, set severity: "issue". Never downgrade an "issue" to a nit; omit severity to keep the claimed one.`
}

// Bound fan-out and preserve missing verdicts as visible coverage gaps.
const stats = { profile, finderCalls: 0, verifierCalls: 0, candidates: 0, duplicates: 0 }
const dimensionsUnverified = new Set()
const unchallenged = []
const refuted = []
const rejectedFindings = []
const covered = new Set(Array.isArray(parsedArgs.coveredDimensions) ? parsedArgs.coveredDimensions : [])
// Ownership can suppress overlapping checks, never core correctness or security.
const allowedCovered = new Set(['tests', 'comments', 'conventions'])
for (const key of covered) if (!allowedCovered.has(key)) throw new Error(`Cannot delegate essential dimension ${key}`)
const active = DIMENSIONS.filter(d => !covered.has(d.key))
const fastKeys = new Set(['line-scan', 'removed-behavior', 'cross-file', 'language-pitfalls', 'wrapper-proxy', 'error-handling', 'type-invariants', 'security', 'tests'])
const selected = profile === 'fast' ? active.filter(d => fastKeys.has(d.key)) : active
const batchesOf = (items, count) => Array.from({ length: Math.ceil(items.length / count) }, (_, i) => items.slice(i * count, (i + 1) * count))
const normalize = value => String(value || '').replace(/[–—―]/g, '-').replace(/→/g, '->').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase()
const byPriority = (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.file.localeCompare(b.file) || a.line - b.line
async function pool(items, worker) {
  let next = 0
  const output = new Array(items.length).fill(null)
  await parallel(Array.from({ length: Math.min(4, items.length) }, () => async () => {
    while (next < items.length) {
      const i = next++
      try { output[i] = await worker(items[i], i) }
      catch (e) { log(`worker failed: ${e.message || e}`) }
    }
  }))
  return output
}
function acceptFinding(raw, dimension, external = false) {
  const { finding, errors } = reviewFinding(raw, repoDir, external)
  if (errors.length) {
    const source = dimension || finding?.dimension || 'malformed-finding'
    dimensionsUnverified.add(source)
    rejectedFindings.push({ finding: raw, dimension: source, validationErrors: errors, verified: false })
    log(`${source}: rejected finding — ${errors.join('; ')}`)
    return null
  }
  return { ...finding, dimension: dimension || finding.dimension || 'external' }
}
function deduplicate(items) {
  const unique = new Map()
  for (const f of items) {
    const key = `${f.file}:${f.line}:${normalize(f.claimKey || f.description)}`
    const first = unique.get(key)
    if (!first) unique.set(key, { ...f, dimensions: [...new Set([...(f.dimensions || []), f.dimension || 'external'])] })
    else {
      stats.duplicates++
      first.severity = higherSeverity(first.severity, f.severity)
      first.dimensions = [...new Set([...first.dimensions, ...(f.dimensions || []), f.dimension || 'external'])]
      // Keep all proof inputs when equivalent claims come from different checkers.
      first.evidence = [...(first.evidence || []), ...(f.evidence || []), ...[f.guidelinePath, f.coverageFile].filter(Boolean)]
    }
  }
  return [...unique.values()].sort(byPriority)
}
function external(items) {
  return items.map(f => acceptFinding(f, null, true)).filter(Boolean)
}
async function find() {
  phase('Find')
  const groups = profile === 'thorough' ? selected.map(d => [d]) : [
    selected.filter(d => d.kind === 'bug'),
    selected.filter(d => ['tests', 'comments', 'conventions'].includes(d.key)),
    selected.filter(d => d.kind === 'cost' && !['tests', 'comments', 'conventions'].includes(d.key)),
  ].filter(g => g.length)
  const results = await pool(groups, async group => {
    stats.finderCalls++
    const prompt = group.length === 1 ? findPrompt(group[0]) : `Review these related angles in one source-reading pass. Read changed hunks and enclosing code once, expanding to callers as needed.\n${contextBlock()}\nAngles:\n${group.map(d => `${d.key}: ${d.prompt} ${descriptionRule(d)}`).join('\n')}\n${SHARED_RULES}\nReturn at most 8 concrete findings, each with dimension set to one supplied angle. Report equivalent claims once. Return findings: [] when clean.`
    const result = await agent(`${prompt}\nReturn repo-relative file paths. ${nitInstructions}`, { label: `find:${group.map(d => d.key).join('+')}`, phase: 'Find', model: MODEL, effort: EFFORT, schema: FINDINGS_SCHEMA })
    if (!result || !Array.isArray(result.findings)) return null
    const accepted = []
    for (const f of result.findings) {
      const dimension = group.length === 1 ? group[0].key : f?.dimension
      const finding = acceptFinding(f, dimension)
      if (!finding || !group.some(d => d.key === dimension)) {
        for (const d of group) dimensionsUnverified.add(d.key)
        if (finding) rejectedFindings.push({ finding: f, validationErrors: ['dimension outside finder group'], verified: false })
        continue
      }
      accepted.push(finding)
    }
    return accepted
  })
  const candidates = []
  results.forEach((r, i) => {
    if (!r) for (const d of groups[i]) dimensionsUnverified.add(d.key)
    else candidates.push(...r)
  })
  if (profile === 'thorough' || parsedArgs.sweep === true) {
    phase('Sweep')
    stats.finderCalls++
    try {
      const result = await agent(`${sweepPrompt(candidates)}\nReturn repo-relative file paths. ${nitInstructions}`, { label: 'find:sweep', phase: 'Sweep', model: MODEL, effort: EFFORT, schema: FINDINGS_SCHEMA })
      if (!result || !Array.isArray(result.findings)) dimensionsUnverified.add('sweep')
      else for (const f of result.findings) {
        const finding = acceptFinding(f, 'sweep')
        if (finding) candidates.push(finding)
      }
    } catch (e) { dimensionsUnverified.add('sweep'); log(`sweep: ${e.message || e}`) }
  }
  return candidates
}
const candidates = deduplicate(verifyOnly ? external(verifyOnly) : [...await find(), ...external(Array.isArray(parsedArgs.externalFindings) ? parsedArgs.externalFindings : [])])
stats.candidates = candidates.length
phase('Verify')
const findings = []
const verdictBatchSchema = { type: 'object', required: ['verdicts'], properties: { verdicts: { type: 'array', items: { type: 'object', required: ['id', 'refuted', 'reason'], properties: { id: { type: 'integer' }, ...VERDICT_SCHEMA.properties } } } } }
const verified = await pool(batchesOf(candidates, 4), async (batch, index) => {
  if (index >= 8) return null // At most 8 calls / 32 claims; excess stays unchallenged.
  stats.verifierCalls++
  return await agent(`Independently challenge this batch. Read shared context once, but return exactly one verdict for EACH id. Do not assume agreement with the finder. For test claims read the applicable test-check guideline (if provided) and honor its exceptions.\n${batch.map((f, id) => {
    const dim = DIMENSIONS.find(d => d.key === f.dimension) || { key: f.dimension, label: f.dimensionLabel || f.dimension }
    return `ID ${id}\n${verifyPrompt(f, dim)}${f.guidelinePath ? `\nGuideline: ${f.guidelinePath}` : ''}${f.coverageFile ? `\nCoverage: ${f.coverageFile}` : ''}${f.evidence?.length ? `\nAdditional evidence inputs: ${JSON.stringify(f.evidence)}` : ''}`
  }).join('\n\n')}`, { label: `verify:batch:${index}`, phase: 'Verify', model: MODEL, effort: EFFORT, schema: verdictBatchSchema })
})
batchesOf(candidates, 4).forEach((batch, index) => {
  for (let id = 0; id < batch.length; id++) {
    const f = batch[id]
    const matches = Array.isArray(verified[index]?.verdicts) ? verified[index].verdicts.filter(v => v && v.id === id) : []
    const v = matches.length === 1 ? matches[0] : null
    if (!v || typeof v.refuted !== 'boolean' || typeof v.reason !== 'string' || !v.reason.trim() || (v.severity !== undefined && !['issue', 'nit'].includes(v.severity))) {
      unchallenged.push({ ...f, verified: false, verificationReason: index >= 8 ? 'verifier budget exhausted' : 'missing or malformed verdict' })
      for (const dimension of f.dimensions) dimensionsUnverified.add(dimension)
    } else if (v.refuted) refuted.push({ ...f, refutedReason: v.reason })
    else findings.push({ ...f, severity: higherSeverity(f.severity, v.severity || f.severity), verified: true, verificationReason: v.reason })
  }
})
findings.push(...unchallenged)
findings.sort(byPriority)
stats.confirmed = findings.length - unchallenged.length
stats.rejected = rejectedFindings.length
// Timing belongs to Workflow metadata; sandbox clocks are deliberately unavailable.
return {
  findings, findingCount: findings.length, dimensionsUnverified: [...dimensionsUnverified].sort(),
  unchallenged, refuted, rejectedFindings, stats,
  dimensionsDelegated: [...covered],
  dimensionsSkipped: verifyOnly ? [] : active.filter(d => !selected.includes(d)).map(d => d.key),
}
