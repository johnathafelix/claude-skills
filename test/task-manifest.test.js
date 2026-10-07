const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { init, refresh, repositorySnapshot } = require('../plugins/claude-skills/scripts/task-manifest');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), out = path.join(root, 'artifacts');
  fs.mkdirSync(repo);
  const git = (...argv) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Manifest Test', '-c', 'user.email=manifest@example.invalid', '-C', repo, ...argv], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
  git('init', '-b', 'main');
  write('a.go', 'package a\n\nfunc A() int { return 1 }\n');
  write('delete.go', 'package a\n');
  write('staged.txt', 'original\n');
  git('add', '.'); git('commit', '-m', 'baseline');
  return { repo, out, git, write };
}
test('task scope excludes existing dirt, includes additions/deletions and preserves index', t => {
  const f = fixture(t);
  f.write('a.go', 'package a\n\nfunc A() int { return 2 }\n');
  f.write('existing.txt', 'existing untracked\n');
  f.write('staged.txt', 'user staged\n'); f.git('add', 'staged.txt');
  const beforeIndex = f.git('diff', '--cached');
  const baseline = init(f.repo, f.out);
  assert.equal(baseline.files.length, 0);
  f.write('a.go', 'package a\n\nfunc A() int { return 3 }\n');
  f.write('new file.go', 'package a\nfunc B() {}\n');
  fs.unlinkSync(path.join(f.repo, 'delete.go'));
  const manifest = refresh(f.out);
  assert.deepEqual(manifest.files.map(f => [f.path, f.status]), [['a.go', 'modified'], ['delete.go', 'deleted'], ['new file.go', 'added']]);
  const entry = manifest.files[0];
  assert.equal(entry.baselineDirty, true);
  assert.match(fs.readFileSync(entry.patchPath, 'utf8'), /-func A\(\) int \{ return 2 \}/);
  assert.deepEqual(entry.changedRanges, [{ start: 3, end: 3 }]);
  assert.equal(f.git('diff', '--cached'), beforeIndex);
  assert.equal(fs.readFileSync(path.join(f.repo, 'existing.txt'), 'utf8'), 'existing untracked\n');
});
test('manifest baseline stays pinned across a task commit and tracks renamed files', t => {
  const f = fixture(t); init(f.repo, f.out);
  fs.renameSync(path.join(f.repo, 'a.go'), path.join(f.repo, 'renamed.go'));
  const beforeCommit = refresh(f.out);
  f.git('add', '.'); f.git('commit', '-m', 'rename');
  const afterCommit = refresh(f.out);
  assert.equal(afterCommit.revision, beforeCommit.revision);
  assert.deepEqual(afterCommit.files.map(e => [e.path, e.status]), [['a.go', 'deleted'], ['renamed.go', 'added']]);
  assert.notEqual(afterCommit.repositorySnapshot, beforeCommit.repositorySnapshot);
});
test('fingerprints invalidate coverage on test/config/untracked input changes', t => {
  const f = fixture(t);
  const original = repositorySnapshot(f.repo);
  f.write('a_test.go', 'package a\n');
  const withTest = repositorySnapshot(f.repo);
  assert.notEqual(withTest, original);
  f.write('a_test.go', 'package a\n// changed fixture\n');
  assert.notEqual(repositorySnapshot(f.repo), withTest);
  f.write('test-config.json', '{}\n');
  const config = repositorySnapshot(f.repo);
  f.write('test-config.json', '{"mode":"integration"}\n');
  assert.notEqual(repositorySnapshot(f.repo), config);
});
test('symlinks, executable modes, empty additions and excluded plans remain explicit', t => {
  const f = fixture(t); init(f.repo, f.out, 'main', ['.claude/plans']);
  f.write('empty.txt', '');
  f.write('run.sh', '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(f.repo, 'run.sh'), 0o755);
  fs.symlinkSync('a.go', path.join(f.repo, 'link.go'));
  f.write('.claude/plans/current.md', 'scratch plan');
  const manifest = refresh(f.out);
  assert.deepEqual(manifest.files.map(e => e.path), ['empty.txt', 'link.go', 'run.sh']);
  assert.equal(manifest.files.find(e => e.path === 'link.go').afterMode, '120000');
  assert.equal(manifest.files.find(e => e.path === 'run.sh').afterMode, '100755');
  assert.equal(manifest.files.find(e => e.path === 'empty.txt').status, 'added');
});
test('review revision changes on deletion/restoration and resets are rejected', t => {
  const f = fixture(t); const baseline = init(f.repo, f.out);
  fs.unlinkSync(path.join(f.repo, 'delete.go'));
  assert.notEqual(refresh(f.out).revision, baseline.revision);
  f.write('delete.go', 'package a\n');
  assert.equal(refresh(f.out).revision, baseline.revision);
  assert.throws(() => init(f.repo, f.out), /already exists/);
  assert.throws(() => init(f.repo, path.join(f.repo, 'artifacts')), /outside/);
});
