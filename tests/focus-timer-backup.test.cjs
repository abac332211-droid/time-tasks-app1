'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function loadTopLevelFunction(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `Missing function ${name}`);
  const end = html.indexOf('\n}', start);
  assert.notEqual(end, -1, `Could not find end of function ${name}`);
  return vm.runInNewContext(`(${html.slice(start, end + 2)})`);
}

const buildSnapshot = loadTopLevelFunction('_buildFocusTimerBackupSnapshot');
const validateSnapshot = loadTopLevelFunction('_validateFocusTimerBackupSnapshot');

function timer(overrides = {}) {
  return {
    mode: 'pomodoro',
    phase: 'work',
    running: true,
    baseElapsed: 0,
    startedAt: 1_000,
    cyclePosition: 0,
    taskId: 10,
    sessionStartAt: 1_000,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    ...overrides
  };
}

test('stopwatch export is frozen at elapsed time and cannot auto-resume', () => {
  const snapshot = buildSnapshot(
    timer({ mode: 'stopwatch', baseElapsed: 12 }),
    9_000,
    19,
    Infinity,
    new Set([10])
  );

  assert.equal(snapshot.running, false);
  assert.equal(snapshot.startedAt, null);
  assert.equal(snapshot.baseElapsed, 19);
  assert.equal(snapshot.taskId, 10);
});

test('running Pomodoro export preserves elapsed time as a paused timer', () => {
  const snapshot = buildSnapshot(timer({ baseElapsed: 120 }), 9_000, 420, 1_500, new Set([10]));

  assert.equal(snapshot.running, false);
  assert.equal(snapshot.startedAt, null);
  assert.equal(snapshot.baseElapsed, 420);
  assert.equal(snapshot.awaitingConfirmation, false);
  assert.equal(snapshot.pendingPhaseEndedAt, null);
});

test('completed Pomodoro phase becomes a pending confirmation with its exact end time', () => {
  const snapshot = buildSnapshot(
    timer({ baseElapsed: 1_450, startedAt: 5_000 }),
    60_000,
    1_500,
    1_500,
    new Set([10])
  );

  assert.equal(snapshot.running, false);
  assert.equal(snapshot.startedAt, null);
  assert.equal(snapshot.baseElapsed, 1_500);
  assert.equal(snapshot.awaitingConfirmation, true);
  assert.equal(snapshot.pendingPhaseEndedAt, 55_000);
});

test('snapshot drops a task reference that is absent from the exported tasks', () => {
  const snapshot = buildSnapshot(timer(), 9_000, 300, 1_500, new Set());
  assert.equal(snapshot.taskId, null);
});

test('validator accepts a paused snapshot and rejects auto-running snapshots', () => {
  const paused = buildSnapshot(timer(), 9_000, 300, 1_500, new Set([10]));
  assert.equal(validateSnapshot(paused, new Set([10])).valid, true);

  const running = { ...paused, running: true, startedAt: 9_000 };
  assert.equal(validateSnapshot(running, new Set([10])).valid, false);
});

test('validator rejects an invalid task reference and incomplete pending confirmation', () => {
  const paused = buildSnapshot(timer(), 9_000, 300, 1_500, new Set([10]));
  assert.equal(validateSnapshot(paused, new Set()).valid, false);

  const incomplete = {
    ...paused,
    awaitingConfirmation: true,
    pendingPhaseEndedAt: null
  };
  assert.equal(validateSnapshot(incomplete, new Set([10])).valid, false);
});

test('backup builder includes the paused focus timer and uses backup format v2', () => {
  const sourceStart = html.indexOf('function buildBackupObject(');
  const sourceEnd = html.indexOf('\n}', sourceStart);
  assert.notEqual(sourceStart, -1);
  assert.notEqual(sourceEnd, -1);

  const context = {
    STORAGE_KEY: 'main',
    APP_VERSION: '2.9.0',
    CURRENT_SCHEMA_VERSION: 2,
    BACKUP_FORMAT_VERSION: 2,
    localStorage: {
      getItem(key) {
        return key === 'main'
          ? JSON.stringify({ settings: {}, tasks: [{ id: 10 }], dailyLogs: [] })
          : null;
      }
    },
    buildEmptyV2: () => ({ settings: {}, tasks: [], dailyLogs: [] }),
    localDateTimeString: () => '2026-11-19T18:00:00',
    _loadSessions: () => [],
    _buildFocusTimerBackupSnapshot: buildSnapshot,
    _focusTimer: timer(),
    _getElapsedSec: () => 300,
    _phaseTargetSec: () => 1_500,
    _loadMentalInbox: () => [],
    _loadThoughts: () => [],
    _loadProjects: () => [],
    _getFocusSettingsSnapshot: () => ({ workMin: 25, shortMin: 5, longMin: 15 }),
    _getNotificationsPref: () => ({ enabled: false })
  };
  const buildBackup = vm.runInNewContext(`(${html.slice(sourceStart, sourceEnd + 2)})`, context);
  const backup = buildBackup();

  assert.equal(backup.backupFormatVersion, 2);
  assert.equal(backup.data.focusTimer.running, false);
  assert.equal(backup.data.focusTimer.baseElapsed, 300);
});

test('backup validator is wired to focus-timer validation', () => {
  const sourceStart = html.indexOf('function validateBackup(');
  const sourceEnd = html.indexOf('\n}', sourceStart);
  assert.notEqual(sourceStart, -1);
  assert.notEqual(sourceEnd, -1);

  const context = {
    BACKUP_FORMAT_VERSION: 2,
    CURRENT_SCHEMA_VERSION: 2,
    VALID_STATUS: ['pending'],
    VALID_TYPES: ['معرفية'],
    isValidCalendarDate: () => true,
    isValidLocalTime: () => true,
    isValidLocalDateTime: () => true,
    validateDailyLog: () => true,
    _validateFocusTimerBackupSnapshot: validateSnapshot
  };
  const validateBackup = vm.runInNewContext(`(${html.slice(sourceStart, sourceEnd + 2)})`, context);
  const paused = buildSnapshot(timer(), 9_000, 300, 1_500, new Set([10]));
  const valid = {
    backupFormatVersion: 2,
    schemaVersion: 2,
    data: { tasks: [{ id: 10, name: 'مهمة اختبار', status: 'pending', type: 'معرفية', expected: 10, actual: null, plannedDate: '2026-11-19', plannedTime: '09:00', completedAt: null }], dailyLogs: [], focusTimer: paused }
  };
  const invalid = {
    ...valid,
    data: { ...valid.data, focusTimer: { ...paused, running: true, startedAt: 9_000 } }
  };

  assert.equal(validateBackup(valid).valid, true);
  assert.equal(validateBackup(invalid).valid, false);
});

test('legacy format-v1 backup without focusTimer remains import-compatible', () => {
  const sourceStart = html.indexOf('function validateBackup(');
  const sourceEnd = html.indexOf('\n}', sourceStart);
  const context = {
    BACKUP_FORMAT_VERSION: 2,
    CURRENT_SCHEMA_VERSION: 2,
    VALID_STATUS: [],
    VALID_TYPES: [],
    isValidCalendarDate: () => true,
    isValidLocalTime: () => true,
    isValidLocalDateTime: () => true,
    validateDailyLog: () => true,
    _validateFocusTimerBackupSnapshot: validateSnapshot
  };
  const validateBackup = vm.runInNewContext(`(${html.slice(sourceStart, sourceEnd + 2)})`, context);
  const legacy = {
    backupFormatVersion: 1,
    schemaVersion: 2,
    data: { tasks: [], dailyLogs: [] }
  };

  assert.equal(validateBackup(legacy).valid, true);
});

test('restored pending Pomodoro confirmation is presented after initialization', () => {
  const normalizedHtml = html.replace(/\r\n/g, '\n');
  const initTimer = normalizedHtml.lastIndexOf('_renderFocusTimer();');
  const pendingPrompt = normalizedHtml.indexOf(
    'if (_focusTimer.awaitingConfirmation) {\n  setTimeout(function() { _showAwaySessionConfirmation(); }, 300);\n}',
    initTimer
  );
  assert.notEqual(initTimer, -1);
  assert.ok(pendingPrompt > initTimer);
});


function extractTopLevelSource(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `Missing function ${name}`);
  const end = html.indexOf('\n}', start);
  assert.notEqual(end, -1, `Could not find end of function ${name}`);
  return html.slice(start, end + 2);
}

function memoryStorage(seed = {}, faults = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) {
      if (faults.mismatchReadKey === key) return '__readback_mismatch__';
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (faults.throwOnSetKey === key) throw new Error('simulated quota/write failure');
      values.set(key, String(value));
    },
    removeItem(key) {
      if (faults.throwOnRemoveKey === key) throw new Error('simulated remove failure');
      values.delete(key);
    },
    values
  };
}

function storageSnapshot(prefix) {
  return {
    main: prefix + '-main',
    focusSessions: prefix + '-sessions',
    focusTimer: prefix + '-timer',
    mentalInbox: prefix + '-inbox',
    thoughts: prefix + '-thoughts',
    projects: prefix + '-projects',
    focusSettings: prefix + '-settings',
    notifications: prefix + '-notifications'
  };
}

function restoreContext(storage) {
  let invalidations = 0;
  const context = {
    localStorage: storage,
    STORAGE_KEY: 'app-main',
    THOUGHTS_KEY: 'app-thoughts',
    PROJECTS_KEY: 'app-projects',
    FOCUS_SETTINGS_KEY: 'app-focus-settings',
    NOTIFICATIONS_KEY: 'app-notifications',
    IMPORT_IN_PROGRESS_KEY: 'app-import-marker',
    PRE_IMPORT_KEY: 'app-pre-import',
    validateV2: () => true,
    _invalidateProjectsCache: () => { invalidations++; }
  };
  return {
    context,
    invalidationCount: () => invalidations
  };
}

test('rollback snapshot restores and reads back the focus timer with every other key', () => {
  const storage = memoryStorage({
    'app-main': 'new-main',
    'timeTasksApp_focusSessions': 'new-sessions',
    'timeTasksApp_focusTimer': 'new-timer',
    'timeTasksApp_mentalInbox': 'new-inbox',
    'app-thoughts': 'new-thoughts',
    'app-projects': 'new-projects',
    'app-focus-settings': 'new-settings',
    'app-notifications': 'new-notifications'
  });
  const harness = restoreContext(storage);
  const restore = vm.runInNewContext(
    '(' + extractTopLevelSource('_restoreStorageSnapshot') + ')',
    harness.context
  );
  const snapshot = storageSnapshot('previous');

  assert.equal(restore(snapshot), true);
  assert.equal(storage.getItem('timeTasksApp_focusTimer'), 'previous-timer');
  assert.equal(storage.getItem('app-main'), 'previous-main');
  assert.equal(storage.getItem('timeTasksApp_focusSessions'), 'previous-sessions');
  assert.equal(storage.getItem('timeTasksApp_mentalInbox'), 'previous-inbox');
  assert.equal(storage.getItem('app-thoughts'), 'previous-thoughts');
  assert.equal(storage.getItem('app-projects'), 'previous-projects');
  assert.equal(storage.getItem('app-focus-settings'), 'previous-settings');
  assert.equal(storage.getItem('app-notifications'), 'previous-notifications');
  assert.equal(harness.invalidationCount(), 1);
});

test('rollback reports failure when focus-timer storage write or read-back fails', () => {
  const snapshot = storageSnapshot('previous');
  const failedWrite = memoryStorage({}, { throwOnSetKey: 'timeTasksApp_focusTimer' });
  const writeHarness = restoreContext(failedWrite);
  const restoreAfterWriteFailure = vm.runInNewContext(
    '(' + extractTopLevelSource('_restoreStorageSnapshot') + ')',
    writeHarness.context
  );
  assert.equal(restoreAfterWriteFailure(snapshot), false);

  const failedReadback = memoryStorage({}, { mismatchReadKey: 'timeTasksApp_focusTimer' });
  const readHarness = restoreContext(failedReadback);
  const restoreAfterReadbackFailure = vm.runInNewContext(
    '(' + extractTopLevelSource('_restoreStorageSnapshot') + ')',
    readHarness.context
  );
  assert.equal(restoreAfterReadbackFailure(snapshot), false);
});

test('interrupted import recovery restores the previous timer and clears both markers', () => {
  const previous = storageSnapshot('previous');
  previous.main = JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [] });
  const storage = memoryStorage({
    'app-import-marker': '1',
    'app-pre-import': JSON.stringify(previous),
    'app-main': 'partially-imported-main',
    'timeTasksApp_focusSessions': 'partially-imported-sessions',
    'timeTasksApp_focusTimer': 'partially-imported-timer',
    'timeTasksApp_mentalInbox': 'partially-imported-inbox',
    'app-thoughts': 'partially-imported-thoughts',
    'app-projects': 'partially-imported-projects',
    'app-focus-settings': 'partially-imported-settings',
    'app-notifications': 'partially-imported-notifications'
  });
  const harness = restoreContext(storage);
  const recovery = vm.runInNewContext(
    extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
    extractTopLevelSource('_recoverInterruptedImport') + '\n_recoverInterruptedImport',
    harness.context
  );

  assert.equal(recovery(), true);
  assert.equal(storage.getItem('timeTasksApp_focusTimer'), 'previous-timer');
  assert.equal(storage.getItem('app-main'), previous.main);
  assert.equal(storage.getItem('app-import-marker'), null);
  assert.equal(storage.getItem('app-pre-import'), null);
  assert.equal(harness.invalidationCount(), 1);
});

test('interrupted import keeps its recovery marker when the saved snapshot is missing', () => {
  const storage = memoryStorage({ 'app-import-marker': '1' });
  const harness = restoreContext(storage);
  const recovery = vm.runInNewContext(
    extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
    extractTopLevelSource('_recoverInterruptedImport') + '\n_recoverInterruptedImport',
    harness.context
  );

  assert.equal(recovery(), false);
  assert.equal(storage.getItem('app-import-marker'), '1');
});


function loadTimerContext(snapshot, taskRows = [{ id: 10 }]) {
  const saved = snapshot ? JSON.stringify(snapshot) : null;
  const values = new Map(saved === null ? [] : [['timer-key', saved]]);
  const state = {
    mode: 'pomodoro',
    phase: 'work',
    running: false,
    baseElapsed: 0,
    startedAt: null,
    cyclePosition: 0,
    taskId: null,
    sessionStartAt: null,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null
  };
  let savedAfterLoad = null;
  const context = {
    FOCUS_TIMER_KEY: 'timer-key',
    localStorage: {
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        values.set(key, String(value));
        savedAfterLoad = String(value);
      }
    },
    _focusTimer: state,
    tasks: taskRows,
    _saveFocusTimer() {
      values.set('timer-key', JSON.stringify(state));
      savedAfterLoad = values.get('timer-key');
      return true;
    }
  };
  return { context, state, savedValue: () => savedAfterLoad };
}

test('timer loader restores a backed-up Pomodoro snapshot in paused state', () => {
  const snapshot = buildSnapshot(
    timer({ baseElapsed: 120 }),
    9_000,
    420,
    1_500,
    new Set([10])
  );
  const harness = loadTimerContext(snapshot);
  const loadTimer = vm.runInNewContext(
    '(' + loadTopLevelFunction('_loadFocusTimer') + ')',
    harness.context
  );

  loadTimer();

  assert.equal(harness.state.mode, 'pomodoro');
  assert.equal(harness.state.phase, 'work');
  assert.equal(harness.state.running, false);
  assert.equal(harness.state.startedAt, null);
  assert.equal(harness.state.baseElapsed, 420);
  assert.equal(harness.state.taskId, 10);
});

test('timer loader preserves an ended Pomodoro phase pending user confirmation', () => {
  const snapshot = buildSnapshot(
    timer({ baseElapsed: 1_450, startedAt: 5_000 }),
    60_000,
    1_500,
    1_500,
    new Set([10])
  );
  const harness = loadTimerContext(snapshot);
  const loadTimer = vm.runInNewContext(
    '(' + loadTopLevelFunction('_loadFocusTimer') + ')',
    harness.context
  );

  loadTimer();

  assert.equal(harness.state.running, false);
  assert.equal(harness.state.startedAt, null);
  assert.equal(harness.state.baseElapsed, 1_500);
  assert.equal(harness.state.awaitingConfirmation, true);
  assert.equal(harness.state.pendingPhaseEndedAt, 55_000);
  assert.equal(harness.state.taskId, 10);
});


test('paused stopwatch backup rehydrates from storage without restarting', () => {
  const saved = buildSnapshot(
    timer({ mode: 'stopwatch', phase: 'work', baseElapsed: 2_400 }),
    90_000,
    2_400,
    Infinity,
    new Set()
  );
  const storage = memoryStorage({ focusTimer: JSON.stringify(saved) });
  const state = {
    mode: 'pomodoro',
    phase: 'work',
    running: false,
    baseElapsed: 0,
    startedAt: null,
    cyclePosition: 0,
    taskId: null,
    sessionStartAt: null,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null
  };
  let writes = 0;
  const context = {
    FOCUS_TIMER_KEY: 'focusTimer',
    localStorage: storage,
    tasks: [],
    _focusTimer: state,
    _saveFocusTimer() { writes++; return true; }
  };
  const load = vm.runInNewContext(
    '(' + extractTopLevelSource('_loadFocusTimer') + ')',
    context
  );

  load();

  assert.equal(state.mode, 'stopwatch');
  assert.equal(state.running, false);
  assert.equal(state.startedAt, null);
  assert.equal(state.baseElapsed, 2_400);
  assert.equal(writes, 0);
});

test('pending Pomodoro confirmation survives timer rehydration without auto-resuming', () => {
  const saved = buildSnapshot(
    timer({
      mode: 'pomodoro',
      phase: 'work',
      baseElapsed: 1_500,
      running: false,
      awaitingConfirmation: true,
      pendingPhaseEndedAt: 55_000
    }),
    60_000,
    1_500,
    1_500,
    new Set([10])
  );
  const storage = memoryStorage({ focusTimer: JSON.stringify(saved) });
  const state = {
    mode: 'stopwatch',
    phase: 'short-break',
    running: false,
    baseElapsed: 0,
    startedAt: null,
    cyclePosition: 0,
    taskId: null,
    sessionStartAt: null,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null
  };
  const context = {
    FOCUS_TIMER_KEY: 'focusTimer',
    localStorage: storage,
    tasks: [{ id: 10 }],
    _focusTimer: state,
    _saveFocusTimer() { return true; }
  };
  const load = vm.runInNewContext(
    '(' + extractTopLevelSource('_loadFocusTimer') + ')',
    context
  );

  load();

  assert.equal(state.mode, 'pomodoro');
  assert.equal(state.phase, 'work');
  assert.equal(state.running, false);
  assert.equal(state.startedAt, null);
  assert.equal(state.baseElapsed, 1_500);
  assert.equal(state.awaitingConfirmation, true);
  assert.equal(state.pendingPhaseEndedAt, 55_000);
  assert.equal(state.taskId, 10);
});

test('timer rehydration removes a reference to a task absent from restored tasks', () => {
  const saved = buildSnapshot(timer({ running: false, startedAt: null }), 90_000, 300, 1_500, new Set([10]));
  const storage = memoryStorage({ focusTimer: JSON.stringify(saved) });
  const state = {
    mode: 'pomodoro',
    phase: 'work',
    running: false,
    baseElapsed: 0,
    startedAt: null,
    cyclePosition: 0,
    taskId: null,
    sessionStartAt: null,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null
  };
  let savedState = null;
  const context = {
    FOCUS_TIMER_KEY: 'focusTimer',
    localStorage: storage,
    tasks: [],
    _focusTimer: state,
    _saveFocusTimer() {
      savedState = JSON.parse(storage.getItem('focusTimer'));
      return true;
    }
  };
  const load = vm.runInNewContext(
    '(' + extractTopLevelSource('_loadFocusTimer') + ')',
    context
  );

  load();

  assert.equal(state.taskId, null);
  assert.equal(savedState.taskId, null);
  assert.equal(state.running, false);
});
