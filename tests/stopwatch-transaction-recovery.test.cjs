'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const inlineScripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map((match) => match[1])
  .filter((source) => source.trim());
const appScript = inlineScripts.find((source) => source.includes('APP_VERSION'));
assert.ok(appScript, 'application inline script exists');

function extractFunction(name) {
  const pattern = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists in index.html');
  return match[0];
}

function createPersistentStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem(key) {
      key = String(key);
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    }
  };
}

function createRuntime(storage, options = {}) {
  const mainRaw = storage.getItem('main');
  const main = JSON.parse(mainRaw);
  const timerRaw = storage.getItem('focus-timer');
  const timer = timerRaw ? JSON.parse(timerRaw) : {
    mode: 'stopwatch',
    phase: 'work',
    running: false,
    baseElapsed: 125,
    elapsedRemainderMs: 0,
    startedAt: null,
    cyclePosition: 0,
    taskId: 7,
    sessionStartAt: Date.now() - 600_000,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false,
    savedAt: Date.now()
  };

  let failMainWriteOnce = options.failMainWriteOnce === true;
  const alerts = [];
  const toasts = [];
  const rollingSnapshots = [];
  const sandbox = {
    STORAGE_KEY: 'main',
    FOCUS_TIMER_KEY: 'focus-timer',
    FOCUS_SESSIONS_KEY: 'focus-sessions',
    FOCUS_MAX_SESSIONS: 500,
    FOCUS_TIMER_CHECKPOINT_INTERVAL_MS: 5_000,
    CURRENT_SCHEMA_VERSION: 2,
    APP_VERSION: '2.9.0',
    IMPORT_IN_PROGRESS_KEY: 'import-in-progress',
    MIGRATION_IN_PROGRESS_KEY: 'migration-in-progress',
    RESET_IN_PROGRESS_KEY: 'reset-in-progress',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore-in-progress',
    storageRecoveryRequired: false,
    _startupResetRecoveryInFlight: false,
    _resetRecoveryInFlight: false,
    _resetInFlight: false,
    _rollingRecoveryCheckpointHold: 0,
    _stopwatchTransactionLockDepth: 0,
    _focusCommitInFlight: false,
    _focusCommitWriteDepth: 0,
    _focusCommitPendingPromise: null,
    _rollingRecoveryBackupPending: null,
    _rollingRecoveryBackupLastFailure: null,
    _mainStorageBaselineRaw: mainRaw,
    _mainStorageBaselineReady: true,
    _mainStorageExternalChangeObserved: false,
    _secondaryStorageBaselines: Object.create(null),
    _secondaryStorageConflicts: Object.create(null),
    _sessionsCache: null,
    _invalidFocusSessionsNoticeShown: false,
    _focusTimerExternalConflict: false,
    _focusTimerCheckpointAt: 0,
    _focusTimerColdStartWasRunning: false,
    _focusTimerSavedAtAtLoad: null,
    _focusElapsedRemainderMs: timer.elapsedRemainderMs || 0,
    _focusMonotonicStart: null,
    _focusMonotonicLastSample: null,
    _focusMonotonicLastWallSample: null,
    _focusMonotonicClockFailed: false,
    _focusWallClockAnchor: null,
    _focusFallbackLastWall: null,
    _focusFallbackElapsedMs: 0,
    tasks: main.tasks,
    appSettings: main.settings || {},
    _startupResetRecoveryInFlight: false,
    _resetRecoveryInFlight: false,
    _resetInFlight: false,
    _focusTimer: {
      mode: 'stopwatch',
      phase: 'work',
      running: false,
      baseElapsed: 125,
      startedAt: null,
      cyclePosition: 0,
      taskId: 7,
      sessionStartAt: Date.now() - 600_000,
      awaitingConfirmation: false,
      pendingPhaseEndedAt: null,
      clockAdjusted: false,
      pendingStopwatchTransaction: null
    },
    navigator: {
      locks: {
        _tail: Promise.resolve(),
        request(_name, _options, callback) {
          const run = this._tail.then(() => callback({ name: _name, mode: 'exclusive' }));
          this._tail = run.catch(() => {});
          return run;
        }
      }
    },
    localStorage: {
      getItem(key) { return storage.getItem(key); },
      setItem(key, value) {
        if (String(key) === 'main' && failMainWriteOnce) {
          failMainWriteOnce = false;
          throw new Error('simulated main-key write interruption');
        }
        storage.setItem(key, value);
      },
      removeItem(key) { storage.removeItem(key); }
    },
    validateV2(data) {
      return !!data && data.schemaVersion === 2
        && Array.isArray(data.tasks) && Array.isArray(data.dailyLogs);
    },
    todayStr: () => '2026-11-23',
    _pruneLastRecurringDates() {},
    _queueAllTaskReminderSync() {},
    _storeRollingRecoveryBackup(reason) {
      if (sandbox._rollingRecoveryCheckpointHold > 0
          || (sandbox._focusTimer && sandbox._focusTimer.pendingStopwatchTransaction)) return true;
      rollingSnapshots.push(reason);
      return true;
    },
    _isOptionalRollingRecoveryBackupFailure: () => false,
    _completeRollingRecoveryCheckpoint(reason) {
      rollingSnapshots.push(reason);
      return true;
    },
    _stopDisplayTick() {},
    _renderFocusTimer() {},
    _clearFocusTimerClock() {},
    _anchorFocusTimerClock() {},
    _startDisplayTick() {},
    _unlockAudioContext() {},
    renderAll() {},
    renderFocusSessionsCard() {},
    _renderFocusTimerView() {},
    showAlertModal(...args) { alerts.push(args); },
    showToast(message) { toasts.push(message); },
    escapeHTML(value) { return String(value); },
    console: { error() {}, warn() {}, log() {} }
  };

  const names = [
    '_trackSecondaryStorageRead',
    '_isFocusCommitBlocked',
    '_withFocusCommitWrite',
    '_captureFocusTimerSnapshot',
    '_focusTimerSnapshotMatchesState',
    '_focusTimerSnapshotMatchesRecord',
    '_focusCommitBaselinesMatch',
    '_verifyFocusTimerResetAfterCommit',
    '_pendingTxMatchesCommitRequest',
    '_commitFocusTaskSession',
    '_commitFocusTaskSessionLocked',
    '_discardShortFocusSession',
    '_matchingFocusSessionRecords',
    '_hasAmbiguousLegacyFocusSession',
    '_pendingStopwatchWriteAllowed',
    '_withStopwatchTransactionLock',
    '_secondaryStorageWriteAllowed',
    '_writeSecondaryStorageVerified',
    '_storageWriteAllowed',
    '_setMainStorageBaseline',
    '_acquireRollingRecoveryCheckpointHold',
    '_parseStrictFocusSessionTimestamp',
    '_validateFocusSessionRecord',
    '_loadSessions',
    '_saveSessions',
    '_sessionAlreadyLogged',
    '_logSession',
    '_validatePendingStopwatchTransaction',
    '_saveFocusTimer',
    '_loadFocusTimer',
    '_resetAfterSession',
    '_recoverPendingStopwatchSave',
    '_applyStopwatchSave',
    '_applyStopwatchSaveLocked',
    'saveData'
  ];
  vm.runInNewContext(
    names.map(extractFunction).join('\n'),
    sandbox
  );

  sandbox._loadFocusTimer();
  return { sandbox, storage, alerts, toasts, rollingSnapshots };
}

function initialStorage() {
  const sessionStartAt = Date.now() - 600_000;
  const main = {
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: { operationalDayStart: 4, firstUseDate: '2026-11-20', darkMode: false },
    tasks: [{
      id: 7,
      name: 'Stopwatch task',
      status: 'pending',
      type: 'معرفية',
      expected: 20,
      actual: 5,
      plannedDate: '2026-11-23',
      plannedTime: '',
      completedAt: null,
      createdAt: Date.now()
    }],
    dailyLogs: []
  };
  const timer = {
    mode: 'stopwatch',
    phase: 'work',
    running: false,
    baseElapsed: 125,
    elapsedRemainderMs: 0,
    startedAt: null,
    cyclePosition: 0,
    taskId: 7,
    sessionStartAt,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false,
    pendingStopwatchTransaction: null,
    savedAt: Date.now()
  };
  return createPersistentStorage({
    main: JSON.stringify(main),
    'focus-timer': JSON.stringify(timer),
    'focus-sessions': JSON.stringify([])
  });
}

test('process restart after task commit but before session logging resumes without adding task minutes twice', async () => {
  const storage = initialStorage();
  const first = createRuntime(storage);
  first.sandbox._logSession = () => {
    throw new Error('simulated process death after the main task commit');
  };

  await first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);

  const afterInterruptedCommit = JSON.parse(storage.getItem('main'));
  const interruptedTimer = JSON.parse(storage.getItem('focus-timer'));
  assert.equal(afterInterruptedCommit.tasks[0].actual, 8,
    'the first process has durably committed task minutes');
  assert.equal(typeof afterInterruptedCommit.tasks[0].lastStopwatchTransactionId, 'string',
    'main task record must persist its transaction identity');
  assert.ok(interruptedTimer.pendingStopwatchTransaction,
    'the transaction journal must survive with the timer record');
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 0,
    'the simulated interruption occurs before the session write');

  const restarted = createRuntime(storage);
  assert.ok(restarted.sandbox._focusTimer.pendingStopwatchTransaction);
  assert.equal(await restarted.sandbox._withStopwatchTransactionLock(
    () => restarted.sandbox._recoverPendingStopwatchSave(false)
  ), true);

  const recoveredMain = JSON.parse(storage.getItem('main'));
  const recoveredTimer = JSON.parse(storage.getItem('focus-timer'));
  const recoveredSessions = JSON.parse(storage.getItem('focus-sessions'));
  assert.equal(recoveredMain.tasks[0].actual, 8,
    'recovery must not apply the same minutes a second time');
  assert.equal(recoveredSessions.length, 1);
  assert.equal(recoveredSessions[0].durationSec, 125);
  assert.equal(recoveredSessions[0].taskId, 7);
  assert.equal(recoveredSessions[0].transactionId,
    afterInterruptedCommit.tasks[0].lastStopwatchTransactionId);
  assert.equal(recoveredTimer.pendingStopwatchTransaction, null);
  assert.equal(recoveredTimer.baseElapsed, 0);
  assert.equal(restarted.sandbox.storageRecoveryRequired, false);
});

test('a durable timer journal can finish the task update when the first main write did not commit', async () => {
  const storage = initialStorage();
  const first = createRuntime(storage, { failMainWriteOnce: true });

  await first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);

  const beforeRestart = JSON.parse(storage.getItem('main'));
  const timerBeforeRestart = JSON.parse(storage.getItem('focus-timer'));
  assert.equal(beforeRestart.tasks[0].actual, 5,
    'the interrupted first main write did not commit');
  assert.ok(timerBeforeRestart.pendingStopwatchTransaction,
    'the timer journal was saved before attempting the main write');

  const restarted = createRuntime(storage);
  assert.equal(await restarted.sandbox._withStopwatchTransactionLock(
    () => restarted.sandbox._recoverPendingStopwatchSave(false)
  ), true);

  const recoveredMain = JSON.parse(storage.getItem('main'));
  const recoveredSessions = JSON.parse(storage.getItem('focus-sessions'));
  assert.equal(recoveredMain.tasks[0].actual, 8);
  assert.equal(recoveredSessions.length, 1);
  assert.equal(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction, null);
});

test('restart after session write but before timer reset is idempotent', async () => {
  const storage = initialStorage();
  const first = createRuntime(storage);
  first.sandbox._resetAfterSession = () => {
    throw new Error('simulated process death after the session was stored');
  };

  await first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);

  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 8);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 1);
  assert.ok(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction);

  const restarted = createRuntime(storage);
  assert.equal(await restarted.sandbox._withStopwatchTransactionLock(
    () => restarted.sandbox._recoverPendingStopwatchSave(false)
  ), true);

  const recoveredMain = JSON.parse(storage.getItem('main'));
  const recoveredSessions = JSON.parse(storage.getItem('focus-sessions'));
  assert.equal(recoveredMain.tasks[0].actual, 8);
  assert.equal(recoveredSessions.length, 1,
    'replaying a transaction whose session already exists must not add another row');
  assert.equal(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction, null);
});

test('recovery refuses to overwrite a task value that is neither the pre-commit nor committed value', async () => {
  const storage = initialStorage();
  const first = createRuntime(storage);
  first.sandbox._logSession = () => {
    throw new Error('interrupt before session save');
  };
  await first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);

  const externallyChanged = JSON.parse(storage.getItem('main'));
  externallyChanged.tasks[0].actual = 17;
  storage.setItem('main', JSON.stringify(externallyChanged));

  const restarted = createRuntime(storage);
  assert.equal(await restarted.sandbox._withStopwatchTransactionLock(
    () => restarted.sandbox._recoverPendingStopwatchSave(false)
  ), false);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 17);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 0);
  assert.ok(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction);
  assert.equal(restarted.sandbox.storageRecoveryRequired, true);
});


test('recovery rejects targetActual without the matching task transaction marker', async () => {
  const storage = initialStorage();
  const first = createRuntime(storage);
  first.sandbox._logSession = () => { throw new Error('interrupt before session save'); };
  await first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);
  const changed = JSON.parse(storage.getItem('main'));
  delete changed.tasks[0].lastStopwatchTransactionId;
  changed.tasks[0].actual = 8;
  storage.setItem('main', JSON.stringify(changed));
  const restarted = createRuntime(storage);
  assert.equal(await restarted.sandbox._withStopwatchTransactionLock(
    () => restarted.sandbox._recoverPendingStopwatchSave(false)
  ), false);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 8);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 0);
  assert.ok(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction);
  assert.equal(restarted.sandbox.storageRecoveryRequired, true);
});

test('session recovery rejects the same identity when duration differs', async () => {
  const storage = initialStorage();
  const first = createRuntime(storage);
  first.sandbox._logSession = () => { throw new Error('interrupt before session save'); };
  await first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);
  const tx = JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction;
  storage.setItem('focus-sessions', JSON.stringify([{
    id: 1, mode: 'stopwatch', phase: 'work', taskId: 7, taskName: 'Stopwatch task',
    startedAt: new Date(tx.sessionStartAt).toISOString(),
    endedAt: new Date(tx.sessionStartAt + 124000).toISOString(),
    durationSec: 124, completed: true
  }]));
  const restarted = createRuntime(storage);
  assert.equal(await restarted.sandbox._withStopwatchTransactionLock(
    () => restarted.sandbox._recoverPendingStopwatchSave(false)
  ), false);
  assert.equal(JSON.parse(storage.getItem('focus-sessions'))[0].durationSec, 124);
  assert.ok(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction);
  assert.equal(restarted.sandbox.storageRecoveryRequired, true);
});

test('session dedupe does not accept the same identity with a different duration', () => {
  const storage = initialStorage();
  const runtime = createRuntime(storage);
  const start = runtime.sandbox._focusTimer.sessionStartAt;
  storage.setItem('focus-sessions', JSON.stringify([{
    id: 1, mode: 'stopwatch', phase: 'work', taskId: 7, taskName: 'Stopwatch task',
    startedAt: new Date(start).toISOString(), endedAt: new Date(start + 124000).toISOString(),
    durationSec: 124, completed: true
  }]));
  runtime.sandbox._sessionsCache = null;
  assert.equal(runtime.sandbox._sessionAlreadyLogged('work', 125), false);
});


test('matching transaction ID in page memory does not grant write permission without owning Web Lock', async () => {
  const storage = initialStorage();
  const tx = {
    version: 1, id: 'stopwatch-lock-owner-test', taskId: 7, previousActual: 5,
    targetActual: 8, minutesToAdd: 3, durationSec: 125,
    sessionStartAt: JSON.parse(storage.getItem('focus-timer')).sessionStartAt,
    mode: 'stopwatch', phase: 'work', clockAdjusted: false,
    elapsedRemainderMs: 0, createdAt: Date.now()
  };
  const timer = JSON.parse(storage.getItem('focus-timer'));
  timer.pendingStopwatchTransaction = tx;
  storage.setItem('focus-timer', JSON.stringify(timer));
  const runtime = createRuntime(storage);
  assert.equal(runtime.sandbox._focusTimer.pendingStopwatchTransaction.id, tx.id);
  assert.equal(runtime.sandbox._pendingStopwatchWriteAllowed(), false);
  assert.equal(runtime.sandbox._storageWriteAllowed(), false);
  assert.equal(await runtime.sandbox._withStopwatchTransactionLock(
    () => runtime.sandbox._pendingStopwatchWriteAllowed()
  ), true);
  assert.equal(runtime.sandbox._stopwatchTransactionLockDepth, 0,
    'lock ownership must be released after the callback settles');
});

test('linked legacy session without transaction ID is held for review when task remains at previousActual', async () => {
  const storage = initialStorage();
  const timer = JSON.parse(storage.getItem('focus-timer'));
  storage.setItem('focus-sessions', JSON.stringify([{
    id: 1, mode: 'stopwatch', phase: 'work', taskId: 7, taskName: 'Stopwatch task',
    startedAt: new Date(timer.sessionStartAt).toISOString(),
    endedAt: new Date(timer.sessionStartAt + 125000).toISOString(),
    durationSec: 125, completed: true
  }]));
  const runtime = createRuntime(storage);
  await runtime.sandbox._applyStopwatchSave(125, runtime.sandbox.tasks[0], 3);
  assert.equal(runtime.sandbox.tasks[0].actual, 5);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 5);
  assert.equal(runtime.sandbox._focusTimer.baseElapsed, 125);
  assert.equal(runtime.sandbox._focusTimer.pendingStopwatchTransaction, null);
  assert.equal(runtime.sandbox.storageRecoveryRequired, true);
  assert.match(String(runtime.alerts[0][0]), /جلسة Stopwatch قديمة تحتاج إلى مراجعة/);
});

test('linked legacy session without transaction ID stays ambiguous when task.actual equals targetActual', async () => {
  const storage = initialStorage();
  const main = JSON.parse(storage.getItem('main'));
  main.tasks[0].actual = 8;
  storage.setItem('main', JSON.stringify(main));
  const timer = JSON.parse(storage.getItem('focus-timer'));
  storage.setItem('focus-sessions', JSON.stringify([{
    id: 1, mode: 'stopwatch', phase: 'work', taskId: 7, taskName: 'Stopwatch task',
    startedAt: new Date(timer.sessionStartAt).toISOString(),
    endedAt: new Date(timer.sessionStartAt + 125000).toISOString(),
    durationSec: 125, completed: true
  }]));
  const runtime = createRuntime(storage);
  await runtime.sandbox._applyStopwatchSave(125, runtime.sandbox.tasks[0], 3);
  assert.equal(runtime.sandbox.tasks[0].actual, 8);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 8);
  assert.equal(runtime.sandbox._focusTimer.baseElapsed, 125);
  assert.equal(runtime.sandbox._focusTimer.pendingStopwatchTransaction, null);
  assert.equal(runtime.sandbox.storageRecoveryRequired, true);
  assert.match(String(runtime.alerts[0][0]), /جلسة Stopwatch قديمة تحتاج إلى مراجعة/);
});

test('invalid present task transaction marker is not treated as an absent legacy marker', async () => {
  const storage = initialStorage();
  const first = createRuntime(storage);
  first.sandbox._logSession = () => { throw new Error('interrupt before session save'); };
  await first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);
  const main = JSON.parse(storage.getItem('main'));
  main.tasks[0].lastStopwatchTransactionId = "";
  storage.setItem('main', JSON.stringify(main));
  const restarted = createRuntime(storage);
  assert.equal(await restarted.sandbox._withStopwatchTransactionLock(
    () => restarted.sandbox._recoverPendingStopwatchSave(false)
  ), false);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].lastStopwatchTransactionId, "");
  assert.ok(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction);
  assert.equal(restarted.sandbox.storageRecoveryRequired, true);
});


test('recovery does not adopt an exact legacy session when task.actual is previousActual', async () => {
  const storage = initialStorage();
  const timer = JSON.parse(storage.getItem('focus-timer'));
  const tx = {
    version: 1, id: 'stopwatch-legacy-previous-actual', taskId: 7,
    previousActual: 5, targetActual: 8, minutesToAdd: 3, durationSec: 125,
    sessionStartAt: timer.sessionStartAt, mode: 'stopwatch', phase: 'work',
    clockAdjusted: false, elapsedRemainderMs: 0, createdAt: Date.now()
  };
  timer.pendingStopwatchTransaction = tx;
  storage.setItem('focus-timer', JSON.stringify(timer));
  const legacy = [{
    id: 41, mode: 'stopwatch', phase: 'work', taskId: 7, taskName: 'Stopwatch task',
    startedAt: new Date(tx.sessionStartAt).toISOString(),
    endedAt: new Date(tx.sessionStartAt + 125000).toISOString(),
    durationSec: 125, completed: true
  }];
  const legacyRaw = JSON.stringify(legacy);
  storage.setItem('focus-sessions', legacyRaw);
  const mainBefore = storage.getItem('main');
  const timerBefore = storage.getItem('focus-timer');
  const runtime = createRuntime(storage);

  const recovered = await runtime.sandbox._withStopwatchTransactionLock(
    () => runtime.sandbox._recoverPendingStopwatchSave(false)
  );

  assert.equal(recovered, false, 'an identity/length match without transaction identity is not proof of commit');
  assert.equal(storage.getItem('main'), mainBefore, 'previousActual and the absent task marker remain untouched');
  assert.equal(storage.getItem('focus-sessions'), legacyRaw, 'the legacy session is not edited, deleted, or replaced');
  assert.equal(storage.getItem('focus-timer'), timerBefore, 'the pending journal and paused timer remain durable');
  assert.equal(runtime.sandbox.tasks[0].actual, 5);
  assert.equal(runtime.sandbox.tasks[0].lastStopwatchTransactionId, undefined);
  assert.equal(runtime.sandbox._focusTimer.baseElapsed, 125, 'the Stopwatch is not reset');
  assert.equal(runtime.sandbox._focusTimer.pendingStopwatchTransaction.id, tx.id);
  assert.equal(runtime.sandbox.storageRecoveryRequired, true);
});

test('recovery does not adopt an exact legacy session when task.actual is targetActual', async () => {
  const storage = initialStorage();
  const timer = JSON.parse(storage.getItem('focus-timer'));
  const tx = {
    version: 1, id: 'stopwatch-legacy-target-actual', taskId: 7,
    previousActual: 5, targetActual: 8, minutesToAdd: 3, durationSec: 125,
    sessionStartAt: timer.sessionStartAt, mode: 'stopwatch', phase: 'work',
    clockAdjusted: false, elapsedRemainderMs: 0, createdAt: Date.now()
  };
  timer.pendingStopwatchTransaction = tx;
  storage.setItem('focus-timer', JSON.stringify(timer));
  const main = JSON.parse(storage.getItem('main'));
  main.tasks[0].actual = tx.targetActual;
  main.tasks[0].lastStopwatchTransactionId = tx.id;
  storage.setItem('main', JSON.stringify(main));
  const legacy = [{
    id: 42, mode: 'stopwatch', phase: 'work', taskId: 7, taskName: 'Stopwatch task',
    startedAt: new Date(tx.sessionStartAt).toISOString(),
    endedAt: new Date(tx.sessionStartAt + 125000).toISOString(),
    durationSec: 125, completed: true
  }];
  const legacyRaw = JSON.stringify(legacy);
  storage.setItem('focus-sessions', legacyRaw);
  const mainBefore = storage.getItem('main');
  const timerBefore = storage.getItem('focus-timer');
  const runtime = createRuntime(storage);

  const recovered = await runtime.sandbox._withStopwatchTransactionLock(
    () => runtime.sandbox._recoverPendingStopwatchSave(false)
  );

  assert.equal(recovered, false, 'a task marker does not retroactively prove a legacy session identity');
  assert.equal(storage.getItem('main'), mainBefore, 'the already committed targetActual is preserved without rollback');
  assert.equal(storage.getItem('focus-sessions'), legacyRaw, 'the legacy session remains byte-for-byte unchanged');
  assert.equal(storage.getItem('focus-timer'), timerBefore, 'the pending journal and timer remain unchanged');
  assert.equal(runtime.sandbox.tasks[0].actual, 8, 'the valid task total is neither incremented nor rolled back');
  assert.equal(runtime.sandbox.tasks[0].lastStopwatchTransactionId, tx.id);
  assert.equal(runtime.sandbox._focusTimer.baseElapsed, 125, 'the Stopwatch is not reset');
  assert.equal(runtime.sandbox._focusTimer.pendingStopwatchTransaction.id, tx.id);
  assert.equal(runtime.sandbox.storageRecoveryRequired, true);
});

test('recovery accepts an existing session only when its saved transaction ID and details match', async () => {
  const storage = initialStorage();
  const timer = JSON.parse(storage.getItem('focus-timer'));
  const tx = {
    version: 1, id: 'stopwatch-valid-session-replay', taskId: 7,
    previousActual: 5, targetActual: 8, minutesToAdd: 3, durationSec: 125,
    sessionStartAt: timer.sessionStartAt, mode: 'stopwatch', phase: 'work',
    clockAdjusted: false, elapsedRemainderMs: 0, createdAt: Date.now()
  };
  timer.pendingStopwatchTransaction = tx;
  storage.setItem('focus-timer', JSON.stringify(timer));
  const main = JSON.parse(storage.getItem('main'));
  main.tasks[0].actual = tx.targetActual;
  main.tasks[0].lastStopwatchTransactionId = tx.id;
  storage.setItem('main', JSON.stringify(main));
  const session = {
    id: 43, mode: tx.mode, phase: tx.phase, taskId: tx.taskId, taskName: 'Stopwatch task',
    startedAt: new Date(tx.sessionStartAt).toISOString(),
    endedAt: new Date(tx.sessionStartAt + tx.durationSec * 1000).toISOString(),
    durationSec: tx.durationSec, completed: true, transactionId: tx.id
  };
  storage.setItem('focus-sessions', JSON.stringify([session]));
  const runtime = createRuntime(storage);

  assert.equal(await runtime.sandbox._withStopwatchTransactionLock(
    () => runtime.sandbox._recoverPendingStopwatchSave(false)
  ), true);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, tx.targetActual);
  assert.deepEqual(JSON.parse(storage.getItem('focus-sessions'))[0], session);
  const recoveredTimer = JSON.parse(storage.getItem('focus-timer'));
  assert.equal(recoveredTimer.pendingStopwatchTransaction, null);
  assert.equal(recoveredTimer.baseElapsed, 0);
  assert.equal(runtime.sandbox.storageRecoveryRequired, false);
});

function createSharedWebLockManager() {
  let tail = Promise.resolve();
  return {
    request(name, _options, callback) {
      const run = tail.then(() => callback({ name, mode: 'exclusive' }));
      tail = run.catch(() => {});
      return run;
    }
  };
}

test('Web Lock ownership is released after a synchronous callback throw before the next page acquires it', async () => {
  const owner = createRuntime(initialStorage());
  const waiter = createRuntime(initialStorage());
  const locks = createSharedWebLockManager();
  owner.sandbox.navigator.locks = locks;
  waiter.sandbox.navigator.locks = locks;

  const failed = owner.sandbox._withStopwatchTransactionLock(() => {
    assert.equal(owner.sandbox._stopwatchTransactionLockDepth, 1);
    throw new Error('intentional synchronous callback failure');
  });
  const acquired = waiter.sandbox._withStopwatchTransactionLock(() => {
    assert.equal(owner.sandbox._stopwatchTransactionLockDepth, 0,
      'the previous page must not retain its local ownership flag');
    assert.equal(waiter.sandbox._stopwatchTransactionLockDepth, 1);
    return 'waiter-acquired';
  });

  await assert.rejects(failed, /intentional synchronous callback failure/);
  assert.equal(await acquired, 'waiter-acquired');
  assert.equal(owner.sandbox._stopwatchTransactionLockDepth, 0);
  assert.equal(waiter.sandbox._stopwatchTransactionLockDepth, 0);
});

test('Web Lock ownership is released after a rejected callback Promise before the next page acquires it', async () => {
  const owner = createRuntime(initialStorage());
  const waiter = createRuntime(initialStorage());
  const locks = createSharedWebLockManager();
  owner.sandbox.navigator.locks = locks;
  waiter.sandbox.navigator.locks = locks;

  const failed = owner.sandbox._withStopwatchTransactionLock(() => {
    assert.equal(owner.sandbox._stopwatchTransactionLockDepth, 1);
    return Promise.reject(new Error('intentional callback Promise rejection'));
  });
  const acquired = waiter.sandbox._withStopwatchTransactionLock(() => {
    assert.equal(owner.sandbox._stopwatchTransactionLockDepth, 0,
      'the previous page must not retain its local ownership flag');
    assert.equal(waiter.sandbox._stopwatchTransactionLockDepth, 1);
    return 'waiter-acquired';
  });

  await assert.rejects(failed, /intentional callback Promise rejection/);
  assert.equal(await acquired, 'waiter-acquired');
  assert.equal(owner.sandbox._stopwatchTransactionLockDepth, 0);
  assert.equal(waiter.sandbox._stopwatchTransactionLockDepth, 0);
});

test('task-linked Stopwatch save fails closed when Web Locks is unavailable', async () => {
  const storage = initialStorage();
  const runtime = createRuntime(storage);
  runtime.sandbox.navigator.locks = null;
  await runtime.sandbox._applyStopwatchSave(125, runtime.sandbox.tasks[0], 3);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 5);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 0);
  assert.equal(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction, null);
  assert.ok(runtime.alerts.some(args => /تعذر تأمين عملية Stopwatch/.test(String(args[0]))));
});


test('zero-minute task-linked commit creates a transaction and preserves actual:null', async () => {
  const storage = initialStorage();
  const main = JSON.parse(storage.getItem('main'));
  main.tasks[0].actual = null;
  storage.setItem('main', JSON.stringify(main));
  const runtime = createRuntime(storage);
  assert.equal(await runtime.sandbox._applyStopwatchSave(125, runtime.sandbox.tasks[0], 0), true);
  const saved = JSON.parse(storage.getItem('main')).tasks[0];
  const sessions = JSON.parse(storage.getItem('focus-sessions'));
  assert.equal(saved.actual, null, 'zero minutes must not turn actual:null into zero');
  assert.equal(typeof saved.lastStopwatchTransactionId, 'string');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].transactionId, saved.lastStopwatchTransactionId);
});

test('invalid negative or fractional task minutes are rejected before writes', async () => {
  for (const minutes of [-1, 1.5, NaN]) {
    const storage = initialStorage();
    const beforeMain = storage.getItem('main');
    const beforeTimer = storage.getItem('focus-timer');
    const runtime = createRuntime(storage);
    assert.equal(await runtime.sandbox._applyStopwatchSave(125, runtime.sandbox.tasks[0], minutes), false);
    assert.equal(storage.getItem('main'), beforeMain);
    assert.equal(storage.getItem('focus-timer'), beforeTimer);
    assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 0);
  }
});

test('second transaction recovers against previousTransactionId on the same task', async () => {
  const storage = initialStorage();
  const previousId = 'stopwatch-transaction-one';
  const nextId = 'stopwatch-transaction-two';
  const main = JSON.parse(storage.getItem('main'));
  main.tasks[0].actual = 2;
  main.tasks[0].lastStopwatchTransactionId = previousId;
  storage.setItem('main', JSON.stringify(main));

  const timer = JSON.parse(storage.getItem('focus-timer'));
  const tx = {
    version: 1, id: nextId, taskId: 7,
    previousActual: 2, targetActual: 5, previousTransactionId: previousId,
    minutesToAdd: 3, durationSec: 125, sessionStartAt: timer.sessionStartAt,
    mode: 'stopwatch', phase: 'work', clockAdjusted: false,
    elapsedRemainderMs: 0, completed: true, createdAt: Date.now()
  };
  timer.pendingStopwatchTransaction = tx;
  storage.setItem('focus-timer', JSON.stringify(timer));

  const runtime = createRuntime(storage);
  assert.equal(await runtime.sandbox._withStopwatchTransactionLock(
    () => runtime.sandbox._recoverPendingStopwatchSave(false)
  ), true);

  const recoveredTask = JSON.parse(storage.getItem('main')).tasks[0];
  const sessions = JSON.parse(storage.getItem('focus-sessions'));
  assert.equal(recoveredTask.actual, 5);
  assert.equal(recoveredTask.lastStopwatchTransactionId, nextId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].transactionId, nextId);

  assert.equal(await runtime.sandbox._withStopwatchTransactionLock(
    () => runtime.sandbox._recoverPendingStopwatchSave(false)
  ), true);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 5);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 1,
    'a repeated recovery after journal clearance must not add task minutes or a session');
});

test('zero-minute transaction validator preserves a null target and validates previous ID', () => {
  const storage = initialStorage();
  const runtime = createRuntime(storage);
  const timer = JSON.parse(storage.getItem('focus-timer'));
  const valid = {
    version: 1, id: 'focus-transaction-zero', taskId: 7,
    previousActual: null, targetActual: null, previousTransactionId: null,
    minutesToAdd: 0, durationSec: 125, sessionStartAt: timer.sessionStartAt,
    mode: 'pomodoro', phase: 'work', clockAdjusted: false,
    elapsedRemainderMs: 999, completed: true, createdAt: Date.now()
  };
  assert.equal(runtime.sandbox._validatePendingStopwatchTransaction(valid), true);
  assert.equal(runtime.sandbox._validatePendingStopwatchTransaction({
    ...valid, previousTransactionId: ''
  }), false);
  assert.equal(runtime.sandbox._validatePendingStopwatchTransaction({
    ...valid, minutesToAdd: 0, targetActual: 0
  }), false);
});


test('failure to clear a pending transaction journal leaves it recoverable without duplicate minutes or session', async () => {
  const storage = initialStorage();
  const main = JSON.parse(storage.getItem('main'));
  const timer = JSON.parse(storage.getItem('focus-timer'));
  const transactionId = 'focus-pending-journal-clear';
  main.tasks[0].actual = 8;
  main.tasks[0].lastStopwatchTransactionId = transactionId;
  const tx = {
    version: 1, id: transactionId, taskId: 7,
    previousActual: 5, targetActual: 8, previousTransactionId: null,
    minutesToAdd: 3, durationSec: 125, sessionStartAt: timer.sessionStartAt,
    mode: 'stopwatch', phase: 'work', clockAdjusted: false,
    elapsedRemainderMs: 0, completed: true, createdAt: Date.now()
  };
  timer.pendingStopwatchTransaction = tx;
  storage.setItem('main', JSON.stringify(main));
  storage.setItem('focus-timer', JSON.stringify(timer));

  const first = createRuntime(storage);
  const saveTimer = first.sandbox._saveFocusTimer.bind(first.sandbox);
  let saveCount = 0;
  first.sandbox._saveFocusTimer = function() {
    saveCount++;
    if (saveCount === 2) return false;
    return saveTimer();
  };
  const firstResult = await first.sandbox._withStopwatchTransactionLock(
    () => first.sandbox._recoverPendingStopwatchSave(false)
  );
  assert.equal(firstResult, false);
  assert.equal(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction.id, transactionId,
    'the durable journal stays present when its final clear cannot be verified');
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 8);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 1);

  const second = createRuntime(storage);
  const retryResult = await second.sandbox._withStopwatchTransactionLock(
    () => second.sandbox._recoverPendingStopwatchSave(false)
  );
  assert.equal(retryResult, true);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 8);
  assert.equal(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction, null);
  const sessions = JSON.parse(storage.getItem('focus-sessions'));
  assert.equal(sessions.length, 1, 'the already-logged transaction must not be logged twice');
  assert.equal(sessions[0].transactionId, transactionId);
});

test('short-session discard resets under the transaction lock without task or session mutation', async () => {
  const storage = initialStorage();
  const runtime = createRuntime(storage);
  const beforeTask = JSON.parse(storage.getItem('main')).tasks[0];
  runtime.sandbox._focusTimer.baseElapsed = 30;
  runtime.sandbox._focusTimer.running = false;
  runtime.sandbox._focusTimer.startedAt = null;
  runtime.sandbox._focusElapsedRemainderMs = 450;
  assert.equal(runtime.sandbox._saveFocusTimer(), true);
  const snapshot = runtime.sandbox._captureFocusTimerSnapshot();
  assert.equal(Object.isFrozen(snapshot), true);

  assert.equal(await runtime.sandbox._discardShortFocusSession({ snapshot }), true);
  const afterTask = JSON.parse(storage.getItem('main')).tasks[0];
  const timer = JSON.parse(storage.getItem('focus-timer'));
  assert.equal(afterTask.actual, beforeTask.actual);
  assert.equal(afterTask.lastStopwatchTransactionId, undefined);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 0);
  assert.equal(timer.baseElapsed, 0);
  assert.equal(timer.pendingStopwatchTransaction, null);
  assert.ok(runtime.rollingSnapshots.includes('focus-session-discard'));
});


test('commit baselines reject a mismatch between durable and in-memory transaction journals', () => {
  const storage = initialStorage();
  const timer = JSON.parse(storage.getItem('focus-timer'));
  timer.pendingStopwatchTransaction = {
    version: 1, id: 'focus-durable-journal', taskId: 7,
    previousActual: 5, targetActual: 8, previousTransactionId: null,
    minutesToAdd: 3, durationSec: 125, sessionStartAt: timer.sessionStartAt,
    mode: 'stopwatch', phase: 'work', clockAdjusted: false,
    elapsedRemainderMs: 0, completed: true, createdAt: Date.now()
  };
  storage.setItem('focus-timer', JSON.stringify(timer));
  const runtime = createRuntime(storage);
  runtime.sandbox._focusTimer.pendingStopwatchTransaction = null;
  const snapshot = runtime.sandbox._captureFocusTimerSnapshot();
  assert.equal(runtime.sandbox._focusCommitBaselinesMatch(snapshot), null);
});
