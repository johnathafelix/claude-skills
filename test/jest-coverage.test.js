const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare } = require('../plugins/claude-skills/scripts/jest-coverage');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jest-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), cwd = path.join(repo, 'package'), out = path.join(root, 'out');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'jest.config.js'), 'module.exports = {rootDir:".", globalSetup:"./setup.js", globalTeardown:"./teardown.js", testEnvironment:"node"}\n');
  const sources = Array.from({ length: 26 }, (_, i) => `package/source ${i}.js`);
  for (const f of [...sources, 'package/a.test.js']) fs.writeFileSync(path.join(repo, f), 'module.exports = 1;\n');
  return { repo, cwd, out, plan: { config: 'package/jest.config.js', runner: ['node', 'jest.js'], sourceFiles: sources, testFiles: ['package/a.test.js'] } };
}
test('all 26 expected sources reach generated Jest config and original setup survives', t => {
  const f = fixture(t), spec = prepare(f.repo, f.cwd, f.out, f.plan);
  const config = require(spec.config);
  assert.equal(config.collectCoverageFrom.length, 26);
  assert.deepEqual(config.collectCoverageFrom, f.plan.sourceFiles.map(s => s.slice('package/'.length)));
  assert.equal(config.globalSetup, './setup.js');
  assert.equal(config.globalTeardown, './teardown.js');
  assert.deepEqual(spec.command.slice(-2), ['--runTestsByPath', fs.realpathSync(path.join(f.cwd, 'a.test.js'))]);
  assert.equal(spec.report, path.join(fs.realpathSync(f.out), 'coverage-final.json'));
});
test('a source from another workspace cannot be silently omitted by a scoped runner', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'elsewhere.js'), 'module.exports=1;');
  assert.throws(() => prepare(f.repo, f.cwd, f.out, { ...f.plan, sourceFiles: ['elsewhere.js'] }), /owning workspace/);
  assert.throws(() => prepare(f.repo, f.cwd, f.cwd, f.plan), /artifacts outside/);
});
