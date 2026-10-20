#!/usr/bin/env python3
"""Shared helpers for prod-monitor: configuration, run directories, stage markers and the daily log.

Every PROD_MONITOR_* value comes from the `env` block of ~/.claude/settings.json. A run
lives in <workdir>/<dd-MM-yyyy-HH-mm>/ and each stage leaves a marker in its state/
directory, so a loop that stops mid-run picks the run up where it left off.
"""
import datetime
import json
import os
import pathlib
import re
import tempfile
import time

RUN_ID_FORMAT = "%d-%m-%Y-%H-%M"
DAY_FORMAT = "%d-%m-%Y"
RUN_ID = re.compile(r"^\d{2}-\d{2}-\d{4}-\d{2}-\d{2}$")
INTERVAL = re.compile(r"^(\d+)([mh])$")
SEVERITIES = ("DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
MAX_GAP_SECONDS = 24 * 3600
MAX_ATTEMPTS = 3

SCRIPTS = pathlib.Path(__file__).resolve().parent
SKILL = SCRIPTS.parent
PLUGIN = SKILL.parents[1]
PROMPTS = SKILL / "prompts"


class Stop(Exception):
    """A problem the user has to fix before the loop can go on (exit 2)."""


def env_list(env, name):
    return [item.strip() for item in env.get(name, "").split(",") if item.strip()]


def env_int(env, name, default, minimum=1):
    value = env.get(name, str(default))
    if not value.isdigit() or int(value) < minimum:
        raise Stop(f"{name} must be a whole number, {minimum} or more")

    return int(value)


def env_choice(env, name, default, choices):
    value = env.get(name, default)
    if value not in choices:
        raise Stop(f"{name} must be one of {', '.join(choices)}")

    return value


def parse_interval(text):
    """Seconds in an interval such as 30m, 1h or 2h."""
    match = INTERVAL.match(text.strip())
    if not match:
        raise Stop("PROD_MONITOR_INTERVAL must look like 30m or 1h")

    amount, unit = int(match.group(1)), match.group(2)
    seconds = amount * (3600 if unit == "h" else 60)
    if seconds < 60:
        raise Stop("PROD_MONITOR_INTERVAL must be at least 1m")

    return seconds


def load_config(env=None):
    env = os.environ if env is None else env

    required = {}
    for name in ("GCP_PROJECT", "REPOS_DIR", "LINEAR_TEAM", "LINEAR_PROJECT", "WORKDIR"):
        value = env.get(f"PROD_MONITOR_{name}", "").strip()
        if not value:
            raise Stop(f"set PROD_MONITOR_{name} in the env block of ~/.claude/settings.json")

        required[name.lower()] = value

    namespaces = env_list(env, "PROD_MONITOR_NAMESPACES")
    if not namespaces:
        raise Stop("set PROD_MONITOR_NAMESPACES (comma-separated) in the env block of ~/.claude/settings.json")

    labels = env_list(env, "PROD_MONITOR_LINEAR_LABELS")

    repos_dir = pathlib.Path(required["repos_dir"]).expanduser()
    if not repos_dir.is_dir():
        raise Stop(f"PROD_MONITOR_REPOS_DIR does not exist: {repos_dir}")

    return {
        "gcp_project": required["gcp_project"],
        "namespaces": namespaces,
        "interval": parse_interval(env.get("PROD_MONITOR_INTERVAL", "1h")),
        "repos_dir": repos_dir,
        "linear_team": required["linear_team"],
        "linear_project": required["linear_project"],
        "linear_labels": labels,
        "workdir": pathlib.Path(required["workdir"]).expanduser(),
        "min_severity": env_choice(env, "PROD_MONITOR_MIN_SEVERITY", "WARNING", SEVERITIES),
        "extra_filter": env.get("PROD_MONITOR_EXTRA_FILTER", "").strip(),
        "log_limit": env_int(env, "PROD_MONITOR_LOG_LIMIT", 5000),
        "slice_seconds": env_int(env, "PROD_MONITOR_FETCH_SLICE_MINUTES", 5) * 60,
        "context_before": env_int(env, "PROD_MONITOR_CONTEXT_BEFORE_MINUTES", 5, minimum=0) * 60,
        "context_after": env_int(env, "PROD_MONITOR_CONTEXT_AFTER_MINUTES", 1, minimum=0) * 60,
        "context_limit": env_int(env, "PROD_MONITOR_CONTEXT_LIMIT", 500),
        "max_parallel": env_int(env, "PROD_MONITOR_MAX_PARALLEL", 4),
        "session_timeout": env_int(env, "PROD_MONITOR_SESSION_TIMEOUT_SECONDS", 1800),
        "reject_ttl": env_int(env, "PROD_MONITOR_SKIP_TTL_HOURS", 24) * 3600,
        "open_prs": env.get("PROD_MONITOR_OPEN_PRS", "0") == "1",
        "triage_model": env.get("PROD_MONITOR_TRIAGE_MODEL", "opus"),
        "triage_effort": env_choice(env, "PROD_MONITOR_TRIAGE_EFFORT", "medium", EFFORTS),
        "findings_model": env.get("PROD_MONITOR_FINDINGS_MODEL", "opus"),
        "findings_effort": env_choice(env, "PROD_MONITOR_FINDINGS_EFFORT", "high", EFFORTS),
        "challenge_model": env.get("PROD_MONITOR_CHALLENGE_MODEL", "opus"),
        "challenge_effort": env_choice(env, "PROD_MONITOR_CHALLENGE_EFFORT", "high", EFFORTS),
        "linear_model": env.get("PROD_MONITOR_LINEAR_MODEL", "sonnet"),
        "pr_model": env.get("PROD_MONITOR_PR_MODEL", "opus"),
        "pr_effort": env_choice(env, "PROD_MONITOR_PR_EFFORT", "medium", EFFORTS),
    }


# --- time ---------------------------------------------------------------------------


def run_id_for(now):
    return time.strftime(RUN_ID_FORMAT, time.localtime(now))


def day_for(now):
    return time.strftime(DAY_FORMAT, time.localtime(now))


def run_started(run_id):
    """Epoch seconds a run id stands for, or None when the name is not a run id."""
    if not RUN_ID.match(run_id):
        return None

    try:
        return time.mktime(time.strptime(run_id, RUN_ID_FORMAT))
    except ValueError:
        return None


def iso(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def from_iso(text):
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()


# --- files --------------------------------------------------------------------------


def write_text_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", prefix=f".{path.name}-", dir=path.parent, delete=False) as f:
        f.write(text)
        temporary = f.name

    os.replace(temporary, path)


def write_json_atomic(path, value):
    write_text_atomic(path, json.dumps(value, indent=2, sort_keys=True) + "\n")


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def read_text(path):
    try:
        return path.read_text()
    except FileNotFoundError:
        return ""


def append_line(path, line):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(line + "\n")


# --- runs ---------------------------------------------------------------------------


def marker(run, name):
    return run / "state" / f"{name}.done"


def is_done(run, name):
    return marker(run, name).exists()


def mark_done(run, name):
    marker(run, name).parent.mkdir(parents=True, exist_ok=True)
    marker(run, name).touch()


def mark_failed(run, reason):
    write_text_atomic(run / "state" / "failed", reason.strip() + "\n")


def attempts(run, name):
    return int(read_text(run / "state" / f"{name}.attempts").strip() or 0)


def bump_attempts(run, name):
    count = attempts(run, name) + 1
    write_text_atomic(run / "state" / f"{name}.attempts", f"{count}\n")

    return count


def incomplete_runs(workdir):
    """Run directories with no done/failed marker, oldest first."""
    runs = []
    for path in workdir.iterdir() if workdir.is_dir() else []:
        started = run_started(path.name)
        if started is None or not path.is_dir():
            continue

        if is_done(path, "run") or (path / "state" / "failed").exists():
            continue

        runs.append((started, path))

    return [path for _, path in sorted(runs)]


def read_cursor(workdir):
    text = read_text(workdir / "cursor").strip()

    try:
        return from_iso(text) if text else None
    except ValueError:
        return None


def write_cursor(workdir, seconds):
    write_text_atomic(workdir / "cursor", iso(seconds) + "\n")


def window_for(cursor, now, interval):
    """[start, end) of the logs a new run reads; a gap longer than a day is not caught up."""
    if cursor is None or now - cursor > MAX_GAP_SECONDS or cursor >= now:
        return now - interval, now

    return cursor, now


def is_due(cursor, now, interval):
    return cursor is None or now >= cursor + interval


# --- daily log ----------------------------------------------------------------------


def log(workdir, run_id, message, now=None):
    now = time.time() if now is None else now
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))
    tag = f" [{run_id}]" if run_id else ""
    append_line(workdir / "logs" / f"{day_for(now)}.txt", f"{stamp}{tag} {message}")


def render_prompt(name, **values):
    text = (PROMPTS / f"{name}.md").read_text()
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", str(value))

    leftover = re.search(r"{{[a-z_]+}}", text)
    if leftover:
        raise KeyError(f"prompt {name} still has {leftover.group(0)}")

    return text
