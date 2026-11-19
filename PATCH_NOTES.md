# TimeTasks — Focus Timer Backup Patch

## Scope

This patch corrects a data-integrity gap in the 2.9.0 source snapshot: the full backup previously exported focus sessions and focus settings, but omitted the current focus-timer state.

### Changes

1. Adds `data.focusTimer` to new backups.
2. Exports the timer as a **paused snapshot**. A stopwatch or Pomodoro timer does not resume elapsed time automatically after restore.
3. If a Pomodoro phase has already ended at export time, preserves it as a pending confirmation with the calculated phase-end timestamp. It does not silently complete or double-log that phase.
4. Clears a timer's task reference in the exported snapshot if that task is not among the exported tasks.
5. Validates imported timer snapshots, including timer mode, phase, elapsed time, cycle position, task reference, and pending-confirmation fields.
6. Restores the timer state inside the existing import/rollback transaction and verifies it during read-back. Legacy backups without `focusTimer` keep the previous reset-on-import behavior.
7. Increments `BACKUP_FORMAT_VERSION` from 1 to 2. Version-1 backups remain accepted; older application builds should reject version-2 backups rather than silently discard the new timer field.
8. Shows the timer state in the import preview.
9. Displays the pending-session confirmation after app initialization when a restored snapshot contains an ended Pomodoro phase.

## Tests

Run from the repository root:

```bash
node --test tests/focus-timer-backup.test.cjs
```

The test file covers snapshotting, paused stopwatch behavior, active and completed Pomodoro behavior, invalid task references, validator integration, and version-1 compatibility.

For CI integration, update the existing `package.json` test script from:

```json
"test": "node --test tests/regression.test.cjs"
```

to:

```json
"test": "node --test tests/*.test.cjs"
```

This retains the existing regression suite and adds the new test file to the normal CI run.

## Review boundaries

- No app runtime features were removed.
- The app version string was not changed; release/version alignment must be completed against the live repository files, not this partial source snapshot.
- This patch has not been committed or pushed. GitHub write access was not available in this session, so apply it to the repository branch and run the full repository CI before merging.
- The tests here are focused unit/regression tests, not Android device or browser end-to-end tests.
