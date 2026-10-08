const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../plugins/claude-skills/scripts/review-dispatch');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dispatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), scratchpad = path.join(root, 'scratchpad'), out = path.join(root, 'artifacts');
  fs.mkdirSync(repo); fs.mkdirSync(scratchpad);
  return { repo, scratchpad, out };
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
test('unknown scratchpad uses the complete staged script inline on the first dispatch', t => {
  const f = fixture(t);
  const spec = build('ts-check', { files: ['a.ts'], guidelines: [{ stem: 'strong-types' }] }, f.out);
  const payload = read(spec.dispatchPath);
  assert.equal(spec.transport, 'script');
  assert.equal(payload.scriptPath, undefined);
  assert.equal(payload.script, fs.readFileSync(spec.stagedPath, 'utf8'));
  assert.ok(payload.script.includes('reviewFinding'));
});
test('declared scratchpad produces a readable staged file and preserves checker arguments', t => {
  const f = fixture(t), args = { files: ['a.go'], guidelines: [{ stem: 'errors', files: ['a.go'] }], mode: 'individual' };
  const spec = build('golang-check', args, f.out, { scratchpad: f.scratchpad });
  const payload = read(spec.dispatchPath);
  assert.equal(payload.script, undefined);
  assert.equal(path.dirname(payload.scriptPath), fs.realpathSync(f.scratchpad));
  assert.deepEqual(payload.args, args);
});
test('pinned cached and GitHub prior claims enter challenge even on a full review', async t => {
  const f = fixture(t);
  const context = { repoDir: f.repo, diffCommand: 'git diff pinned-base pinned-head', reviewFiles: ['a.go'], incremental: false,
    expectedPriorIds: ['cached:one'], priorFindings: [{ priorId: 'cached:one', priorIds: ['cached:one', 'cached:two'], file: 'a.go', line: 2, description: 'old race', severity: 'issue', suggestedFix: 'atomic write' }] };
  const spec = build('code-review', { verifyOnly: [] }, f.out, { context,
    prior: [{ id: 12, path: 'a.go', original_line: 8, body: 'Nit: duplicated constant' }],
    checks: [{ skill: 'test-check', result: { result: { coverageFile: '/coverage/report.json', findings: [{ file: 'a_test.go', line: 4, rule: 'assertion-fidelity', severity: 'error', description: 'weak assertion', rationale: 'wrong output passes', action: 'assert value' }], unverified: [] } } }],
  });
  const payload = read(spec.dispatchPath);
  assert.deepEqual(payload.args.expectedPriorIds, ['cached:one', 'cached:two', 'github:12']);
  assert.equal(payload.args.priorFindings[1].severity, 'nit');
  assert.equal(payload.args.externalFindings[0].severity, 'issue');
  assert.equal(payload.args.externalFindings[0].coverageFile, '/coverage/report.json');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const prompts = [];
  const result = await new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', payload.script.replace('export const meta', 'const meta'))(
    payload.args, async p => { prompts.push(p); return { verdicts: [{ id: 0, refuted: true, reason: 'fixed' }, { id: 1, refuted: true, reason: 'covered' }, { id: 2, refuted: true, reason: 'removed' }] }; },
    thunks => Promise.all(thunks.map(fn => fn())), () => {}, () => {},
  );
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Coverage: \/coverage\/report.json/);
  assert.deepEqual(result.priorClaims.missing, []);
  assert.deepEqual(result.priorClaims.challenged, ['cached:one', 'cached:two', 'github:12']);
  assert.equal(result.refuted.length, 3);
});
test('checker rejections remain explicit input gaps and missing checker results fail setup', t => {
  const f = fixture(t);
  const spec = build('code-review', { files: ['a.go'] }, f.out, { checks: [{ skill: 'golang-check', result: { findings: [], unverified: ['errors'], rejectedFindings: [{ finding: null, rule: 'errors', validationErrors: ['invalid finding'] }] } }] });
  assert.deepEqual(read(spec.dispatchPath).args.inputGaps, ['golang-check/errors']);
  assert.equal(read(spec.dispatchPath).args.inputRejectedFindings.length, 1);
  assert.throws(() => build('code-review', { files: ['a.go'] }, f.out, { checks: [{ skill: 'ts-check', result: { status: 'running' } }] }), /incomplete/);
  assert.throws(() => build('code-review', { files: ['a.go'], repoDir: f.scratchpad }, f.out, { context: { repoDir: f.repo } }), /pinned context/);
  const malformed = build('code-review', { verifyOnly: [], inputRejectedFindings: [null] }, f.out, { checks: [{ skill: 'test-check', result: { findings: [null], unverified: [] } }] });
  assert.deepEqual(read(malformed.dispatchPath).args.externalFindings, [null]);
  assert.deepEqual(read(malformed.dispatchPath).args.inputRejectedFindings, [null]);
});
