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
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'staged.js');
    stage(skill === 'code-review' ? '-' : path.join(PLUGIN, 'skills', skill, 'guidelines'), path.join(PLUGIN, 'skills', skill, 'workflow.js'), out);
    source = fs.readFileSync(out, 'utf8');
    assert.ok(!source.includes('// GROUPED_CHECK_RUNTIME'));
  }
  // The real Workflow runtime prohibits wall clocks to keep resume deterministic.
  class SandboxDate {
    constructor() { throw new Error('new Date unavailable in Workflow'); }
    static now() { throw new Error('Date.now unavailable in Workflow'); }
  }
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', 'Date', source.replace('export const meta', 'const meta'));
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
      }, thunks => Promise.all(thunks.map(async f => { try { return await f(); } catch { return null; } })), () => {}, m => logs.push(m), SandboxDate);
    },
  };
}
const finding = (description = 'reachable nil dereference', extra = {}) => ({ file: 'a.go', line: 5, severity: 'issue', description, suggestedFix: 'guard before use', ...extra });
test('thorough grouped passes retain every angle and an incomplete sweep is a gap', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], profile: 'thorough' }, (p, o) => o.phase === 'Sweep'
    ? { findings: [finding('possible leak', { claimKey: 'A:resource closed:early return' })], reviewComplete: false, incompleteReason: '12 reads exhausted; early-return caller unresolved' }
    : o.phase === 'Verify' ? { verdicts: [{ id: 0, refuted: false, reason: 'resource leaks on early return' }] } : { findings: [] });
  for (const key of ['line-scan', 'removed-behavior', 'cross-file', 'language-pitfalls', 'wrapper-proxy', 'error-handling', 'type-invariants', 'security', 'tests', 'comments', 'conventions', 'reuse', 'simplification', 'efficiency', 'altitude']) {
    assert.ok(r.calls.some(c => c.options.phase === 'Find' && c.prompt.includes(`${key}:`)), key);
  }
  assert.deepEqual(result.dimensionsUnverified, ['sweep']);
  assert.equal(result.stats.confirmed, 1);
  assert.match(r.logs.join('\n'), /early-return caller unresolved/);
});
test('prior claims join the independent queue and omitted expected claims block completion', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], verifyOnly: [], priorFindings: [{ ...finding('old race'), priorId: 'github:123' }], expectedPriorIds: ['github:123', 'github:456'] }, (p, o) => {
    assert.equal(o.phase, 'Verify');
    assert.match(p, /prior review claim \(github:123\)/);
    return { verdicts: [{ id: 0, refuted: true, reason: 'new atomic guard closes race' }] };
  });
  assert.deepEqual(result.priorClaims, { expected: ['github:123', 'github:456'], challenged: ['github:123'], missing: ['github:456'] });
  assert.deepEqual(result.dimensionsUnverified, ['prior-review']);
});
test('a prior claim cannot be confirmed at its stale coordinate', async t => {
  for (const relocated of [false, true]) {
    const r = runner(t, 'code-review');
    const result = await r.run({ files: ['a.go'], verifyOnly: [], priorFindings: [{ ...finding(), priorId: 'old', needsRelocation: true }] }, () => ({ verdicts: [{ id: 0, refuted: false, reason: 'same defect moved', ...(relocated ? { file: 'renamed.go', line: 12 } : {}) }] }));
    assert.equal(result.stats.confirmed, relocated ? 1 : 0);
    assert.deepEqual(result.priorClaims.missing, relocated ? [] : ['old']);
    if (relocated) assert.equal(result.findings[0].file, 'renamed.go');
    else assert.match(result.unchallenged[0].verificationReason, /current source anchor/);
  }
});
test('structured invariant identity merges different prose and nearby anchors without merging triggers', async t => {
  const r = runner(t, 'code-review');
  const identity = { symbol: 'COM-1206 overlay docs', invariant: 'pointer locates overlay block', trigger: 'stale line range' };
  const result = await r.run({ files: ['a.go'], verifyOnly: [
    finding('stale pointer', { identity, claimKey: 'wording-one', line: 1264 }),
    finding('wrong documentation anchor', { identity, claimKey: 'wording-two', line: 1265 }),
    finding('wrong target section', { identity, claimKey: 'wording-three', priorIds: ['old-pointer'] }),
    finding('distinct target', { identity: { ...identity, trigger: 'renamed file' }, claimKey: 'wording-four' }),
  ] }, () => ({ verdicts: [{ id: 0, refuted: false, reason: 'block at different lines' }, { id: 1, refuted: false, reason: 'file renamed' }] }));
  assert.equal(result.stats.candidates, 2);
  assert.equal(result.stats.duplicates, 2);
  const merged = result.findings.find(f => f.priorIds?.includes('old-pointer'));
  assert.equal(merged.locations.length, 2);
});
test('checker validation gaps survive dispatch into the core result', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], verifyOnly: [], inputGaps: ['ts-check/strong-types'], inputRejectedFindings: [{ finding: null, rule: 'errors', validationErrors: ['invalid finding'] }] }, () => null);
  assert.deepEqual(result.dimensionsUnverified, ['external/errors', 'ts-check/strong-types']);
  assert.equal(result.rejectedFindings.length, 1);
});
test('legacy keys share one verdict with an unambiguous structured identity', async t => {
  const r = runner(t, 'code-review');
  const identity = { symbol: 'ReadUser', invariant: 'user non-null', trigger: 'nil input' };
  const result = await r.run({ files: ['a.go'], verifyOnly: [
    finding('missing guard', { identity, claimKey: 'ReadUser:user non-null:nil input' }),
    finding('older wording', { claimKey: 'ReadUser:user non-null:nil input', line: 6, priorIds: ['old'] }),
  ] }, () => ({ verdicts: [{ id: 0, refuted: true, reason: 'guard exists' }] }));
  assert.equal(result.stats.candidates, 1);
  assert.equal(result.stats.duplicates, 1);
  assert.deepEqual(result.priorClaims.challenged, ['old']);
});
test('conflicting identities and case-sensitive symbols retain distinct verdicts', async t => {
  const r = runner(t, 'code-review');
  const identity = { symbol: 'ReadUser', invariant: 'user non-null', trigger: 'nil input' };
  const result = await r.run({ files: ['a.go'], verifyOnly: [
    finding('one symbol', { identity, claimKey: 'same legacy key' }),
    finding('other symbol', { identity: { ...identity, symbol: 'readUser' }, claimKey: 'same legacy key' }),
    finding('ambiguous older claim', { claimKey: 'same legacy key' }),
  ] }, () => ({ verdicts: [0, 1, 2].map(id => ({ id, refuted: false, reason: 'distinct or unresolved claim' })) }));
  assert.equal(result.stats.candidates, 3);
  assert.equal(result.stats.duplicates, 0);
});
test('Go rules share three reads while preserving per-rule scope and severity', async t => {
  const r = runner(t, 'golang-check');
  const stems = Object.keys(r.meta).filter(s => s !== 'testing');
  const result = await r.run({ guidelines: stems.map(stem => ({ stem, files: [stem === 'modernizers' ? 'new.go' : 'a.go'] })) }, p => r.proof(p));
  assert.equal(result.stats.checkCalls, 3);
  assert.deepEqual(result.unverified, []);
  assert.ok(r.calls.some(c => c.prompt.includes('Files for this guideline: new.go')));
  assert.equal(r.calls.every(c => c.options.agentType === 'claude-skills:go-idiom-checker'), true);
  assert.ok(r.calls.every(c => c.options.schema.properties.findings.items.required.includes('identity')));
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
  assert.deepEqual(result.rejectedFindings, []);
  assert.match(r.calls[1].prompt, /Correct these previous output errors: proof lineCount mismatch/);
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
  const result = await r.run({ verify: false, coverageFile: '/coverage/report.json', guidelines: [{ stem: 'mock-expectations' }], sourceFiles: [], testFiles: ['a_test.go'] }, p => r.proof(p));
  assert.equal(result.verificationDeferred, true);
  assert.equal(result.stats.verifierCalls, 0);
  assert.equal(result.coverageFile, '/coverage/report.json');
});
test('review profiles bound finder fan-out while preserving a thorough escape hatch', async t => {
  for (const [profile, expected] of [['fast', 2], ['standard', 3], ['thorough', 6]]) {
    const r = runner(t, 'code-review');
    const result = await r.run({ files: ['a.go'], profile }, () => ({ findings: [], reviewComplete: true, incompleteReason: '' }));
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

test('standard gap sweep completes with sandbox clocks denied and leaves timing to metadata', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], sweep: true }, () => ({ findings: [], reviewComplete: true, incompleteReason: '' }));
  assert.equal(result.stats.finderCalls, 4);
  for (const key of ['durationMs', 'findDurationMs', 'sweepDurationMs', 'verifyDurationMs']) assert.equal(Object.hasOwn(result.stats, key), false);
});

test('absolute Go scope accepts relative findings and macOS temp aliases without retry', async t => {
  const r = runner(t, 'golang-check');
  const result = await r.run({ repoDir: '/private/tmp/review/wt', guidelines: [{ stem: 'errors', files: ['/tmp/review/wt/internal/client.go'] }] }, p => r.proof(p, [{
    file: 'internal/./client.go', line: 10, symbol: 'MakeRequest', rule: 'errors',
    severity: 'error', confidence: 'high', description: 'body read error is discarded', suggestedFix: 'return the error',
  }]));
  assert.equal(result.stats.checkCalls, 1);
  assert.deepEqual(result.unverified, []);
  assert.equal(result.findings[0].file, 'internal/client.go');
  assert.deepEqual(result.rejectedFindings, []);
});

test('relative TS scope accepts absolute findings inside the pinned checkout', async t => {
  const r = runner(t, 'ts-check');
  const result = await r.run({ repoDir: '/worktree', files: ['src/a.ts'], guidelines: [{ stem: 'strong-types' }] }, p => r.proof(p, [{
    file: '/worktree/src/a.ts', line: 3, rule: 'strong-types', description: 'unsafe decode', suggestedFix: 'validate input',
  }]));
  assert.equal(result.stats.checkCalls, 1);
  assert.equal(result.findings[0].file, 'src/a.ts');
});

test('real-session test finding with relative path survives absolute scope validation', async t => {
  const r = runner(t, 'test-check');
  const result = await r.run({ repoDir: '/private/tmp/review/wt', verify: false,
    sourceFiles: ['/tmp/review/wt/stock-availability/base/headless/client.go'],
    testFiles: ['/tmp/review/wt/stock-availability/base/headless/client_test.go'],
    guidelines: [{ stem: 'assertion-strictness' }],
  }, p => r.proof(p, [{ file: 'stock-availability/base/headless/client_test.go', line: 376, endLine: 376,
    symbol: 'TestMakeRequest', rule: 'assertion-strictness', severity: 'warning', confidence: 'high',
    description: '429 test only checks a substring', rationale: 'wrong error type passes', action: 'assert the error type',
  }]));
  assert.equal(result.stats.checkCalls, 1);
  assert.equal(result.findingCount, 1);
  assert.deepEqual(result.unverified, []);
});

test('path normalization rejects checkout escapes and preserves specific errors', async t => {
  for (const file of ['../src/a.ts', '/worktree-other/src/a.ts', '/worktree/../outside/a.ts', '/outside/src/a.ts']) {
    const r = runner(t, 'ts-check');
    const result = await r.run({ repoDir: '/worktree', files: ['src/a.ts'], guidelines: [{ stem: 'strong-types' }] }, p => r.proof(p, [{
      file, line: 1, rule: 'strong-types', description: 'claim', suggestedFix: 'fix',
    }]));
    assert.equal(result.findingCount, 0);
    assert.deepEqual(result.unverified, ['strong-types']);
    assert.ok(result.rejectedFindings.every(f => f.finding.file === file));
    assert.ok(r.logs.every(log => !log.includes('proof')));
    assert.ok(r.logs.every(log => log.includes('file outside guideline scope')));
  }
});

test('invalid absolute scopes without repoDir are explicit gaps without model calls', async t => {
  const r = runner(t, 'ts-check');
  const result = await r.run({ files: ['/worktree/src/a.ts'], guidelines: [{ stem: 'strong-types' }] }, () => { throw new Error('must not dispatch'); });
  assert.equal(result.stats.checkCalls, 0);
  assert.deepEqual(result.unverified, ['strong-types']);
  assert.match(r.logs[0], /absolute scope without repoDir/);
});

test('external implementer summary and trigger reach independent challenge', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ repoDir: '/worktree', files: ['app/handler.go'], verifyOnly: [{
    file: '/worktree/app/handler.go', line: 1000, severity: 'issue', rule: 'candidate-from-implementer',
    summary: 'Disabled draft is served', failure_scenario: 'Storefront disabled after assignment', suggestedFix: 'check enabled before serving',
  }] }, p => {
    assert.match(p, /Claim: Disabled draft is served\nTrigger: Storefront disabled after assignment/);
    assert.match(p, /File: app\/handler.go/);
    return { verdicts: [{ id: 0, refuted: false, reason: 'disabled draft request demonstrates it' }] };
  });
  assert.equal(result.stats.verifierCalls, 1);
  assert.equal(result.stats.confirmed, 1);
  assert.deepEqual(result.dimensionsUnverified, []);
  assert.deepEqual(result.rejectedFindings, []);
});

test('malformed external claims retain their details and stay distinct from unchallenged', async t => {
  const r = runner(t, 'code-review');
  const malformed = finding('disabled draft', { file: '../outside.go', suggestedFix: '', dimension: 'implementer' });
  const result = await r.run({ files: ['a.go'], verifyOnly: [malformed, null] }, () => { throw new Error('must not challenge invalid input'); });
  assert.equal(result.stats.verifierCalls, 0);
  assert.equal(result.rejectedFindings.length, 2);
  assert.equal(result.rejectedFindings[0].finding.description, 'disabled draft');
  assert.ok(result.rejectedFindings[0].validationErrors.some(e => e.includes('suggestedFix')));
  assert.ok(result.dimensionsUnverified.includes('implementer'));
  assert.deepEqual(result.unchallenged, []);
  assert.equal(result.stats.rejected, 2);
});

test('absolute and relative claim paths deduplicate before challenge', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ repoDir: '/worktree', files: ['a.go'], verifyOnly: [finding('race'), finding('race', { file: '/worktree/./a.go' })] }, () => ({ verdicts: [{ id: 0, refuted: false, reason: 'race reproduced' }] }));
  assert.equal(result.stats.candidates, 1);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.stats.verifierCalls, 1);
});

test('material nit policy never drops reported issues or existing claims before challenge', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ files: ['a.go'], nitPolicy: 'material', verifyOnly: [
    ...Array.from({ length: 5 }, (_, i) => finding(`issue ${i}`, { line: i + 1 })),
    ...Array.from({ length: 5 }, (_, i) => finding(`existing nit ${i}`, { severity: 'nit', line: i + 6 })),
  ] }, () => ({ verdicts: Array.from({ length: 4 }, (_, id) => ({ id, refuted: false, reason: 'proven' })) }));
  assert.equal(result.stats.confirmed, 10);
  assert.deepEqual(result.unchallenged, []);
  await assert.rejects(r.run({ files: ['a.go'], nitPolicy: 'typo' }, () => null), /nitPolicy/);
});

test('a corrected checker retry leaves no rejected claim blocking a complete result', async t => {
  const r = runner(t, 'ts-check');
  let attempt = 0;
  const result = await r.run({ files: ['a.ts'], guidelines: [{ stem: 'strong-types' }] }, p => r.proof(p, [{
    file: attempt++ === 0 ? 'outside.ts' : 'a.ts', line: 1, rule: 'strong-types', description: 'unsafe parse', suggestedFix: 'validate',
  }]));
  assert.equal(result.stats.checkCalls, 2);
  assert.equal(result.findingCount, 1);
  assert.deepEqual(result.unverified, []);
  assert.deepEqual(result.rejectedFindings, []);
  assert.match(r.calls[1].prompt, /file outside guideline scope/);
});

test('finder absolute paths normalize without losing independent verification', async t => {
  const r = runner(t, 'code-review');
  const result = await r.run({ repoDir: '/worktree', files: ['a.go'], profile: 'fast' }, (p, o) => {
    if (o.phase === 'Find') return { findings: o.label.includes('line-scan') ? [finding('race', { file: '/worktree/a.go', dimension: 'line-scan' })] : [] };
    return { verdicts: [{ id: 0, refuted: false, reason: 'race reproduced' }] };
  });
  assert.equal(result.stats.confirmed, 1);
  assert.equal(result.findings[0].file, 'a.go');
});

test('language checkers use the pinned PR checkout and delta command', async t => {
  const r = runner(t, 'ts-check');
  await r.run({ guidelines: [{ stem: 'strong-types' }], files: ['/worktree/a.ts'], repoDir: '/worktree', diffCommand: 'git -C /worktree diff oldsha newsha' }, p => {
    assert.match(p, /reviewed checkout is \/worktree/);
    assert.match(p, /git -C \/worktree diff oldsha newsha/);
    return r.proof(p);
  });
});
