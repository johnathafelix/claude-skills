#!/usr/bin/env python3
"""Prepare a pinned PR scope and retain complete reviews for incremental re-review."""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shlex
import subprocess
import tempfile

VERSION = 1
PLUGIN = pathlib.Path(__file__).resolve().parents[3]
PR = re.compile(r"https://github.com/([^/\s]+)/([^/\s]+)/pull/(\d+)$")
GLOBAL_INPUT = re.compile(
    r"(^|/)(package\.json|[^/]*lock[^/]*|go\.(mod|sum)|CLAUDE(?:\.local)?\.md|"
    r"tsconfig[^/]*|[^/]*(?:jest|vitest|babel|webpack|vite)\.config\.[^/]+|"
    r"\.npmrc|\.yarnrc[^/]*|\.env[^/]*|Dockerfile[^/]*)$|(^|/)(\.github|\.claude|\.yarn)/"
)


def git(repo, *args, check=True):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, check=False)
    if check and result.returncode:
        raise ValueError(result.stderr.decode(errors="replace").strip())
    return result


def names(repo, start, end):
    return sorted(set(git(repo, "diff", "--no-renames", "--name-only", "-z", start, end).stdout.decode().split("\0")) - {""})


def policy_hash(plugin, profile, effort):
    digest = hashlib.sha256(f"{VERSION}:{profile}:{effort}".encode())
    # Any checker, guideline, reference or review helper change invalidates reuse.
    roots = [plugin / "skills" / s for s in ("code-review", "review-pr", "golang-check", "ts-check", "test-check")]
    roots += [plugin / "scripts", plugin / "agents"]
    for root in roots:
        for p in sorted(root.rglob("*")):
            if p.is_file() and p.suffix in (".md", ".js", ".py", ".json"):
                digest.update(str(p.relative_to(plugin)).encode())
                digest.update(p.read_bytes())
    return digest.hexdigest()


def cache_path(url, cache_dir):
    match = PR.fullmatch(url)
    if not match:
        raise ValueError("Expected a GitHub PR URL")
    owner, repo, number = match.groups()
    if any(part in (".", "..") for part in (owner, repo)):
        raise ValueError("Invalid repository name")
    return cache_dir / owner.lower() / repo.lower() / f"{number}.json"


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def valid_findings(findings):
    return isinstance(findings, list) and all(
        isinstance(f, dict) and f.get("verified") is True
        and isinstance(f.get("file"), str) and bool(f["file"])
        and not pathlib.PurePosixPath(f["file"]).is_absolute()
        and ".." not in pathlib.PurePosixPath(f["file"]).parts
        and type(f.get("line")) is int and f["line"] > 0
        for f in findings
    )


def require_clean(repo):
    if git(repo, "status", "--porcelain", "--untracked-files=normal").stdout:
        raise ValueError("Review cache requires a clean pinned worktree")


def relocate(repo, previous, head, finding):
    """Translate unaffected old lines; changed anchors require source-based relocation."""
    finding = dict(finding)
    line = finding.get("line")
    if not isinstance(line, int) or not isinstance(finding.get("file"), str):
        raise ValueError("Malformed cached finding")
    patch = git(repo, "diff", "--no-renames", "-U0", previous, head, "--", finding["file"]).stdout.decode(errors="replace")
    offset = 0
    for match in re.finditer(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", patch, re.M):
        start, count = int(match[1]), int(match[2] if match[2] is not None else 1)
        added = int(match[4] if match[4] is not None else 1)
        if count == 0:
            if line > start:
                offset += added
        elif line >= start + count:
            offset += added - count
        elif line >= start:
            finding["needsRelocation"] = True
            break
    finding["previousLine"] = line
    if not finding.get("needsRelocation"):
        finding["line"] = line + offset
    if not (repo / finding["file"]).exists():
        finding["needsRelocation"] = True
    return finding


def prior_id(finding):
    if finding.get("priorId"):
        return str(finding["priorId"])
    if finding.get("priorIds"):
        return str(finding["priorIds"][0])
    value = json.dumps([finding.get("file"), finding.get("claimKey") or finding.get("description")], ensure_ascii=False, separators=(",", ":"))
    return "cached:" + hashlib.sha256(value.encode()).hexdigest()[:20]


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as f:
        json.dump(data, f, indent=2)
        name = f.name
    os.replace(name, path)


def prepare(repo, base, head, url, cache_dir, plugin=PLUGIN, profile="standard", effort="medium", full=False):
    repo = pathlib.Path(repo).resolve()
    actual = git(repo, "rev-parse", "HEAD").stdout.decode().strip()
    head = git(repo, "rev-parse", "--verify", f"{head}^{{commit}}").stdout.decode().strip()
    if actual != head:
        raise ValueError("Worktree does not contain the pinned PR head")
    require_clean(repo)
    base_sha = git(repo, "rev-parse", "--verify", f"{base}^{{commit}}").stdout.decode().strip()
    merge_base = git(repo, "merge-base", base_sha, head).stdout.decode().strip()
    files = names(repo, merge_base, head)
    policy = policy_hash(plugin, profile, effort)
    stored = cache_path(url, cache_dir)
    prior = load(stored)
    reason = "no complete matching prior review"
    incremental = False
    delta = files
    prior_findings = []
    # Full scope/profile changes invalidate reuse, not the obligation to recheck
    # previous claims. Keep them even when no incremental review can be used.
    if isinstance(prior, dict) and prior.get("url") == url and valid_findings(prior.get("findings")):
        previous = prior.get("head", "")
        available = bool(re.fullmatch(r"[0-9a-f]{40,64}", str(previous))) and git(repo, "cat-file", "-e", f"{previous}^{{commit}}", check=False).returncode == 0
        for finding in prior["findings"]:
            moved = relocate(repo, previous, head, finding) if available else {**finding, "needsRelocation": True}
            moved["priorId"] = prior_id(finding)
            prior_findings.append(moved)
    if full:
        reason = "full review requested"
    elif isinstance(prior, dict) and prior.get("complete") and prior.get("version") == VERSION:
        if prior.get("url") != url or not valid_findings(prior.get("findings")):
            reason = "prior cache is malformed or belongs to another PR"
        elif prior.get("policy") != policy:
            reason = "review policy, profile or effort changed"
        elif prior.get("baseSha") != base_sha or prior.get("mergeBase") != merge_base:
            reason = "PR base changed"
        elif not re.fullmatch(r"[0-9a-f]{40,64}", str(prior.get("head", ""))) or git(repo, "merge-base", "--is-ancestor", prior["head"], head, check=False).returncode:
            reason = "prior head unavailable or history rewritten"
        else:
            delta = names(repo, prior["head"], head)
            if any(GLOBAL_INPUT.search(f) for f in delta):
                reason = "dependency, configuration or repository instructions changed"
                delta = files
            else:
                incremental = True
                reason = "review new delta and affected callers; recheck all prior findings"
    # Include both sides of renames/deletions and prior findings, even outside the PR diff.
    review_files = sorted(set(delta) | {f["file"] for f in prior_findings if isinstance(f, dict) and isinstance(f.get("file"), str)})
    start = prior["head"] if incremental else merge_base
    command = shlex.join(["git", "-C", str(repo), "diff", start, head])
    return {
        "version": VERSION, "url": url, "repoDir": str(repo), "head": head,
        "baseSha": base_sha, "mergeBase": merge_base, "policy": policy,
        "cachePath": str(stored), "incremental": incremental, "reason": reason,
        "files": files, "reviewFiles": review_files, "deltaFiles": delta,
        "priorFindings": prior_findings, "diffCommand": command,
        "expectedPriorIds": list(dict.fromkeys(identifier for f in prior_findings
            for identifier in [f["priorId"], *(f.get("priorIds") or [])] if isinstance(identifier, str))),
        "fullDiffCommand": shlex.join(["git", "-C", str(repo), "diff", merge_base, head]),
        "previousHead": prior.get("head") if isinstance(prior, dict) else None,
    }


def save(context, report):
    claims = report.get("priorClaims") or {}
    expected = set(context.get("expectedPriorIds", [])) | set(claims.get("expected", []))
    if expected - set(claims.get("challenged", [])) or claims.get("missing"):
        return {"saved": False, "reason": "prior claims lack independent verdicts; prior cache retained"}
    if not report.get("complete") or any(report.get(k) for k in ("dimensionsUnverified", "unverified", "unchallenged", "rejectedFindings", "inputGaps", "coverageUnverified")):
        return {"saved": False, "reason": "review incomplete; prior cache retained"}
    findings = report.get("findings")
    if not valid_findings(findings):
        raise ValueError("Store only independently verified findings")
    if git(context["repoDir"], "rev-parse", "HEAD").stdout.decode().strip() != context["head"]:
        raise ValueError("Reviewed worktree head changed")
    require_clean(context["repoDir"])
    data = {k: context[k] for k in ("version", "url", "head", "baseSha", "mergeBase", "policy")}
    data.update(complete=True, findings=findings)
    path = pathlib.Path(context["cachePath"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        old = load(path)
        if isinstance(old, dict) and old.get("head") != context["previousHead"] and old.get("head") != context["head"]:
            return {"saved": False, "reason": "another review updated this cache"}
        atomic_json(path, data)
    return {"saved": True, "cachePath": str(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("prepare")
    for flag in ("repo", "base", "head", "url", "out"):
        plan.add_argument(f"--{flag}", required=True)
    plan.add_argument("--cache-dir", type=pathlib.Path, default=pathlib.Path(os.environ.get("REVIEW_PR_CACHE_DIR", pathlib.Path.home() / ".claude/review-requests/reviews")))
    plan.add_argument("--plugin", type=pathlib.Path, default=PLUGIN)
    plan.add_argument("--profile", choices=("fast", "standard", "thorough"), default="standard")
    plan.add_argument("--effort", choices=("low", "medium", "high", "xhigh", "max"), default="medium")
    plan.add_argument("--full", action="store_true")
    write = sub.add_parser("save")
    write.add_argument("--context", required=True, type=pathlib.Path)
    write.add_argument("--report", required=True, type=pathlib.Path)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            data = prepare(args.repo, args.base, args.head, args.url, args.cache_dir, args.plugin, args.profile, args.effort, args.full)
            atomic_json(pathlib.Path(args.out), data)
            print(json.dumps({"contextPath": args.out, "incremental": data["incremental"], "reason": data["reason"], "files": data["files"], "reviewFiles": data["reviewFiles"]}))
        else:
            print(json.dumps(save(json.loads(args.context.read_text()), json.loads(args.report.read_text()))))
    except (OSError, ValueError, KeyError) as e:
        parser.exit(1, f"{e}\n")


if __name__ == "__main__":
    main()
