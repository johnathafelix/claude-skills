// Behavior shared by both enforce-*-check hooks, asserted once per hook via a
// table rather than duplicated per file.
//
// SCOPE NOTE: this file deliberately asserts only behavior that is INVARIANT
// across the move from "block once per turn" to "enforce completion". The
// stop_hook_active guard and the harness-injected boundary entries
// (metaFeedback / task-notification wakes) are intentionally NOT tested here —
// their behavior changes, and their tests live with the state machine.
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers/transcript');

const HOOKS = [
  {
    name: 'enforce-golang-check.js',
    file: h.REPO + '/pkg/store.go',
    file2: h.REPO + '/pkg/other.go',
    lead: 'Go source was modified this turn',
    skill: '/golang-check',
  },
  {
    name: 'enforce-ts-check.js',
    file: h.REPO + '/src/store.ts',
    file2: h.REPO + '/src/other.tsx',
    lead: 'TypeScript source was modified this turn',
    skill: '/ts-check',
  },
];

for (const hook of HOOKS) {
  test(hook.name + ': empty stdin exits silently', () => {
    const r = h.runHook(hook.name, undefined);

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });

  test(hook.name + ': unparseable stdin exits silently', () => {
    const r = h.runHook(hook.name, '{not json');

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });

  test(hook.name + ': missing transcript_path exits silently', () => {
    const r = h.runHook(hook.name, { stop_hook_active: false });

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });

  test(hook.name + ': nonexistent transcript_path exits silently', () => {
    const r = h.runHook(hook.name, h.stopInput('/nope/does/not/exist.jsonl'));

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });

  test(hook.name + ': plan mode exits silently even with edits', () => {
    const tp = h.turnEditing([hook.file]);
    const r = h.runHook(hook.name, h.stopInput(tp, { permission_mode: 'plan' }));

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });

  test(hook.name + ': malformed JSONL lines are skipped, not fatal', () => {
    const good = [h.humanPrompt('go'), h.edit(hook.file)].map(e => JSON.stringify(e));
    const tp = h.writeTranscript(null, [good[0], '{"broken', '', 'not json at all', good[1]]);
    const r = h.runHook(hook.name, h.stopInput(tp));

    assert.strictEqual(r.status, 0);
    assert.ok(r.parsed, 'expected a decision despite malformed lines');
    assert.strictEqual(r.parsed.decision, 'block');
  });

  test(hook.name + ': a turn with no edits exits silently', () => {
    const tp = h.writeTranscript([h.humanPrompt('just talk')]);
    const r = h.runHook(hook.name, h.stopInput(tp));

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });

  test(hook.name + ': blocks on an in-scope edit and names the skill', () => {
    const tp = h.turnEditing([hook.file]);
    const r = h.runHook(hook.name, h.stopInput(tp));

    assert.strictEqual(r.status, 0);
    assert.ok(r.parsed, 'expected JSON on stdout, got: ' + r.stdout);
    assert.strictEqual(r.parsed.decision, 'block');
    assert.match(r.parsed.reason, new RegExp(hook.lead));
    assert.ok(
      r.parsed.reason.includes(hook.skill),
      'reason must name ' + hook.skill + ': ' + r.parsed.reason,
    );
  });

  test(hook.name + ': reason is singular for one file, plural for two', () => {
    const one = h.runHook(hook.name, h.stopInput(h.turnEditing([hook.file])));
    const two = h.runHook(hook.name, h.stopInput(h.turnEditing([hook.file, hook.file2])));

    assert.match(one.parsed.reason, /\(1 file\)/);
    assert.match(two.parsed.reason, /\(2 files\)/);
  });

  test(hook.name + ': counts distinct files, not edit operations', () => {
    const tp = h.writeTranscript([
      h.humanPrompt('go'),
      h.edit(hook.file),
      h.assistantToolUse('Write', { file_path: hook.file }, 'toolu_again'),
    ]);
    const r = h.runHook(hook.name, h.stopInput(tp));

    assert.match(r.parsed.reason, /\(1 file\)/);
  });

  test(hook.name + ': Edit, Write and MultiEdit all count', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      const tp = h.turnEditing([hook.file], { tool });
      const r = h.runHook(hook.name, h.stopInput(tp));

      assert.ok(r.parsed, tool + ' did not trigger a block');
      assert.strictEqual(r.parsed.decision, 'block', tool + ' did not trigger a block');
    }
  });

  test(hook.name + ': a tool_result user entry is not a turn boundary', () => {
    // Role is 'user', so a walk that checked only the role would stop here and
    // miss the edit that precedes it.
    const tp = h.writeTranscript([
      h.humanPrompt('go'),
      h.edit(hook.file),
      h.toolResultUser('toolu_edit_' + hook.file, 'done'),
    ]);
    const r = h.runHook(hook.name, h.stopInput(tp));

    assert.ok(r.parsed, 'edit before a tool_result was not seen');
    assert.strictEqual(r.parsed.decision, 'block');
  });

  test(hook.name + ': a legacy prompt with no origin still counts as human', () => {
    const tp = h.writeTranscript([h.legacyHumanPrompt('go'), h.edit(hook.file)]);
    const r = h.runHook(hook.name, h.stopInput(tp));

    assert.ok(r.parsed, 'legacy human prompt was not treated as a boundary');
    assert.strictEqual(r.parsed.decision, 'block');
  });

  test(hook.name + ': a user interrupt ends the hook\'s business with prior edits', () => {
    // Intentional: the user took control, so pre-interrupt edits are no longer
    // this hook's concern.
    const tp = h.writeTranscript([h.humanPrompt('go'), h.edit(hook.file), h.interrupted()]);
    const r = h.runHook(hook.name, h.stopInput(tp));

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });
}
