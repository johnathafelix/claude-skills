---
name: rebase-or-merge
description: Bring the current branch up to date with its PR base. Tries `git rebase` onto the base first; if it completes with no conflicts, verifies tests and pushes with `--force-with-lease`. If the rebase hits any conflict, aborts it and falls back to merging the base in, resolving conflicts, verifying tests, committing via /git-commit, and pushing. Use when the user wants to bring their feature branch up to date with its PR base, or invokes /rebase-or-merge.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Skill
model: sonnet
---

# Rebase-or-Merge Skill

Bring the current branch up to date with its PR's base branch. Rebasing is often far simpler than merging — one replay instead of a tangle of conflicts — so try it first. Only when the rebase stops on a conflict do we abort it and fall back to a merge.

## Workflow

### 1. Preflight

Run in parallel:
- `git branch --show-current` — capture the current branch name
- `git status` — confirm working tree is clean (no unstaged changes, no in-progress merge/rebase)
- `git rev-parse HEAD` — record the pre-update SHA for the final report
- `gh pr view --json baseRefName,headRefName,number,title` — get the PR's base branch

Abort and tell the user if:
- Current branch is `main` / `master` (nothing to update)
- Working tree is dirty (ask them to stash or commit first)
- `gh pr view` fails (no open PR for this branch — ask which branch to use as base)

### 2. Fetch the base branch

```bash
git fetch origin <baseRefName>
```

Do **not** check out or reset — we update the current branch in place.

### 3. Survey the incoming change

Before touching history, understand what's coming in so any conflict resolution can be strategic rather than mechanical:

- `git log --oneline ^HEAD origin/<baseRefName>` — commits in base not yet in this branch
- `git log --oneline ^origin/<baseRefName> HEAD` — commits in this branch not yet in base

If the base is already an ancestor of `HEAD` (first command prints nothing), the branch is up to date — report that and stop.

If the base has a large refactor that overlaps with branch work, expect conflicts and plan to accept the base-branch shape while re-integrating branch-specific fixes on top. If the overlap is small, the rebase will usually go through clean.

### 4. Try a rebase

```bash
git rebase origin/<baseRefName>
```

- **Exit 0, no stop** → the rebase is clean. Continue with the **Rebase path** (step 5).
- **Stops on a conflict** (any commit, at any point) → do **not** resolve. Abort immediately and fall back:
  ```bash
  git rebase --abort
  git status   # confirm HEAD is back at the pre-update SHA from step 1
  ```
  Then continue with the **Merge path** (step 6).

Aborting here is safe: no resolution work has been invested yet, and the abort restores the branch exactly to the pre-update SHA. The "never abort without asking" rule below applies to resolutions already in progress, not to this immediate fallback.

### 5. Rebase path

#### 5a. Build & test

Run whatever the project uses. Infer from `package.json` / `Makefile` / `CLAUDE.md`:

- TypeScript project: `npm run build` (or `tsc --build`), then `npm run unitest` (or `npm test`).
- Go project: `make test` / `go test ./...`.
- Other: whatever the project's CI runs.

A clean rebase can still break the build or tests — e.g. the base renamed an API the branch calls. If that happens:
- Read the failure and fix the underlying code (or update tests to match the new API).
- Re-run until green.
- Commit the fix via `/git-commit` as a new commit on top of the rebased branch.
- Never skip tests or use `--no-verify` to bypass a failure.

#### 5b. Push with lease

```bash
git push --force-with-lease
```

The rebase rewrote the branch's commits, so a plain `git push` is rejected. `--force-with-lease` only overwrites the remote if it still points at the commit we last fetched — if someone else pushed to the branch meanwhile, the push is refused. In that case **stop and tell the user**; never escalate to `--force`.

Report the pre-update SHA from step 1, the new `HEAD`, and the branch it landed on. Then stop — the merge path does not apply.

### 6. Merge path

```bash
git merge origin/<baseRefName> --no-edit
```

If the merge succeeds with no conflicts (the rebase conflict was order-dependent), skip to step 8 (tests).

If conflicts are reported, continue to step 7.

### 7. Resolve conflicts

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

### 8. Build & test

Same as step 5a: run the project's build and tests.

If the build or tests fail:
- Read the failure, understand whether it's a real regression from the merge or a broken test that needs updating to match the new API.
- Fix the underlying code (or update tests to match the new API).
- Re-run until green.
- Never skip tests or use `--no-verify` to bypass a failure.

### 9. Stage and commit via /git-commit

```bash
git add <resolved files>
git status   # confirm all conflicts cleared
```

Invoke the `/git-commit` skill to create the merge commit. Pass a hint describing the merge (e.g., "merge base branch <baseRefName>, resolved conflicts in X/Y/Z, re-integrated <branch's fix> on top of base rewrite").

If the project already has a pending merge commit staged (git created it automatically on a clean merge), `/git-commit` is not needed — just run `git commit --no-edit` to accept the default merge message, or amend it with `/git-commit` if the user wants a descriptive message.

### 10. Push

```bash
git push
```

Report the pushed range (`<old-sha>..<new-sha>`) and the branch it landed on.

## Important Rules

1. **Rebase first, merge second.** Only fall back to merge after `git rebase` actually stops on a conflict. Never skip straight to merge because conflicts "look likely".
2. **Never resolve rebase conflicts.** The moment a rebase stops, `git rebase --abort` and switch to the merge path — that is the only rebase abort this skill performs on its own.
3. **Never** run `git merge --abort` once conflict resolution has started without asking first — the user may have invested time in it.
4. **Never** use `git reset --hard` or `git checkout --` on conflicted files to "start over" without explicit approval.
5. **Never** skip tests. Green tests are the gate for pushing on both paths.
6. **Force-push only on the rebase path, only with `--force-with-lease`.** Never plain `--force`. If the lease is refused, stop and tell the user. On the merge path, never force-push at all — merges are not rebases.
7. **Always** verify no conflict markers remain before staging.
8. **Always** understand *why* each conflict resolution direction was chosen — if you can't articulate it, you probably picked wrong.
9. **Always** survey incoming commits (step 3) before rebasing or resolving — context prevents mechanical, wrong resolutions.
10. If the project's base branch is protected or the update would introduce an unexpected history shape, **stop and ask** before pushing.
