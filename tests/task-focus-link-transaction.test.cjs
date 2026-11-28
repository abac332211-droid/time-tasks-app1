'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appScript = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map((match) => match[1]).find((source) => source.includes('APP_VERSION'));
assert.ok(appScript, 'application script exists');

function extract(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(re);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

const sandbox = {
  validateV2(record) {
    return !!record && record.schemaVersion === 2
      && Array.isArray(record.tasks) && record.tasks.length === 1
      && Array.isArray(record.dailyLogs) && Array.isArray(record.creditOperations)
      && record.tasks.every(task => task && Number.isSafeInteger(task.id)
        && typeof task.name === 'string' && ['pending', 'done'].includes(task.status)
        && typeof task.type === 'string' && Number.isFinite(task.expected)
        && typeof task.plannedDate === 'string' && typeof task.plannedTime === 'string'
        && typeof task.createdAt === 'number');
  }
};
vm.createContext(sandbox);
vm.runInContext([
  extract('_taskFocusLinkComparableTask'),
  extract('_taskFocusLinkOtherTasksFingerprint'),
  extract('_isValidTaskFocusLinkTaskSnapshot'),
  extract('_validatePendingTaskFocusLinkMutation'),
  extract('_taskFocusLinkMutationState'),
  extract('_focusCommitDeepEqual')
].join('\n'), sandbox);

const before = {
  id: 7, name: 'مهمة مرتبطة', status: 'pending', type: 'معرفية',
  expected: 25, actual: null, plannedDate: '2026-11-28',
  plannedTime: '', completedAt: null, createdAt: 7
};
const target = { ...before, status: 'done', completedAt: '2026-11-28T10:00:00' };
const other = {
  id: 8, name: 'مهمة أخرى', status: 'pending', type: 'معرفية',
  expected: 25, actual: null, plannedDate: '2026-11-28',
  plannedTime: '', completedAt: null, createdAt: 8
};
const journal = {
  version: 1,
  id: '123e4567-e89b-42d3-a456-426614174000',
  taskId: 7,
  operation: 'complete',
  phase: 'FOCUS_DETACHED',
  beforeTask: before,
  targetTask: target,
  otherTasksFingerprint: JSON.stringify([other]),
  createdAt: 1795860000000,
  updatedAt: 1795860000000
};

test('Task–Focus journal schema validates and rejects corrupt or mismatched records', () => {
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation(journal), true);
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation({ ...journal, phase: 'UNKNOWN' }), false);
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation({ ...journal, otherTasksFingerprint: '{bad' }), false);
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation({
    ...journal, targetTask: { ...target, id: 99 }
  }), false);
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation({
    ...journal, targetTask: { ...target, expected: 'not-a-number' }
  }), false);
});

test('journal classifier distinguishes pre-commit, committed, and conflicting task snapshots', () => {
  const base = { schemaVersion: 2, tasks: [before, other] };
  assert.equal(sandbox._taskFocusLinkMutationState(base, journal), 'before');
  assert.equal(sandbox._taskFocusLinkMutationState({
    ...base, tasks: [target, other]
  }, journal), 'target');
  assert.equal(sandbox._taskFocusLinkMutationState({
    ...base, tasks: [before, { ...other, name: 'تعديل خارجي' }]
  }, journal), 'conflict');
});

test('delete journal identifies an already-applied deletion but not a missing unrelated task', () => {
  const deletion = {
    ...journal,
    operation: 'delete',
    targetTask: null
  };
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation(deletion), true);
  assert.equal(sandbox._taskFocusLinkMutationState({
    schemaVersion: 2, tasks: [other]
  }, deletion), 'target');
  assert.equal(sandbox._taskFocusLinkMutationState({
    schemaVersion: 2, tasks: [{ ...before, name: 'different' }, other]
  }, deletion), 'conflict');
});

test('main source recognizes the transaction journal in both startup and save paths', () => {
  assert.match(appScript, /pendingTaskFocusLinkMutation/);
  assert.match(appScript, /_recoverPendingTaskFocusLinkMutationFromStartup/);
  assert.match(appScript, /_runStorageRecoveryCoordinatorInsideLock/);
  assert.match(appScript, /if \(pendingTaskFocusLink\) v2\.pendingTaskFocusLinkMutation = pendingTaskFocusLink/);
});


function transactionHarness(options = {}) {
  const mainKey = 'timeTasksApp_v1';
  const focusKey = 'timeTasksApp_focusTimer';
  const tasks = [
    { id: 7, name: 'مهمة مرتبطة', status: 'pending', type: 'معرفية',
      expected: 25, actual: null, plannedDate: '2026-11-28',
      plannedTime: '', completedAt: null, createdAt: 7 },
    { id: 8, name: 'مهمة أخرى', status: 'pending', type: 'معرفية',
      expected: 25, actual: null, plannedDate: '2026-11-28',
      plannedTime: '', completedAt: null, createdAt: 8 }
  ];
  const initialData = {
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: {},
    tasks: tasks.map((row) => ({ ...row })),
    dailyLogs: [],
    creditOperations: []
  };
  const values = new Map([
    [mainKey, options.mainRaw || JSON.stringify(initialData)],
    [focusKey, options.focusRaw === undefined
      ? JSON.stringify({ taskId: 7, mode: 'stopwatch', running: false })
      : options.focusRaw]
  ]);
  const sandbox = {
    Date, JSON, Object, Array, Number, String, RegExp, Promise,
    console: { error() {}, warn() {}, log() {} },
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    },
    STORAGE_KEY: mainKey,
    FOCUS_TIMER_KEY: focusKey,
    CURRENT_SCHEMA_VERSION: 2,
    APP_VERSION: '2.9.0',
    storageRecoveryRequired: false,
    _mainStorageBaselineReady: true,
    _mainStorageExternalChangeObserved: false,
    _mainStorageBaselineRaw: values.get(mainKey),
    _secondaryStorageBaselines: Object.create(null),
    _secondaryStorageConflicts: Object.create(null),
    _taskFocusLinkMutationWriteDepth: 0,
    _startupStopwatchRecoveryWriteDepth: 0,
    _startupStopwatchRecoveryFailed: false,
    _stopwatchTransactionLockDepth: 1,
    _focusTimer: { taskId: 7 },
    tasks: tasks.map((row) => ({ ...row })),
    createdByVersion: '2.9.0',
    saveCount: 0,
    _newPendingFocusCommitUuid: () => '123e4567-e89b-42d3-a456-426614174000',
    _isTaskStorageLockHeld: () => true,
    _isFocusCommitBlocked: () => false,
    _hasPersistedPendingStopwatchTransaction: () => false,
    _hasPersistedPendingFocusCommit: () => false,
    _acquireRollingRecoveryCheckpointHold: () => () => {},
    _loadAppSettings: () => {},
    _renderFocusTimer: () => {},
    showAlertModal: () => {},
    _setMainStorageBaseline(raw) {
      sandbox._mainStorageBaselineRaw = raw;
      sandbox._mainStorageBaselineReady = true;
      sandbox._mainStorageExternalChangeObserved = false;
      return true;
    },
    validateV2(record) {
      return !!record && record.schemaVersion === 2
        && Array.isArray(record.tasks) && Array.isArray(record.dailyLogs)
        && Array.isArray(record.creditOperations);
    },
    _writeSecondaryStorageVerified(key, serialized) {
      const current = values.get(key);
      if (Object.prototype.hasOwnProperty.call(sandbox._secondaryStorageBaselines, key)
          && sandbox._secondaryStorageBaselines[key] !== current) return false;
      values.set(key, serialized);
      if (values.get(key) !== serialized) return false;
      sandbox._secondaryStorageBaselines[key] = serialized;
      delete sandbox._secondaryStorageConflicts[key];
      return true;
    },
    _saveFocusTimer() {
      const raw = values.get(focusKey);
      if (raw === undefined) return false;
      let record;
      try { record = JSON.parse(raw); } catch (error) { return false; }
      record.taskId = sandbox._focusTimer.taskId;
      const serialized = JSON.stringify(record);
      values.set(focusKey, serialized);
      sandbox._secondaryStorageBaselines[focusKey] = serialized;
      return values.get(focusKey) === serialized;
    },
    saveData() {
      sandbox.saveCount++;
      if (options.saveFailure === 'before') return false;
      const raw = values.get(mainKey);
      if (!raw) return false;
      const record = JSON.parse(raw);
      record.tasks = sandbox.tasks.map((row) => ({ ...row }));
      const serialized = JSON.stringify(record);
      values.set(mainKey, serialized);
      sandbox._setMainStorageBaseline(serialized);
      return options.saveFailure === 'after' ? false : values.get(mainKey) === serialized;
    }
  };
  vm.createContext(sandbox);
  const names = [
    '_taskFocusLinkComparableTask',
    '_taskFocusLinkOtherTasksFingerprint',
    '_isValidTaskFocusLinkTaskSnapshot',
    '_validatePendingTaskFocusLinkMutation',
    '_taskFocusLinkMutationState',
    '_writeTaskFocusLinkJournal',
    '_setTaskFocusLinkOnDurableTimer',
    '_advanceTaskFocusLinkJournal',
    '_beginTaskFocusLinkMutationDurable',
    '_finishTaskFocusLinkMutationDurable',
    '_recoverPendingTaskFocusLinkMutationFromStartup',
    '_focusCommitDeepEqual'
  ];
  vm.runInContext(names.map(extract).join('\n'), sandbox);
  return {
    sandbox, values, mainKey, focusKey,
    readMain() { return JSON.parse(values.get(mainKey)); },
    readFocus() {
      const raw = values.get(focusKey);
      return raw === undefined ? null : JSON.parse(raw);
    }
  };
}

function makeRecoveryProbe(harness) {
  const mainRaw = harness.values.get(harness.mainKey);
  const mainData = JSON.parse(mainRaw);
  return {
    error: null,
    pending: true,
    blockingMarkers: { reset: false, rollingRestore: false, import: false, migration: false },
    markerValues: { reset: null, rollingRestore: null, import: null, migration: null },
    timerRaw: harness.values.get(harness.focusKey),
    timerObj: harness.readFocus(),
    expectedTx: null,
    expectedFocusCommit: null,
    expectedTaskFocusLink: mainData.pendingTaskFocusLinkMutation,
    bootPersistedGeneration: null,
    mainRaw,
    mainData
  };
}

test('durable completion writes its journal before detaching and clears it after verified commit', () => {
  const h = transactionHarness();
  const original = h.sandbox.tasks.find((row) => row.id === 7);
  const targetRow = { ...original, status: 'done', actual: 18, completedAt: '2026-11-28T10:00:00' };
  const detachment = h.sandbox._beginTaskFocusLinkMutationDurable(7, 'complete', targetRow);

  assert.equal(detachment.ok, true);
  assert.equal(detachment.journal.phase, 'FOCUS_DETACHED');
  assert.equal(h.readMain().pendingTaskFocusLinkMutation.phase, 'FOCUS_DETACHED');
  assert.equal(h.readMain().tasks.find((row) => row.id === 7).status, 'pending');
  assert.equal(h.readFocus().taskId, null);

  Object.assign(original, targetRow);
  assert.equal(h.sandbox.saveData(), true);
  assert.equal(h.sandbox._finishTaskFocusLinkMutationDurable(detachment, true), 'committed');

  const committed = h.readMain();
  assert.equal(committed.tasks.find((row) => row.id === 7).status, 'done');
  assert.equal(Object.hasOwn(committed, 'pendingTaskFocusLinkMutation'), false);
  assert.equal(h.readFocus().taskId, null);
  assert.equal(h.sandbox._taskFocusLinkMutationWriteDepth, 0);
});

test('an ambiguous task write that actually committed returns the verified task snapshot to the caller', () => {
  const h = transactionHarness({ saveFailure: 'after' });
  const task = h.sandbox.tasks.find((row) => row.id === 7);
  const targetRow = { ...task, status: 'done', actual: 18, completedAt: '2026-11-28T10:00:00' };
  const detachment = h.sandbox._beginTaskFocusLinkMutationDurable(7, 'complete', targetRow);
  assert.equal(detachment.ok, true);

  Object.assign(task, targetRow);
  assert.equal(h.sandbox.saveData(), false, 'the simulated writer reports an ambiguous failure after persisting');
  const outcome = h.sandbox._finishTaskFocusLinkMutationDurable(detachment, false);

  assert.equal(outcome, 'committed');
  assert.equal(detachment.committedTasks[0].status, 'done');
  assert.equal(h.readMain().tasks[0].status, 'done');
  assert.equal(Object.hasOwn(h.readMain(), 'pendingTaskFocusLinkMutation'), false);
  assert.equal(h.readFocus().taskId, null);
});

test('startup recovery replays completion after a cold start immediately following Focus detachment', () => {
  const first = transactionHarness();
  const task = first.sandbox.tasks.find((row) => row.id === 7);
  const targetRow = { ...task, status: 'done', actual: 18, completedAt: '2026-11-28T10:00:00' };
  const started = first.sandbox._beginTaskFocusLinkMutationDurable(7, 'complete', targetRow);
  assert.equal(started.ok, true);

  const restarted = transactionHarness({
    mainRaw: first.values.get(first.mainKey),
    focusRaw: first.values.get(first.focusKey)
  });
  restarted.sandbox._focusTimer.taskId = null;
  const probe = makeRecoveryProbe(restarted);
  const result = restarted.sandbox._recoverPendingTaskFocusLinkMutationFromStartup(
    probe.expectedTaskFocusLink, probe, probe
  );

  assert.equal(result.ok, true);
  assert.equal(result.recovered, 'replayed');
  assert.equal(restarted.readMain().tasks.find((row) => row.id === 7).status, 'done');
  assert.equal(restarted.readFocus().taskId, null);
  assert.equal(Object.hasOwn(restarted.readMain(), 'pendingTaskFocusLinkMutation'), false);
  assert.equal(restarted.sandbox.saveCount, 1);
});

test('startup recovery recognizes an already-persisted deletion without repeating the task write', () => {
  const first = transactionHarness();
  const started = first.sandbox._beginTaskFocusLinkMutationDurable(7, 'delete', null);
  assert.equal(started.ok, true);

  const partiallyCommitted = first.readMain();
  partiallyCommitted.tasks = partiallyCommitted.tasks.filter((row) => row.id !== 7);
  first.values.set(first.mainKey, JSON.stringify(partiallyCommitted));

  const restarted = transactionHarness({
    mainRaw: first.values.get(first.mainKey),
    focusRaw: first.values.get(first.focusKey)
  });
  restarted.sandbox._focusTimer.taskId = null;
  const probe = makeRecoveryProbe(restarted);
  const result = restarted.sandbox._recoverPendingTaskFocusLinkMutationFromStartup(
    probe.expectedTaskFocusLink, probe, probe
  );

  assert.equal(result.ok, true);
  assert.equal(result.recovered, 'already_applied');
  assert.equal(restarted.readMain().tasks.some((row) => row.id === 7), false);
  assert.equal(restarted.readFocus().taskId, null);
  assert.equal(Object.hasOwn(restarted.readMain(), 'pendingTaskFocusLinkMutation'), false);
  assert.equal(restarted.sandbox.saveCount, 0);
});

test('startup recovery fails closed when another task changed while the journal was pending', () => {
  const first = transactionHarness();
  const task = first.sandbox.tasks.find((row) => row.id === 7);
  const targetRow = { ...task, status: 'done', completedAt: '2026-11-28T10:00:00' };
  first.sandbox._beginTaskFocusLinkMutationDurable(7, 'complete', targetRow);

  const conflictData = first.readMain();
  conflictData.tasks.find((row) => row.id === 8).name = 'تعديل خارجي';
  const restarted = transactionHarness({
    mainRaw: JSON.stringify(conflictData),
    focusRaw: first.values.get(first.focusKey)
  });
  restarted.sandbox._focusTimer.taskId = null;
  const probe = makeRecoveryProbe(restarted);
  const result = restarted.sandbox._recoverPendingTaskFocusLinkMutationFromStartup(
    probe.expectedTaskFocusLink, probe, probe
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'task_focus_task_snapshot_conflict');
  assert.equal(restarted.sandbox.storageRecoveryRequired, true);
  assert.ok(restarted.readMain().pendingTaskFocusLinkMutation);
  assert.equal(restarted.readFocus().taskId, null);
});

test('startup recovery refuses a missing or malformed Focus timer record', () => {
  const first = transactionHarness();
  const task = first.sandbox.tasks.find((row) => row.id === 7);
  first.sandbox._beginTaskFocusLinkMutationDurable(
    7, 'complete', { ...task, status: 'done', completedAt: '2026-11-28T10:00:00' }
  );

  const restarted = transactionHarness({
    mainRaw: first.values.get(first.mainKey),
    focusRaw: null
  });
  restarted.values.delete(restarted.focusKey);
  restarted.sandbox._focusTimer.taskId = null;
  const probe = makeRecoveryProbe(restarted);
  const result = restarted.sandbox._recoverPendingTaskFocusLinkMutationFromStartup(
    probe.expectedTaskFocusLink, probe, probe
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'task_focus_timer_record_invalid');
  assert.equal(restarted.sandbox.storageRecoveryRequired, true);
  assert.ok(restarted.readMain().pendingTaskFocusLinkMutation);
});
