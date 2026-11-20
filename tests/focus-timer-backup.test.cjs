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

test('validator rejects a pending phase end before its session start', () => {
  const pending = buildSnapshot(
    timer({
      mode: 'pomodoro',
      phase: 'work',
      baseElapsed: 1_500,
      running: false,
      startedAt: null,
      awaitingConfirmation: true,
      pendingPhaseEndedAt: 55_000
    }),
    60_000,
    1_500,
    1_500,
    new Set([10])
  );
  const invalid = { ...pending, pendingPhaseEndedAt: pending.sessionStartAt - 1 };

  assert.equal(validateSnapshot(pending, new Set([10])).valid, true);
  assert.equal(validateSnapshot(invalid, new Set([10])).valid, false);
});

test('backup builder includes the paused focus timer and uses backup format v2', () => {
  const sourceStart = html.indexOf('function buildBackupObject(');
  const sourceEnd = html.indexOf('\n}', sourceStart);
  assert.notEqual(sourceStart, -1);
  assert.notEqual(sourceEnd, -1);

  const context = {
    STORAGE_KEY: 'main',
    FOCUS_SESSIONS_KEY: 'sessions',
    MENTAL_INBOX_KEY: 'inbox',
    THOUGHTS_KEY: 'thoughts',
    PROJECTS_KEY: 'projects',
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
    validateBackup: () => ({ valid: true }),
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

test('backup builder validates raw session records instead of silently filtering corrupted sessions', () => {
  const sourceStart = html.indexOf('function buildBackupObject(');
  const sourceEnd = html.indexOf('\n}', sourceStart);
  const context = {
    STORAGE_KEY: 'main',
    FOCUS_SESSIONS_KEY: 'sessions',
    MENTAL_INBOX_KEY: 'inbox',
    THOUGHTS_KEY: 'thoughts',
    PROJECTS_KEY: 'projects',
    APP_VERSION: '2.9.0',
    CURRENT_SCHEMA_VERSION: 2,
    BACKUP_FORMAT_VERSION: 2,
    localStorage: {
      getItem(key) {
        if (key === 'main') return JSON.stringify({ settings: {}, tasks: [], dailyLogs: [] });
        if (key === 'sessions') return JSON.stringify([{ id: 1, durationSec: 'broken', startedAt: 'not-a-date', mode: 'stopwatch', phase: 'work' }]);
        return null;
      }
    },
    buildEmptyV2: () => ({ settings: {}, tasks: [], dailyLogs: [] }),
    localDateTimeString: () => '2026-11-19T18:00:00',
    _buildFocusTimerBackupSnapshot: () => timer(),
    _focusTimer: timer(),
    _getElapsedSec: () => 300,
    _phaseTargetSec: () => 1_500,
    _getFocusSettingsSnapshot: () => ({ workMin: 25, shortMin: 5, longMin: 15 }),
    _getNotificationsPref: () => ({ enabled: false }),
    validateBackup: (backup) => backup.data.focusSessions.some((session) => typeof session.durationSec !== 'number')
      ? { valid: false, reason: 'جلسة تركيز غير صالحة' }
      : { valid: true }
  };
  const buildBackup = vm.runInNewContext(`(${html.slice(sourceStart, sourceEnd + 2)})`, context);

  assert.throws(() => buildBackup(), /تعذر إنشاء نسخة احتياطية كاملة: جلسة تركيز غير صالحة/);
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
    VALID_PROJECT_STATUS: ['active', 'completed', 'paused'],
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
  const missingFocusTimer = {
    ...valid,
    data: { tasks: valid.data.tasks, dailyLogs: [] }
  };
  const nullFocusTimer = {
    ...valid,
    data: { ...valid.data, focusTimer: null }
  };
  assert.equal(validateBackup(missingFocusTimer).valid, false);
  assert.equal(validateBackup(nullFocusTimer).valid, false);

  const missingTimer = {
    ...valid,
    data: { ...valid.data }
  };
  delete missingTimer.data.focusTimer;
  assert.equal(validateBackup(missingTimer).valid, false);

  const nullTimer = {
    ...valid,
    data: { ...valid.data, focusTimer: null }
  };
  assert.equal(validateBackup(nullTimer).valid, false);
});

test('legacy V1 import without a timer snapshot preserves the current timer value', () => {
  const restoreSnapshot = loadTopLevelFunction('_restoreFocusTimerSnapshot');
  const existing = JSON.stringify({ mode: 'stopwatch', running: false, baseElapsed: 900 });
  const storage = memoryStorage({ focusTimer: existing });

  restoreSnapshot({ tasks: [], dailyLogs: [] }, storage, 'focusTimer');
  restoreSnapshot({ tasks: [], dailyLogs: [], focusTimer: null }, storage, 'focusTimer');
  assert.equal(storage.getItem('focusTimer'), existing);

  const replacement = { mode: 'pomodoro', running: false, baseElapsed: 120 };
  restoreSnapshot({ focusTimer: replacement }, storage, 'focusTimer');
  assert.deepEqual(JSON.parse(storage.getItem('focusTimer')), replacement);
});

test('legacy format-v1 backup without focusTimer remains import-compatible', () => {
  const sourceStart = html.indexOf('function validateBackup(');
  const sourceEnd = html.indexOf('\n}', sourceStart);
  const context = {
    BACKUP_FORMAT_VERSION: 2,
    CURRENT_SCHEMA_VERSION: 2,
    VALID_STATUS: [],
    VALID_TYPES: [],
    VALID_PROJECT_STATUS: ['active', 'completed', 'paused'],
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

test('cold-start finalization runs after focus settings are loaded', () => {
  const normalizedHtml = html.replace(/\\r\\n/g, '\\n');
  const loadTimer = normalizedHtml.lastIndexOf('_loadFocusTimer();');
  const loadSettings = normalizedHtml.indexOf('_loadFocusSettings();', loadTimer);
  const finalize = normalizedHtml.indexOf('_finalizeFocusTimerColdStartRestore();', loadSettings);
  const render = normalizedHtml.indexOf('renderAll();', finalize);

  assert.ok(loadTimer >= 0);
  assert.ok(loadSettings > loadTimer);
  assert.ok(finalize > loadSettings);
  assert.ok(render > finalize);
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
  const getCounts = new Map();
  const setCounts = new Map();
  return {
    getItem(key) {
      const count = (getCounts.get(key) || 0) + 1;
      getCounts.set(key, count);
      if (faults.throwOnGetKey === key) throw new Error('simulated read failure');
      if (faults.failGetAt && faults.failGetAt[key] === count) throw new Error('simulated staged read failure');
      if (faults.mismatchReadKey === key) return '__readback_mismatch__';
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      const count = (setCounts.get(key) || 0) + 1;
      setCounts.set(key, count);
      if (faults.throwOnSetKey === key) throw new Error('simulated quota/write failure');
      if (faults.failSetOnceKey === key && !faults.didFailSetOnce) {
        faults.didFailSetOnce = true;
        throw new Error('simulated one-time write failure');
      }
      if (faults.failSetAt && faults.failSetAt[key] === count) throw new Error('simulated staged write failure');
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

test('timer loader pauses a running Stopwatch after a cold restart at the last persisted checkpoint', () => {
  const snapshot = timer({
    mode: 'stopwatch',
    phase: 'work',
    running: true,
    baseElapsed: 420,
    startedAt: 5_000,
    sessionStartAt: 1_000,
    taskId: 10
  });
  const harness = loadTimerContext(snapshot);
  const loadTimer = vm.runInNewContext(
    '(' + loadTopLevelFunction('_loadFocusTimer') + ')',
    harness.context
  );

  loadTimer();

  assert.equal(harness.state.mode, 'stopwatch');
  assert.equal(harness.state.running, false);
  assert.equal(harness.state.startedAt, null);
  assert.equal(harness.state.baseElapsed, 420);
  const persisted = JSON.parse(harness.savedValue());
  assert.equal(persisted.running, false);
  assert.equal(persisted.startedAt, null);
  assert.equal(persisted.baseElapsed, 420);
});

test('timer loader pauses a running Pomodoro after a cold restart without counting downtime', () => {
  const snapshot = timer({
    mode: 'pomodoro',
    phase: 'work',
    running: true,
    baseElapsed: 780,
    startedAt: 5_000,
    sessionStartAt: 1_000,
    taskId: 10,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null
  });
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
  assert.equal(harness.state.baseElapsed, 780);
  assert.equal(harness.state.awaitingConfirmation, false);
  const persisted = JSON.parse(harness.savedValue());
  assert.equal(persisted.running, false);
  assert.equal(persisted.baseElapsed, 780);
});

test('running timer checkpoints persist elapsed time and reset the checkpoint timestamp', () => {
  const state = timer({
    mode: 'stopwatch',
    phase: 'work',
    running: true,
    baseElapsed: 120,
    startedAt: 1_000
  });
  let stored = null;
  let saveTimestamp = 0;
  const context = {
    FOCUS_TIMER_KEY: 'timer-key',
    FOCUS_TIMER_CHECKPOINT_INTERVAL_MS: 5_000,
    _focusTimerCheckpointAt: 1_000,
    _focusTimer: state,
    Date: { now: () => 7_000 },
    _getElapsedSec: () => 305,
    localStorage: {
      setItem(key, value) {
        assert.equal(key, 'timer-key');
        stored = value;
        saveTimestamp = 7_000;
      }
    }
  };
  const saveTimer = vm.runInNewContext(
    '(' + loadTopLevelFunction('_saveFocusTimer') + ')',
    context
  );

  assert.equal(saveTimer(), true);
  const persisted = JSON.parse(stored);
  assert.equal(persisted.baseElapsed, 305);
  assert.equal(persisted.startedAt, saveTimestamp);
  assert.equal(persisted.running, true);
  assert.equal(context._focusTimerCheckpointAt, saveTimestamp);
  assert.equal(state.baseElapsed, 120);
});

test('cold restart preserves a Pomodoro phase that expired after its last checkpoint for user confirmation', () => {
  const snapshot = timer({
    mode: 'pomodoro',
    phase: 'work',
    running: true,
    baseElapsed: 1_502,
    startedAt: 5_000,
    sessionStartAt: 1_000,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null
  });
  snapshot.savedAt = 60_000;
  const harness = loadTimerContext(snapshot);
  harness.context._phaseTargetSec = () => 1_500;
  const loadTimer = vm.runInNewContext(
    '(' + loadTopLevelFunction('_loadFocusTimer') + ')',
    harness.context
  );
  const finalizeRestore = vm.runInNewContext(
    '(' + loadTopLevelFunction('_finalizeFocusTimerColdStartRestore') + ')',
    harness.context
  );

  loadTimer();
  finalizeRestore();

  assert.equal(harness.state.running, false);
  assert.equal(harness.state.startedAt, null);
  assert.equal(harness.state.baseElapsed, 1_500);
  assert.equal(harness.state.awaitingConfirmation, true);
  assert.equal(harness.state.pendingPhaseEndedAt, 58_000);
  assert.equal(harness.state.sessionStartAt, 1_000);
  const persisted = JSON.parse(harness.savedValue());
  assert.equal(persisted.running, false);
  assert.equal(persisted.awaitingConfirmation, true);
  assert.equal(persisted.pendingPhaseEndedAt, 58_000);
});

test('cold restart finalization keeps an unexpired Pomodoro paused without creating a pending phase', () => {
  const snapshot = timer({
    mode: 'pomodoro',
    phase: 'work',
    running: true,
    baseElapsed: 780,
    startedAt: 5_000,
    sessionStartAt: 1_000
  });
  snapshot.savedAt = 60_000;
  const harness = loadTimerContext(snapshot);
  harness.context._phaseTargetSec = () => 1_500;
  const loadTimer = vm.runInNewContext(
    '(' + loadTopLevelFunction('_loadFocusTimer') + ')',
    harness.context
  );
  const finalizeRestore = vm.runInNewContext(
    '(' + loadTopLevelFunction('_finalizeFocusTimerColdStartRestore') + ')',
    harness.context
  );

  loadTimer();
  finalizeRestore();

  assert.equal(harness.state.running, false);
  assert.equal(harness.state.startedAt, null);
  assert.equal(harness.state.baseElapsed, 780);
  assert.equal(harness.state.awaitingConfirmation, false);
  assert.equal(harness.state.pendingPhaseEndedAt, null);
});

test('focus timer display tick checkpoints even while hidden and skips UI work', () => {
  let tick = null;
  let checkpoints = 0;
  let renders = 0;
  let catchUps = 0;
  const context = {
    _focusDisplayInterval: null,
    _focusTimerCheckpointAt: 0,
    FOCUS_TIMER_CHECKPOINT_INTERVAL_MS: 5_000,
    _focusTimer: { running: true, mode: 'stopwatch' },
    document: { visibilityState: 'hidden' },
    Date: { now: () => 5_000 },
    setInterval(callback, interval) {
      assert.equal(interval, 1_000);
      tick = callback;
      return 1;
    },
    _saveFocusTimer() { checkpoints++; return true; },
    _renderFocusTimer() { renders++; },
    _catchUp() { catchUps++; }
  };
  const startTick = vm.runInNewContext(
    '(' + loadTopLevelFunction('_startDisplayTick') + ')',
    context
  );

  startTick();
  tick();

  assert.equal(checkpoints, 1);
  assert.equal(renders, 0);
  assert.equal(catchUps, 0);
});

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
      storage.setItem('focusTimer', JSON.stringify(state));
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


function runImportPreviewIntegration(backup, existingTimerRaw, faults = {}) {
  const storage = memoryStorage({
    'app-data': JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} }),
    'timeTasksApp_focusSessions': 'previous-sessions',
    'timeTasksApp_focusTimer': existingTimerRaw,
    'timeTasksApp_mentalInbox': 'previous-inbox',
    thoughts: 'previous-thoughts',
    projects: 'previous-projects',
    'focus-settings': 'previous-focus-settings',
    notifications: 'previous-notifications'
  }, faults);
  const values = storage.values;
  const sessionValues = new Map();
  const alerts = [];
  let reloads = 0;
  const sandbox = {
    STORAGE_KEY: 'app-data',
    FOCUS_TIMER_KEY: 'timeTasksApp_focusTimer',
    IMPORT_IN_PROGRESS_KEY: 'import-marker',
    PRE_IMPORT_KEY: 'pre-import',
    THOUGHTS_KEY: 'thoughts',
    PROJECTS_KEY: 'projects',
    FOCUS_SETTINGS_KEY: 'focus-settings',
    NOTIFICATIONS_KEY: 'notifications',
    CURRENT_SCHEMA_VERSION: 2,
    APP_VERSION: '2.9.0',
    localStorage: storage,
    sessionStorage: {
      setItem(key, value) { sessionValues.set(key, String(value)); }
    },
    location: { reload() { reloads++; } },
    todayStr: () => '2026-11-20',
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    validateV2: () => true,
    _healTaskArray: () => false,
    _invalidateProjectsCache: () => {},
    showConfirmModal: (_title, _body, accept) => accept(),
    showPromptModal: (_title, _body, _initial, _placeholder, submit) => submit('استبدال'),
    showAlertModal: (...args) => alerts.push(args),
    showToast: () => {},
    escapeHTML: (value) => String(value)
  };
  const source = [
    extractTopLevelSource('_restoreFocusTimerSnapshot'),
    extractTopLevelSource('_restoreStorageSnapshot'),
    extractTopLevelSource('_rollbackRestore'),
    extractTopLevelSource('_recoverInterruptedImport'),
    extractTopLevelSource('showImportPreview'),
    'showImportPreview(' + JSON.stringify(backup) + ');'
  ].join('\n');
  vm.runInNewContext(source, sandbox);
  const recover = vm.runInNewContext('_recoverInterruptedImport', sandbox);
  return { values, sessionValues, alerts, reloads: () => reloads, recover, faults };
}

function integrationBackup(data) {
  return { backupFormatVersion: data.focusTimer ? 2 : 1, schemaVersion: 2, data };
}


function backupValidationContext() {
  return {
    BACKUP_FORMAT_VERSION: 2,
    CURRENT_SCHEMA_VERSION: 2,
    VALID_STATUS: ['pending', 'done', 'cancelled'],
    VALID_TYPES: ['معرفية', 'إدارية', 'إبداعية', 'اجتماعية'],
    VALID_PROJECT_STATUS: ['active', 'completed', 'paused'],
    isValidCalendarDate: () => true,
    isValidLocalTime: () => true,
    isValidLocalDateTime: () => true,
    validateDailyLog: () => true,
    _validateFocusTimerBackupSnapshot: () => ({ valid: true })
  };
}

function validationTask(overrides = {}) {
  return {
    id: 7, name: 'مهمة اختبار', status: 'pending', type: 'معرفية',
    expected: 20, actual: null, plannedDate: '2026-11-20',
    plannedTime: '', completedAt: null, ...overrides
  };
}

test('backup validator checks loader-required thought and project fields without rejecting legacy timestamp formats or extra fields', () => {
  const validate = vm.runInNewContext(
    '(' + extractTopLevelSource('validateBackup') + ')',
    backupValidationContext()
  );
  const backup = integrationBackup({
    tasks: [], dailyLogs: [],
    thoughts: [{ id: 1, text: 'فكرة قديمة', createdAt: 'legacy-date-string', customField: { retained: true } }],
    projects: [{ id: 4, name: 'مشروع قديم', status: 'paused', createdAt: 'legacy-created-at', extension: 'kept' }]
  });

  assert.equal(validate(backup).valid, true);
  assert.equal(backup.data.thoughts[0].customField.retained, true);
  assert.equal(backup.data.projects[0].extension, 'kept');
});

test('backup validator rejects duplicate or loader-repaired thought and project records', () => {
  const validate = vm.runInNewContext(
    '(' + extractTopLevelSource('validateBackup') + ')',
    backupValidationContext()
  );
  const validThought = { id: 1, text: 'فكرة', createdAt: 'stored-date', extra: 'preserve' };
  const validProject = { id: 3, name: 'مشروع', status: 'active', createdAt: 'stored-date', extra: 'preserve' };
  const cases = [
    { thoughts: [validThought, { ...validThought, text: 'أخرى' }], reason: 'معرّف خاطرة مكرر' },
    { thoughts: [{ ...validThought, id: 0 }], reason: 'معرّف خاطرة غير صالح' },
    { thoughts: [{ ...validThought, text: '  ' }], reason: 'نص الخاطرة' },
    { thoughts: [{ ...validThought, createdAt: '' }], reason: 'تاريخ إنشاء الخاطرة' },
    { projects: [validProject, { ...validProject, name: 'مشروع آخر' }], reason: 'معرّف مشروع مكرر' },
    { projects: [{ ...validProject, id: -1 }], reason: 'معرّف مشروع غير صالح' },
    { projects: [{ ...validProject, name: '' }], reason: 'اسم المشروع' },
    { projects: [{ ...validProject, status: 'unknown' }], reason: 'حالة المشروع' },
    { projects: [{ ...validProject, createdAt: '' }], reason: 'تاريخ إنشاء المشروع' }
  ];

  for (const item of cases) {
    const backup = integrationBackup({
      tasks: [], dailyLogs: [],
      thoughts: item.thoughts || [],
      projects: item.projects || []
    });
    const result = validate(backup);
    assert.equal(result.valid, false, item.reason);
    assert.match(result.reason, new RegExp(item.reason));
  }
});

test('backup validator rejects duplicate mental-inbox identifiers', () => {
  const validate = vm.runInNewContext(
    '(' + extractTopLevelSource('validateBackup') + ')',
    backupValidationContext()
  );
  const item = { id: 3, text: 'فكرة', createdAt: 'legacy' };
  const result = validate(integrationBackup({
    tasks: [], dailyLogs: [], mentalInbox: [item, { ...item }]
  }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /معرّف فكرة مكرر/);
});

test('backup validator rejects dangling task project references only when a projects collection is supplied', () => {
  const validate = vm.runInNewContext(
    '(' + extractTopLevelSource('validateBackup') + ')',
    backupValidationContext()
  );
  const task = validationTask({ projectId: 99 });
  const project = { id: 99, name: 'مرتبط', status: 'active', createdAt: 'legacy' };

  assert.equal(validate(integrationBackup({
    tasks: [task], dailyLogs: [], projects: [project]
  })).valid, true);
  assert.equal(validate(integrationBackup({
    tasks: [task], dailyLogs: [], projects: []
  })).valid, false);
  assert.equal(validate(integrationBackup({
    tasks: [task], dailyLogs: []
  })).valid, true);
});

test('invalid backup is rejected by the text import gate before the preview can write storage', () => {
  const invalid = integrationBackup({
    tasks: [], dailyLogs: [],
    thoughts: [
      { id: 5, text: 'أولى', createdAt: 'legacy' },
      { id: 5, text: 'مكررة', createdAt: 'legacy' }
    ]
  });
  const alerts = [];
  let previews = 0;
  const context = {
    ...backupValidationContext(),
    showTextAreaModal: (_title, _body, _initial, submit) => submit(JSON.stringify(invalid)),
    showAlertModal: (...args) => alerts.push(args),
    showToast: () => {},
    escapeHTML: (value) => String(value),
    showImportPreview: () => { previews++; }
  };
  const importText = vm.runInNewContext(
    extractTopLevelSource('validateBackup') + '\n' +
    extractTopLevelSource('importFromText') + '\nimportFromText',
    context
  );

  importText();
  assert.equal(previews, 0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][1], /معرّف خاطرة مكرر/);
});

test('full import preview restores the focus timer and the system theme preference', () => {
  const timerSnapshot = {
    mode: 'pomodoro', phase: 'work', running: false, baseElapsed: 420,
    startedAt: null, cyclePosition: 1, taskId: null, sessionStartAt: 1000,
    awaitingConfirmation: false, pendingPhaseEndedAt: null
  };
  const backup = integrationBackup({
    settings: { operationalDayStart: 4, firstUseDate: '2026-11-20', darkMode: false, themeMode: 'system' },
    tasks: [], dailyLogs: [], focusTimer: timerSnapshot
  });
  const harness = runImportPreviewIntegration(backup, 'previous-timer');

  const restored = JSON.parse(harness.values.get('app-data'));
  assert.equal(restored.settings.themeMode, 'system');
  assert.equal(harness.values.get('timeTasksApp_focusTimer'), JSON.stringify(timerSnapshot));
  assert.equal(harness.values.has('import-marker'), false);
  assert.equal(harness.reloads(), 1);
  assert.deepEqual(harness.alerts, []);
});

test('legacy V1 import without focusTimer preserves the device timer and maps legacy darkMode', () => {
  const backup = integrationBackup({
    settings: { operationalDayStart: 4, firstUseDate: '2026-11-20', darkMode: true },
    tasks: [], dailyLogs: []
  });
  const harness = runImportPreviewIntegration(backup, 'keep-existing-timer');

  const restored = JSON.parse(harness.values.get('app-data'));
  assert.equal(restored.settings.themeMode, 'dark');
  assert.equal(harness.values.get('timeTasksApp_focusTimer'), 'keep-existing-timer');
  assert.equal(harness.values.has('import-marker'), false);
  assert.equal(harness.reloads(), 1);
  assert.deepEqual(harness.alerts, []);
});


const RESTORE_KEY_CASES = [
  ['app-main', 'main', 'main'],
  ['timeTasksApp_focusSessions', 'focusSessions', 'focusSessions'],
  ['timeTasksApp_focusTimer', 'focusTimer', 'focusTimer'],
  ['timeTasksApp_mentalInbox', 'mentalInbox', 'mentalInbox'],
  ['app-thoughts', 'thoughts', 'thoughts'],
  ['app-projects', 'projects', 'projects'],
  ['app-focus-settings', 'focusSettings', 'focusSettings'],
  ['app-notifications', 'notifications', 'notifications']
];

test('snapshot restoration reports read, write and remove failures for every storage key', () => {
  const snapshot = storageSnapshot('known-good');
  for (const [key, property] of RESTORE_KEY_CASES) {
    const writeStorage = memoryStorage({}, { throwOnSetKey: key });
    const writeHarness = restoreContext(writeStorage);
    const restoreWrite = vm.runInNewContext(
      '(' + extractTopLevelSource('_restoreStorageSnapshot') + ')',
      writeHarness.context
    );
    assert.equal(restoreWrite(snapshot), false, 'write failure: ' + key);

    const readStorage = memoryStorage({}, { throwOnGetKey: key });
    const readHarness = restoreContext(readStorage);
    const restoreRead = vm.runInNewContext(
      '(' + extractTopLevelSource('_restoreStorageSnapshot') + ')',
      readHarness.context
    );
    assert.equal(restoreRead(snapshot), false, 'read-back failure: ' + key);

    const removeStorage = memoryStorage({ [key]: 'current-value' }, { throwOnRemoveKey: key });
    const removeHarness = restoreContext(removeStorage);
    const restoreRemove = vm.runInNewContext(
      '(' + extractTopLevelSource('_restoreStorageSnapshot') + ')',
      removeHarness.context
    );
    assert.equal(restoreRemove({ ...snapshot, [property]: null }), false, 'remove failure: ' + key);
  }
});

test('interrupted import recovery restores snapshots after interruption at every collection boundary', () => {
  const previous = storageSnapshot('previous');
  previous.main = JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} });

  for (let interruptedAfter = 0; interruptedAfter <= RESTORE_KEY_CASES.length; interruptedAfter++) {
    const seed = {
      'app-import-marker': '1',
      'app-pre-import': JSON.stringify(previous)
    };
    RESTORE_KEY_CASES.forEach(([key, property], index) => {
      seed[key] = index < interruptedAfter ? 'partially-imported-' + property : previous[property];
    });
    const storage = memoryStorage(seed);
    const harness = restoreContext(storage);
    const recover = vm.runInNewContext(
      extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
      extractTopLevelSource('_recoverInterruptedImport') + '\n_recoverInterruptedImport',
      harness.context
    );

    assert.equal(recover(), true, 'recovery boundary: ' + interruptedAfter);
    for (const [key, property] of RESTORE_KEY_CASES) {
      assert.equal(storage.getItem(key), previous[property], 'restored ' + key);
    }
    assert.equal(storage.getItem('app-import-marker'), null);
    assert.equal(storage.getItem('app-pre-import'), null);
  }
});

test('failed recovery retains both the recovery marker and original snapshot, then succeeds on retry', () => {
  const previous = storageSnapshot('previous');
  previous.main = JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} });
  const faults = { throwOnSetKey: 'app-thoughts' };
  const storage = memoryStorage({
    'app-import-marker': '1',
    'app-pre-import': JSON.stringify(previous),
    ...Object.fromEntries(RESTORE_KEY_CASES.map(([key, property]) => [key, 'partial-' + property]))
  }, faults);
  const harness = restoreContext(storage);
  const recover = vm.runInNewContext(
    extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
    extractTopLevelSource('_recoverInterruptedImport') + '\n_recoverInterruptedImport',
    harness.context
  );

  assert.equal(recover(), false);
  assert.equal(storage.getItem('app-import-marker'), '1');
  assert.equal(storage.getItem('app-pre-import'), JSON.stringify(previous));
  faults.throwOnSetKey = null;
  assert.equal(recover(), true);
  for (const [key, property] of RESTORE_KEY_CASES) {
    assert.equal(storage.getItem(key), previous[property]);
  }
});

test('import round trip restores all data collections and preserves extra setting fields', () => {
  const timerSnapshot = {
    mode: 'pomodoro', phase: 'work', running: false, baseElapsed: 420,
    startedAt: null, cyclePosition: 1, taskId: null, sessionStartAt: 1000,
    awaitingConfirmation: false, pendingPhaseEndedAt: null
  };
  const data = {
    settings: {
      operationalDayStart: 4, firstUseDate: '2026-11-20',
      darkMode: false, themeMode: 'system', customSetting: { keep: true }
    },
    tasks: [], dailyLogs: [],
    focusSessions: [{ id: 1, durationSec: 900, startedAt: '2026-11-20T09:00:00.000Z', custom: 'session' }],
    focusTimer: timerSnapshot,
    mentalInbox: [{ id: 2, text: 'فكرة', createdAt: 'legacy-created-at', custom: 7 }],
    thoughts: [{ id: 3, text: 'خاطرة', createdAt: 'legacy-created-at', custom: { kept: true } }],
    projects: [{ id: 4, name: 'مشروع', status: 'active', createdAt: 'legacy-created-at', extra: 'kept' }],
    focusSettings: { workMin: 25, shortMin: 5, longMin: 15, customDurationRule: 'keep' },
    notifications: { enabled: false, futurePreference: 'keep' }
  };
  const harness = runImportPreviewIntegration(integrationBackup(data), 'previous-timer');

  const restoredMain = JSON.parse(harness.values.get('app-data'));
  assert.deepEqual(restoredMain.tasks, data.tasks);
  assert.deepEqual(restoredMain.dailyLogs, data.dailyLogs);
  assert.deepEqual(restoredMain.settings.customSetting, data.settings.customSetting);
  assert.deepEqual(JSON.parse(harness.values.get('timeTasksApp_focusSessions')), data.focusSessions);
  assert.equal(harness.values.get('timeTasksApp_focusTimer'), JSON.stringify(timerSnapshot));
  assert.deepEqual(JSON.parse(harness.values.get('timeTasksApp_mentalInbox')), data.mentalInbox);
  assert.deepEqual(JSON.parse(harness.values.get('thoughts')), data.thoughts);
  assert.deepEqual(JSON.parse(harness.values.get('projects')), data.projects);
  assert.deepEqual(JSON.parse(harness.values.get('focus-settings')), data.focusSettings);
  assert.deepEqual(JSON.parse(harness.values.get('notifications')), data.notifications);
});

const IMPORT_WRITE_KEYS = [
  'app-data',
  'timeTasksApp_focusSessions',
  'timeTasksApp_focusTimer',
  'timeTasksApp_mentalInbox',
  'thoughts',
  'projects',
  'focus-settings',
  'notifications'
];

test('import write failure rolls back every collection before reporting failure', () => {
  const timerSnapshot = {
    mode: 'pomodoro', phase: 'work', running: false, baseElapsed: 100,
    startedAt: null, cyclePosition: 0, taskId: null, sessionStartAt: 1000,
    awaitingConfirmation: false, pendingPhaseEndedAt: null
  };
  const data = {
    settings: { operationalDayStart: 4, firstUseDate: '2026-11-20', darkMode: false },
    tasks: [], dailyLogs: [], focusSessions: [{ id: 1, durationSec: 10, startedAt: '2026-11-20T00:00:00.000Z' }],
    focusTimer: timerSnapshot,
    mentalInbox: [{ id: 2, text: 'فكرة', createdAt: 'legacy' }],
    thoughts: [{ id: 3, text: 'خاطرة', createdAt: 'legacy' }],
    projects: [{ id: 4, name: 'مشروع', status: 'active', createdAt: 'legacy' }],
    focusSettings: { workMin: 25, shortMin: 5, longMin: 15 },
    notifications: { enabled: true }
  };
  for (const key of IMPORT_WRITE_KEYS) {
    const faults = { failSetOnceKey: key };
    const harness = runImportPreviewIntegration(integrationBackup(data), 'previous-timer', faults);
    assert.equal(harness.reloads(), 0, 'must not reload after failed write: ' + key);
    assert.ok(harness.alerts.length > 0, 'must report failed write: ' + key);
    assert.equal(harness.values.get('app-data'), JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} }));
    assert.equal(harness.values.get('timeTasksApp_focusSessions'), 'previous-sessions');
    assert.equal(harness.values.get('timeTasksApp_focusTimer'), 'previous-timer');
    assert.equal(harness.values.get('timeTasksApp_mentalInbox'), 'previous-inbox');
    assert.equal(harness.values.get('thoughts'), 'previous-thoughts');
    assert.equal(harness.values.get('projects'), 'previous-projects');
    assert.equal(harness.values.get('focus-settings'), 'previous-focus-settings');
    assert.equal(harness.values.get('notifications'), 'previous-notifications');
    assert.equal(harness.values.has('import-marker'), false);
  }
});

test('when rollback itself fails, marker and snapshot survive and startup recovery can finish later', () => {
  const data = {
    settings: { operationalDayStart: 4, firstUseDate: '2026-11-20', darkMode: false },
    tasks: [], dailyLogs: [], focusSessions: [{ id: 1, durationSec: 10, startedAt: '2026-11-20T00:00:00.000Z' }],
    focusTimer: {
      mode: 'pomodoro', phase: 'work', running: false, baseElapsed: 100,
      startedAt: null, cyclePosition: 0, taskId: null, sessionStartAt: 1000,
      awaitingConfirmation: false, pendingPhaseEndedAt: null
    },
    mentalInbox: [{ id: 2, text: 'فكرة', createdAt: 'legacy' }],
    thoughts: [{ id: 3, text: 'خاطرة', createdAt: 'legacy' }],
    projects: [{ id: 4, name: 'مشروع', status: 'active', createdAt: 'legacy' }],
    focusSettings: { workMin: 25, shortMin: 5, longMin: 15 },
    notifications: { enabled: true }
  };
  const faults = { failSetOnceKey: 'notifications', failSetAt: { thoughts: 2 } };
  const harness = runImportPreviewIntegration(integrationBackup(data), 'previous-timer', faults);

  assert.equal(harness.reloads(), 0);
  assert.ok(harness.alerts.length > 0);
  assert.equal(harness.values.get('import-marker'), '1');
  assert.ok(harness.values.has('pre-import'));

  delete faults.failSetAt.thoughts;
  assert.equal(harness.recover(), true);
  assert.equal(harness.values.get('app-data'), JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} }));
  assert.equal(harness.values.get('timeTasksApp_focusSessions'), 'previous-sessions');
  assert.equal(harness.values.get('timeTasksApp_focusTimer'), 'previous-timer');
  assert.equal(harness.values.get('timeTasksApp_mentalInbox'), 'previous-inbox');
  assert.equal(harness.values.get('thoughts'), 'previous-thoughts');
  assert.equal(harness.values.get('projects'), 'previous-projects');
  assert.equal(harness.values.get('focus-settings'), 'previous-focus-settings');
  assert.equal(harness.values.get('notifications'), 'previous-notifications');
});
