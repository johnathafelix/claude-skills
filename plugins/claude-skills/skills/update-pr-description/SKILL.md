---
name: update-pr-description
description: Update the current PR description with a summary of changes compared to the PR base branch
disable-model-invocation: true
model: claude-sonnet
---

Update the PR description for the current branch by following these steps:

## 1. Determine the base branch and PR

- Check if a PR exists for the current branch: `gh pr view --json number,url,baseRefName`
- If a PR exists, extract the `baseRefName` (e.g. `develop`, `feature/parent`, etc.) and `number`
- If no PR exists, inform the user that they need to create a PR first and stop

Store the base branch as `BASE_BRANCH` and use `origin/$BASE_BRANCH` for all subsequent diff/log commands.

## 2. Gather Information

Run these commands to understand the changes:
- `git fetch origin $BASE_BRANCH` - Ensure we have the latest remote base to avoid including already-merged PRs
- `git diff origin/$BASE_BRANCH` - Get the diff between up-to-date remote base and the current branch
- `git log origin/$BASE_BRANCH..HEAD --oneline` - Get the list of commits not yet merged to the base branch

## 3. Build a PR Summary

Analyze the changes and create a concise summary:
- **Maximum 3 bullet points.** Rank changes by impact and meaning — include only the top 1-3 changes that matter most. Omit minor fixes, comment cleanups, test additions, defensive fallbacks, and cosmetic changes unless they are the primary purpose of the PR.
- Focus on what was changed and why it matters
- Be concise and to the point
- Do NOT generate a test plan
- Do NOT mention that the summary was generated with Claude Code

## 4. Update the PR

Update the PR description using `gh pr edit <number> --body "<summary>"`

## Summary Format

Use this format for the PR body:

```
## Summary

- [Most impactful change]
- [Second most impactful change, if meaningful]
- [Third change, only if truly significant]
```
