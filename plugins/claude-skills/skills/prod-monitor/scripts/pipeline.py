#!/usr/bin/env python3
"""The stages of one prod-monitor run, each resumable from its markers.

    fetch      gcloud logging read for the run's window -> gcp-logs/ (no model)
    triage     one opus session classifies the digest -> triage/
    findings   one opus session per actionable, unknown issue -> findings/
    challenge  one opus session per finding, high effort -> challenged-findings/
    tickets    one sonnet relay session per confirmed finding -> tickets/, Linear
    prs        optional (PROD_MONITOR_OPEN_PRS=1): one opus session per confirmed ticket -> prs/

A stage that completes leaves state/<stage>.done. Per-issue work leaves one JSON file per
issue, so a run that stops halfway redoes only the issues without one. Failed sessions
are retried on the next tick, up to MAX_ATTEMPTS; after that the issue is recorded as
failed and the run goes on. Only a fetch that keeps failing stops the loop, since that
means gcloud itself needs the user.
"""
import concurrent.futures
import json
import re
import time

import gcp
import session
from common import (
    MAX_ATTEMPTS, Stop, bump_attempts, day_for, from_iso, is_done, iso, mark_done, mark_failed,
    read_cursor, read_json, render_prompt, run_id_for, run_started, window_for, write_cursor,
    write_json_atomic, write_text_atomic,
)
from common import log as daily_log

SLUG = re.compile(r"[^a-z0-9]+")
PRIORITY = {"error": 2, "warning": 4}
TICKET_VERDICTS = ("confirmed", "partially_confirmed")
SAMPLE_LINES = 3
MAX_DESCRIPTION = 20000
INVESTIGATE_TOOLS = ("Bash", "Read", "Grep", "Glob", "Write")
LINEAR_SAVE = "mcp__claude_ai_Linear__save_issue"
RELAY_SYSTEM_PROMPT = "You relay Linear tool calls for a script and answer only in the requested JSON."

TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "service": {"type": "string"},
                    "namespace": {"type": "string"},
                    "severity": {"enum": ["error", "warning"]},
                    "fingerprint": {"type": "string"},
                    "digest_groups": {"type": "array", "items": {"type": "string"}},
                    "summary": {"type": "string"},
                    "actionable": {"type": "boolean"},
                    "known_ticket": {"type": "string"},
                },
                "required": ["id", "title", "service", "severity", "fingerprint", "digest_groups", "summary", "actionable"],
            },
        },
        "notes": {"type": "string"},
    },
    "required": ["issues"],
}

FINDING_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"enum": ["found", "inconclusive"]},
        "confidence": {"enum": ["high", "medium", "low"]},
        "summary": {"type": "string"},
        "root_cause": {"type": "string"},
        "proposed_fix": {"type": "string"},
        "repos": {"type": "array", "items": {"type": "string"}},
        "files": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["status", "confidence", "summary", "root_cause", "proposed_fix", "repos", "files"],
}

CHALLENGE_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"enum": ["confirmed", "partially_confirmed", "rejected"]},
        "confidence": {"enum": ["high", "medium", "low"]},
        "summary": {"type": "string"},
        "corrected_root_cause": {"type": "string"},
        "corrected_fix": {"type": "string"},
    },
    "required": ["verdict", "confidence", "summary", "corrected_root_cause", "corrected_fix"],
}

LINEAR_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"enum": ["ok", "unavailable", "error"]},
        "detail": {"type": "string"},
        "identifier": {"type": "string"},
        "url": {"type": "string"},
    },
    "required": ["status", "identifier", "url"],
}

PR_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"enum": ["ok", "skipped", "error"]},
        "detail": {"type": "string"},
        "url": {"type": "string"},
        "branch": {"type": "string"},
    },
    "required": ["status", "detail", "url"],
}


class StageError(Exception):
    """A stage attempt that failed as a whole; retried next tick, MAX_ATTEMPTS times."""


def slug(text):
    return SLUG.sub("-", str(text).lower()).strip("-")[:60] or "issue"


class Run:
    def __init__(self, config, path):
        self.config = config
        self.path = path
        self.id = path.name
        self.workdir = config["workdir"]
        self.notes = []
        self.alerts = []

    def note(self, message):
        self.notes.append(message)
        daily_log(self.workdir, self.id, message)

    def alert(self, message):
        self.alerts.append(message)
        daily_log(self.workdir, self.id, f"ALERT {message}")

    def file(self, *parts):
        return self.path.joinpath(*parts)

    def issues(self):
        return (read_json(self.file("triage", "issues.json")) or {}).get("issues") or []

    def plan(self):
        return read_json(self.file("triage", "plan.json")) or {}

    def known(self):
        return read_json(self.workdir / "known-issues.json") or {}

    def save_known(self, known):
        write_json_atomic(self.workdir / "known-issues.json", known)

    def session(self, name, **kwargs):
        for directory in kwargs.get("writable", ()):
            directory.mkdir(parents=True, exist_ok=True)

        return session.run(self.config, event_log=self.file("sessions", f"{name}.log"), **kwargs)

    def parallel(self, items, worker):
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.config["max_parallel"]) as pool:
            return list(pool.map(worker, items))


# --- fetch ------------------------------------------------------------------------


def create_run(config, now):
    """A new run directory with its log window pinned; fetch reads the window from it."""
    path = config["workdir"] / run_id_for(now)
    start, end = window_for(read_cursor(config["workdir"]), now, config["interval"])
    write_json_atomic(path / "gcp-logs" / "window.json", {"start": iso(start), "end": iso(end)})

    return path


def stage_fetch(run):
    window = read_json(run.file("gcp-logs", "window.json"))
    if not window:
        raise StageError("gcp-logs/window.json is missing")

    entries, error = gcp.read_logs(run.config, window["start"], window["end"])
    if error:
        raise StageError(error)

    summary = gcp.digest(entries)
    truncated = len(entries) >= run.config["log_limit"]
    write_json_atomic(run.file("gcp-logs", "logs.json"), entries)
    write_json_atomic(run.file("gcp-logs", "digest.json"), summary)
    write_text_atomic(run.file("gcp-logs", "digest.md"), gcp.render_digest(window, summary, truncated))
    write_cursor(run.workdir, from_iso(window["end"]))
    run.note(f"fetch: {len(entries)} entries in {len(summary['groups'])} groups for {window['start']}..{window['end']}" + (" (truncated)" if truncated else ""))

    return True


# --- triage -----------------------------------------------------------------------


def normalize_issues(structured, summary):
    groups = {group["id"]: group for group in summary.get("groups") or []}
    issues = []
    seen = set()
    for raw in structured.get("issues") or []:
        if not isinstance(raw, dict) or not str(raw.get("title") or "").strip():
            continue

        base = slug(raw.get("id") or raw["title"])
        identifier = base
        suffix = 2
        while identifier in seen:
            identifier = f"{base}-{suffix}"
            suffix += 1

        seen.add(identifier)
        group_ids = [g for g in raw.get("digest_groups") or [] if g in groups]
        first = groups[group_ids[0]] if group_ids else {}
        service = str(raw.get("service") or first.get("service") or "unknown")
        title = str(raw["title"]).strip()[:200]
        issues.append({
            "id": identifier,
            "title": title,
            "service": service,
            "namespace": str(raw.get("namespace") or first.get("namespace") or "unknown"),
            "severity": "error" if str(raw.get("severity", "")).lower() == "error" else "warning",
            "fingerprint": str(raw.get("fingerprint") or "").strip() or f"{service}:{slug(title)}",
            "count": sum(groups[g]["count"] for g in group_ids),
            "digest_groups": group_ids,
            "summary": str(raw.get("summary") or "").strip(),
            "actionable": bool(raw.get("actionable", True)),
            "known_ticket": str(raw.get("known_ticket") or "").strip(),
        })

    return issues


def known_entry(known, issue, now, ttl):
    """The known-issues entry that makes this issue skippable: a ticketed one, or one
    skipped (rejected, inconclusive, failed) less than `ttl` seconds ago."""
    entry = known.get(issue["fingerprint"])
    if entry is None and issue["known_ticket"]:
        entry = next((e for e in known.values() if e.get("ticket") == issue["known_ticket"]), None)

    if entry is None:
        return None

    if entry.get("status") == "ticketed":
        return entry

    try:
        return entry if now - from_iso(entry.get("at", "")) < ttl else None
    except ValueError:
        return None


def plan_issues(issues, known, now, ttl):
    plan = {}
    for issue in issues:
        if not issue["actionable"]:
            plan[issue["id"]] = {"action": "ignore"}
            continue

        entry = known_entry(known, issue, now, ttl)
        if entry:
            plan[issue["id"]] = {"action": "known", "ticket": entry.get("ticket", ""), "status": entry.get("status", "")}
        else:
            plan[issue["id"]] = {"action": "investigate"}

    return plan


def fallback_triage(issues, notes):
    lines = ["# Triage", "", "The triage session returned its result without writing this file; generated from its structured reply.", ""]
    if notes:
        lines += [notes, ""]

    for issue in issues:
        lines += [f"## {issue['id']} — {issue['severity']} — {issue['namespace']}/{issue['service']}", "", issue["title"], "", issue["summary"], ""]

    return "\n".join(lines)


def stage_triage(run):
    summary = read_json(run.file("gcp-logs", "digest.json"))
    if summary is None:
        raise StageError("gcp-logs/digest.json is missing")

    known = run.known()
    known_for_prompt = [
        {"fingerprint": fingerprint, "title": entry.get("title", ""), "ticket": entry.get("ticket", ""), "status": entry.get("status", "")}
        for fingerprint, entry in sorted(known.items())
    ]
    write_json_atomic(run.file("triage", "known-issues.json"), known_for_prompt)

    if summary["total"] == 0:
        write_text_atomic(run.file("triage", "triage.md"), "# Triage\n\nNo log entries at or above the configured severity in this window.\n")
        write_json_atomic(run.file("triage", "issues.json"), {"issues": [], "notes": "no entries"})
        write_json_atomic(run.file("triage", "plan.json"), {})
        run.note("triage: no entries, nothing to classify")

        return True

    window = read_json(run.file("gcp-logs", "window.json")) or {}
    prompt = render_prompt(
        "triage",
        run_dir=run.path,
        window_start=window.get("start", ""),
        window_end=window.get("end", ""),
        namespaces=", ".join(run.config["namespaces"]),
    )
    reply = run.session(
        "triage",
        model=run.config["triage_model"],
        effort=run.config["triage_effort"],
        prompt=prompt,
        cwd=run.path,
        schema=TRIAGE_SCHEMA,
        tools=INVESTIGATE_TOOLS,
        add_dirs=(run.workdir,),
        writable=(run.file("triage"),),
    )
    if reply["status"] != "ok":
        raise StageError(f"triage session: {reply['detail']}")

    issues = normalize_issues(reply["structured"], summary)
    notes = str(reply["structured"].get("notes") or "")
    if not run.file("triage", "triage.md").exists():
        write_text_atomic(run.file("triage", "triage.md"), fallback_triage(issues, notes))

    logs = read_json(run.file("gcp-logs", "logs.json")) or []
    groups = {group["id"]: group for group in summary["groups"]}
    for issue in issues:
        indexes = [index for group_id in issue["digest_groups"] for index in groups[group_id]["entries"]]
        write_json_atomic(run.file("triage", "issues", f"{issue['id']}.json"), {**issue, "sample_entries": [logs[index] for index in indexes if index < len(logs)]})

    plan = plan_issues(issues, known, time.time(), run.config["reject_ttl"])
    write_json_atomic(run.file("triage", "issues.json"), {"issues": issues, "notes": notes})
    write_json_atomic(run.file("triage", "plan.json"), plan)

    counts = {action: sum(1 for p in plan.values() if p["action"] == action) for action in ("investigate", "known", "ignore")}
    errors = sum(1 for issue in issues if issue["severity"] == "error")
    run.note(f"triage: {len(issues)} issues ({errors} errors, {len(issues) - errors} warnings); {counts['investigate']} to investigate, {counts['known']} known, {counts['ignore']} not actionable ({session.usage_note(reply)})")

    return True


# --- findings and challenge ------------------------------------------------------------


def to_investigate(run):
    plan = run.plan()

    return [issue for issue in run.issues() if plan.get(issue["id"], {}).get("action") == "investigate"]


def item_failed(run, stage, issue, detail, result):
    """Counts one failed attempt; after MAX_ATTEMPTS the item is recorded as failed and the stage moves on."""
    count = bump_attempts(run.path, f"{stage}-{issue['id']}")
    if count < MAX_ATTEMPTS:
        run.note(f"{stage} {issue['id']} failed (attempt {count}): {detail}; retrying next tick")

        return

    write_json_atomic(result, {"status": "failed", "detail": detail})
    run.alert(f"{stage} {issue['id']} gave up after {count} attempts: {detail}")


def fallback_markdown(title, structured, fields):
    lines = [f"# {title}", "", "The session returned its result without writing this file; generated from its structured reply.", ""]
    for key, heading in fields:
        lines += [f"## {heading}", "", str(structured.get(key) or "(none)"), ""]

    return "\n".join(lines)


def investigate(run, issue):
    result = run.file("findings", f"{issue['id']}.json")
    output = run.file("findings", f"{issue['id']}.md")
    prompt = render_prompt(
        "finding",
        run_dir=run.path,
        issue_file=run.file("triage", "issues", f"{issue['id']}.json"),
        output=output,
        repos_dir=run.config["repos_dir"],
        worktrees_dir=run.workdir / "worktrees",
        gcp_project=run.config["gcp_project"],
        namespace=issue["namespace"],
        service=issue["service"],
        title=issue["title"],
    )
    reply = run.session(
        f"finding-{issue['id']}",
        model=run.config["findings_model"],
        effort=run.config["findings_effort"],
        prompt=prompt,
        cwd=run.path,
        schema=FINDING_SCHEMA,
        tools=INVESTIGATE_TOOLS,
        add_dirs=(run.workdir, run.config["repos_dir"]),
        writable=(run.file("findings"), run.workdir / "worktrees"),
    )
    if reply["status"] != "ok":
        item_failed(run, "findings", issue, reply["detail"], result)

        return

    structured = reply["structured"]
    if not output.exists():
        write_text_atomic(output, fallback_markdown(f"Finding: {issue['title']}", structured, (("summary", "Summary"), ("root_cause", "Probable root cause"), ("proposed_fix", "Proposed fix"))))

    write_json_atomic(result, {**structured, "usage": reply["usage"]})
    run.note(f"findings {issue['id']}: {structured['status']} ({structured['confidence']} confidence, {session.usage_note(reply)})")


def stage_findings(run):
    pending = [issue for issue in to_investigate(run) if not run.file("findings", f"{issue['id']}.json").exists()]
    run.parallel(pending, lambda issue: investigate(run, issue))
    remaining = [issue["id"] for issue in to_investigate(run) if not run.file("findings", f"{issue['id']}.json").exists()]
    if remaining:
        run.note(f"findings: {len(remaining)} still pending, retrying next tick")

        return False

    return True


def challenge(run, issue):
    result = run.file("challenged-findings", f"{issue['id']}.json")
    finding = read_json(run.file("findings", f"{issue['id']}.json")) or {}
    if finding.get("status") != "found":
        write_json_atomic(result, {"verdict": "skipped", "detail": f"finding status {finding.get('status', 'missing')}"})

        return

    output = run.file("challenged-findings", f"{issue['id']}.md")
    prompt = render_prompt(
        "challenge",
        run_dir=run.path,
        issue_file=run.file("triage", "issues", f"{issue['id']}.json"),
        finding_file=run.file("findings", f"{issue['id']}.md"),
        output=output,
        repos_dir=run.config["repos_dir"],
        worktrees_dir=run.workdir / "worktrees",
        gcp_project=run.config["gcp_project"],
        title=issue["title"],
    )
    reply = run.session(
        f"challenge-{issue['id']}",
        model=run.config["challenge_model"],
        effort=run.config["challenge_effort"],
        prompt=prompt,
        cwd=run.path,
        schema=CHALLENGE_SCHEMA,
        tools=INVESTIGATE_TOOLS,
        add_dirs=(run.workdir, run.config["repos_dir"]),
        writable=(run.file("challenged-findings"), run.workdir / "worktrees"),
    )
    if reply["status"] != "ok":
        item_failed(run, "challenge", issue, reply["detail"], result)

        return

    structured = reply["structured"]
    if not output.exists():
        write_text_atomic(output, fallback_markdown(f"Challenge: {issue['title']}", structured, (("verdict", "Verdict"), ("summary", "Summary"), ("corrected_root_cause", "Corrected root cause"), ("corrected_fix", "Corrected fix"))))

    write_json_atomic(result, {**structured, "usage": reply["usage"]})
    run.note(f"challenge {issue['id']}: {structured['verdict']} ({structured['confidence']} confidence, {session.usage_note(reply)})")


def stage_challenge(run):
    pending = [issue for issue in to_investigate(run) if not run.file("challenged-findings", f"{issue['id']}.json").exists()]
    run.parallel(pending, lambda issue: challenge(run, issue))
    remaining = [issue["id"] for issue in to_investigate(run) if not run.file("challenged-findings", f"{issue['id']}.json").exists()]
    if remaining:
        run.note(f"challenge: {len(remaining)} still pending, retrying next tick")

        return False

    return True


# --- tickets ----------------------------------------------------------------------


def sample_lines(issue_data):
    lines = []
    for entry in issue_data.get("sample_entries") or []:
        lines.append(f"{entry.get('timestamp', '')} {entry.get('severity', '')} {gcp.message_of(entry)[:400]}")
        if len(lines) == SAMPLE_LINES:
            break

    return lines


def ticket_title(issue):
    return f"[{issue['service']}] {issue['title']}"[:120]


def ticket_description(run, issue, finding, verdict):
    window = read_json(run.file("gcp-logs", "window.json")) or {}
    issue_data = read_json(run.file("triage", "issues", f"{issue['id']}.json")) or {}
    root_cause = verdict.get("corrected_root_cause") or finding.get("root_cause") or "(none)"
    fix = verdict.get("corrected_fix") or finding.get("proposed_fix") or "(none)"
    samples = sample_lines(issue_data)
    files = finding.get("files") or []
    parts = [
        "## Summary", "", finding.get("summary") or issue["summary"] or issue["title"], "",
        "## Impact", "",
        f"- Service: {issue['namespace']}/{issue['service']}",
        f"- Severity: {issue['severity']}",
        f"- Occurrences: {issue['count']} between {window.get('start', '?')} and {window.get('end', '?')} (UTC)",
        "",
        "## Evidence", "", "```", *(samples or ["(no sample entries)"]), "```", "",
        "## Probable root cause", "", root_cause, "",
        "## Proposed fix", "", fix, "",
        *(["Files:", "", *[f"- `{file}`" for file in files], ""] if files else []),
        "## Independent challenge", "",
        f"Verdict: **{verdict.get('verdict', '?')}** ({verdict.get('confidence', '?')} confidence)", "", verdict.get("summary") or "", "",
        "## Artifacts", "",
        f"- Finding: `{run.file('findings', issue['id'] + '.md')}`",
        f"- Challenge: `{run.file('challenged-findings', issue['id'] + '.md')}`",
        f"- Triage: `{run.file('triage', 'triage.md')}`",
        "",
        f"_Created by prod-monitor run {run.id}._",
    ]
    text = "\n".join(parts)

    return text if len(text) <= MAX_DESCRIPTION else text[: MAX_DESCRIPTION - 20] + "\n\n_(truncated)_"


def create_ticket(run, issue, finding, verdict):
    result = run.file("tickets", f"{issue['id']}.json")
    prompt = render_prompt(
        "linear",
        tool=LINEAR_SAVE,
        team=run.config["linear_team"],
        project=run.config["linear_project"],
        labels=json.dumps(run.config["linear_labels"]),
        priority=PRIORITY[issue["severity"]],
        title=ticket_title(issue),
        description=ticket_description(run, issue, finding, verdict),
    )
    reply = run.session(
        f"linear-{issue['id']}",
        model=run.config["linear_model"],
        effort="",
        prompt=prompt,
        cwd=run.path,
        schema=LINEAR_SCHEMA,
        tools=("ToolSearch",),
        allowed_tools=("ToolSearch", LINEAR_SAVE),
        plugin=False,
        system_prompt=RELAY_SYSTEM_PROMPT,
        timeout=300,
    )
    structured = reply.get("structured") or {}
    if reply["status"] == "ok" and structured.get("status") == "unavailable":
        raise Stop(f"Linear connector unavailable: {structured.get('detail', '')}; connect it with /mcp and invoke the skill again")

    if reply["status"] != "ok" or structured.get("status") != "ok" or not structured.get("identifier"):
        item_failed(run, "tickets", issue, reply["detail"] or structured.get("detail") or "no identifier returned", result)

        return None

    ticket = {"status": "created", "identifier": structured["identifier"], "url": structured.get("url", ""), "title": ticket_title(issue)}
    write_json_atomic(result, ticket)
    run.note(f"ticket {issue['id']}: {ticket['identifier']} {ticket['url']} ({session.usage_note(reply)})")

    return ticket


def remember(run, issue, status, ticket=None, now=None):
    known = run.known()
    entry = known.get(issue["fingerprint"]) or {"recurrences": 0}
    entry.update({
        "status": status,
        "title": issue["title"],
        "service": issue["service"],
        "at": iso(now or time.time()),
        "last_seen": iso(now or time.time()),
        "run": run.id,
    })
    if ticket:
        entry.update({"ticket": ticket.get("identifier", ""), "url": ticket.get("url", "")})

    known[issue["fingerprint"]] = entry
    run.save_known(known)


def stage_tickets(run):
    plan = run.plan()
    now = time.time()
    pending = False
    for issue in run.issues():
        action = plan.get(issue["id"], {}).get("action")
        if action == "known":
            known = run.known()
            entry = known.get(issue["fingerprint"])
            if entry and entry.get("run") != run.id:
                entry["recurrences"] = entry.get("recurrences", 0) + 1
                entry["last_seen"] = iso(now)
                entry["run"] = run.id
                run.save_known(known)

            continue

        if action != "investigate" or run.file("tickets", f"{issue['id']}.json").exists():
            continue

        verdict = read_json(run.file("challenged-findings", f"{issue['id']}.json")) or {}
        finding = read_json(run.file("findings", f"{issue['id']}.json")) or {}
        if verdict.get("verdict") in TICKET_VERDICTS:
            ticket = create_ticket(run, issue, finding, verdict)
            if ticket:
                remember(run, issue, "ticketed", ticket, now)
            elif not run.file("tickets", f"{issue['id']}.json").exists():
                pending = True

            continue

        reason = verdict["verdict"] if verdict.get("verdict") not in (None, "skipped") else finding.get("status") or "failed"
        write_json_atomic(run.file("tickets", f"{issue['id']}.json"), {"status": "skipped", "reason": reason})
        remember(run, issue, f"skipped:{reason}", None, now)

    if pending:
        run.note("tickets: some still pending, retrying next tick")

        return False

    return True


def ticket_entries(run):
    """(issue, ticket record) for every investigated issue."""
    plan = run.plan()
    rows = []
    for issue in run.issues():
        if plan.get(issue["id"], {}).get("action") == "investigate":
            rows.append((issue, read_json(run.file("tickets", f"{issue['id']}.json")) or {"status": "missing"}))

    return rows


# --- optional draft PRs -------------------------------------------------------------


def open_pr(run, issue):
    result = run.file("prs", f"{issue['id']}.json")
    finding = read_json(run.file("findings", f"{issue['id']}.json")) or {}
    verdict = read_json(run.file("challenged-findings", f"{issue['id']}.json")) or {}
    ticket = read_json(run.file("tickets", f"{issue['id']}.json")) or {}
    repos = [name for name in finding.get("repos") or [] if (run.config["repos_dir"] / name).is_dir()]
    if ticket.get("status") != "created" or verdict.get("verdict") != "confirmed" or len(repos) != 1:
        write_json_atomic(result, {"status": "skipped", "detail": "needs a created ticket, a confirmed verdict and exactly one repo", "url": ""})

        return

    worktree = run.workdir / "worktrees" / f"{repos[0]}-{issue['id']}"
    prompt = render_prompt(
        "fix-pr",
        repo_dir=run.config["repos_dir"] / repos[0],
        worktree=worktree,
        branch=f"fix/{issue['id']}"[:60],
        finding_file=run.file("findings", f"{issue['id']}.md"),
        challenge_file=run.file("challenged-findings", f"{issue['id']}.md"),
        ticket=ticket.get("identifier", ""),
        ticket_url=ticket.get("url", ""),
        title=issue["title"],
    )
    reply = run.session(
        f"pr-{issue['id']}",
        model=run.config["pr_model"],
        effort=run.config["pr_effort"],
        prompt=prompt,
        cwd=run.config["repos_dir"] / repos[0],
        schema=PR_SCHEMA,
        add_dirs=(run.workdir, run.config["repos_dir"]),
        writable=(worktree, run.file("prs")),
        slash_commands=True,
    )
    structured = reply.get("structured") or {}
    if reply["status"] != "ok":
        item_failed(run, "prs", issue, reply["detail"], result)

        return

    write_json_atomic(result, {**structured, "usage": reply["usage"]})
    run.note(f"pr {issue['id']}: {structured['status']} {structured.get('url', '')} {structured.get('detail', '')} ({session.usage_note(reply)})")


def stage_prs(run):
    if not run.config["open_prs"]:
        return True

    pending = [issue for issue, _ in ticket_entries(run) if not run.file("prs", f"{issue['id']}.json").exists()]
    run.parallel(pending, lambda issue: open_pr(run, issue))
    remaining = [issue["id"] for issue, _ in ticket_entries(run) if not run.file("prs", f"{issue['id']}.json").exists()]
    if remaining:
        run.note(f"prs: {len(remaining)} still pending, retrying next tick")

        return False

    return True


# --- report -----------------------------------------------------------------------


def render_report(run):
    window = read_json(run.file("gcp-logs", "window.json")) or {}
    plan = run.plan()
    issues = run.issues()
    created = []
    skipped = []
    for issue, ticket in ticket_entries(run):
        pr = read_json(run.file("prs", f"{issue['id']}.json")) or {}
        pr_note = f" — PR {pr['url']}" if pr.get("status") == "ok" and pr.get("url") else ""
        if ticket.get("status") == "created":
            created.append(f"- {ticket['identifier']} — {issue['title']} ({issue['namespace']}/{issue['service']}, {issue['severity']}) — {ticket.get('url', '')}{pr_note} — `{run.file('findings', issue['id'] + '.md')}`")
        else:
            skipped.append(f"- {issue['id']} — {issue['title']} — {ticket.get('reason') or ticket.get('detail') or ticket.get('status')}")

    known = run.known()
    recurring = [
        f"- {known.get(issue['fingerprint'], {}).get('ticket') or plan[issue['id']].get('ticket') or plan[issue['id']].get('status')} — {issue['title']} ({issue['count']} occurrences)"
        for issue in issues
        if plan.get(issue["id"], {}).get("action") == "known"
    ]
    ignored = [f"- {issue['title']} ({issue['count']} occurrences)" for issue in issues if plan.get(issue["id"], {}).get("action") == "ignore"]
    lines = [
        f"# prod-monitor run {run.id}",
        "",
        f"- Window: {window.get('start', '?')} to {window.get('end', '?')} (UTC)",
        f"- Run directory: `{run.path}`",
        f"- Issues triaged: {len(issues)}",
        "",
        "## Tickets created", "", *(created or ["- none"]), "",
        "## Investigated without a ticket", "", *(skipped or ["- none"]), "",
        "## Recurrences of known issues", "", *(recurring or ["- none"]), "",
        "## Not actionable", "", *(ignored or ["- none"]), "",
    ]

    return "\n".join(lines), created


def stage_report(run):
    text, created = render_report(run)
    started = run_started(run.id) or time.time()
    report = run.workdir / "tickets" / day_for(started) / f"{run.id}.md"
    write_text_atomic(report, text)
    write_text_atomic(run.file("report.md"), text)
    run.note(f"report: {report}")
    if created:
        run.alert(f"run {run.id} created {len(created)} ticket(s):\n" + "\n".join(created) + f"\nreport: {report}")

    return True


STAGES = (
    ("fetch", stage_fetch),
    ("triage", stage_triage),
    ("findings", stage_findings),
    ("challenge", stage_challenge),
    ("tickets", stage_tickets),
    ("prs", stage_prs),
    ("report", stage_report),
)


def process(config, path):
    """Runs every unfinished stage of the run at `path`. Returns the Run with its notes and alerts."""
    run = Run(config, path)
    if is_done(path, "run"):
        return run

    for name, stage in STAGES:
        if is_done(path, name):
            continue

        try:
            complete = stage(run)
        except StageError as error:
            count = bump_attempts(path, name)
            if count < MAX_ATTEMPTS:
                run.note(f"{name} failed (attempt {count}): {error}; retrying next tick")

                return run

            if name == "fetch":
                raise Stop(f"fetch failed {count} times for run {run.id}: {error}")

            mark_failed(path, f"{name}: {error}")
            run.alert(f"run {run.id} failed at {name} after {count} attempts: {error}")

            return run

        if not complete:
            return run

        mark_done(path, name)

    mark_done(path, "run")
    run.note("run complete")

    return run
