#!/usr/bin/env node
// Generate one Jest config from exact repository paths; avoid variable-length CLI lists.
const fs = require('node:fs');
const path = require('node:path');
function realLocation(value) {
  let ancestor = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}
function prepare(repo, cwd, out, plan) {
  repo = fs.realpathSync(repo); cwd = fs.realpathSync(cwd); out = realLocation(out);
  const inside = (root, file) => file === root || file.startsWith(root + path.sep);
  if (!inside(repo, cwd) || inside(repo, out)) throw new Error('Jest workspace must be inside repo and artifacts outside');
  if (!Array.isArray(plan.runner) || !plan.runner.length || plan.runner.some(v => typeof v !== 'string' || !v)) throw new Error('Jest plan requires runner argv');
  const resolve = value => {
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid Jest input path');
    const file = fs.realpathSync(path.resolve(repo, value));
    if (!inside(cwd, file) || !fs.statSync(file).isFile()) throw new Error(`Input is outside owning workspace: ${value}`);
    return file;
  };
  if (!Array.isArray(plan.sourceFiles) || !plan.sourceFiles.length || !Array.isArray(plan.testFiles) || !plan.testFiles.length) throw new Error('Jest plan requires sourceFiles and testFiles');
  const sources = [...new Set(plan.sourceFiles.map(resolve))];
  const tests = [...new Set(plan.testFiles.map(resolve))];
  const config = resolve(plan.config);
  fs.mkdirSync(out, { recursive: true });
  const generated = path.join(out, 'jest.coverage.config.cjs');
  // Load the project's normal setup, transforms and rootDir. Never remove integration
  // setup/teardown to manufacture a successful run.
  fs.writeFileSync(generated, `const path = require('node:path');\nconst base = require(${JSON.stringify(config)});\n` +
    `if (!base || typeof base !== 'object' || typeof base.then === 'function') throw new Error('Jest plan requires an object CommonJS config');\n` +
    `const rootDir = base.rootDir ? path.resolve(${JSON.stringify(path.dirname(config))}, base.rootDir) : ${JSON.stringify(cwd)};\n` +
    `module.exports = {...base, rootDir, collectCoverage:true, collectCoverageFrom:${JSON.stringify(sources)}.map(f => path.relative(rootDir,f).split(path.sep).join('/')), coverageDirectory:${JSON.stringify(out)}, coverageReporters:['json']};\n`);
  return { command: [...plan.runner, '--config', generated, '--runTestsByPath', ...tests],
    expectedSources: sources, report: path.join(out, 'coverage-final.json'), config: generated };
}
if (require.main === module) {
  try {
    const [repo, cwd, out, file] = process.argv.slice(2);
    if (!file) throw new Error('usage: jest-coverage.js <repo> <workspace> <out> <plan.json>');
    console.log(JSON.stringify(prepare(repo, cwd, out, JSON.parse(fs.readFileSync(file, 'utf8')))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare };
