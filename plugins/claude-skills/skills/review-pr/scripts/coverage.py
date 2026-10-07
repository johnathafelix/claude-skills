#!/usr/bin/env python3
"""Run bounded coverage with isolated dependency and exact-input report caches."""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import signal
import shutil
import subprocess
import tempfile


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


def coverage(repo, cwd, out, report, command, cache, timeout=300, install_timeout=180, extra_inputs=(), use_cache=True):
    repo, cwd, out, report, cache = [pathlib.Path(p).resolve() for p in (repo, cwd, out, report, cache)]
    if not cwd.is_relative_to(repo) or out.is_relative_to(repo) or cache.is_relative_to(repo):
        raise ValueError("Run inside the worktree; put reports and caches outside it")
    if not report.is_relative_to(out):
        raise ValueError("Coverage report must be under --out")
    out.mkdir(parents=True, exist_ok=True)
    files = tracked(repo)
    context = runtime(repo)
    # Include relevant runtime values without storing their plaintext in artifacts.
    volatile = {"PWD", "OLDPWD", "SHLVL", "_", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"}
    context["envHash"] = hashlib.sha256(json.dumps({k: v for k, v in sorted(os.environ.items()) if k not in volatile}).encode()).hexdigest()
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
        return {"status": "ok", "coverageFile": str(report), "reused": True, "fingerprint": key, "dependency": deps}
    # A leftover report never counts as evidence of this command's success.
    report.unlink(missing_ok=True)
    result = run(command, cwd, out / "coverage.log", timeout)
    if result["status"] != "ok" or not report.is_file():
        return {"status": "unverified", "stage": "coverage", "run": result, "reason": "suite failed, timed out or produced no report", "dependency": deps}
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
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or args.timeout < 1 or args.install_timeout < 1:
        parser.error("Provide positive timeouts and a command after --")
    try:
        print(json.dumps(coverage(args.repo, args.cwd, args.out, args.report, command, args.cache_dir, args.timeout, args.install_timeout, args.input, not args.no_cache)))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(json.dumps({"status": "unverified", "reason": str(error)}))


if __name__ == "__main__":
    main()
