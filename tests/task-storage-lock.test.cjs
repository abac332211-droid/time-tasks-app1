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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(options = {}) {
  const alerts = [];
  const toasts = [];
  const requests = [];
  const gate = options.gate || null;
  const lockRequest = options.lockRequest || ((name, lockOptions, callback) => {
    requests.push({ name, lockOptions });
    return Promise.resolve().then(() => callback({ name, mode: lockOptions.mode }));
  });
  const sandbox = {
    Promise,
    console: { error() {}, warn() {} },
    showToast: (...args) => toasts.push(args),
    showAlertModal: (...args) => alerts.push(args),
    storageRecoveryRequired: false,
    _startupStopwatchRecoveryInFlight: false,
    _startupStopwatchRecoveryFailed: false,
    _startupResetRecoveryInFlight: false,
    _resetRecoveryInFlight: false,
    _resetInFlight: false,
    _mainStorageExternalChangeObserved: false,
    _stopwatchTransactionLockDepth: 0,
    _taskStorageWriteInFlight: false,
    _isFocusCommitBlocked: () => false,
    navigator: {
      locks: {
        request(name, lockOptions, callback) {
          requests.push({ name, lockOptions });
          if (options.unavailable) return Promise.reject(new Error('Web Locks unavailable'));
          if (options.lockRequest) return options.lockRequest(name, lockOptions, callback);
          return (gate ? gate.promise : Promise.resolve()).then(() => callback({ name, mode: lockOptions.mode }));
        }
      }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction('_isTaskStorageLockHeld'),
    extractFunction('_withStopwatchTransactionLock'),
    extractFunction('_withTaskStorageLock'),
    extractFunction('_isTaskWriteBlocked')
  ].join('\n'), sandbox);

  return { sandbox, alerts, toasts, requests };
}

test('task mutation waits for the existing exclusive Stopwatch Web Lock before running', async () => {
  const gate = deferred();
  const h = createHarness({ gate });
  let mutations = 0;

  const pending = h.sandbox._withTaskStorageLock(() => {
    mutations++;
    assert.equal(h.sandbox._stopwatchTransactionLockDepth, 1);
    assert.equal(h.sandbox._isTaskStorageLockHeld(), true);
    return true;
  });

  assert.equal(mutations, 0, 'mutation must not run while lock acquisition is pending');
  assert.equal(h.sandbox._isTaskWriteBlocked(), true, 'other task writers remain blocked while waiting');
  assert.equal(h.sandbox._taskStorageWriteInFlight, true);

  gate.resolve();
  assert.equal(await pending, true);
  assert.equal(mutations, 1);
  assert.equal(h.sandbox._stopwatchTransactionLockDepth, 0, 'page-local lock ownership is released');
  assert.equal(h.sandbox._taskStorageWriteInFlight, false, 'same-tab writer guard is released');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].name, 'timeTasksApp-stopwatch-transaction');
  assert.equal(h.requests[0].lockOptions.mode, 'exclusive');
});

test('a second same-tab task write fails closed while the first is waiting for the shared lock', async () => {
  const gate = deferred();
  const h = createHarness({ gate });
  let firstMutations = 0;
  let secondMutations = 0;

  const first = h.sandbox._withTaskStorageLock(() => { firstMutations++; return true; });
  const second = await h.sandbox._withTaskStorageLock(() => { secondMutations++; return true; });

  assert.equal(second, false);
  assert.equal(firstMutations, 0);
  assert.equal(secondMutations, 0);
  assert.equal(h.toasts.length, 1);

  gate.resolve();
  assert.equal(await first, true);
  assert.equal(firstMutations, 1);
  assert.equal(secondMutations, 0);
  assert.equal(h.sandbox._taskStorageWriteInFlight, false);
});

test('nested task writer reuses existing lock ownership without requesting a second Web Lock', async () => {
  const h = createHarness();
  let innerRuns = 0;

  const result = await h.sandbox._withTaskStorageLock(() => {
    assert.equal(h.sandbox._stopwatchTransactionLockDepth, 1);
    return h.sandbox._withTaskStorageLock(() => {
      innerRuns++;
      assert.equal(h.sandbox._stopwatchTransactionLockDepth, 1);
      return true;
    });
  });

  assert.equal(result, true);
  assert.equal(innerRuns, 1);
  assert.equal(h.requests.length, 1, 'nested writes must not deadlock by reacquiring the non-reentrant Web Lock');
  assert.equal(h.sandbox._stopwatchTransactionLockDepth, 0);
});

test('task mutation is not run when Web Locks is unavailable', async () => {
  const h = createHarness({ unavailable: true });
  let mutations = 0;

  const result = await h.sandbox._withTaskStorageLock(() => { mutations++; return true; });

  assert.equal(result, false);
  assert.equal(mutations, 0);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0][0], /تعذر تأمين حفظ المهام/);
  assert.equal(h.sandbox._stopwatchTransactionLockDepth, 0);
  assert.equal(h.sandbox._taskStorageWriteInFlight, false);
});

test('task mutation failure releases both lock ownership and same-tab writer guard', async () => {
  const h = createHarness();
  const result = await h.sandbox._withTaskStorageLock(() => {
    throw new Error('simulated task writer failure');
  });

  assert.equal(result, false);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.sandbox._stopwatchTransactionLockDepth, 0);
  assert.equal(h.sandbox._taskStorageWriteInFlight, false);
});

test('saveData refuses a direct write unless the shared transaction lock is already held', () => {
  const alerts = [];
  const errors = [];
  const sandbox = {
    _isTaskStorageLockHeld: () => false,
    showAlertModal: (...args) => alerts.push(args),
    console: { error: (...args) => errors.push(args) }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('saveData'), sandbox);

  assert.equal(sandbox.saveData(), false);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][0], /حفظ غير محمي/);
  assert.equal(errors.length, 1);
});


function createCreditLedgerSaveHarness(taskOverrides = {}) {
  const operationId = '123e4567-e89b-42d3-a456-426614174000';
  const operation = {
    recordVersion: 1,
    operationId,
    kind: 'session',
    taskId: 7,
    revision: 1,
    previousSeconds: null,
    targetSeconds: 120,
    measuredSeconds: 120,
    creditedSeconds: 120,
    source: 'measured',
    sessionId: operationId,
    createdAt: '2026-11-26T10:00:00.000Z'
  };
  const task = {
    id: 7,
    name: 'مهمة رصيد',
    status: 'pending',
    type: 'معرفية',
    expected: 30,
    actual: 2,
    plannedDate: '2026-11-26',
    plannedTime: '',
    completedAt: null,
    createdAt: 1,
    actualSeconds: 120,
    creditRevision: 1,
    creditSchemaVersion: 1,
    lastCreditOperationId: operationId
  };
  const inMemoryTask = { ...task, ...taskOverrides };
  const initialMain = {
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: { firstUseDate: '2026-11-26', operationalDayStart: 4 },
    tasks: [{ ...task }],
    dailyLogs: [],
    creditOperations: [operation]
  };
  const initialRaw = JSON.stringify(initialMain);
  const values = new Map([['main', initialRaw]]);
  const writes = [];
  const alerts = [];
  const sandbox = {
    STORAGE_KEY: 'main',
    CURRENT_SCHEMA_VERSION: 2,
    APP_VERSION: '2.9.0',
    IMPORT_IN_PROGRESS_KEY: 'import-pending',
    MIGRATION_IN_PROGRESS_KEY: 'migration-pending',
    RESET_IN_PROGRESS_KEY: 'reset-pending',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore-pending',
    storageRecoveryRequired: false,
    _mainStorageBaselineRaw: initialRaw,
    _mainStorageBaselineReady: true,
    _mainStorageExternalChangeObserved: false,
    tasks: [{ ...inMemoryTask }],
    appSettings: {
      firstUseDate: '2026-11-26',
      operationalDayStart: 4,
      darkMode: false,
      themeMode: 'light',
      lastTaskId: 7,
      lastRecurringDates: {}
    },
    localStorage: {
      getItem(key) {
        const normalized = String(key);
        return values.has(normalized) ? values.get(normalized) : null;
      },
      setItem(key, value) {
        writes.push({ key: String(key), value: String(value) });
        values.set(String(key), String(value));
      }
    },
    _isTaskStorageLockHeld: () => true,
    _isFocusCommitBlocked: () => false,
    _pendingStopwatchWriteAllowed: () => true,
    _pruneLastRecurringDates() {},
    todayStr: () => '2026-11-26',
    _setMainStorageBaseline(raw) {
      sandbox._mainStorageBaselineRaw = raw;
      sandbox._mainStorageBaselineReady = true;
    },
    _queueAllTaskReminderSync() {},
    _storeRollingRecoveryBackup: () => true,
    showAlertModal: (...args) => alerts.push(args),
    console: { error() {}, warn() {} }
  };

  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction('_validateTaskCreditFields'),
    extractFunction('_validateCreditOperationRecord'),
    extractFunction('_validateCreditOperationLedger'),
    extractFunction('_creditOperationLedgerPreservesHistory'),
    extractFunction('saveData')
  ].join('\n'), sandbox);
  sandbox.validateV2 = function(data) {
    return !!data
      && data.schemaVersion === 2
      && Array.isArray(data.tasks)
      && Array.isArray(data.dailyLogs)
      && Array.isArray(data.creditOperations)
      && sandbox._validateCreditOperationLedger(data.creditOperations, data.tasks);
  };

  return { sandbox, values, writes, alerts, operation };
}

test('ordinary task save preserves the durable credit operation ledger under the shared lock', () => {
  const h = createCreditLedgerSaveHarness();
  h.sandbox.tasks[0].name = 'مهمة بعد تعديل عادي';

  assert.equal(h.sandbox.saveData(), true);
  assert.equal(h.writes.length, 1, 'only the primary task record is written');
  const saved = JSON.parse(h.values.get('main'));
  assert.equal(saved.tasks[0].name, 'مهمة بعد تعديل عادي');
  assert.deepEqual(saved.creditOperations, [h.operation],
    'an unrelated task edit must not discard accepted operation identities');
  assert.equal(saved.tasks[0].actualSeconds, 120);
  assert.equal(saved.tasks[0].creditRevision, 1);
  assert.equal(saved.tasks[0].lastCreditOperationId, h.operation.operationId);
  assert.equal(h.sandbox._mainStorageBaselineRaw, h.values.get('main'));
});

test('ordinary task save rejects a balance that no longer matches its durable operation ledger', () => {
  const h = createCreditLedgerSaveHarness({
    actualSeconds: 121,
    actual: 2
  });

  assert.equal(h.sandbox.saveData(), false);
  assert.deepEqual(h.writes, [],
    'a task balance inconsistent with the latest durable operation must not be written');
  assert.equal(JSON.parse(h.values.get('main')).tasks[0].actualSeconds, 120,
    'the previously stored balance remains untouched');
  assert.ok(h.alerts.length > 0, 'the rejected save is reported');
});


function createTaskFocusMutationHarness(options = {}) {
  const mainKey = 'timeTasksApp_v1';
  const focusKey = 'timeTasksApp_focusTimer';
  const task = {
    id: 31,
    name: 'مهمة مرتبطة بالمؤقت',
    status: 'pending',
    actual: 25,
    expected: 30,
    completedAt: null,
    plannedDate: '2026-11-28'
  };
  const focusRecord = { taskId: 31, running: false, baseElapsed: 900 };
  const mainRaw = JSON.stringify({ tasks: [task] });
  const values = new Map([
    [mainKey, mainRaw],
    [focusKey, JSON.stringify(focusRecord)]
  ]);
  const writes = [];
  const alerts = [];
  const toasts = [];
  const prompts = [];
  const confirmations = [];
  let focusWriteCount = 0;

  const sandbox = {
    STORAGE_KEY: mainKey,
    FOCUS_TIMER_KEY: focusKey,
    tasks: [task],
    _focusTimer: { ...focusRecord },
    storageRecoveryRequired: false,
    _mainStorageBaselineReady: true,
    _mainStorageExternalChangeObserved: false,
    editingId: null,
    _isTaskStorageLockHeld: () => true,
    _withTaskStorageLock: callback => callback(),
    _isTaskWriteBlocked: () => false,
    _isFocusCommitBlocked: () => false,
    isTaskCancelled: () => false,
    localDateTimeString: () => '2026-11-28T12:00:00',
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); }
    },
    _saveFocusTimer() {
      focusWriteCount++;
      writes.push('focus');
      if (Array.isArray(options.failFocusWrites)
          && options.failFocusWrites.includes(focusWriteCount)) return false;
      values.set(focusKey, JSON.stringify(sandbox._focusTimer));
      if (Array.isArray(options.failFocusWritesAfterPersist)
          && options.failFocusWritesAfterPersist.includes(focusWriteCount)) return false;
      return true;
    },
    saveData() {
      writes.push('main');
      if (options.mainFailure === 'before') return false;
      values.set(mainKey, JSON.stringify({
        tasks: sandbox.tasks.map(item => ({ ...item }))
      }));
      if (options.mainFailure === 'after') {
        sandbox.storageRecoveryRequired = true;
        return false;
      }
      return true;
    },
    showPromptModal(...args) { prompts.push(args); },
    showConfirmModal(...args) { confirmations.push(args); },
    showAlertModal(...args) { alerts.push(args); },
    showToast(...args) { toasts.push(args); },
    renderAll() {},
    _renderFocusTimer() {},
    cancelEdit() {}
  };

  vm.createContext(sandbox);
  const helpers = [
    'function _beginTaskFocusLinkMutation(taskId) {',
    '  if (!_focusTimer || _focusTimer.taskId !== taskId) return { ok: true, linked: false };',
    '  var previousTaskId = _focusTimer.taskId;',
    '  var previousMainRaw = localStorage.getItem(STORAGE_KEY);',
    '  _focusTimer.taskId = null;',
    '  if (!_saveFocusTimer()) {',
    '    try {',
    '      var raw = localStorage.getItem(FOCUS_TIMER_KEY);',
    '      var persisted = raw === null ? null : JSON.parse(raw);',
    '      if (persisted && persisted.taskId === taskId) _focusTimer.taskId = taskId;',
    '      else storageRecoveryRequired = true;',
    '    } catch (error) { storageRecoveryRequired = true; }',
    '    return { ok: false, linked: true };',
    '  }',
    '  return { ok: true, linked: true, previousTaskId, previousMainRaw };',
    '}',
    'function _finishTaskFocusLinkMutation(detachment, taskSaveSucceeded) {',
    '  if (!detachment || !detachment.linked) return true;',
    '  if (taskSaveSucceeded === true) return "committed";',
    '  var rawMain = localStorage.getItem(STORAGE_KEY);',
    '  if (rawMain !== detachment.previousMainRaw) {',
    '    try {',
    '      var committed = JSON.parse(rawMain);',
    '      if (committed && Array.isArray(committed.tasks)',
    '          && committed.tasks.some(function(task) { return task.id === detachment.previousTaskId && task.status === "done"; })) {',
    '        detachment.committedTasks = committed.tasks;',
    '        return "committed";',
    '      }',
    '    } catch (error) {}',
    '    storageRecoveryRequired = true; return false;',
    '  }',
    '  _focusTimer.taskId = detachment.previousTaskId;',
    '  if (!_saveFocusTimer()) {',
    '    try {',
    '      var raw = localStorage.getItem(FOCUS_TIMER_KEY);',
    '      var persisted = raw === null ? null : JSON.parse(raw);',
    '      _focusTimer.taskId = persisted && Number.isSafeInteger(persisted.taskId) ? persisted.taskId : null;',
    '    } catch (error) { _focusTimer.taskId = null; }',
    '    storageRecoveryRequired = true; return false;',
    '  }',
    '  return "rolled_back";',
    '}'
  ].join('\n');
  vm.runInContext([
    helpers,
    extractFunction('toggleTask'),
    extractFunction('deleteTask')
  ].join('\n'), sandbox);

  return { sandbox, values, writes, alerts, toasts, prompts, confirmations, mainRaw };
}

test('linked task completion detaches and verifies Focus before committing task status', () => {
  const h = createTaskFocusMutationHarness();
  h.sandbox.toggleTask(31);
  assert.equal(h.prompts.length, 1);
  const result = h.prompts[0][4]('40');

  assert.equal(result, true);
  assert.deepEqual(h.writes, ['focus', 'main'],
    'the durable Focus detachment must precede the task status write');
  const persistedMain = JSON.parse(h.values.get('timeTasksApp_v1'));
  const persistedFocus = JSON.parse(h.values.get('timeTasksApp_focusTimer'));
  assert.equal(persistedMain.tasks[0].status, 'done');
  assert.equal(persistedMain.tasks[0].actual, 40);
  assert.equal(persistedFocus.taskId, null);
  assert.equal(h.sandbox._focusTimer.taskId, null);
});

test('failed Focus detachment prevents linked task completion and deletion', () => {
  const completion = createTaskFocusMutationHarness({ failFocusWrites: [1] });
  completion.sandbox.toggleTask(31);
  const completionResult = completion.prompts[0][4]('40');

  assert.equal(completionResult, false);
  assert.deepEqual(completion.writes, ['focus']);
  assert.equal(completion.values.get('timeTasksApp_v1'), completion.mainRaw);
  assert.equal(JSON.parse(completion.values.get('timeTasksApp_focusTimer')).taskId, 31);
  assert.equal(completion.sandbox.tasks[0].status, 'pending');

  const deletion = createTaskFocusMutationHarness({ failFocusWrites: [1] });
  deletion.sandbox.deleteTask(31);
  const deletionResult = deletion.confirmations[0][2]();

  assert.equal(deletionResult, false);
  assert.deepEqual(deletion.writes, ['focus']);
  assert.equal(deletion.values.get('timeTasksApp_v1'), deletion.mainRaw);
  assert.equal(JSON.parse(deletion.values.get('timeTasksApp_focusTimer')).taskId, 31);
  assert.equal(deletion.sandbox.tasks.length, 1);
});

test('task save failure restores the Focus link only when the main record is unchanged', () => {
  const h = createTaskFocusMutationHarness({ mainFailure: 'before' });
  h.sandbox.toggleTask(31);
  const result = h.prompts[0][4]('40');

  assert.equal(result, false);
  assert.deepEqual(h.writes, ['focus', 'main', 'focus']);
  assert.equal(h.values.get('timeTasksApp_v1'), h.mainRaw);
  assert.equal(JSON.parse(h.values.get('timeTasksApp_focusTimer')).taskId, 31);
  assert.equal(h.sandbox._focusTimer.taskId, 31);
  assert.equal(h.sandbox.tasks[0].status, 'pending');
});

test('ambiguous main write failure keeps Focus detached and blocks further writes', () => {
  const h = createTaskFocusMutationHarness({ mainFailure: 'after' });
  h.sandbox.toggleTask(31);
  const result = h.prompts[0][4]('40');

  assert.equal(result, true,
    'the transaction finalizer must report the durable committed state, not the initial ambiguous save result');
  assert.deepEqual(h.writes, ['focus', 'main']);
  assert.equal(JSON.parse(h.values.get('timeTasksApp_v1')).tasks[0].status, 'done');
  assert.equal(JSON.parse(h.values.get('timeTasksApp_focusTimer')).taskId, null);
  assert.equal(h.sandbox._focusTimer.taskId, null);
  assert.equal(h.sandbox.storageRecoveryRequired, false);
});

test('failed Focus-link rollback leaves the verified detached state and blocks writes', () => {
  const h = createTaskFocusMutationHarness({
    mainFailure: 'before',
    failFocusWrites: [2]
  });
  h.sandbox.toggleTask(31);
  const result = h.prompts[0][4]('40');

  assert.equal(result, false);
  assert.deepEqual(h.writes, ['focus', 'main', 'focus']);
  assert.equal(h.values.get('timeTasksApp_v1'), h.mainRaw);
  assert.equal(JSON.parse(h.values.get('timeTasksApp_focusTimer')).taskId, null);
  assert.equal(h.sandbox._focusTimer.taskId, null);
  assert.equal(h.sandbox.storageRecoveryRequired, true);
});


test('Focus write that persists but fails verification blocks the task mutation', () => {
  const h = createTaskFocusMutationHarness({ failFocusWritesAfterPersist: [1] });
  h.sandbox.toggleTask(31);
  const result = h.prompts[0][4]('40');

  assert.equal(result, false);
  assert.deepEqual(h.writes, ['focus']);
  assert.equal(h.values.get('timeTasksApp_v1'), h.mainRaw);
  assert.equal(JSON.parse(h.values.get('timeTasksApp_focusTimer')).taskId, null);
  assert.equal(h.sandbox._focusTimer.taskId, null);
  assert.equal(h.sandbox.tasks[0].status, 'pending');
  assert.equal(h.sandbox.storageRecoveryRequired, true);
});
