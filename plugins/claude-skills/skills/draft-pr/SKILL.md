---
name: draft-pr
description: "Push unpushed local commits to remote and create a draft PR, optionally using a prepared description. Use when the user wants to quickly open a draft pull request."
allowed-tools: Bash
model: sonnet
---

# Draft PR Skill

Push unpushed commits and create a draft pull request. Accept an optional `body-file` and `base` in the arguments; validate the file is readable. Without a body file, retain the empty-description default.

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
   - If a PR already exists, update its description once with `gh pr edit --body-file <path>` when a prepared body was supplied; otherwise leave it alone. Print the URL.
   - If no PR exists, create a draft with `gh pr create --draft --fill --body-file <path> --base <base>` when supplied. Omit unspecified options; without a body file use `--body ""`.

## Important Rules

1. **Never** create a PR from `main` or `master`
2. **Always** use `--draft` flag — the PR must be in draft status
3. Use the supplied `--body-file` verbatim, or `--body ""` when none was supplied. Do not regenerate a prepared description.
4. **Always** use `--fill` — let gh auto-generate the title from the branch name or commit
5. **Always** print the resulting PR URL so the user can access it
