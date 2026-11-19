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
