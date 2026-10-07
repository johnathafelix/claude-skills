# Background lead watchdog

Prefer the lead's completion notification to polling. The lead must send `main` a
short status at each completed wave and before a long command, then send its final
report starting with `IMPLEMENTATION COMPLETE` or `REPLAN NEEDED`. Record last wave,
command, process/task ID and progress time in `<scratchpad>/ship-task/status.json`; pass this exact path to the lead.

Only when completion events cannot reliably wake the coordinator, arm a Monitor
heartbeat at 300 seconds. On a tick, read the small status file; do not repeatedly
read whole diffs or count changed filenames. An unchanged file count is not evidence
of a stall: tests and edits within one file can both be progressing.

After ten minutes without a status/progress event, send one STATUS POLL and inspect
the reported process/task. Check actual progress (command output growth, a completed
wave, content hash changes, or a live active task), not just file count. Poll silence
during a blocking worker call alone is insufficient to stop it. If two watchdog
checks show no progress and the reported task is no longer active, report the last
command and failure, with one targeted recovery attempt at most. Ask the user only
when a new decision or unavailable external input prevents recovery.

Cancel the Monitor when the lead completes, replans, fails, or the user stops the run.
