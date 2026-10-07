#!/usr/bin/env node
// Read compact timing evidence outside the deterministic Workflow sandbox.
const fs = require('node:fs');
const path = require('node:path');

function metrics(metadata) {
  const duration = value => Number.isFinite(value) && value >= 0 ? value : null;
  const phases = new Map();
  for (const event of metadata.workflowProgress || []) {
    if (event.type !== 'workflow_agent') continue;
    const title = event.phaseTitle || '(unassigned)';
    if (!phases.has(title)) phases.set(title, []);
    phases.get(title).push(event);
  }
  const phaseAgentSpansMs = Object.fromEntries([...phases].map(([title, agents]) => {
    const complete = agents.every(a => Number.isFinite(a.startedAt) && duration(a.durationMs) !== null && a.state === 'done');
    return [title, complete ? Math.max(...agents.map(a => a.startedAt + a.durationMs)) - Math.min(...agents.map(a => a.startedAt)) : null];
  }));
  const keys = ['profile', 'mode', 'groups', 'checkCalls', 'finderCalls', 'verifierCalls', 'candidates', 'duplicates', 'confirmed', 'rejected'];
  const stats = Object.fromEntries(keys.filter(k => metadata.result?.stats?.[k] !== undefined).map(k => [k, metadata.result.stats[k]]));
  return { runId: metadata.runId, status: metadata.status, durationMs: duration(metadata.durationMs), phaseAgentSpansMs, agentCount: metadata.agentCount, stats };
}

function read(source) {
  const file = fs.statSync(source).isDirectory()
    ? path.resolve(source, '../../../workflows', path.basename(source) + '.json') : source;
  return metrics(JSON.parse(fs.readFileSync(file, 'utf8')));
}

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('usage: node workflow-metrics.js <Workflow transcript directory or metadata JSON> [...]');
    for (const source of process.argv.slice(2)) console.log(JSON.stringify(read(source)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { metrics, read };
