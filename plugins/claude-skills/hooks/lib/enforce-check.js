// Shared engine for the enforce-*-check Stop hooks. See enforce-golang-check.js
// for the per-skill config shape.
//
// The contract these hooks enforce is NOT "the skill was dispatched" — the
// Workflow tool returns a task ID immediately and the run finishes minutes later
// in the background. It is "a terminal task notification for this skill exists
// in the turn AND it represents a real pass".
//
// Every transcript entry shape below was read out of real session JSONL. The
// comments name each shape so a future harness change is diagnosable rather than
// silently turning these hooks back into advisory prose.
const fs = require('fs');

// Per-hook ceiling on blocks within one logical turn. Blocks are spent only on
// states the model can act on (NONE, UNHEALTHY): one to dispatch, one to re-run
// after a bad result, one spare. `stop_hook_active` is set by the harness on
// every continuation regardless of which hook caused it, so this counter is the
// only loop breaker in the system — which is why it is checked before any
// evidence parsing. A bug in the parser must never be able to produce block N+1.
const MAX_BLOCKS = 3;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// OS temp trees (incl. Claude's session scratchpad) hold throwaway helpers.
const TEMP_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'];

function isTemp(p) {
  return TEMP_PREFIXES.some(t => p.startsWith(t));
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Index of the last real HUMAN prompt = start of the current logical turn.
 *
 * Three kinds of `user`-role entry are NOT human prompts and MUST be walked
 * past. Missing them is what made these hooks advisory:
 *
 *   1. tool_result carriers — content is an array containing a tool_result.
 *   2. harness injections — `isMeta: true`, content a plain string starting
 *      "Stop hook feedback:". Written every time a Stop hook blocks. The turn's
 *      edits fall BEFORE such an entry, so a walk that stops here sees zero
 *      changed files and can never re-block.
 *   3. async task-notification wakes — `origin.kind === 'task-notification'`,
 *      content the raw "<task-notification>…" string. These wake an idle,
 *      already-stopped session and emit a full new-turn preamble, so they look
 *      exactly like a human prompt — and they are precisely the entries
 *      carrying the findings we are here to enforce.
 *
 * `origin` is absent on older entries, so absence must still count as human.
 * A user interrupt ([{type:'text',text:'[Request interrupted by user]'}]) is
 * left counting as a boundary ON PURPOSE: the user took control, so
 * pre-interrupt edits are no longer this hook's business.
 */
function turnStart(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    // Cheap pre-filter so a multi-MB transcript is not fully JSON.parse'd.
    // Every user entry serializes `"role":"user"`; the role check below rejects
    // false positives such as a tool_result that quotes a transcript.
    if (!line || line.indexOf('"user"') === -1) continue;

    const e = parseLine(line);
    if (!e) continue;

    const m = e.message;
    if (!m || m.role !== 'user') continue;
    if (e.isMeta) continue;
    if (e.origin && e.origin.kind && e.origin.kind !== 'human') continue;
    if (Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result')) continue;

    return i;
  }

  return 0;
}

// Emitted once per blocking hook, never merged across hooks, so each hook can
// count only its own. The `command` spelling varies by install (three forms seen
// in real transcripts), so match on the basename substring rather than equality.
function countPriorBlocks(entries, basename) {
  let n = 0;

  for (const e of entries) {
    const a = e && e.attachment;
    if (!a || a.type !== 'hook_blocking_error') continue;

    const cmd = (a.blockingError && a.blockingError.command) || '';
    if (cmd.indexOf(basename) !== -1) n++;
  }

  return n;
}

function changedFiles(entries, skip) {
  const changed = new Set();

  for (const e of entries) {
    // Sub-agent edits are not the main agent's business — demanding a check for
    // files this turn never touched at the top level is a false positive.
    if (e.isSidechain) continue;

    const m = e.message;
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;

    for (const b of m.content) {
      if (!b || b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue;

      const fp = (b.input && b.input.file_path) || '';
      if (!fp || skip(fp)) continue;

      changed.add(fp);
    }
  }

  return changed;
}

// A task-notification blob reaches the transcript through three different
// carriers. All three must be recognised; the 'wake' form is also a turn-start
// candidate, which is why turnStart() rejects it explicitly.
function notificationBlob(e) {
  if (e.type === 'queue-operation' && typeof e.content === 'string') return e.content;

  const a = e.attachment;
  if (a && a.type === 'queued_command' && typeof a.prompt === 'string') return a.prompt;

  const m = e.message;
  if (m && typeof m.content === 'string' && m.content.indexOf('<task-notification>') !== -1) {
    return m.content;
  }

  return '';
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(blob, name) {
  const m = blob.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));

  return m ? m[1].trim() : '';
}

function intTag(blob, name) {
  const raw = tag(blob, name);
  const n = Number(raw);

  return Number.isInteger(n) ? n : null;
}

function parseNotification(blob) {
  if (blob.indexOf('<task-notification>') === -1) return null;

  const usage = tag(blob, 'usage');
  let result = null;

  const rawResult = tag(blob, 'result');
  if (rawResult) {
    try {
      result = JSON.parse(unescapeXml(rawResult));
    } catch {
      result = null;
    }
  }

  return {
    taskId: tag(blob, 'task-id'),
    toolUseId: tag(blob, 'tool-use-id'),
    status: tag(blob, 'status'),
    agentCount: intTag(usage, 'agent_count'),
    agentsDone: intTag(usage, 'agents_done'),
    agentsError: intTag(usage, 'agents_error'),
    result,
    // A truncated blob (the notification text is capped) can lose </result>.
    // Distinguish that from a genuinely absent result so a parse failure is not
    // read as a clean pass.
    resultParsed: rawResult ? result !== null : false,
    hasResult: Boolean(rawResult),
  };
}

// Collects launch acks for THIS skill so a notification can be attributed.
// `toolUseResult.status === 'async_launched'` carries taskId + workflowName +
// scriptPath; `workflowName` is the script's own `meta.name`.
function collectDispatch(entries, config) {
  // Both scriptPath matches below share this marker, so the ack rule and the
  // tool_use rule stay in step. Keep it that way: they are two views of the same
  // "is this dispatch ours?" question, and attributing a notification to the
  // wrong skill would satisfy a hook that should have blocked.
  const pathMarker = '/' + config.workflowName + '/';

  const taskIds = new Set();
  const toolUseIds = new Set();
  let sawWorkflow = false;
  let sawForegroundFallback = false;

  for (const e of entries) {
    const r = e.toolUseResult;
    if (r && r.status === 'async_launched') {
      const byName = r.workflowName === config.workflowName;
      const byPath = typeof r.scriptPath === 'string' && r.scriptPath.indexOf(pathMarker) !== -1;

      if (byName || byPath) {
        sawWorkflow = true;
        if (r.taskId) taskIds.add(r.taskId);
        if (r.toolUseId) toolUseIds.add(r.toolUseId);
      }
    }

    const m = e.message;
    if (!m || !Array.isArray(m.content)) continue;

    for (const b of m.content) {
      if (!b || b.type !== 'tool_use') continue;

      // A Workflow tool_use whose scriptPath names this skill, in case the ack
      // shape changes.
      if (b.name === 'Workflow') {
        const sp = (b.input && b.input.scriptPath) || '';
        if (sp.indexOf(pathMarker) !== -1) {
          sawWorkflow = true;
          if (b.id) toolUseIds.add(b.id);
        }
      }

      // Fallback direct fan-out. A FOREGROUND Agent call returns its findings in
      // the tool_result, so the dispatch itself is the completion.
      if (b.name === 'Agent') {
        const st = (b.input && b.input.subagent_type) || '';
        const background = Boolean(b.input && b.input.run_in_background);

        if (st.indexOf(config.agentType) !== -1 && !background) sawForegroundFallback = true;
      }
    }
  }

  return { taskIds, toolUseIds, sawWorkflow, sawForegroundFallback };
}

function findNotification(entries, dispatch) {
  for (const e of entries) {
    const blob = notificationBlob(e);
    if (!blob) continue;

    const n = parseNotification(blob);
    if (!n) continue;

    const mine =
      (n.taskId && dispatch.taskIds.has(n.taskId)) ||
      (n.toolUseId && dispatch.toolUseIds.has(n.toolUseId));

    if (mine) return n;
  }

  return null;
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// A run is a real pass only when every agent finished and the payload is usable.
//
// Deliberate calibration: a PARTIAL `unverified` alongside real findings is
// HEALTHY — SKILL.md Step 4 already mandates reporting it, and blocking would
// spend budget on something re-running rarely fixes. But `unverified` with NO
// findings at all means the run produced nothing usable, which is the exact
// shape of both real failures this enforcement exists to catch: agents that
// never resolved, and a proof-of-read gate that rejected every guideline.
function healthOf(n) {
  if (!n) return null;

  if (n.status !== 'completed') return { ok: false, why: 'the run ended with status "' + n.status + '"' };

  if (n.agentsError === null) {
    return { ok: false, why: 'it reported no agents_error count at all' };
  }

  if (n.agentsError > 0) {
    return { ok: false, why: plural(n.agentsError, 'agent') + ' errored (agents_error > 0)' };
  }

  if (n.agentCount !== null && n.agentsDone !== null && n.agentsDone !== n.agentCount) {
    return {
      ok: false,
      why: 'only ' + n.agentsDone + ' of ' + n.agentCount + ' agents completed',
    };
  }

  if (n.hasResult && !n.resultParsed) {
    return { ok: false, why: 'its result payload could not be parsed' };
  }

  const r = n.result || {};
  const unverified = Array.isArray(r.unverified) ? r.unverified : [];
  const findings = Array.isArray(r.findings) ? r.findings : null;

  if (findings === null) return { ok: false, why: 'its result carried no findings array' };

  if (unverified.length > 0 && findings.length === 0) {
    return {
      ok: false,
      why:
        'every guideline it reported was UNVERIFIED (' +
        unverified.join(', ') +
        ') and it produced no findings, so nothing was actually checked',
    };
  }

  return { ok: true };
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function notify(systemMessage) {
  process.stdout.write(JSON.stringify({ systemMessage }));
  process.exit(0);
}

function runEnforcement(config) {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0);
  }

  // Skip plan mode (no real source edits land there).
  if (input.permission_mode === 'plan') process.exit(0);

  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) process.exit(0);

  let lines;
  try {
    lines = fs.readFileSync(tp, 'utf8').split('\n');
  } catch {
    process.exit(0);
  }

  const start = turnStart(lines);
  const entries = [];
  for (let i = start; i < lines.length; i++) {
    if (!lines[i]) continue;

    const e = parseLine(lines[i]);
    if (e) entries.push(e);
  }

  const changed = changedFiles(entries, config.skip);
  if (changed.size === 0) process.exit(0);

  // Every message below names the scope the same way ("1 file" / "2 files").
  const changedLabel = plural(changed.size, config.noun);

  // Cap FIRST, before any evidence work. Termination depends on this ordering.
  if (countPriorBlocks(entries, config.basename) >= MAX_BLOCKS) {
    notify(
      config.skill +
        ' was asked for ' +
        MAX_BLOCKS +
        ' times this turn without a healthy result, so this hook has stopped blocking. ' +
        changedLabel +
        ' changed this turn and remain unchecked — treat that as a coverage gap, not a clean bill of health.',
    );
  }

  const dispatch = collectDispatch(entries, config);

  if (dispatch.sawForegroundFallback) process.exit(0);

  if (!dispatch.sawWorkflow) {
    block(
      config.lead +
        ' (' +
        changedLabel +
        '). Before finishing, run the ' +
        config.skill +
        ' skill on ' +
        config.scopeNote +
        ' Dispatching is not enough on its own — wait for the run to finish and address or report ' +
        'its findings (and any UNVERIFIED guidelines) before you stop.',
    );
  }

  const notification = findNotification(entries, dispatch);

  // Dispatched but still running. NEVER block here: a real run takes minutes, so
  // blocking would burn the whole budget in seconds and capitulate long before
  // the findings land. The harness re-invokes this session when the notification
  // arrives, and the turn-start walk now looks past that wake entry, so the
  // continuation still sees these edits.
  if (!notification) {
    notify(
      config.skill +
        ' is still running for ' +
        changedLabel +
        '. Not blocking — report its findings when the task notification arrives.',
    );
  }

  const health = healthOf(notification);

  if (health.ok) process.exit(0);

  block(
    config.lead +
      ' (' +
      changedLabel +
      ') and ' +
      config.skill +
      ' did run, but it was not a real pass: ' +
      health.why +
      '. Re-run it and address the result. If every agent errored with 0 tool calls, the ' +
      'plugin cache is probably behind the repo — commit, push, then `/plugin update` before ' +
      'trying again, because the agent type it dispatches will not exist until you do.',
  );
}

module.exports = { runEnforcement, MAX_BLOCKS, isTemp };
