# Ship gates

Every stage writes one pass/fail entry to `<scratchpad>/ship-task/journal.jsonl`
through `scripts/ship-journal.js`. Re-running a stage appends a newer entry; the gate
reads only the latest one per stage. Entries carry the manifest revision and HEAD, so
a pass recorded before a later edit, refresh or rebase no longer counts.

```bash
J="<plugin>/scripts/ship-journal.js"; A="<scratchpad>/ship-task"
node "$J" record "$A" <stage> pass|fail|na "<command and result, or reason>"
```

`na` is accepted only for `preflight-lint` and `byte-safety` (no task `.go` files) and
`test-first` (not a bug fix), always with the reason. Never record pass for a stage
that did not run, and never record a missing tool as pass.

## Shell portability (all stages)

Commands must behave identically on macOS and Linux. Use perl one-liners for in-place
edits and pattern matching (`perl -pi -e`, `perl -ne`). Never use `sed -i` (BSD and
GNU disagree on its argument) or `grep -P` (absent from BSD grep). Write a file a hook
must read (PR body, commit message) in an earlier Bash call than the command using it:
hooks run before the command.

## (a) preflight-lint

Run once per Go module that contains task `.go` files, from that module's root:

```bash
test -z "$(gofmt -l <task .go files in module>)"
go vet <task package dirs, e.g. ./internal/foo>
golangci-lint run --new-from-rev <initialHead from manifest> ./...
```

`gofmt -l` exits 0 even when files need formatting, so the check is on empty output.
`go vet` is limited to packages holding task files, so pre-existing vet warnings in
untouched packages don't block shipping.
Fix findings with `gofmt -w` or edits, then rerun. Any non-zero exit, unformatted file
or missing tool (`command -v golangci-lint` fails) is a fail. Record the commands and
exit codes. Rerun and re-record after every later source edit.

## (b) byte-safety

```bash
node "$J" check-bytes "$A"
```

It reads each task `.go` patch from the manifest and flags any byte above 0x7F on a
task-added line (BOM U+FEFF, NBSP U+00A0, zero-width U+200B-U+200D, Hangul filler
U+3164/U+115F/U+1160, braille blank U+2800, and any other non-ASCII). Intended
characters must be written as ASCII `\u` escapes, which pass. It records the entry
itself and exits 1 on findings. The post-edit hook only sees Edit/Write content, so
this stage also catches bytes written by Bash, heredocs, `cp` or generated files.
Replace each flagged character with its escape (for example via
`perl -CSD -pi -e 's/\x{00A0}/\\u00a0/g' file.go`), refresh the manifest and rerun.

## (c) test-first (bug fixes)

Prove the new or changed test detects the bug. Never stash, revert or check out in the
live tree: it holds baseline dirt and the manifest snapshot. Use a scratch worktree:

```bash
git worktree add --detach "$A/proof" <initialHead>
```

"Old code" per manifest file: `modified` → copy its `beforePath` (includes baseline
dirt); `deleted` → restore it from `beforePath`; `added` → leave it absent (its
`beforePath` is an empty file, which would not compile).

1. **Red on old code.** Put every manifest file in its old state, then copy only the
   task test files' `afterPath`. Run the targeted test. It must fail on an assertion, not a compile error.
2. **Green on new code.** Copy every task file's `afterPath`. The same test passes.
3. **Mutation.** Starting from green, restore only the fix's behavioral hunks (non-test
   files) to `beforePath`. If step 1 failed to compile because the test uses new
   symbols, keep those declarations and revert only the behavioral hunks. The test
   must fail on an assertion again.

Save each command's output under `$A/proof-*.log`, then `git worktree remove --force
"$A/proof"`. Record pass only when all three hold. A test that passes on the old code
or under the mutation is a fail: strengthen the test. For a feature or refactor, record
`na` with the reason.

## (d) review

Use the independent review from SKILL.md steps 4-5. Clean means zero independently
confirmed issues and zero unchallenged entries. Refuted findings and nits do not count:
a round with only nits is clean. Fix every confirmed issue, refresh the manifest, rerun
(a), (b) and the affected tests, then rerun the core review on the refreshed manifest.
Repeat until clean, at most three review rounds. Record pass with the clean round's
counts, listing any unfixed nits. If the
third round is not clean, or a fix needs new scope or behavior, record fail with the
remaining findings and stop.

## (e) attribution

Write the commit message to `$A/commit-msg.txt` and the PR body to `$A/pr-body.md`,
then scan both before any `git commit` or `gh` call:

```bash
node "$J" check-attribution "$A" "$A/commit-msg.txt" "$A/pr-body.md"
```

It applies the gh-pr-guard hook's own patterns (co-author trailers, "generated with
... claude", "claude code", the robot emoji; case-insensitive). It records the entry
itself and exits 1 on a hit. Remove the line and rerun. Pass the scanned message to
`/git-commit` to use verbatim in its heredoc `-m` commit: git-commit-guard validates
`-m` messages but does not read `-F` files.

## (f) stacked-branch

Run after committing, when the PR base is not main/master:

```bash
git ls-remote --exit-code --heads origin <base>
gh pr list --head <base> --state merged --json number --jq 'length'
```

The base is gone when `ls-remote` exits 2, and merged when the count is above 0 (`gh pr
list` exits 0 even with no match). Then fetch and rebase automatically:

```bash
git fetch origin main
git rebase --onto origin/main <base SHA retained in step 1>
```

Run it on the checked-out task branch with no third argument: `... HEAD` detaches HEAD
and leaves the branch where it was. Confirm `git branch --show-current` still names
the task branch afterwards.

On conflict, `git rebase --abort`, record fail and stop. After a clean rebase, rerun the
verification commands the rebase invalidates and use main as the PR base. If the branch
was already pushed, push with `--force-with-lease`. If a PR already exists, run
`gh pr edit --base main`. Do not refresh the manifest after the rebase: the task patch is
unchanged and main's commits are not task changes. Record pass with the action taken
(`base intact`, `base is main`, or `rebased onto main at <sha>`). Re-record after any
later commit, since this entry is keyed to HEAD.

## Gate

Immediately before `/draft-pr`:

```bash
node "$J" gate "$A" "$A/pr-body.md"
```

It exits 0 only when every stage's latest entry is pass (or allowed `na`) on the
current manifest revision (stacked-branch: on the current HEAD), and the PR body still
scans clean. On exit 1 do not push or open the PR. Report the listed problems and the
journal path.
