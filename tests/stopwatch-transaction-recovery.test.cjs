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
    _rollingRecoveryCheckpointHold: 0,
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
    _renderFocusTimerView() {},
    showAlertModal(...args) { alerts.push(args); },
    showToast(message) { toasts.push(message); },
    escapeHTML(value) { return String(value); },
    console: { error() {}, warn() {}, log() {} }
  };

  const names = [
    '_trackSecondaryStorageRead',
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
    '_hasAmbiguousLegacyFocusSession',
    '_saveFocusTimer',
    '_loadFocusTimer',
    '_resetAfterSession',
    '_recoverPendingStopwatchSave',
    '_applyStopwatchSave',
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

test('process restart after task commit but before session logging resumes without adding task minutes twice', () => {
  const storage = initialStorage();
  const first = createRuntime(storage);
  first.sandbox._logSession = () => {
    throw new Error('simulated process death after the main task commit');
  };

  first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);

  const afterInterruptedCommit = JSON.parse(storage.getItem('main'));
  const interruptedTimer = JSON.parse(storage.getItem('focus-timer'));
  assert.equal(afterInterruptedCommit.tasks[0].actual, 8,
    'the first process has durably committed task minutes');
  assert.ok(interruptedTimer.pendingStopwatchTransaction,
    'the transaction journal must survive with the timer record');
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 0,
    'the simulated interruption occurs before the session write');

  const restarted = createRuntime(storage);
  assert.ok(restarted.sandbox._focusTimer.pendingStopwatchTransaction);
  assert.equal(restarted.sandbox._recoverPendingStopwatchSave(false), true);

  const recoveredMain = JSON.parse(storage.getItem('main'));
  const recoveredTimer = JSON.parse(storage.getItem('focus-timer'));
  const recoveredSessions = JSON.parse(storage.getItem('focus-sessions'));
  assert.equal(recoveredMain.tasks[0].actual, 8,
    'recovery must not apply the same minutes a second time');
  assert.equal(recoveredSessions.length, 1);
  assert.equal(recoveredSessions[0].durationSec, 125);
  assert.equal(recoveredSessions[0].taskId, 7);
  assert.equal(recoveredTimer.pendingStopwatchTransaction, null);
  assert.equal(recoveredTimer.baseElapsed, 0);
  assert.equal(restarted.sandbox.storageRecoveryRequired, false);
});

test('a durable timer journal can finish the task update when the first main write did not commit', () => {
  const storage = initialStorage();
  const first = createRuntime(storage, { failMainWriteOnce: true });

  first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);

  const beforeRestart = JSON.parse(storage.getItem('main'));
  const timerBeforeRestart = JSON.parse(storage.getItem('focus-timer'));
  assert.equal(beforeRestart.tasks[0].actual, 5,
    'the interrupted first main write did not commit');
  assert.ok(timerBeforeRestart.pendingStopwatchTransaction,
    'the timer journal was saved before attempting the main write');

  const restarted = createRuntime(storage);
  assert.equal(restarted.sandbox._recoverPendingStopwatchSave(false), true);

  const recoveredMain = JSON.parse(storage.getItem('main'));
  const recoveredSessions = JSON.parse(storage.getItem('focus-sessions'));
  assert.equal(recoveredMain.tasks[0].actual, 8);
  assert.equal(recoveredSessions.length, 1);
  assert.equal(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction, null);
});

test('restart after session write but before timer reset is idempotent', () => {
  const storage = initialStorage();
  const first = createRuntime(storage);
  first.sandbox._resetAfterSession = () => {
    throw new Error('simulated process death after the session was stored');
  };

  first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);

  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 8);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 1);
  assert.ok(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction);

  const restarted = createRuntime(storage);
  assert.equal(restarted.sandbox._recoverPendingStopwatchSave(false), true);

  const recoveredMain = JSON.parse(storage.getItem('main'));
  const recoveredSessions = JSON.parse(storage.getItem('focus-sessions'));
  assert.equal(recoveredMain.tasks[0].actual, 8);
  assert.equal(recoveredSessions.length, 1,
    'replaying a transaction whose session already exists must not add another row');
  assert.equal(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction, null);
});

test('recovery refuses to overwrite a task value that is neither the pre-commit nor committed value', () => {
  const storage = initialStorage();
  const first = createRuntime(storage);
  first.sandbox._logSession = () => {
    throw new Error('interrupt before session save');
  };
  first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3);

  const externallyChanged = JSON.parse(storage.getItem('main'));
  externallyChanged.tasks[0].actual = 17;
  storage.setItem('main', JSON.stringify(externallyChanged));

  const restarted = createRuntime(storage);
  assert.equal(restarted.sandbox._recoverPendingStopwatchSave(false), false);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 17);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 0);
  assert.ok(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction);
  assert.equal(restarted.sandbox.storageRecoveryRequired, true);
});


test('Pomodoro work-session commit replays a version-2 task/session identity after process death', () => {
  const storage = initialStorage();
  const storedTimer = JSON.parse(storage.getItem('focus-timer'));
  storedTimer.mode = 'pomodoro';
  storage.setItem('focus-timer', JSON.stringify(storedTimer));

  const first = createRuntime(storage);
  assert.equal(first.sandbox._focusTimer.mode, 'pomodoro');
  first.sandbox._logSession = () => {
    throw new Error('simulated process death after task actual and marker were committed');
  };
  assert.equal(first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3), false);

  const committedMain = JSON.parse(storage.getItem('main'));
  const pendingTimer = JSON.parse(storage.getItem('focus-timer'));
  const tx = pendingTimer.pendingStopwatchTransaction;
  assert.equal(tx.version, 2);
  assert.equal(tx.mode, 'pomodoro');
  assert.equal(committedMain.tasks[0].actual, 8);
  assert.equal(committedMain.tasks[0].lastFocusTransactionId, tx.id);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 0);

  const restarted = createRuntime(storage);
  assert.equal(restarted.sandbox._recoverPendingStopwatchSave(false), true);
  const recoveredMain = JSON.parse(storage.getItem('main'));
  const recoveredSessions = JSON.parse(storage.getItem('focus-sessions'));
  const recoveredTimer = JSON.parse(storage.getItem('focus-timer'));
  assert.equal(recoveredMain.tasks[0].actual, 8, 'replay must not add committed minutes twice');
  assert.equal(recoveredMain.tasks[0].lastFocusTransactionId, tx.id);
  assert.equal(recoveredSessions.length, 1);
  assert.equal(recoveredSessions[0].mode, 'pomodoro');
  assert.equal(recoveredSessions[0].transactionId, tx.id);
  assert.equal(recoveredSessions[0].durationSec, 125);
  assert.equal(recoveredTimer.pendingStopwatchTransaction, null);
});

test('version-2 replay recognizes its transaction-tagged session after reset interruption', () => {
  const storage = initialStorage();
  const storedTimer = JSON.parse(storage.getItem('focus-timer'));
  storedTimer.mode = 'pomodoro';
  storage.setItem('focus-timer', JSON.stringify(storedTimer));
  const first = createRuntime(storage);
  first.sandbox._resetAfterSession = () => {
    throw new Error('simulated process death after transaction-tagged session storage');
  };

  assert.equal(first.sandbox._applyStopwatchSave(125, first.sandbox.tasks[0], 3), false);
  const beforeRestartSessions = JSON.parse(storage.getItem('focus-sessions'));
  const beforeRestartTimer = JSON.parse(storage.getItem('focus-timer'));
  assert.equal(beforeRestartSessions.length, 1);
  assert.equal(beforeRestartSessions[0].transactionId, beforeRestartTimer.pendingStopwatchTransaction.id);

  const restarted = createRuntime(storage);
  assert.equal(restarted.sandbox._recoverPendingStopwatchSave(false), true);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 1);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 8);
  assert.equal(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction, null);
});

test('matching legacy session without a transaction ID is not adopted as a new version-2 commit', () => {
  const storage = initialStorage();
  const timer = JSON.parse(storage.getItem('focus-timer'));
  timer.mode = 'pomodoro';
  storage.setItem('focus-timer', JSON.stringify(timer));
  const startedAt = new Date(timer.sessionStartAt).toISOString();
  storage.setItem('focus-sessions', JSON.stringify([{
    id: 1, mode: 'pomodoro', phase: 'work', taskId: 7, taskName: 'Stopwatch task',
    startedAt, endedAt: new Date(timer.sessionStartAt + 125000).toISOString(),
    durationSec: 125, completed: true
  }]));

  const h = createRuntime(storage);
  h.sandbox._focusTimer.mode = 'pomodoro';
  assert.equal(h.sandbox._applyStopwatchSave(125, h.sandbox.tasks[0], 3), false);
  assert.equal(JSON.parse(storage.getItem('main')).tasks[0].actual, 5);
  assert.equal(JSON.parse(storage.getItem('focus-sessions')).length, 1);
  assert.equal(JSON.parse(storage.getItem('focus-timer')).pendingStopwatchTransaction, null);
  assert.equal(h.sandbox.storageRecoveryRequired, true);
});
