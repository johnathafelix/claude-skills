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

from common import SEVERITIES

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


def read_logs(config, start, end):
    """(entries sorted by timestamp, error text). Entries are the newest `log_limit` ones."""
    query = build_filter(config["namespaces"], start, end, config["min_severity"], config["extra_filter"])
    argv = [
        "gcloud", "logging", "read", query,
        f"--project={config['gcp_project']}",
        "--format=json",
        f"--limit={config['log_limit']}",
        "--order=desc",
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
    resource = (entry.get("resource") or {}).get("labels") or {}
    labels = entry.get("labels") or {}
    for key in ("container_name", "service_name"):
        if resource.get(key):
            return resource[key]

    for key in ("k8s-pod/app", "k8s-pod/app_kubernetes_io/name", "k8s-pod/product"):
        if labels.get(key):
            return labels[key]

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
    lines = [
        "# Log digest",
        "",
        f"- Window: {window['start']} to {window['end']} (UTC)",
        f"- Entries: {summary['total']}" + (" (truncated at the configured limit; the newest entries were kept)" if truncated else ""),
        f"- Groups: {len(summary['groups'])}",
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
