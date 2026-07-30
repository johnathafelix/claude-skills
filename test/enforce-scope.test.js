// The two skip() matrices. These encode a deliberate asymmetry that is easy to
// "fix" by mistake: golang-check EXCLUDES _test.go, ts-check INCLUDES tests.
// Each row is a real scope decision, so a change here is a change to what the
// hooks enforce.
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers/transcript');

const R = h.REPO;

// [path, shouldBlock, why]
const GO_CASES = [
  [R + '/pkg/store.go', true, 'plain Go source'],
  [R + '/main.go', true, 'top-level Go source'],
  [R + '/pkg/store_test.go', false, '_test.go is outside golang-check default scope'],
  [R + '/vendor/x/y.go', false, 'vendored dependency'],
  [R + '/.claude/hooks/x.go', false, 'claude infra'],
  [R + '/api/svc.pb.go', false, 'protobuf generated'],
  [R + '/api/model_gen.go', false, 'generated (_gen.go)'],
  [R + '/api/model.gen.go', false, 'generated (.gen.go)'],
  ['/tmp/scratch.go', false, 'temp tree'],
  ['/private/tmp/scratch.go', false, 'temp tree'],
  ['/var/folders/ab/scratch.go', false, 'macOS temp tree'],
  ['/private/var/folders/ab/scratch.go', false, 'macOS temp tree'],
  [R + '/README.md', false, 'not Go'],
  [R + '/src/store.ts', false, 'not Go'],
  [R + '/pkg/gopher.gojson', false, 'does not end in .go'],
];

const TS_CASES = [
  [R + '/src/store.ts', true, 'plain TS source'],
  [R + '/src/App.tsx', true, 'TSX source'],
  [R + '/src/store.test.ts', true, 'tests are INCLUDED in ts-check scope'],
  [R + '/src/App.test.tsx', true, 'tsx tests are INCLUDED'],
  [R + '/src/types.d.ts', false, 'declaration file'],
  [R + '/node_modules/x/y.ts', false, 'dependency'],
  [R + '/.claude/hooks/x.ts', false, 'claude infra'],
  [R + '/src/api.gen.ts', false, 'generated'],
  [R + '/src/api.gen.tsx', false, 'generated tsx'],
  ['/tmp/scratch.ts', false, 'temp tree'],
  ['/var/folders/ab/scratch.ts', false, 'macOS temp tree'],
  [R + '/pkg/store.go', false, 'not TS'],
  [R + '/README.md', false, 'not TS'],
];

function assertScope(hookName, cases) {
  for (const [file, shouldBlock, why] of cases) {
    const label = (shouldBlock ? 'blocks on ' : 'skips ') + file + ' (' + why + ')';

    test(hookName + ': ' + label, () => {
      const r = h.runHook(hookName, h.stopInput(h.turnEditing([file])));

      assert.strictEqual(r.status, 0);

      if (shouldBlock) {
        assert.ok(r.parsed, 'expected a block for ' + file + ' — ' + why);
        assert.strictEqual(r.parsed.decision, 'block');
      } else {
        assert.strictEqual(r.stdout.trim(), '', 'expected silence for ' + file + ' — ' + why);
      }
    });
  }
}

assertScope('enforce-golang-check.js', GO_CASES);
assertScope('enforce-ts-check.js', TS_CASES);

test('the two hooks disagree about test files on purpose', () => {
  // A single assertion that fails loudly if someone "unifies" the predicates.
  const goTest = h.runHook(
    'enforce-golang-check.js',
    h.stopInput(h.turnEditing([R + '/pkg/store_test.go'])),
  );
  const tsTest = h.runHook(
    'enforce-ts-check.js',
    h.stopInput(h.turnEditing([R + '/src/store.test.ts'])),
  );

  assert.strictEqual(goTest.stdout.trim(), '', 'golang-check must EXCLUDE _test.go');
  assert.ok(tsTest.parsed, 'ts-check must INCLUDE .test.ts');
});

test('an out-of-scope edit alongside an in-scope one still blocks', () => {
  const tp = h.turnEditing([R + '/pkg/store_test.go', R + '/pkg/store.go']);
  const r = h.runHook('enforce-golang-check.js', h.stopInput(tp));

  assert.ok(r.parsed);
  assert.match(r.parsed.reason, /\(1 file\)/, 'only the in-scope file should be counted');
});
