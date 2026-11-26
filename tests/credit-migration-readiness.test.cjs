'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map((match) => match[1]).filter((source) => source.trim());
const appScript = scripts.find((source) => source.includes('APP_VERSION'));
assert.ok(appScript, 'application script exists');

function extractFunction(name) {
  const pattern = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

function runtime(overrides = {}) {
  const mainRecord = {
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: { operationalDayStart: 4, firstUseDate: '2026-01-01', darkMode: false, themeMode: 'system', lastRecurringDates: {} },
    tasks: [],
    dailyLogs: []
  };
  const mainRaw = JSON.stringify(mainRecord);
  const values = new Map([
    ['main', mainRaw],
    ['reset', null], ['rolling-restore', null], ['import', null],
    ['migration', null], ['timer', JSON.stringify({ mode: 'stopwatch', pendingStopwatchTransaction: null })]
  ]);
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); }
  };
  const timerRaw = storage.getItem('timer');
  const sandbox = {
    RESET_IN_PROGRESS_KEY: 'reset',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore',
    IMPORT_IN_PROGRESS_KEY: 'import',
    MIGRATION_IN_PROGRESS_KEY: 'migration',
    FOCUS_TIMER_KEY: 'timer',
    STORAGE_KEY: 'main',
    CURRENT_SCHEMA_VERSION: 2,
    _stopwatchTransactionLockDepth: 1,
    storageRecoveryRequired: false,
    _startupStopwatchRecoveryInFlight: false,
    _startupStopwatchRecoveryFailed: false,
    _startupResetRecoveryInFlight: false,
    _resetRecoveryInFlight: false,
    _resetInFlight: false,
    _focusCommitInFlight: false,
    _pendingCorruptStorageSnapshots: [],
    _focusTimer: { pendingStopwatchTransaction: null },
    _secondaryStorageBaselines: { timer: timerRaw },
    _secondaryStorageConflicts: {},
    _mainStorageBaselineReady: true,
    _mainStorageExternalChangeObserved: false,
    _mainStorageBaselineRaw: mainRaw,
    tasks: [],
    validateV2(record) {
      return !!record && record.schemaVersion === 2
        && Array.isArray(record.tasks) && Array.isArray(record.dailyLogs);
    },
    localStorage: storage,
    console: { error() {} }
  };
  Object.assign(sandbox, overrides);
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('_assertCreditMigrationReady'), sandbox);
  sandbox.storage = storage;
  return sandbox;
}

test('credit migration gate opens only under the shared lock with clean, matching storage', () => {
  const app = runtime();
  assert.deepEqual(JSON.parse(JSON.stringify(app._assertCreditMigrationReady())), { ok: true, reason: null });
});

test('credit migration gate refuses to run without the shared Stopwatch lock', () => {
  const app = runtime({ _stopwatchTransactionLockDepth: 0 });
  assert.equal(app._assertCreditMigrationReady().reason, 'lock_required');
});

test('durable legacy transaction blocks migration even when memory has no journal', () => {
  const app = runtime();
  app.storage.setItem('timer', JSON.stringify({
    mode: 'stopwatch',
    pendingStopwatchTransaction: { id: 'legacy-transaction-123' }
  }));
  assert.equal(app._assertCreditMigrationReady().reason, 'pending_legacy_transaction');
});

test('in-memory legacy transaction blocks migration even when durable timer is clean', () => {
  const app = runtime({ _focusTimer: { pendingStopwatchTransaction: { id: 'legacy-transaction-123' } } });
  assert.equal(app._assertCreditMigrationReady().reason, 'pending_memory_transaction');
});

test('malformed timer JSON fails closed without modifying storage', () => {
  const app = runtime();
  app.storage.setItem('timer', '{broken');
  const before = app.storage.getItem('timer');
  assert.equal(app._assertCreditMigrationReady().reason, 'storage_read_failed');
  assert.equal(app.storage.getItem('timer'), before);
});

test('any reset, import, restore, or migration marker blocks credit migration', () => {
  for (const key of ['reset', 'rolling-restore', 'import', 'migration']) {
    const app = runtime();
    app.storage.setItem(key, 'in-progress');
    assert.equal(app._assertCreditMigrationReady().reason, 'blocking_marker', key);
    assert.equal(app.storage.getItem(key), 'in-progress');
  }
});

test('recovery flags and queued forensic snapshots block migration', () => {
  assert.equal(runtime({ storageRecoveryRequired: true })._assertCreditMigrationReady().reason, 'recovery_required');
  assert.equal(runtime({ _pendingCorruptStorageSnapshots: [{ baseKey: 'timer', raw: '{bad' }] })
    ._assertCreditMigrationReady().reason, 'recovery_required');
});

test('changed timer baseline blocks migration without attempting repair', () => {
  const app = runtime();
  app.storage.setItem('timer', JSON.stringify({ mode: 'pomodoro', pendingStopwatchTransaction: null }));
  assert.equal(app._assertCreditMigrationReady().reason, 'timer_baseline_conflict');
  assert.equal(app._secondaryStorageBaselines.timer,
    JSON.stringify({ mode: 'stopwatch', pendingStopwatchTransaction: null }));
});

test('credit migration gate requires a persisted main-storage baseline', () => {
  const app = runtime({ _mainStorageBaselineReady: false });
  assert.equal(app._assertCreditMigrationReady().reason, 'main_baseline_unavailable');
});

test('credit migration gate rejects a main-storage write made by another page even without a storage event', () => {
  const app = runtime();
  const changed = JSON.stringify({
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: { operationalDayStart: 4, firstUseDate: '2026-01-01', darkMode: false, themeMode: 'system', lastRecurringDates: {} },
    tasks: [],
    dailyLogs: [{ date: '2026-01-02', entries: [] }]
  });
  app.storage.setItem('main', changed);
  assert.equal(app._assertCreditMigrationReady().reason, 'main_baseline_conflict');
  assert.notEqual(app._mainStorageBaselineRaw, changed, 'the gate must not silently adopt a new baseline');
});

test('credit migration gate rejects an observed main-storage conflict', () => {
  const app = runtime({ _mainStorageExternalChangeObserved: true });
  assert.equal(app._assertCreditMigrationReady().reason, 'main_baseline_conflict');
});

test('credit migration gate rejects corrupt or unsupported main task data without repair', () => {
  const app = runtime();
  app.storage.setItem('main', '{broken');
  app._mainStorageBaselineRaw = '{broken';
  assert.equal(app._assertCreditMigrationReady().reason, 'invalid_main_record');
  assert.equal(app.storage.getItem('main'), '{broken');
});

test('credit migration gate rejects task objects changed in memory but not persisted', () => {
  const app = runtime();
  app.tasks.push({ id: 9, name: 'unpersisted task' });
  assert.equal(app._assertCreditMigrationReady().reason, 'task_memory_not_persisted');
});

test('credit migration gate refuses each in-memory reset operation independently', () => {
  for (const flag of ['_startupResetRecoveryInFlight', '_resetRecoveryInFlight', '_resetInFlight']) {
    const app = runtime({ [flag]: true });
    assert.equal(app._assertCreditMigrationReady().reason, 'recovery_or_commit_in_flight', flag);
  }
});

test('credit migration gate refuses while a focus commit is in flight', () => {
  const app = runtime({ _focusCommitInFlight: true });
  assert.equal(app._assertCreditMigrationReady().reason, 'recovery_or_commit_in_flight');
});

test('credit migration gate refuses when the focus commit guard reports blocked', () => {
  const app = runtime({ _isFocusCommitBlocked() { return true; } });
  assert.equal(app._assertCreditMigrationReady().reason, 'recovery_or_commit_in_flight');
});
