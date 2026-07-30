// Fixture builder + hook runner for the Stop-hook tests.
//
// Every shape below is copied from real transcript JSONL under
// ~/.claude/projects/**/*.jsonl. The hooks parse these entries, so a fixture
// that drifts from the real shape produces tests that pass while the hook is
// broken in production. If a hook stops working against a real session, suspect
// this file first and re-verify against a live transcript.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Fixture file_path values MUST come from here, never from os.tmpdir().
// os.tmpdir() on macOS is /var/folders/..., which is in the hooks' own isTemp()
// skip list — a fixture rooted there is silently skipped and its test passes
// for the wrong reason.
const REPO = '/repo';

const HOOKS = path.join(__dirname, '..', '..', 'plugins', 'claude-skills', 'hooks');

function hookPath(basename) {
  return path.join(HOOKS, basename);
}

// A real typed prompt: the turn boundary the hooks walk back to.
function humanPrompt(text) {
  return {
    type: 'user',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
  };
}

// Older transcript entries carry no `origin` at all. Absence must still count as
// human, so the walk needs a fixture that proves it.
function legacyHumanPrompt(text) {
  return { type: 'user', message: { role: 'user', content: text } };
}

function assistantToolUse(name, input, id) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: id || 'toolu_' + name, name, input }],
    },
  };
}

function edit(filePath, tool) {
  return assistantToolUse(tool || 'Edit', { file_path: filePath }, 'toolu_edit_' + filePath);
}

// A tool_result carrier. Role is 'user', so the boundary walk must reject it by
// inspecting content rather than role.
function toolResultUser(toolUseId, content, extra) {
  const entry = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: content || 'ok' }],
    },
  };

  return Object.assign(entry, extra || {});
}

// Written by the harness every time a Stop hook blocks. 147 real occurrences.
// The turn's edits fall BEFORE this entry, so a boundary walk that stops here
// sees zero changed files and can never re-block.
function metaFeedback(reason) {
  return { isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\n' + reason } };
}

// Emitted once per blocking hook, not merged across hooks. `command` spelling
// varies by install, so a counter must match on basename substring.
function stopBlock(hookBasename, reason) {
  return {
    type: 'attachment',
    attachment: {
      type: 'hook_blocking_error',
      hookEvent: 'Stop',
      blockingError: {
        blockingError: reason || 'blocked',
        command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/' + hookBasename + '"',
      },
    },
  };
}

// User took control. Left counting as a turn boundary on purpose.
function interrupted() {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  };
}

// Workflow launch: returns [tool_use, tool_result]. The ack proves DISPATCH ONLY
// — the run finishes minutes later. `workflowName` is the script's meta.name.
function workflowLaunch(workflowName, opts) {
  const o = opts || {};
  const taskId = o.taskId || 'w' + workflowName;
  const toolUseId = o.toolUseId || 'toolu_wf_' + workflowName;
  const scriptPath =
    o.scriptPath ||
    '/Users/x/Documents/claude-skills/plugins/claude-skills/skills/' + workflowName + '/workflow.js';

  return [
    assistantToolUse('Workflow', { scriptPath }, toolUseId),
    toolResultUser(toolUseId, 'Workflow launched in background. Task ID: ' + taskId, {
      toolUseResult: {
        status: 'async_launched',
        taskId,
        workflowName,
        runId: 'wf_' + workflowName,
        scriptPath,
      },
    }),
  ];
}

// Fallback direct fan-out. A foreground Agent tool_result IS the findings.
function agentDispatch(subagentType, opts) {
  const o = opts || {};
  const id = o.toolUseId || 'toolu_agent_' + subagentType;
  const entries = [assistantToolUse('Agent', { subagent_type: subagentType }, id)];

  if (o.result !== undefined) entries.push(toolResultUser(id, o.result));

  return entries;
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The terminal notification blob, as raw text. The blob parser is what is under
// test, so this must emit the real XML-ish string and never a parsed object.
//
// `result` defaults to the POST-strengthened-gate return shape: no
// `priorityOrder` (dropped), and `unverified` is the field a failed
// proof-of-read populates. The hook parser's frozen contract is exactly
// findings + unverified + the usage counters — if a later change to
// workflow.js's return shape breaks a test here, that is the coupling working.
function notificationBlob(fields) {
  const f = fields || {};
  const result = f.result === undefined ? { findings: [], findingCount: 0, unverified: [] } : f.result;
  const usage = Object.assign(
    { agent_count: 12, agents_done: 12, agents_error: 0, agents_skipped: 0 },
    f.usage || {},
  );

  const usageXml = Object.keys(usage)
    .map(k => '<' + k + '>' + usage[k] + '</' + k + '>')
    .join('');

  const resultText = typeof result === 'string' ? result : JSON.stringify(result);

  return (
    '<task-notification>\n' +
    '<task-id>' + (f.taskId || 'wtask') + '</task-id>\n' +
    '<tool-use-id>' + (f.toolUseId || 'toolu_wf') + '</tool-use-id>\n' +
    '<status>' + (f.status || 'completed') + '</status>\n' +
    '<result>' + escapeXml(resultText) + '</result>\n' +
    '<usage>' + usageXml + '</usage>\n' +
    '</task-notification>'
  );
}

// Three real carriers for the same blob, all of which must be recognised.
// 'wake' is the dangerous one: it looks exactly like a fresh human prompt and
// arrives with stop_hook_active false.
function taskNotification(fields, carrier) {
  const blob = notificationBlob(fields);

  if (carrier === 'queue') return { type: 'queue-operation', operation: 'enqueue', content: blob };

  if (carrier === 'attachment') {
    return { type: 'attachment', attachment: { type: 'queued_command', prompt: blob } };
  }

  return {
    type: 'user',
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    message: { role: 'user', content: blob },
  };
}

// Writes JSONL to a temp dir. `rawLines` bypasses JSON.stringify so malformed
// lines can be exercised.
function writeTranscript(entries, rawLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooktest-'));
  const file = path.join(dir, 'transcript.jsonl');
  const body = rawLines
    ? rawLines.join('\n')
    : entries.map(e => JSON.stringify(e)).join('\n');

  fs.writeFileSync(file, body + '\n');

  return file;
}

// Spawns the hook the way hooks.json does, so stdin parsing, exit code and the
// stdout-JSON contract are all real. spawnSync (not execFileSync) because a
// nonzero exit must be an assertion, not a thrown exception.
function runHook(basename, input) {
  const r = spawnSync(process.execPath, [hookPath(basename)], {
    input: JSON.stringify(input || {}),
    encoding: 'utf8',
  });

  let parsed = null;
  if (r.stdout && r.stdout.trim()) {
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      parsed = null;
    }
  }

  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', parsed };
}

// The common case: a turn that edited `files` and then stopped.
function turnEditing(files, opts) {
  const o = opts || {};
  const entries = [humanPrompt('do the thing')].concat(files.map(f => edit(f, o.tool)));

  return writeTranscript(entries.concat(o.after || []));
}

function stopInput(transcriptPath, extra) {
  return Object.assign(
    { transcript_path: transcriptPath, stop_hook_active: false, permission_mode: 'default' },
    extra || {},
  );
}

module.exports = {
  REPO,
  hookPath,
  humanPrompt,
  legacyHumanPrompt,
  assistantToolUse,
  edit,
  toolResultUser,
  metaFeedback,
  stopBlock,
  interrupted,
  workflowLaunch,
  agentDispatch,
  notificationBlob,
  taskNotification,
  writeTranscript,
  runHook,
  turnEditing,
  stopInput,
};
