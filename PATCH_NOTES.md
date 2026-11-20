# TimeTasks — Focus Timer Backup Patch

## Scope

This patch closes a data-integrity gap in the TimeTasks 2.9.0 source: the full backup exported focus sessions and focus settings, but omitted the current focus-timer state.

## Changes

1. Adds `data.focusTimer` to new backups.
2. Exports the timer as a **paused snapshot**. A stopwatch or Pomodoro timer does not resume elapsed time automatically after restore.
3. If a Pomodoro phase has already ended at export time, preserves it as a pending confirmation with the calculated phase-end timestamp. It does not silently complete or double-log that phase.
4. Clears a timer's task reference in the exported snapshot if that task is not among the exported tasks.
5. Validates imported timer snapshots, including timer mode, phase, elapsed time, cycle position, task reference, and pending-confirmation fields.
6. Restores the timer state inside the existing import/rollback transaction and verifies it during read-back. Legacy V1 backups without `focusTimer` preserve the timer already stored on the device; the import read-back check verifies that unchanged value.
7. Increments `BACKUP_FORMAT_VERSION` from 1 to 2. Version-1 backups remain accepted; older application builds should reject version-2 backups rather than silently discard the new timer field.
8. Shows the timer state in the import preview.
9. Displays the pending-session confirmation after app initialization when a restored snapshot contains an ended Pomodoro phase.

## Tests

Run from the repository root:

```bash
npm test
```

The test command runs both:
- `tests/regression.test.cjs` — existing application regression coverage.
- `tests/focus-timer-backup.test.cjs` — snapshotting, paused stopwatch behavior, active and completed Pomodoro behavior, invalid task references, validator integration, and version-1 compatibility.

## Review boundaries

- No app runtime features were intentionally removed by this patch.
- The app version remains 2.9.0 while this stability work is integrated; version 2.9.1 must be set consistently only after the release source is frozen.
- The patch is committed on `codex/v2.9.1-stability`; it has not been merged into `main`.
- These focused tests do not replace Android device or browser end-to-end testing.
