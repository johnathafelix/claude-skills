#!/usr/bin/env node
// Pass/fail journal for ship-task stages; `gate` refuses a PR unless every stage passed.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FORBIDDEN } = require('../hooks/gh-pr-guard');

// Stages before commit are keyed to the reviewed manifest revision; stacked-branch to the final HEAD.
const REVISION_STAGES = ['preflight-lint', 'byte-safety', 'test-first', 'review'];
const STAGES = [...REVISION_STAGES, 'attribution', 'stacked-branch'];

// A stage may be not-applicable only with a reason: no Go files, or not a bug fix.
const NA_ALLOWED = new Set(['preflight-lint', 'byte-safety', 'test-first']);

const journalPath = dir => path.join(dir, 'journal.jsonl');

function manifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

function head(repo) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'git rev-parse HEAD failed');

  return r.stdout.trim();
}

function record(dir, stage, status, evidence) {
  if (!STAGES.includes(stage)) throw new Error(`Unknown stage ${stage}; use ${STAGES.join(', ')}`);
  if (!['pass', 'fail', 'na'].includes(status)) throw new Error('Status must be pass, fail or na');
  if (status === 'na' && !NA_ALLOWED.has(stage)) throw new Error(`${stage} cannot be na`);
  if (!evidence?.trim()) throw new Error('Evidence (command, result or reason) is required');

  const m = manifest(dir);
  const entry = { stage, status, evidence: evidence.trim(), revision: m.revision, head: head(m.repo), at: new Date().toISOString() };
  fs.appendFileSync(journalPath(dir), JSON.stringify(entry) + '\n');

  return entry;
}

// Task-added lines of .go files must be pure ASCII; intended characters are written as \u escapes.
function byteFindings(dir) {
  const findings = [];

  for (const file of manifest(dir).files) {
    if (!file.path.endsWith('.go') || file.status === 'deleted') continue;

    let line = 0;
    for (const row of fs.readFileSync(file.patchPath, 'utf8').split('\n')) {
      const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { line = Number(hunk[1]); continue; }

      // Header rows (diff/---/+++) precede the first hunk; inside a hunk "+++x" is an added "++x".
      if (!line) continue;

      if (row.startsWith('+')) {
        const odd = [...row.slice(1)].filter(c => c.codePointAt(0) > 0x7f);
        if (odd.length) findings.push(`${file.path}:${line}: ${odd.map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')}`);
      }

      if (!row.startsWith('-') && !row.startsWith('\\')) line++;
    }
  }

  return findings;
}

function attributionFindings(files) {
  return files.flatMap(file => {
    const text = fs.readFileSync(file, 'utf8');

    return FORBIDDEN.filter(({ re }) => re.test(text)).map(({ msg }) => `${file}: ${msg}`);
  });
}

function checkBytes(dir) {
  const findings = byteFindings(dir);
  const evidence = findings.length ? findings.join('; ') : 'no non-ASCII bytes in task-added .go lines';
  record(dir, 'byte-safety', findings.length ? 'fail' : 'pass', evidence);

  return findings;
}

function checkAttribution(dir, files) {
  if (!files.length) throw new Error('Pass the commit message and PR body files');

  const findings = attributionFindings(files);
  record(dir, 'attribution', findings.length ? 'fail' : 'pass', findings.length ? findings.join('; ') : `clean: ${files.join(', ')}`);

  return findings;
}

// Latest entry per stage must be pass/na on the current revision or HEAD; the PR body is re-scanned.
function gate(dir, bodyFile) {
  const m = manifest(dir);
  const current = head(m.repo);
  const latest = new Map();
  const lines = fs.existsSync(journalPath(dir)) ? fs.readFileSync(journalPath(dir), 'utf8').split('\n').filter(Boolean) : [];
  for (const entry of lines.map(line => JSON.parse(line))) latest.set(entry.stage, entry);

  const problems = [];
  for (const stage of STAGES) {
    const entry = latest.get(stage);
    if (!entry) { problems.push(`${stage}: no journal entry`); continue; }

    if (!['pass', 'na'].includes(entry.status)) problems.push(`${stage}: ${entry.status} (${entry.evidence})`);
    else if (REVISION_STAGES.includes(stage) && entry.revision !== m.revision) problems.push(`${stage}: recorded for manifest ${entry.revision.slice(0, 12)}, current is ${m.revision.slice(0, 12)}`);
    else if (stage === 'stacked-branch' && entry.head !== current) problems.push(`${stage}: recorded at ${entry.head.slice(0, 12)}, HEAD is ${current.slice(0, 12)}`);
  }

  if (!bodyFile) problems.push('attribution: no PR body file given to re-scan');
  else problems.push(...attributionFindings([bodyFile]).map(f => `attribution: ${f}`));

  return { ok: problems.length === 0, problems };
}

if (require.main === module) {
  try {
    const [command, dir, ...rest] = process.argv.slice(2);
    if (!dir) throw new Error('Use record|check-bytes|check-attribution|gate <artifact-directory> ...');

    let failed = false;
    if (command === 'record') console.log(JSON.stringify(record(dir, rest[0], rest[1], rest.slice(2).join(' '))));
    else if (command === 'check-bytes' || command === 'check-attribution') {
      const findings = command === 'check-bytes' ? checkBytes(dir) : checkAttribution(dir, rest);
      findings.forEach(f => console.log(f));
      failed = findings.length > 0;
    } else if (command === 'gate') {
      const result = gate(dir, rest[0]);
      console.log(result.ok ? 'GATE PASS: every stage passed' : 'GATE FAIL: do not open the PR\n- ' + result.problems.join('\n- '));
      failed = !result.ok;
    } else throw new Error('Use record, check-bytes, check-attribution or gate');

    if (failed) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 2; }
}

module.exports = { STAGES, record, byteFindings, attributionFindings, checkBytes, checkAttribution, gate };
