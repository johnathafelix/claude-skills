#!/usr/bin/env node
// Keep review scope independent of pre-existing dirt, the index and later commits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function git(repo, argv, allowFailure = false, input) {
  const r = spawnSync('git', ['-C', repo, ...argv], { input, maxBuffer: 256 * 1024 * 1024 });
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
function scan(repo, excludes = [], objects, algorithm, saved = {}) {
  const digest = crypto.createHash('sha256');
  digest.update(git(repo, ['rev-parse', 'HEAD']));
  const entries = new Map();
  for (const name of files(repo).filter(f => !ignored(f, excludes))) {
    const entry = current(repo, name);
    if (entry) {
      entry.hash = hash(entry.data);
      if (objects) entry.oid = blobId(entry.data, algorithm);
      // Retain source bytes only where a task patch may need them, rather than
      // keeping the entire clean repository in memory alongside the fingerprint.
      if (!objects || (!Object.hasOwn(saved, name) && entry.mode === objects[name]?.mode && entry.oid === objects[name]?.oid)) delete entry.data;
    }
    entries.set(name, entry);
    digest.update(JSON.stringify([name, entry?.mode || null, entry?.hash || null]));
  }
  return { entries, snapshot: digest.digest('hex') };
}
function repositorySnapshot(repo, excludes = []) { return scan(repo, excludes).snapshot; }
function tree(repo, head) {
  return Object.fromEntries(names(git(repo, ['ls-tree', '-r', '-z', head])).map(row => {
    const tab = row.indexOf('\t'), [mode, , oid] = row.slice(0, tab).split(' ');
    return [row.slice(tab + 1), { mode, oid }];
  }));
}
function blobs(repo, ids) {
  ids = [...new Set(ids)];
  const result = new Map();
  if (!ids.length) return result;
  const data = git(repo, ['cat-file', '--batch'], false, ids.join('\n') + '\n');
  let offset = 0;
  for (const oid of ids) {
    const end = data.indexOf(10, offset);
    const [actual, type, size] = data.subarray(offset, end).toString().split(' ');
    if (end < 0 || actual !== oid || type !== 'blob' || !/^\d+$/.test(size)) throw new Error(`Cannot read baseline blob ${oid}`);
    offset = end + 1;
    const length = Number(size);
    if (offset + length >= data.length || data[offset + length] !== 10) throw new Error('Truncated Git blob batch');
    result.set(oid, data.subarray(offset, offset + length));
    offset += length + 1;
  }
  return result;
}
function blobId(data, algorithm) {
  return crypto.createHash(algorithm).update(`blob ${data.length}\0`).update(data).digest('hex');
}
function init(repo, out, base = 'main', excludes = []) {
  repo = fs.realpathSync(repo); out = canonicalLocation(out);
  if (out === repo || out.startsWith(repo + path.sep)) throw new Error('Put manifest artifacts outside the repository');
  if (fs.existsSync(path.join(out, 'baseline.json'))) throw new Error('Baseline already exists; refresh it, do not reset it');
  fs.mkdirSync(path.join(out, 'baseline'), { recursive: true });
  const head = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  const initialFiles = files(repo).filter(f => !ignored(f, excludes));
  const dirty = new Set([...names(git(repo, ['diff', 'HEAD', '--name-only', '-z'])), ...names(git(repo, ['ls-files', '--others', '--exclude-standard', '-z']))]);
  const objects = tree(repo, head);
  const modes = Object.fromEntries(Object.entries(objects).map(([name, obj]) => [name, obj.mode]));
  const objectFormat = git(repo, ['rev-parse', '--show-object-format']).toString().trim();
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
  const state = { repo, out, head, base, excludes, initialFiles: [...new Set([...initialFiles, ...Object.keys(saved)])].sort(), modes, objects, objectFormat, saved };
  fs.writeFileSync(path.join(out, 'baseline.json'), JSON.stringify(state, null, 2));
  return refresh(out);
}
function refresh(out) {
  out = path.resolve(out);
  const state = JSON.parse(fs.readFileSync(path.join(out, 'baseline.json'), 'utf8'));
  const { repo, head, excludes, saved, modes } = state;
  const objects = state.objects || tree(repo, head);
  const algorithm = state.objectFormat || git(repo, ['rev-parse', '--show-object-format']).toString().trim();
  const { entries: scanned, snapshot } = scan(repo, excludes, objects, algorithm, saved);
  const targets = [...new Set([...state.initialFiles, ...scanned.keys()])].filter(f => !ignored(f, excludes)).sort();
  for (const name of targets) if (!scanned.has(name)) {
    const entry = current(repo, name);
    if (entry) { entry.hash = hash(entry.data); entry.oid = blobId(entry.data, algorithm); }
    scanned.set(name, entry);
  }
  // Compare raw content, not only Git status: assume-unchanged files and later task
  // commits must still be visible. One scan also supplies the evidence fingerprint.
  const changed = targets.filter(name => {
    if (modes[name] === '160000') throw new Error(`Submodule requires explicit review scope: ${name}`);
    if (Object.hasOwn(saved, name)) return true;
    const after = scanned.get(name), before = objects[name];
    return before ? !after || after.mode !== before.mode || after.oid !== before.oid : Boolean(after);
  });
  const historical = blobs(repo, changed.filter(name => !Object.hasOwn(saved, name) && objects[name]).map(name => objects[name].oid));
  const previousFile = path.join(out, 'manifest.json');
  const previous = fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : {};
  const reusable = new Map((previous.files || []).map(entry => [entry.path, entry]));
  fs.mkdirSync(path.join(out, 'patches'), { recursive: true });
  const entries = [];
  for (const name of changed) {
    const wasDirty = Object.hasOwn(saved, name);
    let before = null;
    if (wasDirty) {
      if (saved[name]) before = { mode: saved[name].mode, data: fs.readFileSync(saved[name].backup) };
    } else if (modes[name]) {
      before = { mode: modes[name], data: historical.get(objects[name].oid) };
    }
    const after = scanned.get(name) || null;
    if (!before && !after) continue;
    if (before && after && before.mode === after.mode && before.data.equals(after.data)) continue;
    const beforeHash = before ? hash(before.data) : null, afterHash = after?.hash || null;
    const old = reusable.get(name);
    if (old && old.beforeHash === beforeHash && old.afterHash === afterHash && old.beforeMode === (before?.mode || null) && old.afterMode === (after?.mode || null)
      && [old.beforePath, old.afterPath, old.patchPath].every(p => p && fs.existsSync(p))) {
      entries.push(old);
      continue;
    }
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
      beforeHash, afterHash });
  }
  const revision = hash(JSON.stringify(entries.map(({ path, beforeMode, afterMode, beforeHash, afterHash }) => ({ path, beforeMode, afterMode, beforeHash, afterHash }))));
  const manifest = { version: 1, repo, initialHead: head, baseBranch: state.base, revision,
    repositorySnapshot: snapshot, files: entries, preExistingDirty: Object.keys(saved).sort() };
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
