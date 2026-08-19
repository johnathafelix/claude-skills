export const meta = {
  name: 'verify-pr-review-comments',
  description: 'Verify each PR review comment against the codebase (and sibling repos), then adversarially challenge every verdict',
  phases: [{ title: 'Verify' }, { title: 'Challenge' }],
}

// fable for both stages: this is the judgement call the whole skill is built around
// — whether a human reviewer is actually right — so it does not get a cheap model.
const MODEL = 'fable'
const EFFORT = 'high'

// Challengers run one per verdict. The skill's own Phase 1 already asks the user before
// dispatching more than 10 threads, so this cap is a backstop for the case where the
// user says yes to a very large PR — not the primary bound. Anything dropped is logged;
// silent truncation would read as "challenged everything" when it didn't.
const MAX_CHALLENGERS = 12

// Verified empirically in an earlier session (see project memory): `args` has arrived
// as a JSON-encoded STRING even when passed as a genuine object literal at the call
// site. Parse defensively regardless of what the tool docs say the shape should be.
let parsedArgs

if (typeof args === 'string') {
  try {
    parsedArgs = JSON.parse(args)
  } catch (e) {
    throw new Error(
      `verify-pr-review-comments workflow could not parse its args string as JSON — ${(e && e.message) || e}; ` +
        `first 200 chars: ${args.slice(0, 200)}`,
    )
  }
} else {
  parsedArgs = args
}

if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
  throw new Error(
    `verify-pr-review-comments workflow received args of type ${Array.isArray(parsedArgs) ? 'array' : typeof parsedArgs} — ` +
      'expected an object with { threads, siblingRoot, org, baseBranch, prNumber, userAnswers }',
  )
}

// An empty thread list is never legitimate: the skill's Phase 1 already stops when there
// is nothing unresolved to address. Fail loud rather than returning "no valid comments",
// which the caller would read as "the reviewer was wrong about everything".
const threads = parsedArgs.threads

if (!Array.isArray(threads) || threads.length === 0) {
  throw new Error('verify-pr-review-comments workflow received no threads — verify the skill body passed a non-empty list')
}

const siblingRoot = typeof parsedArgs.siblingRoot === 'string' ? parsedArgs.siblingRoot : ''
const org = typeof parsedArgs.org === 'string' ? parsedArgs.org : ''
const baseBranch = typeof parsedArgs.baseBranch === 'string' && parsedArgs.baseBranch.trim() ? parsedArgs.baseBranch.trim() : 'main'
const prNumber = parsedArgs.prNumber === undefined ? '' : String(parsedArgs.prNumber)
const userAnswers = parsedArgs.userAnswers && typeof parsedArgs.userAnswers === 'object' ? parsedArgs.userAnswers : {}

const VERDICTS = ['valid', 'invalid', 'question', 'needs-user-input']

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'reasoning', 'evidence', 'replyPoints'],
  properties: {
    verdict: { type: 'string', enum: VERDICTS },
    reasoning: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    siblingReposChecked: { type: 'array', items: { type: 'string' } },
    proposedFix: { type: 'string' },
    replyPoints: { type: 'string' },
    userQuestion: { type: 'string' },
  },
}

const CHALLENGE_SCHEMA = {
  type: 'object',
  required: ['agrees', 'reason'],
  properties: {
    agrees: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

function threadLabel(t, i) {
  return t.path ? `${t.path}:${t.line ?? '?'}` : `thread-${i + 1}`
}

function verifyPrompt(t) {
  const answer = userAnswers[t.id]

  return `You are verifying ONE pull-request review comment. Decide whether the reviewer is actually right — this is the most important step of the pipeline, and everything downstream trusts your verdict.

## The comment

Repository: current working directory (PR #${prNumber}, base branch \`${baseBranch}\`)
File: ${t.path || '(not tied to a file)'}
Line: ${t.line ?? '(none)'}
${t.isOutdated ? 'NOTE: this thread is marked OUTDATED — the code moved since the comment was written. Judge the code as it exists NOW.\n' : ''}
Reviewer thread:
${t.body}

${t.diffHunk ? `Diff hunk the comment was anchored to:\n\`\`\`\n${t.diffHunk}\n\`\`\`\n` : ''}
${answer ? `## The user already answered your earlier question\n\n${answer}\n\nTreat this as authoritative and produce a final verdict — do NOT return needs-user-input again on the same ground.\n` : ''}
## How to verify

1. Read the actual code at that location as it exists now. Never judge from the diff hunk alone — it may be stale.
2. Trace the claim: does the code really do what the reviewer says? Is the behaviour they want already handled somewhere else? Would their suggested change actually change anything?
3. Check the surrounding conventions — a reviewer sometimes flags something that is deliberate in this codebase.

## When to widen to a sibling repository

Widen ONLY when the comment turns on a contract shared with another system:
field name or type in a request/response payload, endpoint path, HTTP method,
status code, error code, OpenAPI/protobuf/GraphQL schema, event or webhook
payload shape, version compatibility, or a shared auth/permission model.
For anything else (naming, local logic, tests, style) stay in this repository.

When you do widen:
- Sibling search root: ${siblingRoot || '(not provided — ask via needs-user-input)'}
- Organization: ${org || '(unknown)'}
- Infer candidate repo names from: names mentioned in the comment; internal dependencies in package.json / go.mod / requirements.txt / pom.xml; and morphology of this repo's own name (\`foo-sdk\` -> \`foo\`, \`foo-api\`, \`foo-service\`).
- Confirm each candidate with \`test -d <root>/<name>\` before reading. Do NOT list or sweep the search root — it may hold hundreds of directories.
- If the repository you need is not there, return verdict \`needs-user-input\` with a \`userQuestion\` naming the repo. Never assume the contract holds because you could not check it.

## Verdicts — pick exactly one

- \`valid\` — the concern is real. Fill \`proposedFix\` with what should change.
- \`invalid\` — the reviewer's premise does not hold. Your \`evidence\` becomes the rebuttal we post to them, so it must be specific enough to stand on its own.
- \`question\` — the comment ASKS something rather than asserting a defect ("why did you do X here?"). It needs an answer, not a code change. Put the answer in \`replyPoints\`.
- \`needs-user-input\` — the codebase genuinely cannot settle it (a product decision, a missing sibling repo, an intent only the author knows). Put the specific question in \`userQuestion\`.

## Rules

- READ ONLY. Do not edit, write, or create any file, in this repo or a sibling one.
- Every entry in \`evidence\` must be \`path/to/file.ext:LINE — what it shows\`. Prefix sibling-repo paths with the repo name.
- Do not hedge into \`needs-user-input\` to avoid a hard call — use it only when no amount of reading settles the question.
- \`replyPoints\` is raw material for a reply to a human reviewer: the facts, no pleasantries, no restatement of their comment.`
}

function challengeTarget(verdict) {
  switch (verdict) {
    case 'valid':
      return 'Argue that this is NOT a real problem — that the reviewer is wrong, or the code already handles it, or the suggested change would not alter behaviour.'
    case 'invalid':
      return 'Argue that the reviewer WAS right after all and this verdict wrongly dismissed them.'
    default:
      return 'Argue that this comment actually asserts a real defect rather than merely asking a question.'
  }
}

function challengePrompt(t, v) {
  return `An earlier agent judged a pull-request review comment. Your job is to attack that judgement, not to agree with it.

File: ${t.path || '(none)'}${t.line ? `:${t.line}` : ''}
Reviewer thread:
${t.body}

Verdict under challenge: ${v.verdict}
Its reasoning: ${v.reasoning}
Its evidence:
${(v.evidence || []).map(e => `- ${e}`).join('\n') || '- (none given)'}

${challengeTarget(v.verdict)}

Read the real code at every location cited before you judge — a verdict resting on a citation that does not say what it claims is exactly what you are here to catch. Then answer:

- \`agrees: true\` — you tried and could not break it; the verdict stands.
- \`agrees: false\` — the verdict is wrong, and \`reason\` says concretely why, with file:line.

Be genuinely adversarial, but do not manufacture a disagreement you cannot support with code. READ ONLY — do not modify anything.`
}

phase('Verify')

// Claimed synchronously (no await between check and increment) across whichever threads
// happen to be running concurrently in the pipeline — JS is single-threaded, so this is
// race-free without a lock.
let challengersClaimed = 0

const results = await pipeline(
  threads,
  (t, _item, i) =>
    agent(verifyPrompt(t), {
      label: `verify:${threadLabel(t, i)}`,
      phase: 'Verify',
      model: MODEL,
      effort: EFFORT,
      schema: VERDICT_SCHEMA,
    }),
  (verdict, t, i) => {
    // agent() returns null on user-skip or a terminal API error the harness already
    // retried. Unlike ship-task's review workflow — where a lost finding is only a
    // missed opportunity — a lost reviewer comment means silently ignoring a human.
    // Escalate to the user instead of dropping it.
    if (!verdict || !VERDICTS.includes(verdict.verdict)) {
      log(`${threadLabel(t, i)}: verifier returned no usable verdict — escalating to the user rather than dropping the comment`)

      return {
        verdict: 'needs-user-input',
        reasoning: 'The verifier returned no usable result (user skip or terminal API error).',
        evidence: [],
        replyPoints: '',
        userQuestion: `Verification failed for the comment on ${threadLabel(t, i)}. How do you want to handle it?`,
        challenged: false,
      }
    }

    return { ...verdict, challenged: false }
  },
  (v, t, i) => {
    // A verdict already parked on the user needs no challenger — the user is the
    // tie-breaker a challenger would only be trying to become.
    if (v.verdict === 'needs-user-input') return v

    if (challengersClaimed >= MAX_CHALLENGERS) {
      log(`${threadLabel(t, i)}: challenger budget exhausted (cap ${MAX_CHALLENGERS}) — verdict "${v.verdict}" stands UNCHALLENGED`)

      return v
    }

    challengersClaimed++

    return agent(challengePrompt(t, v), {
      label: `challenge:${threadLabel(t, i)}`,
      phase: 'Challenge',
      model: MODEL,
      effort: EFFORT,
      schema: CHALLENGE_SCHEMA,
    }).then(c => {
      // A challenger that returned nothing has not endorsed anything. Leave the verdict
      // as-is but mark it unchallenged, so the caller can say so honestly.
      if (!c || typeof c.agrees !== 'boolean') {
        log(`${threadLabel(t, i)}: challenger returned no result — verdict "${v.verdict}" stands UNCHALLENGED`)

        return v
      }

      if (c.agrees) return { ...v, challenged: true }

      // Resolution is deliberately asymmetric, following the cost of each error.
      // Downgrading `valid` means a disagreement about changing code — the user's call.
      // Upgrading `invalid`/`question` to `valid` means we do a fix we might not have
      // needed, which is far cheaper than posting a wrong rebuttal to a human reviewer.
      const resolved = v.verdict === 'valid' ? 'needs-user-input' : 'valid'

      log(`${threadLabel(t, i)}: challenger refuted "${v.verdict}" -> "${resolved}" — ${c.reason}`)

      return {
        ...v,
        verdict: resolved,
        challenged: true,
        challengeReason: c.reason,
        userQuestion:
          resolved === 'needs-user-input'
            ? `Two agents disagree about the comment on ${threadLabel(t, i)}. Verifier: ${v.reasoning} Challenger: ${c.reason} How do you want to handle it?`
            : v.userQuestion,
      }
    })
  },
)

const verdicts = []
const unverified = []

// Index-paired with `threads` rather than iterating `results` directly: a stage that
// throws drops that pipeline item to `null` (per the Workflow contract), and without the
// index we would lose which comment vanished — it would disappear with no trace at all.
for (let i = 0; i < threads.length; i++) {
  const t = threads[i]
  let r = results[i]

  if (!r) {
    log(`${threadLabel(t, i)}: pipeline stage threw — escalating to the user rather than dropping the comment`)
    unverified.push(t.id)

    r = {
      verdict: 'needs-user-input',
      reasoning: 'The verification pipeline threw for this comment.',
      userQuestion: `Verification threw for the comment on ${threadLabel(t, i)}. How do you want to handle it?`,
    }
  }

  verdicts.push({
    threadId: t.id,
    path: t.path,
    line: t.line,
    verdict: r.verdict,
    reasoning: r.reasoning || '',
    evidence: r.evidence || [],
    siblingReposChecked: r.siblingReposChecked || [],
    proposedFix: r.proposedFix || '',
    replyPoints: r.replyPoints || '',
    userQuestion: r.userQuestion || '',
    challenged: r.challenged === true,
    challengeReason: r.challengeReason || '',
  })
}

const counts = { valid: 0, invalid: 0, question: 0, 'needs-user-input': 0 }

for (const v of verdicts) counts[v.verdict]++

return {
  verdicts,
  counts,
  unverified,
  unchallenged: verdicts.filter(v => v.verdict !== 'needs-user-input' && !v.challenged).map(v => v.threadId),
}
