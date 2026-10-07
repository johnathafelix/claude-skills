#!/usr/bin/env node
// Keep review scope independent of pre-existing dirt, the index and later commits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function git(repo, argv, allowFailure = false) {
  const r = spawnSync('git', ['-C', repo, ...argv], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFailure) throw new Error(r.stderr?.toString() || `git ${argv[0]} failed`);
  return r.status === 0 ? r.stdout : null;
}
const names = data => (data?.toString().split('\0') || []).filter(Boolean);
function canonicalLocation(location) {
  let ancestor = path.resolve(location);
  const suffix = [];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}
function files(repo) {
  return [...new Set([...names(git(repo, ['ls-files', '-z'])), ...names(git(repo, ['ls-files', '--others', '--exclude-standard', '-z']))])].sort();
}
function current(repo, name) {
  const file = path.join(repo, name);
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (stat.isSymbolicLink()) return { mode: '120000', data: Buffer.from(fs.readlinkSync(file)) };
  if (!stat.isFile()) throw new Error(`Unsupported path (directory or submodule): ${name}`);
  return { mode: stat.mode & 0o111 ? '100755' : '100644', data: fs.readFileSync(file) };
}
function ignored(name, excludes) { return excludes.some(x => name === x || name.startsWith(x.replace(/\/$/, '') + '/')); }
function repositorySnapshot(repo, excludes = []) {
  const digest = crypto.createHash('sha256');
  digest.update(git(repo, ['rev-parse', 'HEAD']));
  for (const name of files(repo).filter(f => !ignored(f, excludes))) {
    const entry = current(repo, name);
    digest.update(JSON.stringify([name, entry?.mode || null, entry ? hash(entry.data) : null]));
  }
  return digest.digest('hex');
}
function init(repo, out, base = 'main', excludes = []) {
  repo = fs.realpathSync(repo); out = canonicalLocation(out);
  if (out === repo || out.startsWith(repo + path.sep)) throw new Error('Put manifest artifacts outside the repository');
  if (fs.existsSync(path.join(out, 'baseline.json'))) throw new Error('Baseline already exists; refresh it, do not reset it');
  fs.mkdirSync(path.join(out, 'baseline'), { recursive: true });
  const head = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  const initialFiles = files(repo).filter(f => !ignored(f, excludes));
  const dirty = new Set([...names(git(repo, ['diff', 'HEAD', '--name-only', '-z'])), ...names(git(repo, ['ls-files', '--others', '--exclude-standard', '-z']))]);
  const modes = {};
  for (const row of names(git(repo, ['ls-tree', '-r', '-z', head]))) {
    const tab = row.indexOf('\t'); modes[row.slice(tab + 1)] = row.slice(0, tab).split(' ')[0];
  }
  const saved = {};
  for (const name of dirty) {
    if (ignored(name, excludes)) continue;
    const entry = current(repo, name);
    if (!entry) { saved[name] = null; continue; }
    const backup = path.join(out, 'baseline', hash(name));
    fs.writeFileSync(backup, entry.data);
    saved[name] = { mode: entry.mode, backup };
  }
  // Include pre-existing deletions in the baseline so a later restoration is visible.
  const state = { repo, out, head, base, excludes, initialFiles: [...new Set([...initialFiles, ...Object.keys(saved)])].sort(), modes, saved };
  fs.writeFileSync(path.join(out, 'baseline.json'), JSON.stringify(state, null, 2));
  return refresh(out);
}
function refresh(out) {
  out = path.resolve(out);
  const state = JSON.parse(fs.readFileSync(path.join(out, 'baseline.json'), 'utf8'));
  const { repo, head, excludes, saved, modes } = state;
  const targets = [...new Set([...state.initialFiles, ...files(repo)])].filter(f => !ignored(f, excludes)).sort();
  fs.mkdirSync(path.join(out, 'patches'), { recursive: true });
  const entries = [];
  for (const name of targets) {
    const wasDirty = Object.hasOwn(saved, name);
    let before = null;
    if (wasDirty) {
      if (saved[name]) before = { mode: saved[name].mode, data: fs.readFileSync(saved[name].backup) };
    } else if (modes[name]) {
      if (modes[name] === '160000') throw new Error(`Submodule requires explicit review scope: ${name}`);
      before = { mode: modes[name], data: git(repo, ['show', `${head}:${name}`]) };
    }
    const after = current(repo, name);
    if (!before && !after) continue;
    if (before && after && before.mode === after.mode && before.data.equals(after.data)) continue;
    const stem = hash(name);
    const oldFile = path.join(out, 'patches', stem + '.old');
    const newFile = path.join(out, 'patches', stem + '.new');
    fs.writeFileSync(oldFile, before?.data || Buffer.alloc(0));
    fs.writeFileSync(newFile, after?.data || Buffer.alloc(0));
    const result = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--binary', '-U3', '--', oldFile, newFile], { maxBuffer: 64 * 1024 * 1024 });
    if (![0, 1].includes(result.status)) throw new Error(result.stderr?.toString() || 'Cannot build task patch');
    let patch = result.stdout.toString().replace(/^diff --git .*$/m, `diff --git ${JSON.stringify('a/' + name)} ${JSON.stringify('b/' + name)}`)
      .replace(/^--- .*$/m, `--- ${before ? JSON.stringify('a/' + name) : '/dev/null'}`)
      .replace(/^\+\+\+ .*$/m, `+++ ${after ? JSON.stringify('b/' + name) : '/dev/null'}`);
    if (before?.mode !== after?.mode) patch = `Mode: ${before?.mode || 'absent'} -> ${after?.mode || 'absent'}\n` + patch;
    const patchPath = path.join(out, 'patches', stem + '.patch');
    fs.writeFileSync(patchPath, patch);
    const changedRanges = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].flatMap(m => {
      const count = m[2] === undefined ? 1 : Number(m[2]);
      // Diff context is useful for review, but coverage needs only actual added lines.
      return count ? [{ start: Number(m[1]), end: Number(m[1]) + count - 1 }] : [];
    });
    let oldLine = 0, newLine = 0;
    const added = [];
    for (const line of patch.split('\n')) {
      const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) { oldLine = Number(h[1]); newLine = Number(h[2]); continue; }
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) { added.push(newLine++); }
      else if (line.startsWith('-')) oldLine++;
      else if (line.startsWith(' ')) { oldLine++; newLine++; }
    }
    const ranges = [];
    for (const n of added) {
      const last = ranges.at(-1);
      if (last && last.end + 1 === n) last.end = n; else ranges.push({ start: n, end: n });
    }
    entries.push({ path: name, status: !before ? 'added' : !after ? 'deleted' : 'modified', baselineDirty: wasDirty,
      beforePath: oldFile, afterPath: newFile, patchPath, changedRanges: ranges, hunkRanges: changedRanges,
      binary: (before?.data.includes(0) || after?.data.includes(0)) || false,
      beforeMode: before?.mode || null, afterMode: after?.mode || null,
      beforeHash: before ? hash(before.data) : null, afterHash: after ? hash(after.data) : null });
  }
  const revision = hash(JSON.stringify(entries.map(({ path, beforeMode, afterMode, beforeHash, afterHash }) => ({ path, beforeMode, afterMode, beforeHash, afterHash }))));
  const manifest = { version: 1, repo, initialHead: head, baseBranch: state.base, revision,
    repositorySnapshot: repositorySnapshot(repo, excludes), files: entries, preExistingDirty: Object.keys(saved).sort() };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
if (require.main === module) {
  try {
    const [command, ...values] = process.argv.slice(2);
    let result;
    if (command === 'init') {
      const [repo, out, base, ...excludes] = values;
      if (!repo || !out) throw new Error('init <repo> <artifact-directory> [base] [excluded-path ...]');
      result = init(repo, out, base, excludes);
    } else if (command === 'refresh') result = refresh(values[0]);
    else if (command === 'snapshot') result = { repositorySnapshot: repositorySnapshot(path.resolve(values[0]), values.slice(1)) };
    else throw new Error('Use init, refresh or snapshot');
    console.log(JSON.stringify({ manifestPath: command === 'snapshot' ? undefined : path.join(path.resolve(command === 'init' ? values[1] : values[0]), 'manifest.json'), ...result }));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { init, refresh, repositorySnapshot };
