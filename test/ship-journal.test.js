// Locks the ship-task gate: a PR opens only when every stage's latest entry passed
// on the reviewed revision, and byte/attribution scans record their own outcome.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const manifest = require('../plugins/claude-skills/scripts/task-manifest');
const journal = require('../plugins/claude-skills/scripts/ship-journal');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'claude-skills', 'scripts', 'ship-journal.js');

function git(repo, ...argv) {
  const r = spawnSync('git', ['-C', repo, ...argv], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);

  return r.stdout.trim();
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const repo = path.join(root, 'repo');
  const out = path.join(root, 'ship-task');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.go'), 'package a\n\n// caf\u00e9 predates the task\nvar X = 1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  manifest.init(repo, out, 'main');

  return { repo, out };
}

function passAll(out, body) {
  for (const stage of journal.STAGES) journal.record(out, stage, 'pass', 'ok');

  fs.writeFileSync(body, '## Change\n\nFixes the thing.\n');
}

test('byte scan flags only non-ASCII on task-added .go lines, with its line number', t => {
  const { repo, out } = setup(t);
  fs.writeFileSync(path.join(repo, 'a.go'), 'package a\n\n// caf\u00e9 predates the task\nvar X = 1\n++\u2800\nvar Y = "\u00a0"\nvar Z = "\\u00a0"\n');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'na\u00efve\n');
  manifest.refresh(out);

  assert.deepEqual(journal.checkBytes(out), ['a.go:5: U+2800', 'a.go:6: U+00A0']);
  assert.equal(journal.gate(out, null).problems.some(p => p.startsWith('byte-safety: fail')), true);
});

test('gate passes only when every stage passed on the current revision and the body is clean', t => {
  const { repo, out } = setup(t);
  const body = path.join(out, 'pr-body.md');
  passAll(out, body);
  assert.deepEqual(journal.gate(out, body), { ok: true, problems: [] });

  fs.writeFileSync(path.join(repo, 'a.go'), 'package a\n\nvar X = 2\n');
  manifest.refresh(out);
  const stale = journal.gate(out, body).problems;
  assert.equal(stale.length, 4);
  assert.match(stale[0], /^preflight-lint: recorded for manifest/);

  passAll(out, body);
  git(repo, 'commit', '-qam', 'later');
  assert.match(journal.gate(out, body).problems[0], /^stacked-branch: recorded at/);
});

test('a later fail overrides an earlier pass, and na needs an allowed stage', t => {
  const { out } = setup(t);
  const body = path.join(out, 'pr-body.md');
  passAll(out, body);
  journal.record(out, 'review', 'fail', 'round 3 still has 1 confirmed finding');
  assert.deepEqual(journal.gate(out, body).problems, ['review: fail (round 3 still has 1 confirmed finding)']);

  journal.record(out, 'test-first', 'na', 'feature, not a bug fix');
  assert.throws(() => journal.record(out, 'review', 'na', 'skip'), /review cannot be na/);
  assert.throws(() => journal.record(out, 'attribution', 'pass', ' '), /Evidence/);
});

test('attribution is checked in the scanned files and re-checked in the PR body at the gate', t => {
  const { out } = setup(t);
  const body = path.join(out, 'pr-body.md');
  const msg = path.join(out, 'commit-msg.txt');
  passAll(out, body);
  fs.writeFileSync(msg, 'fix(a): x\n\nCo-Authored-By: someone\n');
  assert.deepEqual(journal.checkAttribution(out, [msg, body]), [`${msg}: remove co-author line`]);

  journal.record(out, 'attribution', 'pass', 'rescanned');
  fs.writeFileSync(body, 'Done.\n\n\u{1F916} Generated with Claude\n');
  assert.deepEqual(journal.gate(out, body).problems.sort(), [`attribution: ${body}: remove 'generated with claude' line`, `attribution: ${body}: remove \u{1F916} emoji`].sort());
});

test('cli gate exits non-zero and refuses the PR when a stage is missing', t => {
  const { out } = setup(t);
  const body = path.join(out, 'pr-body.md');
  fs.writeFileSync(body, 'ok\n');
  const r = spawnSync('node', [SCRIPT, 'gate', out, body], { encoding: 'utf8' });

  assert.equal(r.status, 1);
  assert.match(r.stdout, /GATE FAIL: do not open the PR/);
  assert.match(r.stdout, /review: no journal entry/);
});
