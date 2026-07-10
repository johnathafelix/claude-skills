---
name: draft-pr
description: Push unpushed local commits to remote and create a draft PR with no description. Use when the user wants to quickly open a draft pull request.
allowed-tools: Bash
model: claude-sonnet
---

# Draft PR Skill

Push any unpushed commits and create a draft pull request with no description body.

## Workflow

1. **Identify the current branch**:
   - `git branch --show-current`
   - If on `main` or `master`, stop and inform the user they need to be on a feature branch

2. **Push unpushed commits**:
   - Check if the branch has a remote tracking branch: `git rev-parse --abbrev-ref @{upstream} 2>/dev/null`
   - If no upstream exists, push with: `git push -u origin <branch>`
   - If upstream exists, check for unpushed commits: `git log @{upstream}..HEAD --oneline`
   - If there are unpushed commits, push with: `git push`
   - If there are no unpushed commits, continue to the next step

3. **Create the draft PR**:
   - Check if a PR already exists: `gh pr view --json number,url 2>/dev/null`
   - If a PR already exists, inform the user and print the PR URL
   - If no PR exists, create a draft PR: `gh pr create --draft --fill --body ""`

## Important Rules

1. **Never** create a PR from `main` or `master`
2. **Always** use `--draft` flag — the PR must be in draft status
3. **Always** use `--body ""` — the PR must have no description
4. **Always** use `--fill` — let gh auto-generate the title from the branch name or commit
5. **Always** print the resulting PR URL so the user can access it