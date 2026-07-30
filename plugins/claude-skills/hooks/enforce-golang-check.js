#!/usr/bin/env node
// Stop hook: after a turn that changed Go source, make sure /golang-check
// actually REPORTED findings before the turn can end — not merely that it was
// dispatched. The check runs asynchronously via the Workflow tool, so a hook
// that only demanded dispatch was satisfied by a task ID and let the findings
// vanish. State machine and transcript shapes live in lib/enforce-check.js.
const { runEnforcement, isTemp } = require('./lib/enforce-check.js');

runEnforcement({
  basename: 'enforce-golang-check.js',
  skill: '/golang-check',
  // Must match `meta.name` in skills/golang-check/workflow.js — it is how a task
  // notification is attributed back to this skill.
  workflowName: 'golang-check',
  agentType: 'go-idiom-checker',
  noun: 'file',
  lead: 'Go source was modified this turn',
  // Phrased without a count: the engine already reports the file count, and this
  // clause has to read correctly for one file as well as many.
  scopeNote:
    'the changed Go source to check it against the Go conventions (it fans out one focused ' +
    'read-only agent per guideline and reports violations).',

  // Mirror /golang-check's default scope: real, hand-written .go only.
  skip: p =>
    !p.endsWith('.go') ||          // Go source only
    p.endsWith('_test.go') ||      // test files excluded from default scope
    p.includes('/vendor/') ||      // vendored deps
    p.includes('/.claude/') ||     // claude infra/hooks/skills
    isTemp(p) ||                   // scratchpad/temp files
    /\.pb\.go$/.test(p) ||         // protobuf generated
    /_gen\.go$/.test(p) ||         // generated
    /\.gen\.go$/.test(p),          // generated
});
