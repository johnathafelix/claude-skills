#!/usr/bin/env python3
"""Read Cloud Logging entries for the watched namespaces and digest them.

The digest is deterministic: entries are grouped by namespace, service, severity and
a normalized message (numbers, hex ids and UUIDs replaced), so the triage model reads a
few hundred lines of counts and samples instead of thousands of raw entries, and can
still open the raw entries by index in logs.json.
"""
import json
import re
import subprocess

from common import SEVERITIES, from_iso, iso

GCLOUD_TIMEOUT_SECONDS = 600
SAMPLE_ENTRIES = 5
MESSAGE_KEYS = ("message", "msg", "error", "err", "exception", "stack", "description", "event")
POD_SUFFIX = re.compile(r"(-[a-f0-9]{6,10})?-[a-z0-9]{5}$")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
HEX = re.compile(r"\b[0-9a-f]{12,}\b", re.I)
NUMBER = re.compile(r"\d+")
SPACES = re.compile(r"\s+")


def build_filter(namespaces, start, end, min_severity="WARNING", extra=""):
    names = " OR ".join(json.dumps(name) for name in namespaces)
    clauses = [
        f'timestamp>="{start}"',
        f'timestamp<"{end}"',
        f"severity>={min_severity}",
        f"resource.labels.namespace_name=({names})",
    ]
    if extra:
        clauses.append(f"({extra})")

    return " AND ".join(clauses)


def run_query(project, query, limit, order):
    """(entries sorted by timestamp, error text) for one gcloud logging read."""
    argv = [
        "gcloud", "logging", "read", query,
        f"--project={project}",
        "--format=json",
        f"--limit={limit}",
        f"--order={order}",
    ]

    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=GCLOUD_TIMEOUT_SECONDS)
    except FileNotFoundError:
        return [], "gcloud is not on PATH; install the Google Cloud SDK"
    except subprocess.TimeoutExpired:
        return [], f"gcloud logging read timed out after {GCLOUD_TIMEOUT_SECONDS}s"

    if result.returncode != 0:
        return [], f"gcloud logging read failed: {result.stderr.strip()[-500:]}"

    try:
        entries = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        return [], f"gcloud returned unreadable JSON: {result.stdout[:200]}"

    if not isinstance(entries, list):
        return [], "gcloud returned something other than a list of entries"

    return sorted(entries, key=lambda e: e.get("timestamp", "")), ""


def read_logs(config, start, end):
    """The newest `log_limit` entries of one window, at or above the severity floor."""
    query = build_filter(config["namespaces"], start, end, config["min_severity"], config["extra_filter"])

    return run_query(config["gcp_project"], query, config["log_limit"], "desc")


def slices(start, end, slice_seconds):
    """[start, end) cut into consecutive slices of `slice_seconds` (the last one shorter), as ISO pairs."""
    first, last = from_iso(start), from_iso(end)
    cuts = []
    cursor = first
    while cursor < last:
        cuts.append((iso(cursor), iso(min(cursor + slice_seconds, last))))
        cursor += slice_seconds

    return cuts


def read_window(config, start, end):
    """(entries, slices, error): the window read slice by slice, each slice keeping its newest
    share of `log_limit`, so a noisy hour is sampled evenly instead of newest-only.
    Each slice record says how many entries it returned and whether it hit its cap."""
    cuts = slices(start, end, config["slice_seconds"])
    if not cuts:
        return [], [], "empty window"

    per_slice = max(1, -(-config["log_limit"] // len(cuts)))
    entries = []
    records = []
    for slice_start, slice_end in cuts:
        query = build_filter(config["namespaces"], slice_start, slice_end, config["min_severity"], config["extra_filter"])
        found, error = run_query(config["gcp_project"], query, per_slice, "desc")
        if error:
            return [], records, f"slice {slice_start}..{slice_end}: {error}"

        entries.extend(found)
        records.append({"start": slice_start, "end": slice_end, "entries": len(found), "limit": per_slice, "truncated": len(found) >= per_slice})

    return sorted(entries, key=lambda e: e.get("timestamp", "")), records, ""


def pod_of(entry):
    return ((entry.get("resource") or {}).get("labels") or {}).get("pod_name", "")


def trace_of(entry):
    return entry.get("trace") or ""


def context_filter(namespace, pods, traces, service, start, end):
    """All severities around an issue: its pods or traces, else its service, in its namespace."""
    scopes = []
    if pods:
        scopes.append("resource.labels.pod_name=(" + " OR ".join(json.dumps(p) for p in sorted(pods)) + ")")

    if traces:
        scopes.append("trace=(" + " OR ".join(json.dumps(t) for t in sorted(traces)) + ")")

    if not scopes:
        scopes.append(f"resource.labels.container_name={json.dumps(service)}")

    return " AND ".join([
        f'timestamp>="{start}"',
        f'timestamp<"{end}"',
        f"resource.labels.namespace_name={json.dumps(namespace)}",
        "(" + " OR ".join(scopes) + ")",
    ])


def context_window(entries, before, after):
    """[start, end) ISO timestamps: `before` seconds before the first sample to `after` after the last."""
    stamps = sorted(e.get("timestamp", "") for e in entries if e.get("timestamp"))
    if not stamps:
        return None

    first = from_iso(stamps[0][:19] + "Z")
    last = from_iso(stamps[-1][:19] + "Z")

    return iso(first - before), iso(last + after + 1)


def read_context(config, issue):
    """(entries, window, error): every severity around the issue's sample entries, oldest first."""
    samples = issue.get("sample_entries") or []
    window = context_window(samples, config["context_before"], config["context_after"])
    if window is None:
        return [], None, "the issue has no timestamped sample entries"

    query = context_filter(
        issue.get("namespace", ""),
        {pod_of(e) for e in samples if pod_of(e)},
        {trace_of(e) for e in samples if trace_of(e)},
        issue.get("service", ""),
        *window,
    )
    entries, error = run_query(config["gcp_project"], query, config["context_limit"], "asc")

    return entries, {"start": window[0], "end": window[1], "query": query}, error


def render_context(issue, entries, window, error, limit):
    """Chronological lines; the issue's own sample entries are marked with >>."""
    marked = {(e.get("timestamp"), e.get("insertId")) for e in issue.get("sample_entries") or []}
    lines = [f"# Context for {issue.get('id', '')}", ""]
    if error:
        lines += [f"Context fetch failed: {error}", ""]

        return "\n".join(lines)

    lines += [
        f"- Window: {window['start']} to {window['end']} (UTC), all severities",
        f"- Entries: {len(entries)}" + (f" (truncated at {limit}; the oldest entries were kept)" if len(entries) >= limit else ""),
        "- Lines starting with >> are the issue's own sample entries",
        "",
        "```",
    ]
    for entry in entries:
        mark = ">>" if (entry.get("timestamp"), entry.get("insertId")) in marked else "  "
        lines.append(f"{mark} {entry.get('timestamp', '')} {entry.get('severity', 'DEFAULT'):8} {pod_of(entry) or service_of(entry)} {message_of(entry)[:400]}")

    lines += ["```", ""]

    return "\n".join(lines)


def message_of(entry):
    text = entry.get("textPayload")
    if isinstance(text, str) and text.strip():
        return text.strip()

    payload = entry.get("jsonPayload") or entry.get("protoPayload") or {}
    if isinstance(payload, dict):
        for key in MESSAGE_KEYS:
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

            if isinstance(value, dict):
                nested = value.get("message") or value.get("msg")
                if isinstance(nested, str) and nested.strip():
                    return nested.strip()

        if payload:
            return json.dumps(payload, sort_keys=True)[:500]

    return "(no message)"


def service_of(entry):
    """The service name: the Helm release / app labels first, since the container is often a
    generic name (platform-app) shared by every service of a chart."""
    resource = (entry.get("resource") or {}).get("labels") or {}
    labels = entry.get("labels") or {}
    for key in ("k8s-pod/app_kubernetes_io/instance", "k8s-pod/app", "k8s-pod/app_kubernetes_io/name"):
        if labels.get(key):
            return labels[key]

    for key in ("container_name", "service_name"):
        if resource.get(key):
            return resource[key]

    if labels.get("k8s-pod/product"):
        return labels["k8s-pod/product"]

    pod = resource.get("pod_name")
    if pod:
        return POD_SUFFIX.sub("", pod)

    return resource.get("module_id") or "unknown"


def namespace_of(entry):
    return ((entry.get("resource") or {}).get("labels") or {}).get("namespace_name", "unknown")


def normalize(message):
    text = UUID.sub("<uuid>", message)
    text = HEX.sub("<hex>", text)
    text = NUMBER.sub("#", text)
    text = SPACES.sub(" ", text).strip()

    return text[:200]


def severity_rank(name):
    return SEVERITIES.index(name) if name in SEVERITIES else 0


def digest(entries):
    groups = {}
    for index, entry in enumerate(entries):
        message = message_of(entry)
        severity = entry.get("severity") or "DEFAULT"
        key = (namespace_of(entry), service_of(entry), severity, normalize(message))
        group = groups.get(key)
        stamp = entry.get("timestamp", "")
        if group is None:
            group = groups[key] = {
                "namespace": key[0],
                "service": key[1],
                "severity": severity,
                "signature": key[3],
                "count": 0,
                "first_seen": stamp,
                "last_seen": stamp,
                "sample": message[:1000],
                "entries": [],
            }

        group["count"] += 1
        group["first_seen"] = min(group["first_seen"], stamp) if stamp else group["first_seen"]
        group["last_seen"] = max(group["last_seen"], stamp)
        if len(group["entries"]) < SAMPLE_ENTRIES:
            group["entries"].append(index)

    ordered = sorted(groups.values(), key=lambda g: (-severity_rank(g["severity"]), -g["count"], g["service"], g["signature"]))
    for number, group in enumerate(ordered, start=1):
        group["id"] = f"g{number}"

    by_severity = {}
    by_service = {}
    for group in ordered:
        by_severity[group["severity"]] = by_severity.get(group["severity"], 0) + group["count"]
        service = f"{group['namespace']}/{group['service']}"
        by_service[service] = by_service.get(service, 0) + group["count"]

    return {"total": len(entries), "groups": ordered, "by_severity": by_severity, "by_service": by_service}


def render_digest(window, summary, truncated):
    """`truncated` lists the slices that hit their cap, as {start, end, limit} records."""
    lines = [
        "# Log digest",
        "",
        f"- Window: {window['start']} to {window['end']} (UTC)",
        f"- Entries: {summary['total']}",
        f"- Groups: {len(summary['groups'])}",
    ]
    if truncated:
        lines.append(f"- Truncated: {len(truncated)} slice(s) hit their cap, so only their newest entries are here: "
                     + ", ".join(f"{s['start']}..{s['end']} ({s['limit']})" for s in truncated))

    lines += [
        "",
        "## By severity",
        "",
        *[f"- {severity}: {count}" for severity, count in sorted(summary["by_severity"].items(), key=lambda item: -severity_rank(item[0]))],
        "",
        "## By service",
        "",
        *[f"- {service}: {count}" for service, count in sorted(summary["by_service"].items(), key=lambda item: -item[1])],
        "",
        "## Groups (most severe and most frequent first)",
        "",
        "Each group lists the indexes of up to five raw entries in logs.json.",
        "",
    ]
    for group in summary["groups"]:
        lines += [
            f"### {group['id']} — {group['severity']} ×{group['count']} — {group['namespace']}/{group['service']}",
            "",
            f"- First seen: {group['first_seen']}",
            f"- Last seen: {group['last_seen']}",
            f"- Raw entries: {', '.join(str(index) for index in group['entries'])}",
            "",
            "```",
            group["sample"],
            "```",
            "",
        ]

    return "\n".join(lines)
