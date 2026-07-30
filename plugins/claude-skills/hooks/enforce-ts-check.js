#!/usr/bin/env node
// Stop hook: after a turn that changed TypeScript source, make sure /ts-check
// actually REPORTED findings before the turn can end — not merely that it was
// dispatched. The check runs asynchronously via the Workflow tool, so a hook
// that only demanded dispatch was satisfied by a task ID and let the findings
// vanish. State machine and transcript shapes live in lib/enforce-check.js.
const { runEnforcement, isTemp } = require('./lib/enforce-check.js');

runEnforcement({
  basename: 'enforce-ts-check.js',
  skill: '/ts-check',
  // Must match `meta.name` in skills/ts-check/workflow.js — it is how a task
  // notification is attributed back to this skill.
  workflowName: 'ts-check',
  agentType: 'ts-quality-checker',
  noun: 'file',
  lead: 'TypeScript source was modified this turn',
  // Phrased without a count: the engine already reports the file count, and this
  // clause has to read correctly for one file as well as many.
  scopeNote:
    'the changed .ts/.tsx source to check it against the TypeScript quality rules (strong ' +
    'types, no magic values, data over logic, redundant-variable inlining) — it fans out one ' +
    'focused read-only agent per guideline and reports violations.',

  // Mirror /ts-check's default scope: hand-written .ts/.tsx (tests INCLUDED).
  skip: p =>
    (!p.endsWith('.ts') && !p.endsWith('.tsx')) || // TypeScript source only
    p.endsWith('.d.ts') ||                         // declaration files (type-only/generated)
    p.includes('/node_modules/') ||                // deps
    p.includes('/.claude/') ||                     // claude infra/hooks/skills
    isTemp(p) ||                                   // scratchpad/temp files
    /\.gen\.tsx?$/.test(p),                        // generated
});
