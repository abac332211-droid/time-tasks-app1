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
  const corrupt = runtime();
  corrupt.storage.setItem('main', '{broken');
  corrupt._mainStorageBaselineRaw = '{broken';
  assert.equal(corrupt._assertCreditMigrationReady().reason, 'invalid_main_record');
  assert.equal(corrupt.storage.getItem('main'), '{broken');

  const unsupported = runtime();
  const unsupportedRecord = JSON.parse(unsupported.storage.getItem('main'));
  unsupportedRecord.schemaVersion = 999;
  const unsupportedRaw = JSON.stringify(unsupportedRecord);
  unsupported.storage.setItem('main', unsupportedRaw);
  unsupported._mainStorageBaselineRaw = unsupportedRaw;
  assert.equal(unsupported._assertCreditMigrationReady().reason, 'invalid_main_record');
  assert.equal(unsupported.storage.getItem('main'), unsupportedRaw,
    'an unsupported schema must be rejected without rewriting the original record');
});
 
test('credit migration gate fails closed when reading the persisted main record throws', () => {
  const app = runtime();
  const originalGetItem = app.storage.getItem.bind(app.storage);
  const timerBefore = originalGetItem('timer');
  app.storage.getItem = key => {
    if (String(key) === 'main')
      throw new Error('injected main storage read failure');
    return originalGetItem(key);
  };

  assert.equal(app._assertCreditMigrationReady().reason, 'storage_read_failed');
  assert.equal(originalGetItem('timer'), timerBefore,
    'a failed main-record read must not mutate the timer or start recovery writes');
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


function legacyCreditTask(overrides = {}) {
  return {
    id: 1,
    name: 'Legacy task',
    status: 'pending',
    type: 'معرفية',
    expected: 30,
    actual: 12,
    plannedDate: '2026-11-26',
    plannedTime: '',
    completedAt: null,
    createdAt: 1730000000000,
    ...overrides
  };
}

function migrationRuntime(initialTasks, faults = {}) {
  const mainRecord = {
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: {
      operationalDayStart: 4,
      firstUseDate: '2026-01-01',
      darkMode: false,
      themeMode: 'system',
      lastRecurringDates: {}
    },
    tasks: JSON.parse(JSON.stringify(initialTasks)),
    dailyLogs: []
  };
  const mainRaw = JSON.stringify(mainRecord);
  const timerRaw = JSON.stringify({
    mode: 'pomodoro', phase: 'work', running: false,
    baseElapsed: 0, elapsedRemainderMs: 0, startedAt: null,
    cyclePosition: 0, taskId: null, sessionStartAt: null,
    awaitingConfirmation: false, pendingPhaseEndedAt: null,
    clockAdjusted: false, pendingStopwatchTransaction: null,
    pendingFocusCommit: null
  });
  const values = new Map([
    ['main', mainRaw], ['timer', timerRaw],
    ['reset', null], ['rolling-restore', null],
    ['import', null], ['migration', null]
  ]);
  const writes = [];
  const sandbox = {
    CURRENT_SCHEMA_VERSION: 2,
    VALID_STATUS: ['pending', 'done', 'cancelled'],
    VALID_TYPES: ['معرفية', 'بدنية', 'إدارية'],
    RESET_IN_PROGRESS_KEY: 'reset',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore',
    IMPORT_IN_PROGRESS_KEY: 'import',
    MIGRATION_IN_PROGRESS_KEY: 'migration',
    FOCUS_TIMER_KEY: 'timer',
    STORAGE_KEY: 'main',
    _stopwatchTransactionLockDepth: 1,
    _mainStorageBaselineReady: true,
    _mainStorageExternalChangeObserved: false,
    _mainStorageBaselineRaw: mainRaw,
    _secondaryStorageBaselines: { timer: timerRaw },
    _secondaryStorageConflicts: {},
    _focusTimer: { pendingStopwatchTransaction: null, pendingFocusCommit: null },
    _focusCommitInFlight: false,
    _startupStopwatchRecoveryInFlight: false,
    _startupStopwatchRecoveryFailed: false,
    _startupResetRecoveryInFlight: false,
    _resetRecoveryInFlight: false,
    _resetInFlight: false,
    _pendingCorruptStorageSnapshots: [],
    storageRecoveryRequired: false,
    tasks: JSON.parse(JSON.stringify(initialTasks)),
    isValidCalendarDate: value => /^\\d{4}-\\d{2}-\\d{2}$/.test(value),
    isValidLocalTime: value => value === '' || /^\\d{2}:\\d{2}$/.test(value),
    isValidLocalDateTime: value => typeof value === 'string' && Number.isFinite(Date.parse(value)),
    validateDailyLog: () => true,
    _isTaskStorageLockHeld: () => sandbox._stopwatchTransactionLockDepth > 0,
    _storageWriteAllowed: () => !sandbox.storageRecoveryRequired,
    _setMainStorageBaseline(raw) {
      sandbox._mainStorageBaselineRaw = raw;
      sandbox._mainStorageBaselineReady = true;
      sandbox._mainStorageExternalChangeObserved = false;
    },
    localStorage: {
      getItem(key) {
        if (faults.throwReadKey === key) throw new Error('injected read failure for ' + key);
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        writes.push([key, String(value)]);
        if (faults.throwWriteKey === key) throw new Error('injected write failure for ' + key);
        values.set(String(key), String(value));
      },
      removeItem(key) { values.delete(key); }
    },
    console: { error() {}, warn() {}, log() {} }
  };
  const source = [
    extractFunction('_validateLastRecurringDates'),
    extractFunction('_validateTaskCreditFields'),
    extractFunction('_validateCreditOperationRecord'),
    extractFunction('_validateCreditOperationLedger'),
    extractFunction('_creditOperationLedgerPreservesHistory'),
    extractFunction('validateV2'),
    extractFunction('_assertCreditMigrationReady'),
    extractFunction('_writeMainStorageRecordVerified'),
    extractFunction('_migrateLegacyTaskCreditMetadataLocked')
  ].join('\\n');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    app: sandbox,
    values,
    writes,
    get originalMainRaw() { return mainRaw; },
    readMain() { return JSON.parse(values.get('main')); }
  };
}

test('legacy credit migration converts minutes once and preserves null and empty operation history', () => {
  const runtime = migrationRuntime([
    legacyCreditTask({ id: 1, actual: 12 }),
    legacyCreditTask({ id: 2, actual: null })
  ]);
  const first = runtime.app._migrateLegacyTaskCreditMetadataLocked();
  assert.equal(first.ok, true);
  assert.equal(first.migratedTasks, 2);
  const record = runtime.readMain();
  assert.equal(record.tasks[0].actual, 12);
  assert.equal(record.tasks[0].actualSeconds, 720);
  assert.equal(record.tasks[0].creditRevision, 0);
  assert.equal(record.tasks[0].creditSchemaVersion, 1);
  assert.equal(record.tasks[0].lastCreditOperationId, null);
  assert.equal(record.tasks[1].actual, null);
  assert.equal(record.tasks[1].actualSeconds, null);
  assert.equal(record.tasks[1].creditRevision, 0);
  assert.equal(record.tasks[1].lastCreditOperationId, null);
  assert.deepEqual(record.creditOperations, []);
  assert.equal(runtime.writes.filter(([key]) => key === 'main').length, 1);
});

test('legacy credit migration is idempotent and does not create synthetic historical operations', () => {
  const runtime = migrationRuntime([legacyCreditTask({ actual: 0 })]);
  const first = runtime.app._migrateLegacyTaskCreditMetadataLocked();
  const afterFirst = runtime.values.get('main');
  const writeCount = runtime.writes.length;
  const second = runtime.app._migrateLegacyTaskCreditMetadataLocked();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyMigrated, true);
  assert.equal(runtime.values.get('main'), afterFirst);
  assert.equal(runtime.writes.length, writeCount);
  assert.equal(runtime.readMain().tasks[0].actualSeconds, 0);
  assert.deepEqual(runtime.readMain().creditOperations, []);
});

test('legacy credit migration rejects ambiguous fractional minutes without rewriting the source', () => {
  const runtime = migrationRuntime([legacyCreditTask({ actual: 1.5 })]);
  const result = runtime.app._migrateLegacyTaskCreditMetadataLocked();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'legacy_actual_not_a_safe_integer');
  assert.equal(runtime.values.get('main'), runtime.originalMainRaw);
  assert.equal(runtime.writes.length, 0);
});

test('legacy credit migration fails closed on partial metadata and preserves the original bytes', () => {
  const runtime = migrationRuntime([legacyCreditTask({
    actualSeconds: 720
  })]);
  const result = runtime.app._migrateLegacyTaskCreditMetadataLocked();
  assert.equal(result.ok, false);
  assert.equal(runtime.values.get('main'), runtime.originalMainRaw);
  assert.equal(runtime.writes.length, 0);
});

test('legacy credit migration refuses a changed baseline and never adopts an external balance', () => {
  const runtime = migrationRuntime([legacyCreditTask({ actual: 12 })]);
  const changed = JSON.parse(runtime.values.get('main'));
  changed.tasks[0].actual = 99;
  runtime.values.set('main', JSON.stringify(changed));
  const before = runtime.values.get('main');
  const result = runtime.app._migrateLegacyTaskCreditMetadataLocked();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'main_baseline_conflict');
  assert.equal(runtime.values.get('main'), before);
  assert.equal(runtime.writes.length, 0);
});

test('legacy credit migration read and write failures never report success', () => {
  const readFailure = migrationRuntime([legacyCreditTask()], { throwReadKey: 'main' });
  const readResult = readFailure.app._migrateLegacyTaskCreditMetadataLocked();
  assert.equal(readResult.ok, false);
  assert.equal(readFailure.values.get('main'), readFailure.originalMainRaw);
  assert.equal(readFailure.writes.length, 0);

  const writeFailure = migrationRuntime([legacyCreditTask()], { throwWriteKey: 'main' });
  const writeResult = writeFailure.app._migrateLegacyTaskCreditMetadataLocked();
  assert.equal(writeResult.ok, false);
  assert.equal(writeFailure.values.get('main'), writeFailure.originalMainRaw);
  assert.equal(writeFailure.app.storageRecoveryRequired, true,
    'a failed migration write keeps the storage write gate closed until recovery');
});
