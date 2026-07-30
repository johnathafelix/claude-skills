// The completion-enforcement state machine: SKIP / CAPPED / NONE / WAITING /
// UNHEALTHY / HEALTHY, plus the turn-boundary walk that makes re-blocking
// possible at all.
//
// These are the cases that changed when the hooks stopped accepting "dispatched"
// as "done". Anything asserted here is load-bearing for termination — a
// regression means either an unbounded Stop loop or a silently advisory hook.
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers/transcript');

const GO = 'enforce-golang-check.js';
const TS = 'enforce-ts-check.js';
const GOFILE = h.REPO + '/pkg/store.go';
const TSFILE = h.REPO + '/src/store.ts';

const CLEAN = { findings: [], findingCount: 0, unverified: [] };

// The task ID every Go fixture dispatches under, so attribution is broken only
// where a test breaks it on purpose.
const GO_TASK = 'wgo';

function run(hook, entries, extra) {
  return h.runHook(hook, h.stopInput(h.writeTranscript(entries), extra));
}

function goTurn(after) {
  return [h.humanPrompt('fix the store'), h.edit(GOFILE)].concat(after || []);
}

// A Go turn that dispatched the workflow and then received a terminal
// notification for that same task. `fields` overrides the notification — taskId
// included, which is how the "someone else's task" case is expressed.
function goTurnNotified(fields, carrier = 'wake') {
  return goTurn(
    h.workflowLaunch('golang-check', { taskId: GO_TASK }).concat([
      h.taskNotification({ taskId: GO_TASK, ...fields }, carrier),
    ]),
  );
}

// Prior blocks by `hook`, as the harness records each one: the attachment the cap
// counter matches on, plus the "Stop hook feedback:" entry that follows it — the
// entry the boundary walk has to step past for the cap to be reachable at all.
function priorBlocks(hook, count) {
  const entries = [];

  for (let i = 0; i < count; i++) {
    entries.push(h.stopBlock(hook, 'blocked'), h.metaFeedback('blocked'));
  }

  return entries;
}

// ── the boundary walk ────────────────────────────────────────────────────────

test('walks past a "Stop hook feedback:" entry so the turn\'s edits stay visible', () => {
  // The bug this fixes: the harness writes this entry on every block, so on the
  // continuation Stop the walk landed here, the edit fell before `start`, and
  // re-blocking was impossible even with no loop guard at all.
  const r = run(GO, goTurn([h.stopBlock(GO, 'run /golang-check'), h.metaFeedback('run /golang-check')]));

  assert.ok(r.parsed, 'edits before the feedback entry were lost');
  assert.strictEqual(r.parsed.decision, 'block');
});

test('walks past an async task-notification wake', () => {
  // These wake an idle session with a full new-turn preamble and
  // stop_hook_active false — so the walk, not the guard, silenced the hook
  // exactly when the findings arrived.
  const r = run(
    GO,
    goTurn([h.taskNotification({ taskId: 'wother' }, 'wake'), h.edit(h.REPO + '/pkg/two.go')]),
  );

  assert.ok(r.parsed, 'the notification wake was treated as a new turn');
  assert.strictEqual(r.parsed.decision, 'block');
  assert.match(r.parsed.reason, /\(2 files\)/, 'edits on both sides of the wake should count');
});

test('ignores sub-agent (sidechain) edits', () => {
  const sidechain = Object.assign(h.edit(GOFILE), { isSidechain: true });
  const r = run(GO, [h.humanPrompt('go'), sidechain]);

  assert.strictEqual(r.stdout.trim(), '', 'a sidechain edit should not demand a check');
});

// ── NONE ─────────────────────────────────────────────────────────────────────

test('NONE: edits with no dispatch blocks and says dispatching is not enough', () => {
  const r = run(GO, goTurn());

  assert.strictEqual(r.parsed.decision, 'block');
  assert.match(r.parsed.reason, /Dispatching is not enough/);
});

test('stop_hook_active no longer silences the hook', () => {
  // Replaced by a per-hook block budget. This is the change that makes
  // enforcement real, and the reason more blocks are expected.
  const r = run(GO, goTurn(), { stop_hook_active: true });

  assert.ok(r.parsed, 'stop_hook_active still silenced the hook');
  assert.strictEqual(r.parsed.decision, 'block');
});

test('a block by another hook does not silence this one', () => {
  // stop_hook_active is set by the harness on continuations caused by ANY hook,
  // so auto-code-simplifier blocking used to suppress both enforce hooks.
  const r = run(
    GO,
    goTurn([h.stopBlock('auto-code-simplifier.js', 'simplify'), h.metaFeedback('simplify')]),
    { stop_hook_active: true },
  );

  assert.ok(r.parsed, 'another hook\'s block silenced this one');
  assert.strictEqual(r.parsed.decision, 'block');
});

// ── WAITING ──────────────────────────────────────────────────────────────────

test('WAITING: dispatched but no notification yet never blocks', () => {
  // A real run takes minutes. Blocking here would spend the whole budget in
  // seconds and give up long before the findings land.
  const r = run(GO, goTurn(h.workflowLaunch('golang-check', { taskId: GO_TASK })));

  assert.strictEqual(r.status, 0);
  assert.ok(r.parsed, 'expected a systemMessage');
  assert.ok(!r.parsed.decision, 'WAITING must not block');
  assert.match(r.parsed.systemMessage, /still running/);
});

test('WAITING: a notification for someone else\'s task is not attributed', () => {
  const r = run(GO, goTurnNotified({ taskId: 'wSOMETHINGELSE', result: CLEAN }));

  assert.ok(!r.parsed.decision, 'should still be WAITING');
  assert.match(r.parsed.systemMessage, /still running/);
});

// ── HEALTHY ──────────────────────────────────────────────────────────────────

for (const carrier of ['wake', 'queue', 'attachment']) {
  test('HEALTHY: a clean run via the ' + carrier + ' carrier lets the turn end', () => {
    const r = run(GO, goTurnNotified({ result: CLEAN }, carrier));

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '', 'a clean repo must be able to stop');
  });
}

test('HEALTHY: partial unverified alongside real findings still passes', () => {
  // Deliberate calibration — SKILL.md Step 4 already mandates reporting it, and
  // re-running rarely fixes it, so it should not spend a block.
  const result = {
    findings: [{ file: 'a.go', line: 1, rule: 'naming' }],
    findingCount: 1,
    unverified: ['gotchas'],
  };
  const r = run(GO, goTurnNotified({ result }));

  assert.strictEqual(r.stdout.trim(), '');
});

test('HEALTHY: a completed foreground fallback agent satisfies the hook', () => {
  const r = run(GO, goTurn(h.agentDispatch('claude-skills:go-idiom-checker', { result: '[]' })));

  assert.strictEqual(r.stdout.trim(), '');
});

// ── UNHEALTHY ────────────────────────────────────────────────────────────────

test('UNHEALTHY: the real ts-check failure is caught and names the cache trap', () => {
  // The run that motivated this whole change: status completed, but all four
  // agents errored because the plugin cache predated the agent definition.
  const r = run(
    TS,
    [h.humanPrompt('check it'), h.edit(TSFILE)].concat(
      h.workflowLaunch('ts-check', { taskId: 'wts' }).concat([
        h.taskNotification(
          {
            taskId: 'wts',
            result: {
              findings: [],
              findingCount: 0,
              unverified: ['data-over-logic', 'no-magic-values', 'redundant-variable-inline', 'strong-types'],
            },
            usage: { agent_count: 4, agents_done: 0, agents_error: 4 },
          },
          'wake',
        ),
      ]),
    ),
  );

  assert.ok(r.parsed, 'the failed run was accepted as a pass');
  assert.strictEqual(r.parsed.decision, 'block');
  assert.match(r.parsed.reason, /plugin update/, 'reason should point at the stale-cache cause');
});

test('UNHEALTHY: a non-completed status blocks', () => {
  const r = run(GO, goTurnNotified({ status: 'failed', result: CLEAN }));

  assert.strictEqual(r.parsed.decision, 'block');
  assert.match(r.parsed.reason, /status "failed"/);
});

test('UNHEALTHY: fewer agents done than dispatched blocks', () => {
  const r = run(
    GO,
    goTurnNotified({
      result: CLEAN,
      usage: { agent_count: 12, agents_done: 9, agents_error: 0 },
    }),
  );

  assert.strictEqual(r.parsed.decision, 'block');
  assert.match(r.parsed.reason, /9 of 12/);
});

test('UNHEALTHY: every guideline unverified with no findings blocks', () => {
  // The fail-closed shape of a broken proof-of-read gate: agents all "succeed"
  // but nothing was actually checked.
  const r = run(
    GO,
    goTurnNotified({
      result: { findings: [], findingCount: 0, unverified: ['naming', 'errors'] },
    }),
  );

  assert.strictEqual(r.parsed.decision, 'block');
  assert.match(r.parsed.reason, /every guideline it reported was UNVERIFIED/);
});

test('UNHEALTHY: a result with no findings array blocks rather than passing', () => {
  const r = run(GO, goTurnNotified({ result: { unverified: [] } }));

  assert.strictEqual(r.parsed.decision, 'block');
  assert.match(r.parsed.reason, /no findings array/);
});

test('an escaped result payload is unescaped before parsing', () => {
  // Real blobs HTML-escape the result, so suggestedFix arrives as "a -&gt; b".
  const result = {
    findings: [{ file: 'a.go', line: 1, suggestedFix: 'x -> y', rule: 'naming' }],
    unverified: [],
  };
  const r = run(GO, goTurnNotified({ result }));

  assert.strictEqual(r.stdout.trim(), '', 'escaped payload should parse as a healthy pass');
});

// ── CAPPED ───────────────────────────────────────────────────────────────────

test('CAPPED: after 3 of its own blocks the hook stops blocking', () => {
  // The only loop breaker in the system, since stop_hook_active is gone.
  const r = run(GO, goTurn(priorBlocks(GO, 3)));

  assert.strictEqual(r.status, 0);
  assert.ok(!r.parsed.decision, 'must not block once capped');
  assert.match(r.parsed.systemMessage, /coverage gap/);
});

test('CAPPED: only this hook\'s own blocks count toward its cap', () => {
  const r = run(GO, goTurn(priorBlocks(TS, 4)));

  assert.ok(r.parsed.decision, 'another hook\'s blocks consumed this hook\'s budget');
  assert.strictEqual(r.parsed.decision, 'block');
});

test('CAPPED: two prior blocks still leaves one', () => {
  const r = run(GO, goTurn(priorBlocks(GO, 2)));

  assert.strictEqual(r.parsed.decision, 'block');
});

test('CAPPED beats a bad evidence parse: the cap is checked first', () => {
  // Ordering guarantee — a parser bug must never be able to produce block N+1.
  const priors = priorBlocks(GO, 3).concat([
    h.taskNotification({ taskId: GO_TASK, result: '{{{ not json' }, 'wake'),
  ]);

  const r = run(GO, goTurn(priors));

  assert.ok(!r.parsed.decision, 'cap must win over any evidence state');
});
