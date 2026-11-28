'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appScript = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map((match) => match[1])
  .find((source) => source.includes('APP_VERSION'));
assert.ok(appScript, 'application script exists');

function extractFunction(name) {
  const pattern = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

function makeTimer() {
  return {
    mode: 'pomodoro', phase: 'work', running: false, baseElapsed: 0,
    startedAt: null, cyclePosition: 0, taskId: null, sessionStartAt: null,
    awaitingConfirmation: false, pendingPhaseEndedAt: null, clockAdjusted: false,
    pendingStopwatchTransaction: null, nativeClockActive: false,
    nativeSessionToken: null, handledNotificationActionIds: [],
    pendingNotificationFinish: null
  };
}

function saveHarness(lockHeld) {
  const writes = [];
  const sandbox = {
    FOCUS_TIMER_KEY: 'focus-timer',
    _focusTimer: makeTimer(),
    _focusElapsedRemainderMs: 0,
    _focusTimerCheckpointAt: 0,
    _isTaskStorageLockHeld: () => lockHeld,
    _storageWriteAllowed: () => true,
    _writeSecondaryStorageVerified(key, raw) {
      writes.push({ key, raw });
      return true;
    },
    _clearFocusTimerClock() {},
    _storeRollingRecoveryBackup() { return true; },
    console: { error() {}, warn() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('_saveFocusTimer'), sandbox);
  return { sandbox, writes };
}

test('_withFocusCommitWrite cannot bypass the shared lock', () => {
  const sandbox = {
    _stopwatchTransactionLockDepth: 0,
    _focusCommitWriteDepth: 0,
    console: { error() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('_withFocusCommitWrite'), sandbox);
  let invoked = false;

  assert.equal(sandbox._withFocusCommitWrite(() => { invoked = true; return true; }), false);
  assert.equal(invoked, false, 'the protected callback must not execute without lock ownership');
  assert.equal(sandbox._focusCommitWriteDepth, 0, 'a rejected scope must not open the write bypass');

  sandbox._stopwatchTransactionLockDepth = 1;
  assert.equal(sandbox._withFocusCommitWrite(() => { invoked = true; return true; }), true);
  assert.equal(invoked, true);
  assert.equal(sandbox._focusCommitWriteDepth, 0, 'the write bypass must always close after callback completion');
});

test('_saveFocusTimer fails closed when the shared Stopwatch lock is not held', () => {
  const h = saveHarness(false);
  assert.equal(h.sandbox._saveFocusTimer(), false);
  assert.equal(h.writes.length, 0, 'no focus timer write may be attempted');
});

test('_saveFocusTimer writes the timer record while the shared lock is held', () => {
  const h = saveHarness(true);
  assert.equal(h.sandbox._saveFocusTimer(), true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].key, 'focus-timer');
  const record = JSON.parse(h.writes[0].raw);
  assert.equal(record.running, false);
  assert.equal(record.baseElapsed, 0);
  assert.equal(record.pendingStopwatchTransaction, null);
});

function secondaryWriterHarness(lockHeld) {
  const writes = [];
  const values = new Map([['focus-timer', 'old']]);
  const sandbox = {
    FOCUS_TIMER_KEY: 'focus-timer',
    _isTaskStorageLockHeld: () => lockHeld,
    _storageWriteAllowed: () => true,
    _secondaryStorageWriteAllowed: () => true,
    _secondaryStorageBaselines: { 'focus-timer': 'old' },
    _secondaryStorageConflicts: {},
    storageRecoveryRequired: false,
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { writes.push([key, String(value)]); values.set(key, String(value)); }
    },
    console: { error() {}, warn() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('_writeSecondaryStorageVerified'), sandbox);
  return { sandbox, writes, values };
}

test('_writeSecondaryStorageVerified refuses FOCUS_TIMER_KEY without shared lock ownership', () => {
  const h = secondaryWriterHarness(false);
  assert.equal(h.sandbox._writeSecondaryStorageVerified('focus-timer', 'new'), false);
  assert.equal(h.writes.length, 0);
  assert.equal(h.values.get('focus-timer'), 'old');
});

test('_writeSecondaryStorageVerified verifies FOCUS_TIMER_KEY while shared lock is held', () => {
  const h = secondaryWriterHarness(true);
  assert.equal(h.sandbox._writeSecondaryStorageVerified('focus-timer', 'new'), true);
  assert.deepEqual(h.writes, [['focus-timer', 'new']]);
  assert.equal(h.values.get('focus-timer'), 'new');
  assert.equal(h.sandbox._secondaryStorageBaselines['focus-timer'], 'new');
});

test('all interactive and native focus timer writer entrypoints are lock-gated', () => {
  const required = [
    '_markNativeFocusClockUntrusted',
    '_attachNativeStopwatchClockToRunningTimer',
    '_consumeNativeStopwatchNotificationAction',
    '_handleFocusTimerClockDiscontinuity',
    '_cancelPendingNotificationFinish',
    'linkTimerToTask',
    'toggleTimer',
    'resetTimer',
    'finishTimer',
    'startTimerForTask',
    '_showSessionTransitionDialog'
  ];
  for (const name of required) {
    const source = extractFunction(name);
    assert.match(source, /_withTaskStorageLock|_isTaskStorageLockHeld/,
      name + ' must acquire or require the shared lock');
  }
  assert.match(extractFunction('_freezeFocusTimerForDecision'), /_isTaskStorageLockHeld/);
  assert.match(extractFunction('_startDisplayTick'), /_withTaskStorageLock/);
  assert.match(extractFunction('_scheduleNativeStopwatchClockAttach'), /setTimeout/);
  assert.match(extractFunction('_saveFocusTimer'), /_isTaskStorageLockHeld/);
});

test('focus timer import restore is guarded by shared lock ownership', () => {
  assert.match(extractFunction('_restoreFocusTimerSnapshot'), /_isTaskStorageLockHeld/);
  assert.match(extractFunction('_restoreStorageSnapshot'), /_stopwatchTransactionLockDepth/);
});


test('linkTimerToTask rolls back its in-memory task ID when persistence fails', () => {
  const alerts = [];
  let renders = 0;
  const timer = { running: false, baseElapsed: 0, taskId: 4 };
  const sandbox = {
    _focusTimer: timer,
    _isTaskStorageLockHeld: () => true,
    _withTaskStorageLock(callback) { return callback(); },
    _isTimerControlBlocked: () => false,
    _isFocusCommitBlocked: () => false,
    _saveFocusTimer: () => false,
    _renderFocusTimer() { renders++; },
    _formatDuration: String,
    showToast() {},
    showAlertModal(...args) { alerts.push(args); }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('linkTimerToTask'), sandbox);

  assert.equal(sandbox.linkTimerToTask(7), false);
  assert.equal(timer.taskId, 4, 'failed save must not leave a different task linked in memory');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][0], /تعذر تغيير ربط المهمة/);
  assert.equal(renders, 1);
});


test('_restoreFocusTimerSnapshot refuses a timer restore without the shared lock', () => {
  const writes = [];
  const storage = {
    setItem(key, value) { writes.push([key, String(value)]); }
  };
  const sandbox = {
    FOCUS_TIMER_KEY: 'focus-timer',
    _isTaskStorageLockHeld: () => false
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('_restoreFocusTimerSnapshot'), sandbox);

  assert.throws(
    () => sandbox._restoreFocusTimerSnapshot(
      { focusTimer: { mode: 'pomodoro', running: false, baseElapsed: 30 } },
      storage,
      'focus-timer'
    ),
    /requires the shared Stopwatch Web Lock/
  );
  assert.deepEqual(writes, [], 'restore must not write any timer snapshot without lock ownership');
});

test('_restoreFocusTimerSnapshot restores the timer while the shared lock is held', () => {
  const writes = [];
  const storage = {
    setItem(key, value) { writes.push([key, String(value)]); }
  };
  const sandbox = {
    FOCUS_TIMER_KEY: 'focus-timer',
    _isTaskStorageLockHeld: () => true
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('_restoreFocusTimerSnapshot'), sandbox);
  const record = { mode: 'pomodoro', running: false, baseElapsed: 30 };

  sandbox._restoreFocusTimerSnapshot({ focusTimer: record }, storage, 'focus-timer');

  assert.deepEqual(writes, [['focus-timer', JSON.stringify(record)]]);
});
