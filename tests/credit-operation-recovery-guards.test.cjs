'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map(match => match[1]).filter(source => source.trim());
const appScript = scripts.find(source => source.includes('APP_VERSION'));
assert.ok(appScript, 'application script exists');

function extractTopLevelSource(name) {
  const pattern = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

const IDS = {
  first: '123e4567-e89b-42d3-a456-426614174000',
  second: '223e4567-e89b-42d3-a456-426614174001'
};

function manualOperation(overrides = {}) {
  return {
    recordVersion: 1,
    operationId: IDS.first,
    kind: 'manual_adjustment',
    taskId: 7,
    revision: 1,
    previousSeconds: null,
    targetSeconds: 60,
    source: 'manual_adjustment',
    sessionId: null,
    createdAt: '2026-11-26T10:00:00.000Z',
    ...overrides
  };
}

function secondManualOperation() {
  return manualOperation({
    operationId: IDS.second,
    revision: 2,
    previousSeconds: 60,
    targetSeconds: 120,
    createdAt: '2026-11-26T10:01:00.000Z'
  });
}

function mainRecord(operations = []) {
  return {
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: {},
    tasks: [],
    dailyLogs: [],
    creditOperations: operations
  };
}

function storageSnapshot(mainRaw) {
  return {
    main: mainRaw,
    focusSessions: '[]',
    focusTimer: '{}',
    mentalInbox: '[]',
    thoughts: '[]',
    projects: '[]',
    focusSettings: '{}',
    notifications: '{}'
  };
}

function makeStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  const writes = [];
  return {
    values,
    writes,
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      writes.push({ key: String(key), value: String(value) });
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    }
  };
}

function commonSource() {
  return [
    extractTopLevelSource('_validateTaskCreditFields'),
    extractTopLevelSource('_validateCreditOperationRecord'),
    extractTopLevelSource('_validateCreditOperationLedger'),
    extractTopLevelSource('_creditOperationLedgerPreservesHistory'),
    extractTopLevelSource('_creditOperationSnapshotPreservesHistory')
  ].join('\n');
}

function makeMainValidator(sandbox) {
  sandbox.validateV2 = function(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.schemaVersion !== 2 || !Array.isArray(value.tasks)
        || !Array.isArray(value.dailyLogs)) return false;
    if (Object.prototype.hasOwnProperty.call(value, 'creditOperations')) {
      return sandbox._validateCreditOperationLedger(value.creditOperations, value.tasks);
    }
    return value.tasks.every(task =>
      !task || !Number.isSafeInteger(task.creditRevision) || task.creditRevision === 0
    );
  };
}

function makeRestoreSandbox(storage, extra = {}) {
  const sandbox = {
    localStorage: storage,
    STORAGE_KEY: 'main',
    FOCUS_SESSIONS_KEY: 'sessions',
    FOCUS_TIMER_KEY: 'timer',
    MENTAL_INBOX_KEY: 'inbox',
    THOUGHTS_KEY: 'thoughts',
    PROJECTS_KEY: 'projects',
    FOCUS_SETTINGS_KEY: 'focus-settings',
    NOTIFICATIONS_KEY: 'notifications',
    RESET_IN_PROGRESS_KEY: 'reset',
    IMPORT_IN_PROGRESS_KEY: 'import',
    MIGRATION_IN_PROGRESS_KEY: 'migration',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore',
    ROLLING_BACKUP_A_KEY: 'rolling-a',
    ROLLING_BACKUP_B_KEY: 'rolling-b',
    _stopwatchTransactionLockDepth: 1,
    storageRecoveryRequired: false,
    _hasPersistedPendingStopwatchTransaction: () => false,
    _setMainStorageBaseline(raw) { sandbox.baseline = raw; },
    _invalidateProjectsCache() {},
    console: { error() {}, warn() {} },
    ...extra
  };
  vm.createContext(sandbox);
  vm.runInContext(commonSource(), sandbox);
  makeMainValidator(sandbox);
  return sandbox;
}

function rollingBackup(mainRaw, sequence = 5) {
  return JSON.stringify({
    formatVersion: 1,
    sequence,
    createdAtMs: 1795687200000,
    reason: 'test',
    data: storageSnapshot(mainRaw)
  });
}

test('rolling recovery refuses a stale snapshot that removes an accepted credit operation', () => {
  const current = mainRecord([manualOperation()]);
  const stale = mainRecord([]);
  const before = {
    main: JSON.stringify(current),
    sessions: 'current-sessions',
    timer: '{}',
    inbox: '[]',
    thoughts: '[]',
    projects: '[]',
    'focus-settings': '{}',
    notifications: '{}',
    'rolling-restore': JSON.stringify({ version: 1, slot: 'a', sequence: 5 }),
    'rolling-a': rollingBackup(JSON.stringify(stale), 5)
  };
  const storage = makeStorage(before);
  const sandbox = makeRestoreSandbox(storage);
  vm.runInContext([
    extractTopLevelSource('_parseRollingRecoveryBackup'),
    extractTopLevelSource('_restoreStorageSnapshot'),
    extractTopLevelSource('_recoverInterruptedRollingRestore')
  ].join('\n'), sandbox);

  assert.equal(sandbox._recoverInterruptedRollingRestore(), false);
  assert.equal(sandbox.storageRecoveryRequired, true);
  assert.equal(storage.getItem('rolling-restore'), before['rolling-restore'],
    'the recovery marker remains available for an explicit safe resolution');
  assert.deepEqual(storage.writes, [], 'no collection may be overwritten by a stale snapshot');
  for (const key of Object.keys(before)) {
    assert.equal(storage.getItem(key), before[key], 'stored bytes remain unchanged: ' + key);
  }
});

test('rolling recovery permits an append-only snapshot and writes the main record last', () => {
  const current = mainRecord([manualOperation()]);
  const extended = mainRecord([manualOperation(), secondManualOperation()]);
  const marker = JSON.stringify({ version: 1, slot: 'a', sequence: 5 });
  const backup = rollingBackup(JSON.stringify(extended), 5);
  const storage = makeStorage({
    main: JSON.stringify(current),
    sessions: 'old-sessions',
    timer: '{}',
    inbox: '[]',
    thoughts: '[]',
    projects: '[]',
    'focus-settings': '{}',
    notifications: '{}',
    'rolling-restore': marker,
    'rolling-a': backup
  });
  const sandbox = makeRestoreSandbox(storage);
  vm.runInContext([
    extractTopLevelSource('_parseRollingRecoveryBackup'),
    extractTopLevelSource('_restoreStorageSnapshot'),
    extractTopLevelSource('_recoverInterruptedRollingRestore')
  ].join('\n'), sandbox);

  assert.equal(sandbox._recoverInterruptedRollingRestore(), true);
  assert.equal(storage.getItem('main'), JSON.stringify(extended));
  assert.equal(storage.getItem('rolling-restore'), null);
  assert.equal(storage.writes.at(-1).key, 'main',
    'the durable operation ledger is committed only after all secondary groups');
  assert.equal(sandbox.baseline, JSON.stringify(extended));
});

test('manual import undo refuses a PRE_IMPORT snapshot that would erase newer credit identities', async () => {
  const current = mainRecord([manualOperation()]);
  const stale = mainRecord([]);
  const previous = JSON.stringify(storageSnapshot(JSON.stringify(stale)));
  const storage = makeStorage({
    main: JSON.stringify(current),
    'pre-import': previous,
    timer: '{}'
  });
  const alerts = [];
  let acceptedPromise = null;
  const sandbox = makeRestoreSandbox(storage, {
    PRE_IMPORT_KEY: 'pre-import',
    FOCUS_TIMER_KEY: 'timer',
    _withStopwatchTransactionLock(callback) {
      return Promise.resolve(callback());
    },
    showConfirmModal(_title, _body, accept) {
      acceptedPromise = Promise.resolve(accept());
    },
    showAlertModal: (...args) => alerts.push(args),
    showToast() {},
    _reloadAfterVerifiedOperation() {},
    _storeRollingRecoveryBackup() { return true; }
  });
  vm.runInContext([
    commonSource(),
    extractTopLevelSource('_restoreStorageSnapshot'),
    extractTopLevelSource('_reloadAfterVerifiedOperation'),
    extractTopLevelSource('undoLastImport')
  ].join('\n'), sandbox);
  makeMainValidator(sandbox);

  sandbox.undoLastImport();
  await acceptedPromise;

  assert.equal(alerts.length, 1);
  assert.match(alerts[0][0], /تعذر التراجع بأمان/);
  assert.equal(storage.getItem('main'), JSON.stringify(current));
  assert.equal(storage.getItem('pre-import'), previous);
  assert.equal(storage.getItem('import'), null,
    'the undo marker is not installed when the history guard rejects the operation');
  assert.deepEqual(storage.writes, []);
});

test('snapshot history comparison fails closed on malformed main records', () => {
  const storage = makeStorage();
  const sandbox = makeRestoreSandbox(storage);
  assert.equal(
    sandbox._creditOperationSnapshotPreservesHistory('{bad-json', JSON.stringify(mainRecord([]))),
    false
  );
  assert.equal(
    sandbox._creditOperationSnapshotPreservesHistory(JSON.stringify(mainRecord([manualOperation()])), '{bad-json'),
    false
  );
});
