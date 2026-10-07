---
name: review-pr
description: "Review a teammate's GitHub PR and post confirmed findings. Uses grouped Opus review, language/test checks, one independent verification queue, bounded coverage and incremental re-reviews. Approves when only nits remain; approve permits approval with issues. Posts directly when invoked."
argument-hint: "<PR URL> [fast|standard|thorough] [low|medium|high|xhigh|max] [approve] [full]"
---

# Review PR

Invocation authorizes posting one GitHub review without confirmation. Never edit code,
push, merge or resolve threads. Dependencies and coverage may be generated in an isolated
worktree. Await Workflow completion notifications; dispatch task IDs are not results.
Resolve helper/sibling paths from this SKILL.md, including in the plugin cache. Keep
large artifacts in scratchpad and report concise summaries.

## Arguments and preflight

Accept one `https://github.com/<owner>/<repo>/pull/<number>` URL, an optional profile,
effort, `approve` and `full`, in any order. Reject unknown/conflicting arguments with
usage. `approve` sets FORCE_APPROVE; `full` disables incremental reuse. Profile defaults
to REVIEW_PR_PROFILE or `standard`; effort to REVIEW_PR_EFFORT, else `medium` (`high`
for thorough). Validate environment values against the choices above. Honor explicit
profiles; otherwise escalate to thorough for authorization, concurrency, data migrations,
broad public-contract changes or similarly material risk, explaining the choice.

Fetch PR facts (`number,state,isDraft,author,headRefOid,title,baseRefName`), your login,
and your previous reviews (`commit_id,body`) with gh. Not OPEN: stop. Already reviewed
by you at this head: stop as already_reviewed. Draft or own PR: CAN_APPROVE=false.
Pin HEAD_SHA before fetching code. If prior reviews exist, fetch your inline comments
and the author's thread replies: id,in_reply_to_id,user,path,line (fallback
original_line),body. Include your review bodies' **Outside this PR's diff** entries in
PRIOR. Do not preload other reviewers' conversations.

Find a checkout whose `gh repo view --json nameWithOwner --jq .nameWithOwner` equals
OWNER/REPO case-insensitively: current directory, then
`${REVIEW_REQUESTS_REPOS_DIR:-$HOME/repos}/<repo>`. Clone only if the second path is
absent; never replace existing directories. Use explicit checkout/worktree paths on
every command: a previous shell cd does not persist.

## Pin the worktree and scope

Read code-review's **Steps 2b and 3** for temporary worktree creation/workflow staging.
Use the exact harness-provided session scratchpad for every staged workflow. A temporary
worktree path is not automatically a readable script directory. Without a readable
scratchpad, pass staged contents as Workflow script, never an arbitrary temp scriptPath.
Hold cleanup until checks, verification and cache save finish. Verify the checked-out
head equals HEAD_SHA; a head that moved during fetch stops as head_moved after cleanup.
Include added, renamed and deleted files.

```bash
python3 "<skill>/scripts/review-state.py" prepare --repo "$WT" \
  --base "origin/$BASE" --head "$HEAD_SHA" --url "<PR URL>" \
  --profile "<PROFILE>" --effort "<EFFORT>" --out "<scratchpad>/review-context.json"
```

Append --full when requested. Read that context JSON once: files is the full PR scope;
reviewFiles is the new delta plus prior finding locations. The helper pins base/merge-base
SHAs and checks policy, history and broad configuration changes before allowing
incremental scope. Its diffCommand/fullDiffCommand are authoritative. No full-PR files:
clean up and finish as no_findings.

For incremental scope, search changed symbols' callers/callees and include affected
unchanged PR functions in reviewFiles. If impact cannot be bounded, rerun prepare with
--full. Recheck **all** priorFindings independently, including locations outside the new
delta; never carry an old finding as confirmed. The helper translates unaffected line
offsets. Relocate needsRelocation claims by symbol, code anchors and invariant, including
renames; do not refute them just because their old line moved. A claim that cannot be
relocated or shown fixed is an explicit gap and blocks ordinary approval. An empty delta, no prior findings and
matching inputs permits explicit reuse of the complete clean review: skip empty
workflows, save the clean result for HEAD_SHA and continue to the posting decision.
Keep unrelocated prior claims as gaps rather than submitting stale coordinates.

## Collect candidates and challenge once

Run language/test checks with grouped defaults and the same pinned context. Dispatch
independent check Workflows before waiting. Pass repo-relative paths and
`repoDir: context.repoDir, diffCommand: context.diffCommand, nitPolicy: "material"`;
do not fetch/recompute another base. The runtime also normalizes absolute paths within
the pinned checkout and rejects paths outside it.
Read applicable siblings' **Scope** and **Stage and run** sections for guideline
selection, version gates and staging; use a distinct staged script path for each.
Override their presentation/fix/verification steps with this read-only shared queue.

- Surviving Go files: golang-check, preserving per-module version gates.
- Surviving TS/TSX files: ts-check.
- Changed executable source/tests: test-check with **verify: false**. These are
  candidates for the shared challenger, not confirmed comments.

Keep raw results and guideline paths from staging; skip presentation/fix steps. For
incremental test-check, include relevant tests for affected behavior even when unchanged.
Unavailable coverage must not delay the remaining test guidelines.

Choose the existing coverage command for affected packages/workspaces/tests, covering
every changed executable source file. Run it through the bounded helper:

```bash
python3 "<skill>/scripts/coverage.py" --repo "$WT" --cwd "<affected package>" \
  --out "<scratchpad>/coverage" --report "<scratchpad>/coverage/<report file>" \
  -- <coverage command and separate arguments>
```

The helper installs missing Node dependencies once, selects npm/yarn/pnpm from lockfiles,
uses isolated caches when safe and fingerprints report inputs. Go commands need no Node
install. Set runner flags to write the indicated report. Declare extra ignored source/
config inputs with --input <path>; pass --no-cache when effective inputs are unknown.
Install defaults to 180 seconds, coverage to 300; configurable with
REVIEW_PR_INSTALL_TIMEOUT_SECONDS and REVIEW_PR_COVERAGE_TIMEOUT_SECONDS. Failure/timeout:
coverage UNVERIFIED with its reason/log; omit that guideline and continue the others.
Never restart installations/suites, broaden to the whole repo or investigate unrelated
failures just to make coverage pass. Pure docs/config needs neither coverage nor test-check.

Normalize all candidates to repo-relative
`{file,line,severity,description,suggestedFix,dimension,claimKey}`. Go/test error maps to
issue, other levels to nit; TS findings are nits. Combine test description/rationale,
use action as suggestedFix, preserve source/rule dimensions and attach guidelinePath/
coverageFile for test exceptions/evidence. Canonicalize equivalent claim keys to
`<enclosing symbol>:<violated invariant>:<trigger>`; preserve different triggers/invariants
even at one line. Apply matching keys to prior findings too.
The runtime accepts summary/failure_scenario aliases from implementers, but use
description for new candidates. Preserve rejectedFindings and validationErrors as gaps;
do not recover raw journal output or redispatch an exhausted check to hide a gap.
Include every validated language/test candidate in the shared queue.

Dispatch the staged code-review workflow **once**, after candidate collection:

```text
{ files: reviewFiles, baseBranch: BASE, profile: PROFILE, effort: EFFORT,
  repoDir: context.repoDir, diffCommand: context.diffCommand, reviewContextPath: contextPath,
  nitPolicy: "material",
  changeNote: "PR #<n>: <title>",
  externalFindings: <normalized language/test candidates and priorFindings>,
  coveredDimensions: <["tests"] only if all applicable test rules and measured coverage
                      completed; otherwise []> }
```

Core correctness/security remain in code-review. Suppress its tests angle only when
test-check owns it completely; failure retains the fallback. Deduplicate equivalent
candidates before independent challenge. Do not add a language verify-only run or
standalone test verification. Verifiers prioritize issues, batch four claims and expose
budget overflow/missing verdicts as gaps. Post only **verified: true** findings. Include
all unverified rules/unchallenged claims in the approval decision and user report.
Finder/checker prompts limit nits to concrete maintenance/testing costs; avoid generating
mechanical style and routine edge-coverage suggestions that will not be posted. Preserve
all correctness issues and independently challenge every candidate actually returned.

Keep the complete confirmed list before filtering already-posted comments. With no gaps,
write `{complete:true,findings:<complete verified list>,unchallenged:[]}` to scratchpad and
call `review-state.py save --context <context JSON> --report <report JSON>` while WT still
exists. Set complete=false if any applicable check/coverage was unverified; partial
results never replace a complete cache. Save failure only affects reuse. Always clean
up the temporary worktree/branch before posting, including on failures.

## Prior findings and comment placement

Drop new comments matching a PRIOR problem in the same file, regardless of shifted lines;
a different trigger or fix stays. A prior issue still reproduced by the challenger blocks
approval unless the author replied after your last comment declining it or explaining
why it stays. Agreement/promises to fix do not count. Retain these as STILL_OPEN and never
post them twice.

```bash
gh api --paginate "repos/$OWNER/$REPO/pulls/$PR_NUMBER/files" \
  | python3 "<skill>/scripts/diff-lines.py" > "<scratchpad>/review-lines.json"
```

Findings outside commentable right-side diff lines go in the body under **Outside this
PR's diff**. Comments have at most six lines: problem, concrete trigger/cost, suggested
fix; prefix nits with `Nit: `. Draft plain reviewer English directly: remove AI vocabulary,
inflated claims, hedging, em-dash overuse and repetition. Do not load humanizer or run a
second rewrite. Preserve code, identifiers, paths, numbers and issue/fix meaning; no
internal angles, AI attribution, reactions or added personality.

## Decide and post

Any unverified code/language/test rule or unchallenged claim blocks ordinary approval.
Coverage alone being unavailable does not block it, but must be reported. First match:

| Situation | Action |
|---|---|
| FORCE_APPROVE and CAN_APPROVE | APPROVE with every issue/nit, even with gaps/STILL_OPEN |
| Incomplete checks or any new issue | COMMENT |
| STILL_OPEN, no new findings | Post nothing |
| STILL_OPEN, new nits | COMMENT |
| Nits or clean, CAN_APPROVE | APPROVE |
| Clean, not CAN_APPROVE | Post nothing |
| Nits, not CAN_APPROVE | COMMENT |

Re-read the PR head immediately before posting. A HEAD_SHA mismatch stops as head_moved.
Write the payload to scratchpad:
`{commit_id:HEAD_SHA,event:"APPROVE|COMMENT",body:"",comments:[{path,line,side:"RIGHT",body}]}`
and post via `gh api -X POST repos/$OWNER/$REPO/pulls/$PR_NUMBER/reviews --input <file>`.
Body is empty unless it carries outside-diff findings. GitHub rejection: report and stop,
never retry with another event. Keep coverage gaps/internal machinery in the user report.

## Report

Give decision/review URL, one line per comment, STILL_OPEN/skipped prior findings,
measured/unverified coverage, other gaps, refuted/unchallenged counts, chosen profile/
effort, incremental/full scope and actual finder/verifier calls. Distinguish malformed
rejected claims from claims awaiting a verdict. Read elapsed times from completed Workflow
metadata with scripts/workflow-metrics.js (see code-review Step 4). Phase agent spans
exclude coordinator overhead; unavailable times are null. Never
present unchallenged claims as confirmed or estimate billing from partial usage.
End every run, including early stops, with exactly one final marker:

```text
REVIEW_RESULT: <outcome>
```

Outcomes: approved (no comments), approved_nits, approved_comments (issues, approve flag),
commented, no_findings, still_open, merged, closed, already_reviewed, head_moved, error.
