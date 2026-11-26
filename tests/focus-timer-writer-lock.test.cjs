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
