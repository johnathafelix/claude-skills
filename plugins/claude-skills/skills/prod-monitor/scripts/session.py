#!/usr/bin/env python3
"""Run one headless Claude Code session for a prod-monitor stage and return its structured reply.

Every session starts fresh (`claude -p`, persisted so it can be resumed or inspected) with the plugin loaded
from this checkout, so the prod-guard hook runs inside it, and with PROD_MONITOR_GUARD=1
and PROD_MONITOR_WRITABLE in its environment, which is what turns the guard on and tells
it where the session may write. The reply is the session's structured output
(`--json-schema`); the full event stream goes to `event_log` for debugging.

    run(config, model, effort, prompt, cwd, schema, tools, add_dirs, writable, event_log, ...)
      -> {status: ok|error, detail, structured, result, usage, model_usage}
"""
import json
import os
import subprocess

from common import PLUGIN


def _usage(result):
    usage = result.get("usage") or {}
    total = sum(usage.get(key) or 0 for key in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
    models = (result.get("modelUsage") or {}).values()
    subagents = sum(
        (m.get("inputTokens") or 0) + (m.get("outputTokens") or 0) + (m.get("cacheReadInputTokens") or 0) + (m.get("cacheCreationInputTokens") or 0)
        for m in models
    )

    return {"turn_tokens": total, "session_tokens": max(total, subagents)}


def usage_note(reply):
    usage = reply.get("usage") or {}

    return f"{usage.get('session_tokens', 0)} tokens"


def command(config, model, effort, schema, tools, allowed_tools, add_dirs, plugin, system_prompt, slash_commands):
    argv = [
        "claude", "-p", "--model", model,
        "--permission-mode", "auto", "--permission-prompts", "none",
        "--setting-sources", "user",
        "--settings", json.dumps({"autoMemoryEnabled": False, "disableAllHooks": not plugin}),
        "--output-format", "stream-json", "--verbose",
        "--json-schema", json.dumps(schema),
    ]
    if effort:
        argv += ["--effort", effort]

    if plugin:
        argv += ["--plugin-dir", str(PLUGIN)]

    if not slash_commands:
        argv.append("--disable-slash-commands")

    if tools:
        argv += ["--tools", ",".join(tools)]

    if allowed_tools:
        argv += ["--allowedTools", ",".join(allowed_tools)]

    for directory in add_dirs:
        argv += ["--add-dir", str(directory)]

    if system_prompt:
        argv += ["--append-system-prompt", system_prompt]

    return argv


def run(config, *, model, effort, prompt, cwd, schema, event_log, tools=(), allowed_tools=(), add_dirs=(), writable=(), plugin=True, system_prompt="", slash_commands=False, timeout=None):
    argv = command(config, model, effort, schema, tools, allowed_tools, add_dirs, plugin, system_prompt, slash_commands)
    env = {
        **os.environ,
        "PROD_MONITOR_GUARD": "1",
        "PROD_MONITOR_WRITABLE": os.pathsep.join(str(path) for path in writable),
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
    }
    event_log.parent.mkdir(parents=True, exist_ok=True)

    try:
        with event_log.open("w") as log:
            session = subprocess.run(
                [*argv, prompt],
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
                timeout=timeout or config["session_timeout"],
                cwd=cwd,
                env=env,
            )
    except subprocess.TimeoutExpired:
        return {"status": "error", "detail": f"session timed out after {timeout or config['session_timeout']}s", "structured": None, "result": "", "usage": {}}
    except FileNotFoundError:
        return {"status": "error", "detail": "claude is not on PATH", "structured": None, "result": "", "usage": {}}

    with event_log.open("a") as log:
        log.write(session.stdout)

    result = None
    for line in session.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        if event.get("type") == "result":
            result = event

    if not result:
        return {"status": "error", "detail": f"session ended without a result (exit {session.returncode}); see {event_log}", "structured": None, "result": "", "usage": {}}

    structured = result.get("structured_output")
    reply = {
        "status": "ok" if isinstance(structured, dict) else "error",
        "detail": "" if isinstance(structured, dict) else f"no structured reply: {str(result.get('result'))[-300:]}",
        "structured": structured if isinstance(structured, dict) else None,
        "result": result.get("result") or "",
        "usage": _usage(result),
    }

    return reply
