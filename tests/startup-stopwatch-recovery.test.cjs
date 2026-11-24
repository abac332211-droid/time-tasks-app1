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
  assert.ok(match, 'function ' + name + ' must be implemented in index.html for D-03');
  return match[0];
}

function makeStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  const reads = [];
  const writes = [];
  return {
    values,
    reads,
    writes,
    getItem(key) {
      key = String(key);
      reads.push(key);
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      key = String(key);
      writes.push({ key, value: String(value) });
      values.set(key, String(value));
    },
    removeItem(key) {
      key = String(key);
      writes.push({ key, remove: true });
      values.delete(key);
    }
  };
}

function pendingTransaction(overrides = {}) {
  const now = 1_795_000_000_000;
  return {
    version: 1,
    id: 'startup-recovery-tx-0001',
    taskId: 7011,
    previousActual: 5,
    targetActual: 8,
    previousTransactionId: null,
    minutesToAdd: 3,
    durationSec: 125,
    sessionStartAt: now - 600_000,
    mode: 'stopwatch',
    phase: 'work',
    clockAdjusted: false,
    elapsedRemainderMs: 0,
    completed: true,
    createdAt: now,
    ...overrides
  };
}

function mainRecord(tasks = [{
  id: 7011,
  name: 'Startup recovery task',
  status: 'pending',
  type: 'معرفية',
  expected: 20,
  actual: 5,
  plannedDate: '2026-11-24',
  plannedTime: '',
  completedAt: null,
  createdAt: 1_795_000_000_000
}]) {
  return {
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: { operationalDayStart: 4, firstUseDate: '2026-11-20', darkMode: false },
    tasks,
    dailyLogs: []
  };
}

function makeProbeSandbox(storage, tx) {
  return {
    localStorage: storage,
    STORAGE_KEY: 'main',
    FOCUS_TIMER_KEY: 'timer',
    RESET_IN_PROGRESS_KEY: 'reset',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore',
    IMPORT_IN_PROGRESS_KEY: 'import',
    MIGRATION_IN_PROGRESS_KEY: 'migration',
    CURRENT_SCHEMA_VERSION: 2,
    _validatePendingStopwatchTransaction(value) {
      return !!value && value.version === 1 && typeof value.id === 'string'
        && value.id.length >= 8 && Number.isInteger(value.taskId);
    },
    validateV2(value) {
      return !!value && value.schemaVersion === 2
        && Array.isArray(value.tasks) && Array.isArray(value.dailyLogs);
    },
    _readPersistedRollingBackupGeneration() { return 9; },
    JSON,
    Date,
    tx
  };
}

function runExtracted(name, sandbox, extraNames = []) {
  const source = [name, ...extraNames].map(extractFunction).join('\n');
  vm.runInNewContext(source, sandbox, { timeout: 1_000 });
  return sandbox;
}

function asPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('read-only startup probe finds a pending transaction without writing or migrating', () => {
  const tx = pendingTransaction();
  const main = mainRecord();
  const storage = makeStorage({
    main: JSON.stringify(main),
    timer: JSON.stringify({ pendingStopwatchTransaction: tx, mode: 'stopwatch' })
  });
  const sandbox = makeProbeSandbox(storage, tx);
  runExtracted('_probeStartupStopwatchRecovery', sandbox);

  const result = sandbox._probeStartupStopwatchRecovery();
  assert.equal(result.pending, true);
  assert.equal(result.error, null);
  assert.deepEqual(asPlain(result.mainData), main);
  assert.deepEqual(asPlain(result.expectedTx), tx);
  assert.equal(result.bootPersistedGeneration, 9);
  assert.equal(storage.writes.length, 0, 'the probe must not write any localStorage key');
  assert.deepEqual(storage.reads.slice(0, 5), ['reset', 'rolling-restore', 'import', 'migration', 'timer']);
  assert.ok(storage.reads.includes('main'), 'the probe must read the main V2 record');
});

test('startup probe keeps import and rolling-restore markers pending while inspecting a visible journal', () => {
  for (const marker of ['import', 'rolling-restore']) {
    const tx = pendingTransaction();
    const main = mainRecord();
    const storage = makeStorage({
      reset: null,
      'rolling-restore': marker === 'rolling-restore' ? '1' : null,
      'import': marker === 'import' ? '1' : null,
      migration: null,
      main: JSON.stringify(main),
      timer: JSON.stringify({ pendingStopwatchTransaction: tx, mode: 'stopwatch' })
    });
    const sandbox = makeProbeSandbox(storage, tx);
    runExtracted('_probeStartupStopwatchRecovery', sandbox);
    const result = sandbox._probeStartupStopwatchRecovery();
    assert.equal(result.pending, true);
    assert.equal(result.error, null);
    assert.equal(result.blockingMarkers[marker === 'import' ? 'import' : 'rollingRestore'], true);
    assert.deepEqual(asPlain(result.expectedTx), tx);
    assert.equal(storage.writes.length, 0);
  }
});

test('startup probe fails closed for an empty-but-present timer record and leaves all bytes untouched', () => {
  const storage = makeStorage({ timer: '', main: JSON.stringify(mainRecord()) });
  const sandbox = makeProbeSandbox(storage);
  runExtracted('_probeStartupStopwatchRecovery', sandbox);

  const result = sandbox._probeStartupStopwatchRecovery();
  assert.equal(result.pending, true);
  assert.ok(result.error, 'an empty string is corrupt JSON, not the same as a missing key');
  assert.equal(storage.writes.length, 0);
  assert.equal(storage.values.get('timer'), '');
  assert.equal(storage.values.get('main'), JSON.stringify(mainRecord()));
});

test('sibling transaction outcome is accepted only with both task identity and matching session evidence', () => {
  const tx = pendingTransaction();
  const startedAt = new Date(tx.sessionStartAt).toISOString();
  const task = {
    ...mainRecord().tasks[0],
    actual: tx.targetActual,
    lastStopwatchTransactionId: tx.id
  };
  const bundle = {
    timerObj: { mode: 'stopwatch', pendingStopwatchTransaction: null },
    mainData: mainRecord([task]),
    sessionsArr: [{
      id: 'session-0001',
      transactionId: tx.id,
      taskId: tx.taskId,
      mode: tx.mode,
      phase: tx.phase,
      durationSec: tx.durationSec,
      startedAt,
      completed: true
    }]
  };
  const sandbox = {
    localStorage: makeStorage({}),
    RESET_IN_PROGRESS_KEY: 'reset',
    ROLLING_BACKUP_A_KEY: 'backup-a',
    ROLLING_BACKUP_B_KEY: 'backup-b',
    _readPersistedRollingBackupGeneration() { return 9; },
    Date
  };
  runExtracted('_verifySiblingTransactionOutcome', sandbox);

  const proof = sandbox._verifySiblingTransactionOutcome(bundle, tx, 8);
  assert.deepEqual(asPlain(proof), { proven: true, kind: 'committed' });

  bundle.sessionsArr[0].durationSec++;
  const rejected = sandbox._verifySiblingTransactionOutcome(bundle, tx, 8);
  assert.equal(rejected.proven, false,
    'task transaction marker alone must not prove that the session was committed');
});

test('reset sibling proof requires the complete empty reset footprint and a newer generation', () => {
  const tx = pendingTransaction();
  const storage = makeStorage({
    reset: null,
    'backup-a': null,
    'backup-b': null
  });
  const sandbox = {
    localStorage: storage,
    RESET_IN_PROGRESS_KEY: 'reset',
    ROLLING_BACKUP_A_KEY: 'backup-a',
    ROLLING_BACKUP_B_KEY: 'backup-b',
    _readPersistedRollingBackupGeneration() { return 12; },
    Date
  };
  runExtracted('_verifySiblingTransactionOutcome', sandbox);

  const resetBundle = {
    timerObj: null,
    timerRaw: null,
    mainData: mainRecord([]),
    sessionsRaw: null,
    projectsRaw: null,
    thoughtsRaw: null,
    mentalRaw: null,
    sessionsArr: []
  };
  assert.deepEqual(
    asPlain(sandbox._verifySiblingTransactionOutcome(resetBundle, tx, 11)),
    { proven: true, kind: 'reset' }
  );
  assert.equal(
    sandbox._verifySiblingTransactionOutcome(resetBundle, tx, 12).proven,
    false,
    'a reset generation equal to the boot generation is not new evidence'
  );
  resetBundle.mainData.dailyLogs.push({ date: '2026-11-24', tasks: [] });
  assert.equal(
    sandbox._verifySiblingTransactionOutcome(resetBundle, tx, 11).proven,
    false,
    'a reset proof must include empty daily logs'
  );
});

test('all persisted post-recovery initialization remains inside the Stopwatch lock', () => {
  const calls = [];
  const sandbox = {
    tasks: [{ id: 7011 }],
    _stopwatchTransactionLockDepth: 1,
    _healTaskFieldsAfterLoad() {
      assert.equal(sandbox._stopwatchTransactionLockDepth, 1);
      calls.push('heal');
      return true;
    },
    saveData() {
      assert.equal(sandbox._stopwatchTransactionLockDepth, 1);
      calls.push('save');
      return true;
    },
    _generateAndPersistRecurringTasks() {
      assert.equal(sandbox._stopwatchTransactionLockDepth, 1);
      calls.push('recurring');
      return 2;
    },
    _finalizeFocusTimerColdStartRestore() {
      assert.equal(sandbox._stopwatchTransactionLockDepth, 1);
      calls.push('cold-start');
    },
    _storeRollingRecoveryBackup(reason, interval) {
      assert.equal(sandbox._stopwatchTransactionLockDepth, 1);
      calls.push('backup:' + reason + ':' + interval);
      return true;
    },
    console: { error() {} }
  };
  runExtracted('_runPostRecoveryPersistedInitInsideLock', sandbox);

  const result = sandbox._runPostRecoveryPersistedInitInsideLock();
  assert.equal(result.ok, true);
  assert.equal(result.generatedCount, 2);
  assert.deepEqual(calls, [
    'heal', 'save', 'recurring', 'cold-start', 'backup:startup:60000'
  ]);
});

test('vanished journal without transaction or reset proof keeps recovery locked and does not apply the bundle', () => {
  const storage = makeStorage({
    reset: null,
    'import': null,
    'rolling-restore': null,
    migration: null,
    timer: JSON.stringify({ mode: 'stopwatch', pendingStopwatchTransaction: null })
  });
  let applied = 0;
  const alerts = [];
  const sandbox = {
    localStorage: storage,
    _stopwatchTransactionLockDepth: 1,
    RESET_IN_PROGRESS_KEY: 'reset',
    IMPORT_IN_PROGRESS_KEY: 'import',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore',
    MIGRATION_IN_PROGRESS_KEY: 'migration',
    FOCUS_TIMER_KEY: 'timer',
    STORAGE_KEY: 'main',
    storageRecoveryRequired: false,
    _probeStartupStopwatchRecovery() {
      const markerValues = {
        reset: storage.getItem('reset'),
        rollingRestore: storage.getItem('rolling-restore'),
        import: storage.getItem('import'),
        migration: storage.getItem('migration')
      };
      const timerRaw = storage.getItem('timer');
      const timerObj = timerRaw === null ? null : JSON.parse(timerRaw);
      const tx = timerObj && timerObj.pendingStopwatchTransaction
        ? timerObj.pendingStopwatchTransaction : null;
      return {
        pending: Object.values(markerValues).some(value => value !== null) || !!tx,
        error: null,
        blockingMarkers: {
          reset: markerValues.reset !== null,
          rollingRestore: markerValues.rollingRestore !== null,
          import: markerValues.import !== null,
          migration: markerValues.migration !== null
        },
        markerValues, timerRaw, timerObj, expectedTx: tx,
        bootPersistedGeneration: 9,
        mainRaw: storage.getItem('main'),
        mainData: null
      };
    },
    _flushPendingCorruptStorageSnapshotsInsideLock() { return true; },
    _finishStartupInitializationInsideLock() { return true; },
    _readAndValidateResyncBundle() {
      return {
        timerObj: { mode: 'stopwatch', pendingStopwatchTransaction: null },
        timerRaw: storage.getItem('timer'),
        mainData: mainRecord(),
        sessionsArr: [],
        sessionsRaw: '[]',
        projectsRaw: null,
        thoughtsRaw: null,
        mentalRaw: null
      };
    },
    _verifySiblingTransactionOutcome() { return { proven: false }; },
    _applyValidatedResyncBundle() { applied++; },
    _runPostRecoveryPersistedInitInsideLock() { throw new Error('must not run'); },
    showAlertModal(...args) { alerts.push(args); },
    Date,
    JSON,
    console: { error() {} }
  };
  runExtracted('_recoverPendingStopwatchSaveFromStartup', sandbox);

  const result = sandbox._recoverPendingStopwatchSaveFromStartup(
    pendingTransaction(), 8
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_tx_unproven');
  assert.equal(sandbox.storageRecoveryRequired, true);
  assert.equal(applied, 0, 'unproven data must not be applied to in-memory state');
  assert.ok(alerts.length > 0, 'the user must receive a clear recovery error');
  assert.equal(storage.writes.length, 0);
});

test('retryStorageRecovery detects the durable timer journal even when the memory flag is false', async () => {
  const tx = pendingTransaction();
  const storage = makeStorage({
    reset: null,
    'rolling-restore': null,
    timer: JSON.stringify({ mode: 'stopwatch', pendingStopwatchTransaction: tx })
  });
  let lockCalls = 0;
  let sandbox;
  sandbox = {
    localStorage: storage,
    navigator: { locks: { request() {} } },
    FOCUS_TIMER_KEY: 'timer',
    RESET_IN_PROGRESS_KEY: 'reset',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore',
    IMPORT_IN_PROGRESS_KEY: 'import',
    MIGRATION_IN_PROGRESS_KEY: 'migration',
    storageRecoveryRequired: false,
    _startupStopwatchRecoveryInFlight: false,
    _startupStopwatchRecoveryFailed: false,
    _pendingCorruptStorageSnapshots: [],
    _appInitCompleted: true,
    _startupStopwatchRecoveryExpectedTx: null,
    _stopwatchRetryRecoveryPromise: null,
    _startupResetRecoveryInFlight: false,
    _resetRecoveryInFlight: false,
    _focusCommitInFlight: false,
    _validatePendingStopwatchTransaction(value) { return value && value.id === tx.id; },
    _readPersistedRollingBackupGeneration() { return 9; },
    _probeStartupStopwatchRecovery() {
      const markerValues = {
        reset: storage.getItem('reset'),
        rollingRestore: storage.getItem('rolling-restore'),
        import: storage.getItem('import'),
        migration: storage.getItem('migration')
      };
      const timerRaw = storage.getItem('timer');
      const timerObj = timerRaw === null ? null : JSON.parse(timerRaw);
      const currentTx = timerObj && timerObj.pendingStopwatchTransaction
        ? timerObj.pendingStopwatchTransaction : null;
      return {
        pending: Object.values(markerValues).some(value => value !== null) || !!currentTx,
        error: null,
        blockingMarkers: {
          reset: markerValues.reset !== null,
          rollingRestore: markerValues.rollingRestore !== null,
          import: markerValues.import !== null,
          migration: markerValues.migration !== null
        },
        markerValues, timerRaw, timerObj, expectedTx: currentTx,
        bootPersistedGeneration: 9, mainRaw: 'main', mainData: null
      };
    },
    _withStopwatchTransactionLock(callback) {
      lockCalls++;
      return Promise.resolve().then(callback);
    },
    _runStorageRecoveryCoordinatorInsideLock(probe) {
      assert.ok(probe.expectedTx, 'coordinator must receive the durable Stopwatch journal');
      const timer = JSON.parse(storage.getItem('timer'));
      timer.pendingStopwatchTransaction = null;
      storage.setItem('timer', JSON.stringify(timer));
      sandbox.storageRecoveryRequired = false;
      sandbox._startupStopwatchRecoveryFailed = false;
      sandbox._appInitCompleted = true;
      return { ok: true, recoveredBySibling: false };
    },
    showToast() {},
    showAlertModal() {},
    renderAll() {},
    setTimeout() {},
    _reloadAfterVerifiedOperation() {},
    JSON,
    console: { error() {} }
  };
  runExtracted('retryStorageRecovery', sandbox, ['_runStorageRecoveryCoordinatorWithFreshProbeRetry']);

  sandbox.retryStorageRecovery();
  const pendingPromise = sandbox._stopwatchRetryRecoveryPromise;
  assert.ok(pendingPromise, 'retry must enter the pending-transaction recovery path');
  await pendingPromise;

  assert.equal(lockCalls, 1, 'retry must acquire the shared Stopwatch lock');
  assert.equal(JSON.parse(storage.getItem('timer')).pendingStopwatchTransaction, null);
  assert.equal(sandbox.storageRecoveryRequired, false);
  assert.equal(sandbox._startupStopwatchRecoveryFailed, false);
});

test('timer and task write gates remain closed after startup recovery failure', () => {
  const sandbox = {
    storageRecoveryRequired: true,
    _startupStopwatchRecoveryInFlight: false,
    _startupStopwatchRecoveryFailed: true,
    _startupResetRecoveryInFlight: false,
    _resetRecoveryInFlight: false,
    _resetInFlight: false,
    _focusCommitInFlight: false,
    _focusTimerExternalConflict: false,
    _stopwatchTransactionLockDepth: 0,
    _mainStorageExternalChangeObserved: false,
    _isFocusCommitBlocked() { return false; }
  };
  runExtracted('_isTimerControlBlocked', sandbox);
  runExtracted('_isTaskWriteBlocked', sandbox, ['_isStartupStopwatchBlocked']);

  assert.equal(sandbox._isTimerControlBlocked(), true);
  assert.equal(sandbox._isTaskWriteBlocked(), true);
  sandbox._stopwatchTransactionLockDepth = 1;
  assert.equal(sandbox._isTaskWriteBlocked(), false,
    'the validated recovery callback must be able to write while it owns the lock');
});


test('failed locked forensic snapshot writes retain exact raw bytes in the queue and retry under lock', () => {
  for (const failureMode of ['throw', 'readback-mismatch']) {
    const storage = makeStorage({});
    const originalSet = storage.setItem.bind(storage);
    let injected = true;
    storage.setItem = function(key, value) {
      if (injected && String(key).startsWith('mentalInbox_corrupt_')) {
        injected = false;
        if (failureMode === 'throw') throw new Error('INJECTED_FORENSIC_WRITE_FAILURE');
        return originalSet(key, String(value) + ':mismatch');
      }
      return originalSet(key, value);
    };
    const sandbox = {
      localStorage: storage,
      _stopwatchTransactionLockDepth: 1,
      _pendingCorruptStorageSnapshots: [],
      storageRecoveryRequired: false,
      console: { error() {}, warn() {} },
      Date,
      JSON
    };
    runExtracted('_preserveCorruptStorageSnapshot', sandbox,
      ['_queuePendingCorruptStorageSnapshot']);
    runExtracted('_flushPendingCorruptStorageSnapshotsInsideLock', sandbox,
      ['_queuePendingCorruptStorageSnapshot', '_preserveCorruptStorageSnapshot']);

    const raw = '{broken forensic source — retain byte-for-byte}';
    assert.equal(sandbox._preserveCorruptStorageSnapshot('mentalInbox', raw), false,
      failureMode + ': failed first preservation must not report success');
    assert.equal(
      JSON.stringify(sandbox._pendingCorruptStorageSnapshots),
      JSON.stringify([{ baseKey: 'mentalInbox', raw }]),
      failureMode + ': exact raw bytes must remain queued after a locked write failure'
    );
    assert.equal(sandbox.storageRecoveryRequired, true,
      failureMode + ': failed forensic preservation must keep recovery required');

    storage.setItem = originalSet;
    assert.equal(sandbox._flushPendingCorruptStorageSnapshotsInsideLock(), true,
      failureMode + ': a later locked flush should verify the preserved raw bytes');
    assert.equal(sandbox._pendingCorruptStorageSnapshots.length, 0);
    const preserved = Array.from(storage.values.entries())
      .filter(([key]) => key.startsWith('mentalInbox_corrupt_'))
      .map(([, value]) => value);
    assert.ok(preserved.includes(raw),
      failureMode + ': a verified forensic copy must preserve the original raw string');
  }
});
