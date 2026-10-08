#!/usr/bin/env node
// Build exact Workflow payloads outside the sandbox; never execute a model's shell text.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stage } = require('./stage-workflow');
const PLUGIN = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
const supported = ['code-review', 'golang-check', 'ts-check', 'test-check'];
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function priorClaim(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Prior findings must be objects');
  const file = raw.file || raw.path;
  const description = raw.description || raw.summary || raw.body;
  const priorId = String(raw.priorId || raw.priorIds?.[0] || (raw.id ? `github:${raw.id}` : `cached:${crypto.createHash('sha256').update(JSON.stringify([file, raw.claimKey || description])).digest('hex').slice(0, 20)}`));
  return { ...raw, file, line: raw.line || raw.original_line, description,
    suggestedFix: raw.suggestedFix || raw.action || 'Recheck the original problem and proposed fix against the current code.',
    severity: raw.severity || (/^\s*Nit:/i.test(description || '') ? 'nit' : 'issue'), priorId,
    ...(raw.path && !raw.line ? { needsRelocation: true } : {}) };
}
function build(skill, input, out, { scratchpad, context, prior = [], checks = [] } = {}) {
  if (!supported.includes(skill)) throw new Error(`Skill must be one of ${supported.join(', ')}`);
  const args = { ...object(input, 'Workflow args') };
  for (const key of ['priorFindings', 'externalFindings', 'expectedPriorIds', 'inputGaps', 'inputRejectedFindings', 'coveredDimensions', 'verifyOnly']) {
    if (args[key] !== undefined && !Array.isArray(args[key])) throw new Error(`${key} must be an array`);
  }
  out = path.resolve(out);
  fs.mkdirSync(out, { recursive: true });
  // A temp directory is never inferred to be readable. Only an explicitly supplied
  // harness scratchpad permits scriptPath; otherwise the unchanged staged bytes go inline.
  const directory = scratchpad ? fs.realpathSync(scratchpad) : out;
  const staged = path.join(directory, `${skill}-staged.js`);
  stage(skill === 'code-review' ? '-' : path.join(PLUGIN, 'skills', skill, 'guidelines'), path.join(PLUGIN, 'skills', skill, 'workflow.js'), staged);
  if (skill === 'code-review') {
    if (!Array.isArray(prior) || !Array.isArray(args.priorFindings || [])) throw new Error('Prior findings must be an array');
    if (context) {
      object(context, 'Pinned context');
      if (args.repoDir && fs.realpathSync(args.repoDir) !== fs.realpathSync(context.repoDir)) throw new Error('Workflow repoDir differs from pinned context');
      args.repoDir = context.repoDir;
      args.diffCommand = context.diffCommand;
      args.files ||= context.reviewFiles;
      args.priorFindings = [...(args.priorFindings || []), ...(context.priorFindings || [])];
      args.expectedPriorIds = [...(args.expectedPriorIds || []), ...(context.expectedPriorIds || [])];
    }
    args.priorFindings = [...(args.priorFindings || []), ...prior].map(priorClaim);
    args.expectedPriorIds = [...new Set([...(args.expectedPriorIds || []), ...args.priorFindings.flatMap(f => [f.priorId, ...(Array.isArray(f.priorIds) ? f.priorIds.map(String) : [])])])];
    args.externalFindings = [...(args.externalFindings || [])];
    args.inputGaps = [...(args.inputGaps || [])];
    args.inputRejectedFindings = [...(args.inputRejectedFindings || [])];
    for (const { skill: source, result: wrapped } of checks) {
      if (!supported.includes(source) || source === 'code-review') throw new Error('Checks must name a language/test skill');
      const result = object(wrapped?.result || wrapped, `${source} result`);
      if (!Array.isArray(result.findings) || !Array.isArray(result.unverified) || (result.rejectedFindings !== undefined && !Array.isArray(result.rejectedFindings))) throw new Error(`${source} result is incomplete`);
      args.inputGaps.push(...result.unverified.map(rule => `${source}/${rule}`));
      args.inputRejectedFindings.push(...(result.rejectedFindings || []).map(f => ({ ...f, dimension: `${source}/${f?.rule || 'rejected-input'}` })));
      args.externalFindings.push(...result.findings.map(f => !f || typeof f !== 'object' || Array.isArray(f) ? f : ({ ...f,
        severity: ['error', 'issue'].includes(f.severity) ? 'issue' : source === 'ts-check' || ['warning', 'info'].includes(f.severity) ? 'nit' : f.severity,
        description: [f.description || f.summary, f.rationale].filter(Boolean).join('\n'),
        suggestedFix: f.suggestedFix || f.action, dimension: f.dimension || `${source}/${f.rule || 'candidate'}`,
        ...(f.coverageFile || result.coverageFile ? { coverageFile: f.coverageFile || result.coverageFile } : {}),
        guidelinePath: f.guidelinePath || path.join(PLUGIN, 'skills', source, 'guidelines', `${f.rule}.md`),
      })));
    }
    args.nitPolicy ||= 'material';
    if (args.coverageUnverified || args.inputGaps.some(gap => String(gap).startsWith('test-check/')) || args.inputRejectedFindings.some(f => f?.dimension?.startsWith('test-check/'))) {
      args.coveredDimensions = (args.coveredDimensions || []).filter(key => key !== 'tests');
    }
    const evidence = { repoDir: args.repoDir, diffCommand: args.diffCommand, files: args.files,
      priorClaims: args.priorFindings.map(f => ({ priorId: f.priorId, file: f.file, line: f.line, needsRelocation: f.needsRelocation || false })),
      candidateLocations: args.externalFindings.map(f => ({ file: f?.file, line: f?.line, identity: f?.identity, claimKey: f?.claimKey })),
    };
    if (args.changeManifestPath) evidence.patches = read(args.changeManifestPath).files.map(f => ({ file: f.path, patchPath: f.patchPath, ranges: f.changedRanges }));
    args.evidenceIndexPath = path.join(out, 'review-evidence.json');
    write(args.evidenceIndexPath, evidence);
  }
  const dispatch = { ...(scratchpad ? { scriptPath: staged } : { script: fs.readFileSync(staged, 'utf8') }), args };
  const dispatchPath = path.join(out, `${skill}-dispatch.json`);
  write(dispatchPath, dispatch);
  return { dispatchPath, stagedPath: staged, transport: scratchpad ? 'scriptPath' : 'script', priorCount: args.expectedPriorIds?.length || 0, candidateCount: args.externalFindings?.length || 0 };
}
if (require.main === module) {
  try {
    const [skill, argsFile, out, ...flags] = process.argv.slice(2);
    if (!out) throw new Error('usage: review-dispatch.js <skill> <args.json> <artifact-dir> [--scratchpad <declared path>] [--context <json>] [--prior <json>] [--check <skill>=<result.json> ...]');
    const options = { checks: [] };
    while (flags.length) {
      const flag = flags.shift(), value = flags.shift();
      if (!value) throw new Error(`Missing value for ${flag}`);
      if (flag === '--scratchpad') options.scratchpad = value;
      else if (flag === '--context') options.context = read(value);
      else if (flag === '--prior') options.prior = read(value);
      else if (flag === '--check') {
        const at = value.indexOf('=');
        if (at < 0) throw new Error('--check requires skill=result.json');
        options.checks.push({ skill: value.slice(0, at), result: read(value.slice(at + 1)) });
      } else throw new Error(`Unknown option ${flag}`);
    }
    console.log(JSON.stringify(build(skill, read(argsFile), out, options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build, priorClaim };
