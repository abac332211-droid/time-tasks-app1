'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const STORAGE_KEYS = Object.freeze({
  MAIN: 'timeTasksApp_v1',
  PRE_IMPORT: 'timeTasksApp_preImportBackup',
  IMPORT_IN_PROGRESS: 'timeTasksApp_importInProgress',
  FOCUS_SESSIONS: 'timeTasksApp_focusSessions',
  FOCUS_TIMER: 'timeTasksApp_focusTimer',
  MENTAL_INBOX: 'timeTasksApp_mentalInbox',
  THOUGHTS: 'timeTasksApp_thoughts_v1',
  PROJECTS: 'timeTasksApp_projects_v1',
  FOCUS_SETTINGS: 'timeTasksApp_focusSettings',
  NOTIFICATIONS: 'timeTasksApp_notifications'
});

test('backup fault-injection harness uses the exact LocalStorage keys declared by the app', () => {
  const declarations = [
    ['const STORAGE_KEY = "timeTasksApp_v1"', STORAGE_KEYS.MAIN],
    ['const PRE_IMPORT_KEY = "timeTasksApp_preImportBackup"', STORAGE_KEYS.PRE_IMPORT],
    ['const IMPORT_IN_PROGRESS_KEY = "timeTasksApp_importInProgress"', STORAGE_KEYS.IMPORT_IN_PROGRESS],
    ['var FOCUS_SESSIONS_KEY = "timeTasksApp_focusSessions"', STORAGE_KEYS.FOCUS_SESSIONS],
    ['var FOCUS_TIMER_KEY = "timeTasksApp_focusTimer"', STORAGE_KEYS.FOCUS_TIMER],
    ['var MENTAL_INBOX_KEY = "timeTasksApp_mentalInbox"', STORAGE_KEYS.MENTAL_INBOX],
    ['var THOUGHTS_KEY = "timeTasksApp_thoughts_v1"', STORAGE_KEYS.THOUGHTS],
    ['var PROJECTS_KEY = "timeTasksApp_projects_v1"', STORAGE_KEYS.PROJECTS],
    ['var FOCUS_SETTINGS_KEY = "timeTasksApp_focusSettings"', STORAGE_KEYS.FOCUS_SETTINGS],
    ['var NOTIFICATIONS_KEY = "timeTasksApp_notifications"', STORAGE_KEYS.NOTIFICATIONS]
  ];
  for (const [declaration, key] of declarations) {
    assert.ok(html.includes(declaration), 'missing app storage declaration: ' + key);
  }
});

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
    THOUGHTS_KEY: STORAGE_KEYS.THOUGHTS,
    PROJECTS_KEY: STORAGE_KEYS.PROJECTS,
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
    THOUGHTS_KEY: STORAGE_KEYS.THOUGHTS,
    PROJECTS_KEY: STORAGE_KEYS.PROJECTS,
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
  const normalizedHtml = html.replace(/\\r\\n/g, '\n');
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
    STORAGE_KEY: STORAGE_KEYS.MAIN,
    FOCUS_SESSIONS_KEY: STORAGE_KEYS.FOCUS_SESSIONS,
    FOCUS_TIMER_KEY: STORAGE_KEYS.FOCUS_TIMER,
    MENTAL_INBOX_KEY: STORAGE_KEYS.MENTAL_INBOX,
    THOUGHTS_KEY: STORAGE_KEYS.THOUGHTS,
    PROJECTS_KEY: STORAGE_KEYS.PROJECTS,
    FOCUS_SETTINGS_KEY: STORAGE_KEYS.FOCUS_SETTINGS,
    NOTIFICATIONS_KEY: STORAGE_KEYS.NOTIFICATIONS,
    IMPORT_IN_PROGRESS_KEY: STORAGE_KEYS.IMPORT_IN_PROGRESS,
    PRE_IMPORT_KEY: STORAGE_KEYS.PRE_IMPORT,
    validateV2: () => true,
    storageRecoveryRequired: false,
    location: { reload() {} },
    _reloadAfterVerifiedOperation: () => context.location.reload(),
    _invalidateProjectsCache: () => { invalidations++; }
  };
  return {
    context,
    invalidationCount: () => invalidations
  };
}

test('rollback snapshot restores and reads back the focus timer with every other key', () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.MAIN]: 'new-main',
    [STORAGE_KEYS.FOCUS_SESSIONS]: 'new-sessions',
    [STORAGE_KEYS.FOCUS_TIMER]: 'new-timer',
    [STORAGE_KEYS.MENTAL_INBOX]: 'new-inbox',
    [STORAGE_KEYS.THOUGHTS]: 'new-thoughts',
    [STORAGE_KEYS.PROJECTS]: 'new-projects',
    [STORAGE_KEYS.FOCUS_SETTINGS]: 'new-settings',
    [STORAGE_KEYS.NOTIFICATIONS]: 'new-notifications'
  });
  const harness = restoreContext(storage);
  const restore = vm.runInNewContext(
    '(' + extractTopLevelSource('_restoreStorageSnapshot') + ')',
    harness.context
  );
  const snapshot = storageSnapshot('previous');

  assert.equal(restore(snapshot), true);
  assert.equal(storage.getItem('timeTasksApp_focusTimer'), 'previous-timer');
  assert.equal(storage.getItem(STORAGE_KEYS.MAIN), 'previous-main');
  assert.equal(storage.getItem('timeTasksApp_focusSessions'), 'previous-sessions');
  assert.equal(storage.getItem('timeTasksApp_mentalInbox'), 'previous-inbox');
  assert.equal(storage.getItem(STORAGE_KEYS.THOUGHTS), 'previous-thoughts');
  assert.equal(storage.getItem(STORAGE_KEYS.PROJECTS), 'previous-projects');
  assert.equal(storage.getItem(STORAGE_KEYS.FOCUS_SETTINGS), 'previous-settings');
  assert.equal(storage.getItem(STORAGE_KEYS.NOTIFICATIONS), 'previous-notifications');
  assert.equal(harness.invalidationCount(), 1);
  assert.equal(harness.context.storageRecoveryRequired, false);
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

test('failed snapshot restore compensates already-written keys to the pre-call state', () => {
  const before = {
    [STORAGE_KEYS.MAIN]: 'current-main',
    [STORAGE_KEYS.FOCUS_SESSIONS]: 'current-sessions',
    [STORAGE_KEYS.FOCUS_TIMER]: 'current-timer',
    [STORAGE_KEYS.MENTAL_INBOX]: 'current-inbox',
    [STORAGE_KEYS.THOUGHTS]: 'current-thoughts',
    [STORAGE_KEYS.PROJECTS]: 'current-projects',
    [STORAGE_KEYS.FOCUS_SETTINGS]: 'current-settings',
    [STORAGE_KEYS.NOTIFICATIONS]: 'current-notifications'
  };
  const faults = { failSetOnceKey: STORAGE_KEYS.FOCUS_TIMER, didFailSetOnce: false };
  const storage = memoryStorage(before, faults);
  const harness = restoreContext(storage);
  const restore = vm.runInNewContext(
    '(' + extractTopLevelSource('_restoreStorageSnapshot') + ')',
    harness.context
  );

  assert.equal(restore(storageSnapshot('previous')), false);
  assert.equal(harness.context.storageRecoveryRequired, true);
  for (const [key, value] of Object.entries(before)) {
    assert.equal(storage.getItem(key), value, 'pre-call value restored for ' + key);
  }
});

test('interrupted import recovery restores the previous timer and clears both markers', () => {
  const previous = storageSnapshot('previous');
  previous.main = JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [] });
  const storage = memoryStorage({
    [STORAGE_KEYS.IMPORT_IN_PROGRESS]: '1',
    [STORAGE_KEYS.PRE_IMPORT]: JSON.stringify(previous),
    [STORAGE_KEYS.MAIN]: 'partially-imported-main',
    [STORAGE_KEYS.FOCUS_SESSIONS]: 'partially-imported-sessions',
    [STORAGE_KEYS.FOCUS_TIMER]: 'partially-imported-timer',
    [STORAGE_KEYS.MENTAL_INBOX]: 'partially-imported-inbox',
    [STORAGE_KEYS.THOUGHTS]: 'partially-imported-thoughts',
    [STORAGE_KEYS.PROJECTS]: 'partially-imported-projects',
    [STORAGE_KEYS.FOCUS_SETTINGS]: 'partially-imported-settings',
    [STORAGE_KEYS.NOTIFICATIONS]: 'partially-imported-notifications'
  });
  const harness = restoreContext(storage);
  const recovery = vm.runInNewContext(
    extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
    extractTopLevelSource('_recoverInterruptedImport') + '\n_recoverInterruptedImport',
    harness.context
  );

  assert.equal(recovery(), true);
  assert.equal(storage.getItem('timeTasksApp_focusTimer'), 'previous-timer');
  assert.equal(storage.getItem(STORAGE_KEYS.MAIN), previous.main);
  assert.equal(storage.getItem(STORAGE_KEYS.IMPORT_IN_PROGRESS), null);
  assert.equal(storage.getItem(STORAGE_KEYS.PRE_IMPORT), null);
  assert.equal(harness.invalidationCount(), 1);
});

test('interrupted import keeps its recovery marker when the saved snapshot is missing', () => {
  const storage = memoryStorage({ [STORAGE_KEYS.IMPORT_IN_PROGRESS]: '1' });
  const harness = restoreContext(storage);
  const recovery = vm.runInNewContext(
    extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
    extractTopLevelSource('_recoverInterruptedImport') + '\n_recoverInterruptedImport',
    harness.context
  );

  assert.equal(recovery(), false);
  assert.equal(storage.getItem(STORAGE_KEYS.IMPORT_IN_PROGRESS), '1');
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
    pendingPhaseEndedAt: null,
    clockAdjusted: false
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
    _trackSecondaryStorageRead: (_key, raw) => raw,
    _clearFocusTimerClock: () => {},
    _anchorFocusTimerClock: () => {},
    _phaseTargetSec: () => 1_500,
    _focusTimerColdStartWasRunning: false,
    _focusTimerSavedAtAtLoad: null,
    _focusMonotonicStart: null,
    _focusWallClockAnchor: null,
    _focusFallbackLastWall: null,
    _focusFallbackElapsedMs: 0,
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
    _storageWriteAllowed: () => true,
    _writeSecondaryStorageVerified(key, value) {
      assert.equal(key, 'timer-key');
      stored = value;
      saveTimestamp = 7_000;
      return true;
    },
    _anchorFocusTimerClock: () => {},
    _clearFocusTimerClock: () => {},
    _storeRollingRecoveryBackup: () => true,
    localStorage: {
      getItem: () => stored,
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
  assert.equal(state.baseElapsed, 305);
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
  assert.equal(harness.state.pendingPhaseEndedAt, 1_501_000);
  assert.equal(harness.state.sessionStartAt, 1_000);
  const persisted = JSON.parse(harness.savedValue());
  assert.equal(persisted.running, false);
  assert.equal(persisted.awaitingConfirmation, true);
  assert.equal(persisted.pendingPhaseEndedAt, 1_501_000);
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
    _trackSecondaryStorageRead: (_key, raw) => raw,
    _clearFocusTimerClock: () => {},
    _anchorFocusTimerClock: () => {},
    _phaseTargetSec: () => 1_500,
    _focusTimerColdStartWasRunning: false,
    _focusTimerSavedAtAtLoad: null,
    _focusMonotonicStart: null,
    _focusWallClockAnchor: null,
    _focusFallbackLastWall: null,
    _focusFallbackElapsedMs: 0,
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
    _trackSecondaryStorageRead: (_key, raw) => raw,
    _clearFocusTimerClock: () => {},
    _anchorFocusTimerClock: () => {},
    _phaseTargetSec: () => 1_500,
    _focusTimerColdStartWasRunning: false,
    _focusTimerSavedAtAtLoad: null,
    _focusMonotonicStart: null,
    _focusWallClockAnchor: null,
    _focusFallbackLastWall: null,
    _focusFallbackElapsedMs: 0,
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
    _trackSecondaryStorageRead: (_key, raw) => raw,
    _clearFocusTimerClock: () => {},
    _anchorFocusTimerClock: () => {},
    _phaseTargetSec: () => 1_500,
    _focusTimerColdStartWasRunning: false,
    _focusTimerSavedAtAtLoad: null,
    _focusMonotonicStart: null,
    _focusWallClockAnchor: null,
    _focusFallbackLastWall: null,
    _focusFallbackElapsedMs: 0,
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


function runImportPreviewIntegration(backup, existingTimerRaw, faults = {}, existingMainData = { schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} }, existingProjectsRaw = 'previous-projects') {
  const storage = memoryStorage({
    [STORAGE_KEYS.MAIN]: JSON.stringify(existingMainData),
    [STORAGE_KEYS.FOCUS_SESSIONS]: 'previous-sessions',
    [STORAGE_KEYS.FOCUS_TIMER]: existingTimerRaw,
    [STORAGE_KEYS.MENTAL_INBOX]: 'previous-inbox',
    [STORAGE_KEYS.THOUGHTS]: 'previous-thoughts',
    [STORAGE_KEYS.PROJECTS]: existingProjectsRaw,
    [STORAGE_KEYS.FOCUS_SETTINGS]: 'previous-focus-settings',
    [STORAGE_KEYS.NOTIFICATIONS]: 'previous-notifications'
  }, faults);
  const values = storage.values;
  const sessionValues = new Map();
  const alerts = [];
  const confirmations = [];
  const rollingCheckpoints = [];
  let reloads = 0;
  const sandbox = {
    STORAGE_KEY: STORAGE_KEYS.MAIN,
    FOCUS_SESSIONS_KEY: STORAGE_KEYS.FOCUS_SESSIONS,
    FOCUS_TIMER_KEY: STORAGE_KEYS.FOCUS_TIMER,
    MENTAL_INBOX_KEY: STORAGE_KEYS.MENTAL_INBOX,
    IMPORT_IN_PROGRESS_KEY: STORAGE_KEYS.IMPORT_IN_PROGRESS,
    PRE_IMPORT_KEY: STORAGE_KEYS.PRE_IMPORT,
    THOUGHTS_KEY: STORAGE_KEYS.THOUGHTS,
    PROJECTS_KEY: STORAGE_KEYS.PROJECTS,
    FOCUS_SETTINGS_KEY: STORAGE_KEYS.FOCUS_SETTINGS,
    NOTIFICATIONS_KEY: STORAGE_KEYS.NOTIFICATIONS,
    CURRENT_SCHEMA_VERSION: 2,
    APP_VERSION: '2.9.0',
    localStorage: storage,
    sessionStorage: {
      setItem(key, value) { sessionValues.set(key, String(value)); }
    },
    location: { reload() { reloads++; } },
    _reloadAfterVerifiedOperation: () => { reloads++; },
    todayStr: () => '2026-11-20',
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    validateV2: () => true,
    _healTaskArray: () => false,
    _invalidateProjectsCache: () => {},
    _storeRollingRecoveryBackup(reason) {
      rollingCheckpoints.push({
        reason,
        main: values.get(STORAGE_KEYS.MAIN),
        importMarkerPresent: values.has(STORAGE_KEYS.IMPORT_IN_PROGRESS)
      });
      return true;
    },
    showConfirmModal: (title, body, accept) => { confirmations.push({ title, body }); accept(); },
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
  return { values, sessionValues, alerts, confirmations, rollingCheckpoints, reloads: () => reloads, recover, faults };
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



test('backup validator preserves loader-repairable legacy fields and unknown properties without mutating records', () => {
  const validate = vm.runInNewContext(
    '(' + extractTopLevelSource('validateBackup') + ')',
    backupValidationContext()
  );
  const backup = integrationBackup({
    tasks: [], dailyLogs: [],
    thoughts: [{ id: 1, customField: { retained: true } }],
    projects: [{ id: 4, status: 'legacy-status', extension: 'kept' }]
  });
  const before = JSON.stringify(backup);

  assert.equal(validate(backup).valid, true);
  assert.equal(JSON.stringify(backup), before);
  assert.equal(backup.data.thoughts[0].customField.retained, true);
  assert.equal(backup.data.projects[0].extension, 'kept');
});

test('backup validator rejects duplicate or invalid stable identifiers in thought and project records', () => {
  const validate = vm.runInNewContext(
    '(' + extractTopLevelSource('validateBackup') + ')',
    backupValidationContext()
  );
  const validThought = { id: 1, text: 'فكرة', createdAt: 'stored-date', extra: 'preserve' };
  const validProject = { id: 3, name: 'مشروع', status: 'active', createdAt: 'stored-date', extra: 'preserve' };
  const cases = [
    { thoughts: [validThought, { ...validThought, text: 'أخرى' }], reason: 'معرّف خاطرة مكرر' },
    { thoughts: [{ ...validThought, id: 0 }], reason: 'معرّف خاطرة غير صالح' },
    { projects: [validProject, { ...validProject, name: 'مشروع آخر' }], reason: 'معرّف مشروع مكرر' },
    { projects: [{ ...validProject, id: -1 }], reason: 'معرّف مشروع غير صالح' }
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

test('backup validator checks convertedTaskId type but preserves deleted-task history', () => {
  const validate = vm.runInNewContext(
    '(' + extractTopLevelSource('validateBackup') + ')',
    backupValidationContext()
  );
  const historicalReference = validate(integrationBackup({
    tasks: [], dailyLogs: [],
    mentalInbox: [{ id: 1, text: 'فكرة محوّلة', createdAt: 'legacy', convertedTaskId: 987654 }]
  }));
  assert.equal(historicalReference.valid, true, 'a deleted task may remain as historical archive metadata');

  const malformedReference = validate(integrationBackup({
    tasks: [], dailyLogs: [],
    mentalInbox: [{ id: 1, text: 'فكرة', createdAt: 'legacy', convertedTaskId: 'not-an-id' }]
  }));
  assert.equal(malformedReference.valid, false);
  assert.match(malformedReference.reason, /مرجع المهمة المحوّلة غير صالح/);
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


test('backup preview discloses the legacy partial-to-pending conversion before final confirmation', () => {
  const backup = integrationBackup({
    tasks: [validationTask({ id: 12, status: 'partial' })],
    dailyLogs: []
  });
  const harness = runImportPreviewIntegration(backup, 'previous-timer');

  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0].body, /1 مهمة بحالة partial/);
  assert.match(harness.confirmations[0].body, /سيحوّلها التطبيق إلى pending/);
  assert.match(harness.confirmations[0].body, /يمكنك إلغاء العملية/);
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

  const restored = JSON.parse(harness.values.get(STORAGE_KEYS.MAIN));
  assert.equal(restored.settings.themeMode, 'system');
  assert.equal(harness.values.get('timeTasksApp_focusTimer'), JSON.stringify(timerSnapshot));
  assert.equal(harness.values.has(STORAGE_KEYS.IMPORT_IN_PROGRESS), false);
  assert.equal(harness.reloads(), 1);
  assert.equal(harness.rollingCheckpoints.length, 1);
  assert.equal(harness.rollingCheckpoints[0].reason, 'import-success');
  assert.equal(harness.rollingCheckpoints[0].main, harness.values.get(STORAGE_KEYS.MAIN));
  assert.equal(harness.rollingCheckpoints[0].importMarkerPresent, false,
    'checkpoint must be captured only after the import marker is cleared');
  assert.deepEqual(harness.alerts, []);
});

test('legacy V1 import without focusTimer preserves the device timer and maps legacy darkMode', () => {
  const backup = integrationBackup({
    settings: { operationalDayStart: 4, firstUseDate: '2026-11-20', darkMode: true },
    tasks: [validationTask({ id: 91, projectId: 42 })], dailyLogs: []
  });
  const harness = runImportPreviewIntegration(backup, 'keep-existing-timer');

  const restored = JSON.parse(harness.values.get(STORAGE_KEYS.MAIN));
  assert.equal(restored.settings.themeMode, 'dark');
  assert.equal(restored.tasks[0].projectId, null, 'unverifiable legacy project links are detached safely');
  assert.equal(harness.values.get(STORAGE_KEYS.PROJECTS), 'previous-projects');
  assert.equal(harness.values.get('timeTasksApp_focusTimer'), 'keep-existing-timer');
  assert.equal(harness.values.has(STORAGE_KEYS.IMPORT_IN_PROGRESS), false);
  assert.equal(harness.reloads(), 1);
  assert.deepEqual(harness.alerts, []);
});


const RESTORE_KEY_CASES = [
  [STORAGE_KEYS.MAIN, 'main', 'main'],
  [STORAGE_KEYS.FOCUS_SESSIONS, 'focusSessions', 'focusSessions'],
  [STORAGE_KEYS.FOCUS_TIMER, 'focusTimer', 'focusTimer'],
  [STORAGE_KEYS.MENTAL_INBOX, 'mentalInbox', 'mentalInbox'],
  [STORAGE_KEYS.THOUGHTS, 'thoughts', 'thoughts'],
  [STORAGE_KEYS.PROJECTS, 'projects', 'projects'],
  [STORAGE_KEYS.FOCUS_SETTINGS, 'focusSettings', 'focusSettings'],
  [STORAGE_KEYS.NOTIFICATIONS, 'notifications', 'notifications']
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
      [STORAGE_KEYS.IMPORT_IN_PROGRESS]: '1',
      [STORAGE_KEYS.PRE_IMPORT]: JSON.stringify(previous)
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
    assert.equal(storage.getItem(STORAGE_KEYS.IMPORT_IN_PROGRESS), null);
    assert.equal(storage.getItem(STORAGE_KEYS.PRE_IMPORT), null);
  }
});

test('interrupted-import recovery preserves marker and snapshot when either control key cannot be read', () => {
  const previous = storageSnapshot('previous');
  previous.main = JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} });
  for (const failedKey of [STORAGE_KEYS.IMPORT_IN_PROGRESS, STORAGE_KEYS.PRE_IMPORT]) {
    const faults = { throwOnGetKey: failedKey };
    const storage = memoryStorage({
      [STORAGE_KEYS.IMPORT_IN_PROGRESS]: '1',
      [STORAGE_KEYS.PRE_IMPORT]: JSON.stringify(previous),
      [STORAGE_KEYS.MAIN]: 'partially-imported-main'
    }, faults);
    const harness = restoreContext(storage);
    const recover = vm.runInNewContext(
      extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
      extractTopLevelSource('_recoverInterruptedImport') + '\n_recoverInterruptedImport',
      harness.context
    );

    assert.equal(recover(), false, failedKey);
    faults.throwOnGetKey = null;
    assert.equal(storage.getItem(STORAGE_KEYS.IMPORT_IN_PROGRESS), '1');
    assert.equal(storage.getItem(STORAGE_KEYS.PRE_IMPORT), JSON.stringify(previous));
    assert.equal(storage.getItem(STORAGE_KEYS.MAIN), 'partially-imported-main');
  }
});

test('failure to write either import control key does not change any user data collection', () => {
  const backup = integrationBackup({ tasks: [], dailyLogs: [] });
  const original = {
    [STORAGE_KEYS.MAIN]: JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} }),
    [STORAGE_KEYS.FOCUS_SESSIONS]: 'previous-sessions',
    [STORAGE_KEYS.FOCUS_TIMER]: 'previous-timer',
    [STORAGE_KEYS.MENTAL_INBOX]: 'previous-inbox',
    [STORAGE_KEYS.THOUGHTS]: 'previous-thoughts',
    [STORAGE_KEYS.PROJECTS]: 'previous-projects',
    [STORAGE_KEYS.FOCUS_SETTINGS]: 'previous-focus-settings',
    [STORAGE_KEYS.NOTIFICATIONS]: 'previous-notifications'
  };
  for (const failedKey of [STORAGE_KEYS.PRE_IMPORT, STORAGE_KEYS.IMPORT_IN_PROGRESS]) {
    const harness = runImportPreviewIntegration(backup, 'previous-timer', { throwOnSetKey: failedKey });
    for (const [key, value] of Object.entries(original)) {
      assert.equal(harness.values.get(key), value, 'unchanged user data key: ' + key);
    }
    assert.equal(harness.reloads(), 0);
    assert.ok(harness.alerts.length > 0);
  }
});

test('failed recovery retains both the recovery marker and original snapshot, then succeeds on retry', () => {
  const previous = storageSnapshot('previous');
  previous.main = JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} });
  const faults = { throwOnSetKey: STORAGE_KEYS.THOUGHTS };
  const storage = memoryStorage({
    [STORAGE_KEYS.IMPORT_IN_PROGRESS]: '1',
    [STORAGE_KEYS.PRE_IMPORT]: JSON.stringify(previous),
    ...Object.fromEntries(RESTORE_KEY_CASES.map(([key, property]) => [key, 'partial-' + property]))
  }, faults);
  const harness = restoreContext(storage);
  const recover = vm.runInNewContext(
    extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
    extractTopLevelSource('_recoverInterruptedImport') + '\n_recoverInterruptedImport',
    harness.context
  );

  assert.equal(recover(), false);
  assert.equal(storage.getItem(STORAGE_KEYS.IMPORT_IN_PROGRESS), '1');
  assert.equal(storage.getItem(STORAGE_KEYS.PRE_IMPORT), JSON.stringify(previous));
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
    tasks: [{
      id: 11, name: 'مهمة مستعادة', status: 'pending', type: 'معرفية',
      expected: 35, actual: 10, plannedDate: '2026-11-20', plannedTime: '09:30',
      completedAt: null, createdAt: 1795150000000, projectId: 4, priority: 'high',
      recurrence: 'weekly', checklist: [{ text: 'خطوة', done: true }],
      customTaskField: { retained: true }
    }],
    dailyLogs: [{
      date: '2026-11-20', control: null, execution: null, wellbeing: null,
      energy: null, distractions: null, bufferUsed: null,
      mentalTask: 'تركيز', mentalNext: 'متابعة', createdAt: 1795150000000,
      updatedAt: 1795150001000, customLogField: 'retained'
    }],
    focusSessions: [{ id: 1, durationSec: 900, startedAt: '2026-11-20T09:00:00.000Z', custom: 'session' }],
    focusTimer: timerSnapshot,
    mentalInbox: [{ id: 2, text: 'فكرة', createdAt: 'legacy-created-at', custom: 7 }],
    thoughts: [{ id: 3, text: 'خاطرة', createdAt: 'legacy-created-at', custom: { kept: true } }],
    projects: [{ id: 4, name: 'مشروع', status: 'active', createdAt: 'legacy-created-at', extra: 'kept' }],
    focusSettings: { workMin: 25, shortMin: 5, longMin: 15, customDurationRule: 'keep' },
    notifications: { enabled: false, futurePreference: 'keep' }
  };
  const harness = runImportPreviewIntegration(integrationBackup(data), 'previous-timer');

  const restoredMain = JSON.parse(harness.values.get(STORAGE_KEYS.MAIN));
  assert.deepEqual(restoredMain.tasks, data.tasks);
  assert.equal(restoredMain.tasks[0].id, 11);
  assert.deepEqual(restoredMain.tasks[0].customTaskField, { retained: true });
  assert.deepEqual(restoredMain.dailyLogs, data.dailyLogs);
  assert.equal(restoredMain.dailyLogs[0].customLogField, 'retained');
  assert.deepEqual(restoredMain.settings.customSetting, data.settings.customSetting);
  assert.deepEqual(JSON.parse(harness.values.get('timeTasksApp_focusSessions')), data.focusSessions);
  assert.equal(harness.values.get('timeTasksApp_focusTimer'), JSON.stringify(timerSnapshot));
  assert.deepEqual(JSON.parse(harness.values.get('timeTasksApp_mentalInbox')), data.mentalInbox);
  assert.deepEqual(JSON.parse(harness.values.get(STORAGE_KEYS.THOUGHTS)), data.thoughts);
  assert.deepEqual(JSON.parse(harness.values.get(STORAGE_KEYS.PROJECTS)), data.projects);
  assert.deepEqual(JSON.parse(harness.values.get(STORAGE_KEYS.FOCUS_SETTINGS)), data.focusSettings);
  assert.deepEqual(JSON.parse(harness.values.get(STORAGE_KEYS.NOTIFICATIONS)), data.notifications);
});

const IMPORT_WRITE_KEYS = [
  STORAGE_KEYS.MAIN,
  STORAGE_KEYS.FOCUS_SESSIONS,
  STORAGE_KEYS.FOCUS_TIMER,
  STORAGE_KEYS.MENTAL_INBOX,
  STORAGE_KEYS.THOUGHTS,
  STORAGE_KEYS.PROJECTS,
  STORAGE_KEYS.FOCUS_SETTINGS,
  STORAGE_KEYS.NOTIFICATIONS
];

test('extra settings survive import, app settings load, and the next ordinary save', () => {
  const backup = integrationBackup({
    settings: {
      operationalDayStart: 4,
      firstUseDate: '2026-11-20',
      darkMode: false,
      themeMode: 'system',
      customSetting: { keep: true },
      futurePreference: ['one', 'two']
    },
    tasks: [], dailyLogs: []
  });
  const imported = runImportPreviewIntegration(backup, 'previous-timer');
  const restoredMain = JSON.parse(imported.values.get(STORAGE_KEYS.MAIN));
  const storage = {
    getItem(key) { return imported.values.has(key) ? imported.values.get(key) : null; },
    setItem(key, value) { imported.values.set(key, String(value)); }
  };
  const context = {
    STORAGE_KEY: STORAGE_KEYS.MAIN,
    CURRENT_SCHEMA_VERSION: 2,
    APP_VERSION: '2.9.0',
    localStorage: storage,
    appSettings: {},
    tasks: restoredMain.tasks,
    storageRecoveryRequired: false,
    _mainStorageBaselineReady: false,
    _mainStorageExternalChangeObserved: false,
    _mainStorageBaselineRaw: null,
    _setMainStorageBaseline(raw) {
      context._mainStorageBaselineRaw = raw;
      context._mainStorageBaselineReady = true;
      context._mainStorageExternalChangeObserved = false;
    },
    todayStr: () => '2026-11-21',
    _applyThemePreference: () => {},
    _pruneLastRecurringDates: () => {},
    validateV2: () => true,
    _queueAllTaskReminderSync: () => {},
    showAlertModal: () => {},
    console: { error: () => {} }
  };
  context._copyStorageRecord = loadTopLevelFunction('_copyStorageRecord');
  const loadSettings = vm.runInNewContext(
    '(' + extractTopLevelSource('_loadAppSettings') + ')',
    context
  );
  loadSettings(restoredMain.settings);
  context.appSettings.themeMode = 'dark';
  context.appSettings.darkMode = true;
  context.appSettings.lastTaskId = 12;

  const saveData = vm.runInNewContext(
    '(' + extractTopLevelSource('saveData') + ')',
    context
  );
  assert.equal(saveData(), true);

  const saved = JSON.parse(imported.values.get(STORAGE_KEYS.MAIN));
  assert.deepEqual(saved.settings.customSetting, { keep: true });
  assert.deepEqual(saved.settings.futurePreference, ['one', 'two']);
  assert.equal(saved.settings.themeMode, 'dark');
  assert.equal(saved.settings.darkMode, true);
  assert.equal(saved.settings.lastTaskId, 12);
});

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
    assert.equal(harness.values.get(STORAGE_KEYS.MAIN), JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} }));
    assert.equal(harness.values.get('timeTasksApp_focusSessions'), 'previous-sessions');
    assert.equal(harness.values.get('timeTasksApp_focusTimer'), 'previous-timer');
    assert.equal(harness.values.get('timeTasksApp_mentalInbox'), 'previous-inbox');
    assert.equal(harness.values.get(STORAGE_KEYS.THOUGHTS), 'previous-thoughts');
    assert.equal(harness.values.get(STORAGE_KEYS.PROJECTS), 'previous-projects');
    assert.equal(harness.values.get(STORAGE_KEYS.FOCUS_SETTINGS), 'previous-focus-settings');
    assert.equal(harness.values.get(STORAGE_KEYS.NOTIFICATIONS), 'previous-notifications');
    assert.equal(harness.values.has(STORAGE_KEYS.IMPORT_IN_PROGRESS), false);
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
  const faults = {
    failSetOnceKey: STORAGE_KEYS.NOTIFICATIONS,
    failSetAt: { [STORAGE_KEYS.THOUGHTS]: 2 }
  };
  const harness = runImportPreviewIntegration(integrationBackup(data), 'previous-timer', faults);

  assert.equal(harness.reloads(), 0);
  assert.ok(harness.alerts.length > 0);
  assert.equal(harness.values.get(STORAGE_KEYS.IMPORT_IN_PROGRESS), '1');
  assert.ok(harness.values.has(STORAGE_KEYS.PRE_IMPORT));

  delete faults.failSetAt.thoughts;
  assert.equal(harness.recover(), true);
  assert.equal(harness.values.get(STORAGE_KEYS.MAIN), JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} }));
  assert.equal(harness.values.get('timeTasksApp_focusSessions'), 'previous-sessions');
  assert.equal(harness.values.get('timeTasksApp_focusTimer'), 'previous-timer');
  assert.equal(harness.values.get('timeTasksApp_mentalInbox'), 'previous-inbox');
  assert.equal(harness.values.get(STORAGE_KEYS.THOUGHTS), 'previous-thoughts');
  assert.equal(harness.values.get(STORAGE_KEYS.PROJECTS), 'previous-projects');
  assert.equal(harness.values.get(STORAGE_KEYS.FOCUS_SETTINGS), 'previous-focus-settings');
  assert.equal(harness.values.get(STORAGE_KEYS.NOTIFICATIONS), 'previous-notifications');
});


test('snapshot capture read failure for every storage key aborts import before any storage write', () => {
  const backup = integrationBackup({ tasks: [], dailyLogs: [] });
  for (const key of IMPORT_WRITE_KEYS) {
    const harness = runImportPreviewIntegration(backup, 'previous-timer', { throwOnGetKey: key });
    assert.equal(harness.reloads(), 0, 'must not reload after snapshot read failure: ' + key);
    assert.ok(harness.alerts.length > 0, 'must report snapshot read failure: ' + key);
    assert.equal(harness.values.get(STORAGE_KEYS.MAIN), JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} }));
    assert.equal(harness.values.get('timeTasksApp_focusSessions'), 'previous-sessions');
    assert.equal(harness.values.get('timeTasksApp_focusTimer'), 'previous-timer');
    assert.equal(harness.values.get('timeTasksApp_mentalInbox'), 'previous-inbox');
    assert.equal(harness.values.get(STORAGE_KEYS.THOUGHTS), 'previous-thoughts');
    assert.equal(harness.values.get(STORAGE_KEYS.PROJECTS), 'previous-projects');
    assert.equal(harness.values.get(STORAGE_KEYS.FOCUS_SETTINGS), 'previous-focus-settings');
    assert.equal(harness.values.get(STORAGE_KEYS.NOTIFICATIONS), 'previous-notifications');
    assert.equal(harness.values.has(STORAGE_KEYS.IMPORT_IN_PROGRESS), false);
    assert.equal(harness.values.has(STORAGE_KEYS.PRE_IMPORT), false);
  }
});

test('manual undo marks restoration in progress and startup recovery completes a failed undo', () => {
  const previous = storageSnapshot('previous');
  previous.main = JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [], settings: {} });
  const faults = { throwOnSetKey: STORAGE_KEYS.PROJECTS };
  const storage = memoryStorage({
    [STORAGE_KEYS.MAIN]: 'current-main',
    [STORAGE_KEYS.FOCUS_SESSIONS]: 'current-sessions',
    [STORAGE_KEYS.FOCUS_TIMER]: 'current-timer',
    [STORAGE_KEYS.MENTAL_INBOX]: 'current-inbox',
    [STORAGE_KEYS.THOUGHTS]: 'current-thoughts',
    [STORAGE_KEYS.PROJECTS]: 'current-projects',
    [STORAGE_KEYS.FOCUS_SETTINGS]: 'current-settings',
    [STORAGE_KEYS.NOTIFICATIONS]: 'current-notifications',
    [STORAGE_KEYS.PRE_IMPORT]: JSON.stringify(previous)
  }, faults);
  const harness = restoreContext(storage);
  harness.context.showConfirmModal = (_title, _body, accept) => accept();
  harness.context.showAlertModal = (...args) => { harness.context.alerts.push(args); };
  harness.context.alerts = [];
  harness.context.sessionStorage = { setItem() {} };
  harness.context.location = { reload() { harness.context.reloads++; } };
  harness.context.reloads = 0;

  const undo = vm.runInNewContext(
    extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
    extractTopLevelSource('undoLastImport') + '\nundoLastImport',
    harness.context
  );

  undo();
  assert.equal(storage.getItem(STORAGE_KEYS.IMPORT_IN_PROGRESS), '1');
  assert.equal(storage.getItem(STORAGE_KEYS.PRE_IMPORT), JSON.stringify(previous));
  assert.equal(harness.context.reloads, 0);
  assert.equal(harness.context.alerts.length, 1);

  faults.throwOnSetKey = null;
  const recover = vm.runInNewContext(
    extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
    extractTopLevelSource('_recoverInterruptedImport') + '\n_recoverInterruptedImport',
    harness.context
  );
  assert.equal(recover(), true);
  for (const [key, property] of [
    [STORAGE_KEYS.MAIN, 'main'],
    [STORAGE_KEYS.FOCUS_SESSIONS, 'focusSessions'],
    [STORAGE_KEYS.FOCUS_TIMER, 'focusTimer'],
    [STORAGE_KEYS.MENTAL_INBOX, 'mentalInbox'],
    [STORAGE_KEYS.THOUGHTS, 'thoughts'],
    [STORAGE_KEYS.PROJECTS, 'projects'],
    [STORAGE_KEYS.FOCUS_SETTINGS, 'focusSettings'],
    [STORAGE_KEYS.NOTIFICATIONS, 'notifications']
  ]) {
    assert.equal(storage.getItem(key), previous[property]);
  }
  assert.equal(storage.getItem(STORAGE_KEYS.IMPORT_IN_PROGRESS), null);
  assert.equal(storage.getItem(STORAGE_KEYS.PRE_IMPORT), null);
});


test('snapshot restore rejects a missing collection field before touching any stored value', () => {
  const before = {
    [STORAGE_KEYS.MAIN]: 'current-main',
    [STORAGE_KEYS.FOCUS_SESSIONS]: 'current-sessions',
    [STORAGE_KEYS.FOCUS_TIMER]: 'current-timer',
    [STORAGE_KEYS.MENTAL_INBOX]: 'current-inbox',
    [STORAGE_KEYS.THOUGHTS]: 'current-thoughts',
    [STORAGE_KEYS.PROJECTS]: 'current-projects',
    [STORAGE_KEYS.FOCUS_SETTINGS]: 'current-settings',
    [STORAGE_KEYS.NOTIFICATIONS]: 'current-notifications'
  };
  const storage = memoryStorage(before);
  const harness = restoreContext(storage);
  const restore = vm.runInNewContext(
    '(' + extractTopLevelSource('_restoreStorageSnapshot') + ')',
    harness.context
  );
  const incomplete = storageSnapshot('previous');
  delete incomplete.projects;

  assert.equal(restore(incomplete), false);
  for (const [key, value] of Object.entries(before)) {
    assert.equal(storage.getItem(key), value, 'no collection may be deleted or changed: ' + key);
  }
  assert.equal(harness.context.storageRecoveryRequired, true);
});

test('interrupted recovery refuses an incomplete snapshot and preserves its marker and bytes', () => {
  const previous = storageSnapshot('previous');
  previous.main = JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [] });
  delete previous.notifications;
  const rawSnapshot = JSON.stringify(previous);
  const partiallyImported = {
    [STORAGE_KEYS.MAIN]: 'partial-main',
    [STORAGE_KEYS.FOCUS_SESSIONS]: 'partial-sessions',
    [STORAGE_KEYS.FOCUS_TIMER]: 'partial-timer',
    [STORAGE_KEYS.MENTAL_INBOX]: 'partial-inbox',
    [STORAGE_KEYS.THOUGHTS]: 'partial-thoughts',
    [STORAGE_KEYS.PROJECTS]: 'partial-projects',
    [STORAGE_KEYS.FOCUS_SETTINGS]: 'partial-settings',
    [STORAGE_KEYS.NOTIFICATIONS]: 'partial-notifications',
    [STORAGE_KEYS.IMPORT_IN_PROGRESS]: '1',
    [STORAGE_KEYS.PRE_IMPORT]: rawSnapshot
  };
  const storage = memoryStorage(partiallyImported);
  const harness = restoreContext(storage);
  const recover = vm.runInNewContext(
    extractTopLevelSource('_restoreStorageSnapshot') + '\n' +
    extractTopLevelSource('_recoverInterruptedImport') + '\n_recoverInterruptedImport',
    harness.context
  );

  assert.equal(recover(), false);
  for (const [key, value] of Object.entries(partiallyImported)) {
    assert.equal(storage.getItem(key), value, 'must preserve data and recovery evidence: ' + key);
  }
});

test('manual undo reports restored data separately when only backup cleanup fails', () => {
  const previous = storageSnapshot('previous');
  previous.main = JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [] });
  const storage = memoryStorage(
    { [STORAGE_KEYS.PRE_IMPORT]: JSON.stringify(previous) },
    { throwOnRemoveKey: STORAGE_KEYS.PRE_IMPORT }
  );
  const harness = restoreContext(storage);
  const alerts = [];
  let reloads = 0;
  harness.context.showConfirmModal = (_title, _body, accept) => accept();
  harness.context.showAlertModal = (...args) => alerts.push(args);
  harness.context.validateV2 = () => true;
  harness.context._restoreStorageSnapshot = () => true;
  harness.context.sessionStorage = { setItem() {} };
  harness.context.location = { reload() { reloads++; } };
  const rollingCheckpoints = [];
  harness.context._storeRollingRecoveryBackup = (reason) => {
    rollingCheckpoints.push({
      reason,
      importMarkerPresent: storage.getItem(STORAGE_KEYS.IMPORT_IN_PROGRESS) !== null,
      main: storage.getItem(STORAGE_KEYS.MAIN)
    });
    return true;
  };

  const undo = vm.runInNewContext(
    extractTopLevelSource('undoLastImport') + '\nundoLastImport',
    harness.context
  );
  undo();

  assert.equal(storage.getItem(STORAGE_KEYS.IMPORT_IN_PROGRESS), null);
  assert.equal(storage.getItem(STORAGE_KEYS.PRE_IMPORT), JSON.stringify(previous));
  assert.equal(reloads, 1);
  assert.equal(alerts.length, 1);
  assert.match(String(alerts[0][0]), /تم الاسترجاع مع بقاء نسخة التراجع/);
  assert.equal(rollingCheckpoints.length, 1);
  assert.equal(rollingCheckpoints[0].reason, 'import-undo');
  assert.equal(rollingCheckpoints[0].importMarkerPresent, false);
  assert.equal(rollingCheckpoints[0].main, storage.getItem(STORAGE_KEYS.MAIN));
  assert.doesNotMatch(String(alerts[0][0]), /فشل الاسترجاع/);
});

test('legacy import preview distinguishes replaced primary data from preserved optional collections', () => {
  const backup = integrationBackup({ tasks: [], dailyLogs: [] });
  const harness = runImportPreviewIntegration(backup, 'previous-timer');
  const preview = harness.confirmations[0].body;

  assert.match(preview, /ستُستبدل المهام وسجلات الأيام وإعدادات التطبيق/);
  assert.match(preview, /المجموعات غير الموجودة في الملف ستبقى كما هي على هذا الجهاز/);
  assert.match(preview, /مؤقت التركيز/);
  assert.doesNotMatch(preview, /سيتم استبدال كل البيانات الحالية/);
});


test('legacy import detaches a preserved device timer from a reused task ID with a different identity', () => {
  const previousMain = {
    schemaVersion: 2,
    settings: {},
    tasks: [{ id: 5, name: 'المهمة القديمة', createdAt: 1000 }],
    dailyLogs: []
  };
  const importedTask = {
    id: 5, name: 'المهمة الجديدة', status: 'pending', type: 'معرفية',
    expected: 25, actual: null, plannedDate: '2026-11-21', plannedTime: '',
    completedAt: null, createdAt: 2000
  };
  const legacyBackup = integrationBackup({ tasks: [importedTask], dailyLogs: [] });
  const previousTimer = {
    mode: 'pomodoro', phase: 'work', running: false, baseElapsed: 120,
    startedAt: null, cyclePosition: 0, taskId: 5, sessionStartAt: 1000,
    awaitingConfirmation: false, pendingPhaseEndedAt: null
  };
  const harness = runImportPreviewIntegration(
    legacyBackup, JSON.stringify(previousTimer), {}, previousMain
  );

  const restoredTimer = JSON.parse(harness.values.get(STORAGE_KEYS.FOCUS_TIMER));
  assert.equal(restoredTimer.taskId, null);
  assert.equal(restoredTimer.baseElapsed, 120, 'timer progress itself is preserved');
});


test('legacy import clears imported project links when preserving device projects without backup mapping', () => {
  const previousMain = {
    schemaVersion: 2,
    settings: {},
    tasks: [{ id: 1, name: 'مهمة سابقة', createdAt: 1000 }],
    dailyLogs: []
  };
  const importedTask = {
    id: 2, name: 'مهمة مستوردة', status: 'pending', type: 'معرفية',
    expected: 25, actual: null, plannedDate: '2026-11-21', plannedTime: '',
    completedAt: null, createdAt: 2000, projectId: 12
  };
  const backup = integrationBackup({ tasks: [importedTask], dailyLogs: [] });
  const currentProjects = JSON.stringify([{ id: 12, name: 'مشروع هذا الجهاز' }]);
  const harness = runImportPreviewIntegration(
    backup, null, {}, previousMain, currentProjects
  );

  const importedMain = JSON.parse(harness.values.get(STORAGE_KEYS.MAIN));
  assert.equal(importedMain.tasks[0].projectId, null);
  assert.equal(harness.values.get(STORAGE_KEYS.PROJECTS), currentProjects);
  assert.match(harness.confirmations[0].body, /تُفصل مراجع المشاريع/);
});

test('import refuses to proceed when rollback snapshot or marker readback cannot be verified', () => {
  const backup = integrationBackup({ tasks: [], dailyLogs: [] });
  for (const failedKey of [STORAGE_KEYS.PRE_IMPORT, STORAGE_KEYS.IMPORT_IN_PROGRESS]) {
    const faults = { throwOnGetKey: failedKey };
    const harness = runImportPreviewIntegration(backup, 'previous-timer', faults);

    assert.equal(harness.reloads(), 0, 'must not reload if a safety checkpoint is unreadable');
    assert.ok(harness.alerts.length > 0, 'must report the failed safety checkpoint');
    assert.equal(harness.values.get(STORAGE_KEYS.MAIN), JSON.stringify({
      schemaVersion: 2, tasks: [], dailyLogs: [], settings: {}
    }));
    assert.equal(harness.values.get(STORAGE_KEYS.IMPORT_IN_PROGRESS), undefined);
    assert.equal(harness.values.get(STORAGE_KEYS.PRE_IMPORT), undefined);
    assert.equal(harness.values.get(STORAGE_KEYS.FOCUS_TIMER), 'previous-timer');
  }
});
