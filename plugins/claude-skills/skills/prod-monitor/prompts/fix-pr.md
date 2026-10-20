You are opening a draft pull request with the fix for a confirmed production issue found by prod-monitor.

Issue: {{title}}
Linear ticket: {{ticket}} ({{ticket_url}})
Finding (root cause and proposed fix): {{finding_file}}
Independent challenge (apply its corrections when it gives any): {{challenge_file}}
Repository: {{repo_dir}}, the user's working copy. Do not change its branch, index or files.

Steps:
1. git -C {{repo_dir}} fetch origin, find the default branch, then create a worktree for the fix: git -C {{repo_dir}} worktree add {{worktree}} -b {{branch}} origin/<default-branch>. When the worktree already exists, reuse it; when the branch already exists, check it out there. Work only inside {{worktree}}.
2. Implement the corrected fix, minimal and limited to this issue. Add or adjust a test that fails without the fix when the code has a test suite. Run the relevant tests and build. If they fail and the failure is outside the issue's scope, stop and answer status "error" with what failed.
3. Record the change with /claude-skills:git-commit (conventional message; mention {{ticket}} in the body). Push the branch and open a draft PR with /claude-skills:draft-pr. The PR body explains the production symptom, the root cause, the fix and how it was verified, and links {{ticket_url}}. Never add AI attribution anywhere.
4. Reply with the structured JSON: status ok with the PR url and branch; skipped when the fix cannot be automated safely (say why in detail); or error with what failed.

Never force-push, never touch other branches, never run a mutating kubectl, gcloud or helm command.
