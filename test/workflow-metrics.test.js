const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { metrics, read } = require('../plugins/claude-skills/scripts/workflow-metrics');

test('timing uses harness metadata instead of sandbox zeroes or summed concurrent durations', () => {
  const result = metrics({ status: 'completed', durationMs: 130370, result: { stats: { finderCalls: 3, durationMs: 0, findDurationMs: 0 } }, workflowProgress: [
    { type: 'workflow_agent', phaseTitle: 'Find', state: 'done', startedAt: 1000, durationMs: 60000 },
    { type: 'workflow_agent', phaseTitle: 'Find', state: 'done', startedAt: 2000, durationMs: 50000 },
    { type: 'workflow_agent', phaseTitle: 'Verify', state: 'done', startedAt: 70000, durationMs: 30000 },
  ] });
  assert.equal(result.durationMs, 130370);
  assert.deepEqual(result.phaseAgentSpansMs, { Find: 60000, Verify: 30000 });
  assert.deepEqual(result.stats, { finderCalls: 3 });
});

test('missing or partial timing is unavailable rather than a fabricated zero', () => {
  const result = metrics({ workflowProgress: [{ type: 'workflow_agent', phaseTitle: 'Find', startedAt: 1000, state: 'running' }] });
  assert.equal(result.durationMs, null);
  assert.deepEqual(result.phaseAgentSpansMs, { Find: null });
});

test('transcript-directory input reads only compact evidence from its sibling metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-metrics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'subagents/workflows/wf_test');
  fs.mkdirSync(transcript, { recursive: true });
  fs.mkdirSync(path.join(root, 'workflows'));
  fs.writeFileSync(path.join(root, 'workflows/wf_test.json'), JSON.stringify({ runId: 'wf_test', status: 'completed', durationMs: 25, script: 'large workflow source', result: { findings: ['large report'] } }));
  const result = read(transcript);
  assert.equal(result.runId, 'wf_test');
  assert.equal(result.durationMs, 25);
  assert.equal(Object.hasOwn(result, 'script'), false);
  assert.equal(Object.hasOwn(result, 'result'), false);
});
