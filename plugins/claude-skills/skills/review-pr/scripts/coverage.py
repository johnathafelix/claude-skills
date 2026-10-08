#!/usr/bin/env python3
"""Run bounded coverage with isolated dependency and exact-input report caches."""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import re
import signal
import shutil
import subprocess
import tempfile
import time


def run(command, cwd, log, timeout):
    """Keep verbose output out of model context; stop the entire process group."""
    try:
        with pathlib.Path(log).open("w") as output:
            process = subprocess.Popen(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                return {"status": "timeout", "reason": f"command exceeded {timeout}s", "log": str(log)}
        return {"status": "ok" if code == 0 else "failed", "exitCode": code, "log": str(log)}
    except OSError as error:
        return {"status": "failed", "reason": str(error), "log": str(log)}


def tracked(repo):
    result = subprocess.run(["git", "-C", str(repo), "ls-files", "--cached", "--others", "--exclude-standard", "-z"], capture_output=True, check=True)
    return [repo / p for p in result.stdout.decode().split("\0") if p]


def fingerprint(repo, inputs, context):
    digest = hashlib.sha256(json.dumps(context, sort_keys=True).encode())
    for p in sorted(set(inputs)):
        digest.update(str(p.relative_to(repo)).encode())
        if p.exists():
            digest.update(str(p.stat().st_mode).encode())
        if p.is_symlink():
            digest.update(os.readlink(p).encode())
        elif p.is_file():
            digest.update(p.read_bytes())
        else:
            digest.update(b"<missing>")
    return digest.hexdigest()


def runtime(repo):
    versions = {}
    for tool in ("node", "npm", "yarn", "pnpm", "go"):
        try:
            result = subprocess.run([tool, "--version" if tool != "go" else "version"], cwd=repo, capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                versions[tool] = result.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
    configs = hashlib.sha256()
    for name in (".npmrc", ".yarnrc", ".yarnrc.yml"):
        p = pathlib.Path.home() / name
        configs.update(p.read_bytes() if p.is_file() else b"<missing>")
    return {"platform": platform.platform(), "machine": platform.machine(), "versions": versions, "userConfigHash": configs.hexdigest()}


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def install_command(repo, cache, versions):
    if (repo / "pnpm-lock.yaml").exists():
        return ["pnpm", "install", "--frozen-lockfile", "--store-dir", str(cache / "downloads/pnpm")]
    if (repo / "yarn.lock").exists():
        version = versions.get("yarn", "")
        if version.startswith("1."):
            return ["yarn", "install", "--frozen-lockfile", "--cache-folder", str(cache / "downloads/yarn")]
        return ["yarn", "install", "--immutable"]
    return ["npm", "ci" if (repo / "package-lock.json").exists() else "install", "--cache", str(cache / "downloads/npm")]


def dependencies(repo, cache, out, timeout, files, context):
    if not (repo / "package.json").exists():
        return {"status": "ok", "key": "non-node", "cacheable": True}
    packages = [p for p in files if p.name == "package.json"]
    inputs = [p for p in files if p.name in ("package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".npmrc", ".yarnrc", ".yarnrc.yml") or ".yarn" in p.parts]
    inputs += [repo / name for name in (".npmrc", ".yarnrc", ".yarnrc.yml")]
    key = fingerprint(repo, inputs, context)
    locked = any((repo / f).exists() for f in ("package-lock.json", "yarn.lock", "pnpm-lock.yaml"))
    # Repository lifecycle hooks may produce files outside node_modules. Re-run the
    # installer for those projects; its download cache still avoids network fetches.
    hooks = any(any(k in ((read_json(p) or {}).get("scripts") or {}) for k in ("preinstall", "install", "postinstall", "prepare")) for p in packages)
    config_files = [p for p in inputs if p.is_file() and p.name in (".npmrc", ".yarnrc", ".yarnrc.yml")]
    # Custom nodeLinker/modules-folder layouts need their own lifecycle handling.
    custom_layout = any(any(k in p.read_text() for k in ("nodeLinker:", "modules-folder", "modules-dir")) for p in config_files)
    cacheable = locked and not hooks and not custom_layout
    artifact = cache / "dependencies" / key
    manifest = read_json(artifact / "manifest.json") if cacheable else None
    if (repo / "node_modules").exists():
        return {"status": "ok", "key": key, "cacheable": False, "reason": "existing dependencies have no cache provenance"}
    if manifest:
        for name in manifest["directories"]:
            destination = repo / name
            shutil.copytree(artifact / name, destination, symlinks=True)
        return {"status": "ok", "key": key, "cacheable": True, "reused": True}
    result = run(install_command(repo, cache, context["versions"]), repo, out / "install.log", timeout)
    if result["status"] != "ok":
        return result
    if cacheable:
        directories = sorted({str((p.parent / "node_modules").relative_to(repo)) for p in packages if (p.parent / "node_modules").is_dir()})
        # Absolute symlinks cannot be transplanted between worktrees safely.
        if any(p.is_symlink() and (os.path.isabs(os.readlink(p)) or not p.resolve().is_relative_to(repo)) for name in directories for p in (repo / name).rglob("*")):
            cacheable = False
        elif directories and not artifact.exists():
            artifact.parent.mkdir(parents=True, exist_ok=True)
            staging = pathlib.Path(tempfile.mkdtemp(prefix="deps-", dir=artifact.parent))
            try:
                for name in directories:
                    shutil.copytree(repo / name, staging / name, symlinks=True)
                (staging / "manifest.json").write_text(json.dumps({"directories": directories}))
                try:
                    staging.rename(artifact)
                except OSError:
                    if not artifact.exists():
                        raise
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
    return {**result, "key": key, "cacheable": cacheable, "reused": False}


def restore_report(source, destination, previous_repo, repo):
    if destination.suffix == ".json":
        # Istanbul/Jest/Vitest JSON reports embed absolute worktree paths in keys
        # and path fields. Rebase them when restoring into a different checkout.
        def rebase(value):
            if isinstance(value, str):
                return str(repo) + value[len(previous_repo):] if value.startswith(previous_repo + "/") else value
            if isinstance(value, list):
                return [rebase(v) for v in value]
            if isinstance(value, dict):
                return {rebase(k): rebase(v) for k, v in value.items()}
            return value
        destination.write_text(json.dumps(rebase(json.loads(source.read_text()))))
    else:
        shutil.copyfile(source, destination)


def report_scope(report, expected, repo, cwd):
    """A passing suite/report is not evidence for omitted changed source files."""
    if not expected:
        return []
    if report.suffix == ".json":
        data = read_json(report)
        if not isinstance(data, dict):
            return list(expected)
        names = set(data) - {"total"}
        names.update(v["path"] for v in data.values() if isinstance(v, dict) and isinstance(v.get("path"), str))
    elif report.suffix in (".info", ".lcov"):
        names = {line[3:] for line in report.read_text().splitlines() if line.startswith("SF:")}
    else:
        lines = report.read_text().splitlines()
        names = {line.rsplit(":", 1)[0] for line in lines[1:] if ":" in line}
    present = set()
    modules = {}
    for source in expected:
        for directory in (source.parent, *source.parent.parents):
            if not directory.is_relative_to(repo):
                break
            mod = directory / "go.mod"
            if mod.is_file():
                match = re.search(r'^module\s+"?([^"\s]+)', mod.read_text(), re.M)
                if match:
                    modules[match[1]] = directory
                break
    for name in names:
        candidate = pathlib.Path(name)
        if candidate.is_absolute():
            present.add(candidate.resolve())
        else:
            present.update((root / candidate).resolve() for root in (repo, cwd))
            for module, root in modules.items():
                if name.startswith(module + "/"):
                    present.add((root / name[len(module) + 1:]).resolve())
    return [str(p) for p in expected if p.resolve() not in present]


def status(out, value):
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=out, delete=False) as f:
        json.dump(value, f)
        name = f.name
    os.replace(name, out / "result.json")


def coverage(repo, cwd, out, report, command, cache, timeout=300, install_timeout=180, extra_inputs=(), use_cache=True, expected_sources=(), plan=None):
    repo, cwd, out, report, cache = [pathlib.Path(p).resolve() for p in (repo, cwd, out, report, cache)]
    if not cwd.is_relative_to(repo) or out.is_relative_to(repo) or cache.is_relative_to(repo):
        raise ValueError("Run inside the worktree; put reports and caches outside it")
    if not report.is_relative_to(out):
        raise ValueError("Coverage report must be under --out")
    out.mkdir(parents=True, exist_ok=True)
    expected = [(repo / p).resolve() for p in expected_sources]
    if any(not p.is_relative_to(repo) or not p.is_file() for p in expected):
        raise ValueError("Expected sources must be files inside the pinned repository")
    if plan:
        helper = pathlib.Path(__file__).resolve().parents[3] / "scripts/jest-coverage.js"
        prepared = subprocess.run(["node", str(helper), str(repo), str(cwd), str(out), str(plan)], capture_output=True, text=True, timeout=15)
        if prepared.returncode:
            raise ValueError(prepared.stderr.strip())
        spec = json.loads(prepared.stdout)
        command, report = spec["command"], pathlib.Path(spec["report"])
        expected = [pathlib.Path(p) for p in spec["expectedSources"]]
    status(out, {"status": "running", "stage": "prepare"})
    files = tracked(repo)
    context = runtime(repo)
    if plan:
        context["jestPlanHash"] = hashlib.sha256(pathlib.Path(plan).read_bytes()).hexdigest()
    context["expectedSources"] = [str(p.relative_to(repo)) for p in expected]
    # Include relevant runtime values without storing their plaintext in artifacts.
    volatile = {"PWD", "OLDPWD", "SHLVL", "_", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"}
    context["envHash"] = hashlib.sha256(json.dumps({k: v for k, v in sorted(os.environ.items()) if k not in volatile}).encode()).hexdigest()
    status(out, {"status": "running", "stage": "install", "timeoutSeconds": install_timeout})
    deps = dependencies(repo, cache, out, install_timeout, files, context)
    if deps["status"] != "ok":
        return {"status": "unverified", "stage": "install", "dependency": deps}
    # Git excludes ignored env/config files; include env files at every owning directory.
    env_files = [p for directory in {repo, cwd, *(p.parent for p in files)} for p in directory.glob(".env*") if p.is_file()]
    inputs = files + env_files + [repo / name for name in (".pnp.cjs", ".pnp.loader.mjs")] + [pathlib.Path(p).resolve() for p in extra_inputs]
    if any(not p.is_relative_to(repo) for p in inputs):
        raise ValueError("Additional inputs must be inside the worktree")
    normalized = [arg.replace(str(repo), "<repo>").replace(str(out), "<out>") for arg in command]
    key = fingerprint(repo, inputs, {"runtime": context, "dependencies": deps["key"], "command": normalized, "cwd": str(cwd.relative_to(repo))})
    artifact = cache / "coverage" / key
    # Symlinks and submodules can read inputs outside this fingerprint's scope.
    cacheable = use_cache and deps["cacheable"] and not any(p.is_dir() or p.is_symlink() for p in inputs)
    metadata = read_json(artifact / "inputs.json")
    if cacheable and metadata and (artifact / "report").is_file():
        report.parent.mkdir(parents=True, exist_ok=True)
        restore_report(artifact / "report", report, metadata["repoDir"], repo)
        missing = report_scope(report, expected, repo, cwd)
        if missing:
            return {"status": "unverified", "stage": "scope", "missingSources": missing, "coverageFile": str(report)}
        return {"status": "ok", "coverageFile": str(report), "reused": True, "fingerprint": key, "dependency": deps}
    # A leftover report never counts as evidence of this command's success.
    report.unlink(missing_ok=True)
    status(out, {"status": "running", "stage": "coverage", "timeoutSeconds": timeout})
    result = run(command, cwd, out / "coverage.log", timeout)
    if result["status"] != "ok" or not report.is_file():
        return {"status": "unverified", "stage": "coverage", "run": result, "reason": "suite failed, timed out or produced no report", "dependency": deps}
    missing = report_scope(report, expected, repo, cwd)
    if missing:
        return {"status": "unverified", "stage": "scope", "missingSources": missing, "coverageFile": str(report), "dependency": deps}
    if cacheable:
        artifact.parent.mkdir(parents=True, exist_ok=True)
        staging = pathlib.Path(tempfile.mkdtemp(prefix="report-", dir=artifact.parent))
        try:
            shutil.copyfile(report, staging / "report")
            (staging / "inputs.json").write_text(json.dumps({"fingerprint": key, "command": normalized, "repoDir": str(repo), "cwd": str(cwd.relative_to(repo)), "runtime": context, "dependencies": deps["key"]}))
            try:
                staging.rename(artifact)
            except OSError:
                if not artifact.exists():
                    raise
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    return {"status": "ok", "coverageFile": str(report), "reused": False, "fingerprint": key, "dependency": deps, "log": result["log"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("repo", "cwd", "out", "report"):
        parser.add_argument(f"--{flag}", required=True)
    parser.add_argument("--cache-dir", default=os.environ.get("REVIEW_PR_ARTIFACT_CACHE_DIR", str(pathlib.Path.home() / ".claude/review-requests/artifacts")))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("REVIEW_PR_COVERAGE_TIMEOUT_SECONDS", "300")))
    parser.add_argument("--install-timeout", type=int, default=int(os.environ.get("REVIEW_PR_INSTALL_TIMEOUT_SECONDS", "180")))
    parser.add_argument("--input", action="append", default=[])
    parser.add_argument("--no-cache", action="store_true", help="Run coverage without report reuse when effective inputs are unknown")
    parser.add_argument("--expected-sources", help="JSON array of repo-relative executable source paths this report must cover")
    parser.add_argument("--jest-plan", help="JSON with runner argv, config, sourceFiles and testFiles; generates an exact Jest config")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if (not command and not args.jest_plan) or args.timeout < 1 or args.install_timeout < 1:
        parser.error("Provide positive timeouts and a command after --")
    out = pathlib.Path(args.out).resolve()
    if out.is_relative_to(pathlib.Path(args.repo).resolve()):
        print(json.dumps({"status": "unverified", "reason": "Put coverage artifacts outside the repository"}))
        return
    out.mkdir(parents=True, exist_ok=True)
    with (out / ".coverage.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"status": "unverified", "reason": "coverage already running in this artifact directory"}))
            return
        started = time.monotonic()
        try:
            expected = json.loads(pathlib.Path(args.expected_sources).read_text()) if args.expected_sources else []
            if not isinstance(expected, list) or any(not isinstance(p, str) for p in expected):
                raise ValueError("Expected sources must be a JSON array of paths")
            result = coverage(args.repo, args.cwd, out, args.report, command, args.cache_dir, args.timeout, args.install_timeout, args.input, not args.no_cache, expected, args.jest_plan)
        except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            result = {"status": "unverified", "reason": str(error)}
        result["durationMs"] = round((time.monotonic() - started) * 1000)
        status(out, result)
        print(json.dumps(result))


if __name__ == "__main__":
    main()
