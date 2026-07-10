---
name: merge
description: Merge the PR's base branch into the current branch, resolve any conflicts, verify tests pass, commit the merge via /git-commit, and push. Use when the user wants to bring their feature branch up to date with its PR base.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill
model: claude-sonnet
---

# Merge Skill

Bring the current branch up to date with its PR's base branch: fetch the base, merge it in, resolve conflicts strategically, run tests, commit via `/git-commit`, and push.

## Workflow

### 1. Preflight

Run in parallel:
- `git branch --show-current` — capture the current branch name
- `git status` — confirm working tree is clean (no unstaged changes, no in-progress merge/rebase)
- `gh pr view --json baseRefName,headRefName,number,title` — get the PR's base branch

Abort and tell the user if:
- Current branch is `main` / `master` (no merge needed)
- Working tree is dirty (ask them to stash or commit first)
- `gh pr view` fails (no open PR for this branch — ask which branch to use as base)

### 2. Fetch the base branch

```bash
git fetch origin <baseRefName>
```

Do **not** check out or reset — we merge into the current branch.

### 3. Survey the incoming change

Before running `git merge`, understand what's coming in so conflict resolution can be strategic rather than mechanical:

- `git log --oneline ^HEAD origin/<baseRefName>` — commits in base not yet in this branch
- `git log --oneline ^origin/<baseRefName> HEAD` — commits in this branch not yet in base

If the base has a large refactor that overlaps with branch work, expect wide conflicts and plan to accept the base-branch shape while re-integrating branch-specific fixes on top. If the overlap is small, conflicts will usually auto-resolve or need only minor edits.

### 4. Merge

```bash
git merge origin/<baseRefName> --no-edit
```

If the merge succeeds with no conflicts, skip to step 6 (tests).

If conflicts are reported, continue to step 5.

### 5. Resolve conflicts

For each conflicted file:

1. **Identify which "side" the change belongs to**. Use `git log --oneline` summaries from step 3 to understand intent:
   - If the base branch's change *supersedes* or *includes* the branch's change — take the base ("theirs") version.
   - If the branch's change is unique work (bug fix, feature) not in the base — preserve it on top of the base-branch shape.
   - If both sides evolved the same region — merge them manually.

2. **Dump the three versions to `/tmp` for comparison** when the conflict is large:
   ```bash
   git show HEAD:<path> > /tmp/ours.ts
   git show origin/<baseRefName>:<path> > /tmp/theirs.ts
   git show :1:<path> > /tmp/base.ts    # merge-base (common ancestor)
   diff /tmp/base.ts /tmp/theirs.ts | head -200
   diff /tmp/base.ts /tmp/ours.ts | head -200
   ```

3. **Resolve**. For "take theirs wholesale":
   ```bash
   cp /tmp/theirs.ts <path>
   ```
   For "take ours wholesale":
   ```bash
   cp /tmp/ours.ts <path>
   ```
   For "theirs + branch-specific patch": `cp` theirs in place, then re-apply the branch's change with `Edit`.

4. **Remove every conflict marker**. After each file, verify none remain:
   ```bash
   grep -nE '^(<{7}|\|{7}|={7}|>{7})' <path> || echo "clean"
   ```

5. **Do not `git add` yet** — stage after all resolutions AND tests pass, so a mid-resolution abort (`git merge --abort`) still works.

When all files are clean of markers, proceed.

### 6. Build & test

Run whatever the project uses. Infer from `package.json` / `Makefile` / `CLAUDE.md`:

- TypeScript project: `npm run build` (or `tsc --build`), then `npm run unitest` (or `npm test`).
- Go project: `make test` / `go test ./...`.
- Other: whatever the project's CI runs.

If the build or tests fail:
- Read the failure, understand whether it's a real regression from the merge or a broken test that needs updating to match the new API.
- Fix the underlying code (or update tests to match the new API).
- Re-run until green.
- Never skip tests or use `--no-verify` to bypass a failure.

### 7. Stage and commit via /git-commit

```bash
git add <resolved files>
git status   # confirm all conflicts cleared
```

Invoke the `/git-commit` skill to create the merge commit. Pass a hint describing the merge (e.g., "merge base branch <baseRefName>, resolved conflicts in X/Y/Z, re-integrated <branch's fix> on top of base rewrite").

If the project already has a pending merge commit staged (git created it automatically on a clean merge), `/git-commit` is not needed — just run `git commit --no-edit` to accept the default merge message, or amend it with `/git-commit` if the user wants a descriptive message.

### 8. Push

```bash
git push
```

Report the pushed range (`<old-sha>..<new-sha>`) and the branch it landed on.

## Important Rules

1. **Never** run `git merge --abort` without asking first — the user may have invested time in resolution.
2. **Never** use `git reset --hard` or `git checkout --` on conflicted files to "start over" without explicit approval.
3. **Never** skip tests. Green tests are the gate for pushing.
4. **Never** force-push after a merge — merges are not rebases.
5. **Always** verify no conflict markers remain before staging.
6. **Always** understand *why* each conflict resolution direction was chosen — if you can't articulate it, you probably picked wrong.
7. **Always** survey incoming commits (step 3) before resolving — context prevents mechanical, wrong resolutions.
8. If the project's base branch is protected or the merge would introduce an unexpected history shape, **stop and ask** before pushing.
