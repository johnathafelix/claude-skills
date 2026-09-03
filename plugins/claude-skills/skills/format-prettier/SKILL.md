---
name: format-prettier
description: Format files with prettier. Use PROACTIVELY right after editing files in a repo that declares prettier (.prettierrc*, prettier.config.*, .prettierignore, or prettier in package.json) — pass the files you just edited. Also use whenever the user asks to format code, run prettier, or invokes /format-prettier. In a repo with NO prettier config, never run this on your own; run it only when the user explicitly asks.
allowed-tools: Bash
model: sonnet
argument-hint: [files or directories]
---

# Format with Prettier

Format files with `prettier --write`, scoped to one project at a time.

## Workflow

1. **Resolve the script path.** `format-prettier.cjs` sits alongside this SKILL.md — resolve it to an absolute path from SKILL.md's own location. Do **not** hardcode a home directory; the skill may be installed under `~/.claude/plugins/cache/…`, not `~/.claude/skills/…`.

2. **Determine scope**:
   - If the user gave files or directories, use those.
   - Else if you were invoked right after editing files this turn, use those files.
   - Else fall back to `git diff --name-only HEAD` plus `git ls-files --others --exclude-standard` for uncommitted changed files.

   `git diff --name-only` returns paths relative to the repo root — resolve every candidate to an absolute path before passing it (e.g. join with the repo root from `git rev-parse --show-toplevel`, or run the script with `cwd` set to the repo root). The script filters by extension, skips `.claude/` and temp paths, and skips missing files on its own, but it needs absolute paths to do that correctly.

3. **Run**: `node <abs>/format-prettier.cjs [--force] <paths...>`

4. **`--force` rule.** Pass `--force` only when the user explicitly asked to format code, run prettier, or typed `/format-prettier`. Never pass it when you are invoking this skill on your own initiative — a repo with no prettier config must not get auto-formatted with prettier's defaults.

5. **Report** the script's output verbatim. A non-zero exit means at least one prettier run failed — surface the failure message, don't swallow it. If the output reports files skipped for missing config, tell the user `--force` would format them with prettier's defaults.
