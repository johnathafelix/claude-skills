const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { stage, guidelineMeta } = require('../plugins/claude-skills/scripts/stage-workflow');
const PLUGIN = path.resolve(__dirname, '../plugins/claude-skills');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function runner(t, skill) {
  let source;
  const meta = skill === 'code-review' ? {} : guidelineMeta(path.join(PLUGIN, 'skills', skill, 'guidelines'));
  if (skill === 'code-review') source = fs.readFileSync(path.join(PLUGIN, 'skills', skill, 'workflow.js'), 'utf8');
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'staged.js');
    stage(path.join(PLUGIN, 'skills', skill, 'guidelines'), path.join(PLUGIN, 'skills', skill, 'workflow.js'), out);
    source = fs.readFileSync(out, 'utf8');
    assert.ok(!source.includes('// GROUPED_CHECK_RUNTIME'));
  }
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', source.replace('export const meta', 'const meta'));
  const calls = [], logs = [];
  let live = 0, maximum = 0;
  return {
    calls, logs, meta, get maximum() { return maximum; },
    proof(prompt, findings = []) {
      return { findings, guidelineProofs: Object.entries(meta).filter(([stem]) => prompt.includes(`Guideline ${stem}:`)).map(([stem, m]) => ({ stem, lineCount: m.lines, title: m.title, lastLine: m.lastLine })) };
    },
    async run(args, response) {
      return fn(args, async (prompt, options) => {
        live++; maximum = Math.max(live, maximum); calls.push({ prompt, options });
        try { return await response(prompt, options); } finally { live--; }
      }, thunks => Promise.all(thunks.map(async f => { try { return await f(); } catch { return null; } })), () => {}, m => logs.push(m));
    },
  };
}
const finding = (description = 'reachable nil dereference', extra = {}) => ({ file: 'a.go', line: 5, severity: 'issue', description, suggestedFix: 'guard before use', ...extra });
test('Go rules share three reads while preserving per-rule scope and severity', async t => {
  const r = runner(t, 'golang-check');
  const stems = Object.keys(r.meta).filter(s => s !== 'testing');
  const result = await r.run({ guidelines: stems.map(stem => ({ stem, files: [stem === 'modernizers' ? 'new.go' : 'a.go'] })) }, p => r.proof(p));
  assert.equal(result.stats.checkCalls, 3);
  assert.deepEqual(result.unverified, []);
  assert.ok(r.calls.some(c => c.prompt.includes('Files for this guideline: new.go')));
  assert.equal(r.calls.every(c => c.options.agentType === 'claude-skills:go-idiom-checker'), true);
});
test('a failed grouped proof retries only that rule and retains successful siblings', async t => {
  const r = runner(t, 'ts-check');
  let count = 0;
  const result = await r.run({ guidelines: [{ stem: 'strong-types' }, { stem: 'object-params' }], files: ['a.ts'] }, p => {
    const response = r.proof(p, p.includes('Guideline strong-types:') ? [{ file: 'a.ts', line: 2, rule: 'strong-types', description: 'unsafe parse', suggestedFix: 'decode input' }] : []);
    if (count++ === 0) response.guidelineProofs.find(x => x.stem === 'object-params').lineCount = -1;
    return response;
  });
  assert.equal(r.calls.length, 2);
  assert.ok(!r.calls[1].prompt.includes('Guideline strong-types:'));
  assert.deepEqual(result.unverified, []);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].priority, 1);
});
test('malformed findings are retried once, then reported unverified', async t => {
  const r = runner(t, 'ts-check');
  const result = await r.run({ guidelines: [{ stem: 'strong-types' }], files: ['a.ts'] }, p => r.proof(p, [{ file: 'outside.ts', line: -1, rule: 'strong-types' }]));
  assert.equal(r.calls.length, 2);
  assert.deepEqual(result.unverified, ['strong-types']);
  assert.equal(result.findingCount, 0);
});
test('terminal checker failure is a coverage gap without another retry loop', async t => {
  const r = runner(t, 'golang-check');
  const result = await r.run({ guidelines: [{ stem: 'errors', files: ['a.go'] }] }, () => null);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(result.unverified, ['errors']);
});
test('individual mode preserves all TS rules and canonical priorities', async t => {
  const r = runner(t, 'ts-check');
  const result = await r.run({ mode: 'individual', guidelines: Object.keys(r.meta).map(stem => ({ stem })), files: ['a.ts'] }, p => r.proof(p));
  assert.equal(result.stats.checkCalls, 5);
  assert.deepEqual(result.unverified, []);
  assert.ok(r.maximum <= 4);
});
test('standalone test verification is capped and retains missing/excess verdicts', async t => {
  const r = runner(t, 'test-check');
  const candidates = Array.from({ length: 37 }, (_, i) => ({ file: 'a_test.go', line: i + 1, endLine: i + 1, symbol: 'TestA', rule: 'assertion-fidelity', severity: 'error', confidence: 'high', description: `missing assertion ${i}`, rationale: 'bad output passes', action: 'assert output' }));
  const result = await r.run({ guidelines: [{ stem: 'assertion-fidelity' }], sourceFiles: ['a.go'], testFiles: ['a_test.go'] }, (p, o) => o.phase === 'Check' ? r.proof(p, candidates) : { verdicts: [] });
  assert.equal(result.stats.verifierCalls, 8);
  assert.equal(result.unchallenged.length, 37);
  assert.equal(result.findings.length, 37);
  assert.ok(result.findings.every(f => f.verified === false));
  assert.equal(result.unchallenged.filter(f => f.verificationReason === 'verifier budget exhausted').length, 5);
  assert.ok(r.maximum <= 4);
});
test('pipeline test mode defers independent challenge explicitly', async t => {
  const r = runner(t, 'test-check');
  const result = await r.run({ verify: false, guidelines: [{ stem: 'mock-expectations' }], sourceFiles: [], testFiles: ['a_test.go'] }, p => r.proof(p));
  assert.equal(result.verificationDeferred, true);
  assert.equal(result.stats.verifierCalls, 0);
});
test('review profiles bound finder fan-out while preserving a thorough escape hatch', async t => {
  for (const [profile, expected] of [['fast', 2], ['standard', 3], ['thorough', 16]]) {
    const r = runner(t, 'code-review');
    const result = await r.run({ files: ['a.go'], profile }, () => ({ findings: [] }));
    assert.equal(result.stats.finderCalls, expected);
    assert.equal(result.stats.verifierCalls, 0);
    assert.deepEqual(result.dimensionsUnverified, []);
    assert.ok(r.maximum <= 4);
    assert.equal(result.dimensionsSkipped.length, profile === 'fast' ? 6 : 0);
  }
});
test('deduplication happens before verification and preserves distinct same-line defects', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], verifyOnly: [finding('race', { dimension: 'concurrency' }), finding('race', { dimension: 'line-scan' }), finding('leak')] }, () => ({ verdicts: [{ id: 0, refuted: false, reason: 'race demonstrated' }, { id: 1, refuted: false, reason: 'leak demonstrated' }] }));
  assert.equal(result.stats.candidates, 2);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.stats.verifierCalls, 1);
  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.every(f => f.verified === true));
  assert.deepEqual(result.findings[0].dimensions, ['concurrency', 'line-scan']);
});
test('a missing verdict remains a finding and blocks an apparently clean review', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run(JSON.stringify({ files: ['a.go'], verifyOnly: [finding()] }), () => null);
  assert.equal(result.findings.length, 1);
  assert.equal(result.unchallenged.length, 1);
  assert.deepEqual(result.dimensionsUnverified, ['external']);
  assert.equal(result.findings[0].verified, false);
});
test('review verifier overflow has an explicit budget reason and four-agent concurrency', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], verifyOnly: Array.from({ length: 35 }, (_, i) => finding(`defect ${i}`, { line: i + 1 })) }, () => ({ verdicts: Array.from({ length: 4 }, (_, id) => ({ id, refuted: false, reason: 'proven' })) }));
  assert.equal(result.stats.verifierCalls, 8);
  assert.equal(result.unchallenged.length, 3);
  assert.equal(result.findings.length, 35);
  assert.ok(result.unchallenged.every(f => f.verificationReason === 'verifier budget exhausted'));
  assert.ok(r.maximum <= 4);
});
test('external test evidence reaches the independent challenger without a second finder', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], externalFindings: [{ ...finding(), rule: 'coverage', severity: 'error', suggestedFix: undefined, action: 'cover error path', guidelinePath: '/rules/coverage.md', coverageFile: '/artifacts/coverage.out' }] }, (p, o) => {
    if (o.phase === 'Find') return { findings: [] };
    assert.match(p, /\/rules\/coverage.md/);
    assert.match(p, /\/artifacts\/coverage.out/);
    return { verdicts: [{ id: 0, refuted: true, reason: 'existing test covers the path' }] };
  });
  assert.equal(result.findingCount, 0);
  assert.equal(result.refuted.length, 1);
});
test('essential review dimensions cannot be delegated away', async t => {
  const r = runner(t, 'code-review');
  await assert.rejects(r.run({ files: ['a.go'], coveredDimensions: ['security'] }, () => null), /essential dimension/);
});

test('equivalent invariant keys share one verdict across sources and retain evidence', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], verifyOnly: [
    finding('read may dereference a nil user', { dimension: 'line-scan', claimKey: 'read:user non-null:nil input' }),
    finding('missing guard before accessing user', { dimension: 'go/errors', claimKey: 'read:user non-null:nil input', guidelinePath: '/rules/errors.md' }),
    finding('other trigger', { claimKey: 'read:user non-null:lookup miss' }),
  ] }, p => {
    assert.match(p, /\/rules\/errors.md/);
    return { verdicts: [{ id: 0, refuted: false, reason: 'nil input demonstrated' }, { id: 1, refuted: false, reason: 'lookup miss demonstrated' }] };
  });
  assert.equal(result.stats.candidates, 2);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.stats.confirmed, 2);
  assert.ok(result.findings.every(f => f.verificationReason));
});

test('issues receive the verifier budget before earlier-file nits', async t => {
  const r = runner(t, 'code-review');
  const nits = Array.from({ length: 33 }, (_, i) => finding(`nit ${i}`, { severity: 'nit', line: i + 1 }));
  const result = await r.run({ files: ['a.go'], verifyOnly: [...nits, finding('data loss', { file: 'z.go' })] }, (p, o) => {
    if (o.label === 'verify:batch:0') assert.match(p, /ID 0\n[\s\S]*Claim: data loss/);
    return { verdicts: Array.from({ length: 4 }, (_, id) => ({ id, refuted: false, reason: 'demonstrated' })) };
  });
  assert.equal(result.findings.find(f => f.description === 'data loss').verified, true);
  assert.equal(result.unchallenged.length, 2);
  assert.ok(result.unchallenged.every(f => f.severity === 'nit'));
});

test('delegated test ownership avoids another test finder but retains core angles', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], coveredDimensions: ['tests'] }, p => {
    assert.ok(!p.includes('tests: Judge behavioral coverage'));
    return { findings: [] };
  });
  assert.deepEqual(result.dimensionsDelegated, ['tests']);
  assert.equal(result.stats.finderCalls, 3);
  assert.ok(r.calls.some(c => c.prompt.includes('security: Look for injection')));
});

test('standard review can request a gap sweep and records phase durations', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], sweep: true }, () => ({ findings: [] }));
  assert.equal(result.stats.finderCalls, 4);
  for (const key of ['findDurationMs', 'sweepDurationMs', 'verifyDurationMs']) assert.ok(result.stats[key] >= 0);
});

test('language checkers use the pinned PR checkout and delta command', async t => {
  const r = runner(t, 'ts-check');
  await r.run({ guidelines: [{ stem: 'strong-types' }], files: ['/worktree/a.ts'], repoDir: '/worktree', diffCommand: 'git -C /worktree diff oldsha newsha' }, p => {
    assert.match(p, /reviewed checkout is \/worktree/);
    assert.match(p, /git -C \/worktree diff oldsha newsha/);
    return r.proof(p);
  });
});
