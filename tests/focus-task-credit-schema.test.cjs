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

function extractFunction(name) {
  const pattern = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

const uuid = '123e4567-e89b-42d3-a456-426614174000';
function creditTask(overrides = {}) {
  return {
    id: 1, name: 'مهمة اختبار', status: 'pending', type: 'معرفية',
    expected: 30, actual: 25, plannedDate: '2026-11-26',
    plannedTime: '', completedAt: null, createdAt: 1,
    actualSeconds: 1540, creditRevision: 1,
    creditSchemaVersion: 1, lastCreditOperationId: uuid,
    ...overrides
  };
}

function context() {
  const sandbox = {
    VALID_STATUS: ['pending', 'done', 'cancelled'],
    VALID_TYPES: ['معرفية', 'بدنية', 'إدارية'],
    CURRENT_SCHEMA_VERSION: 2,
    BACKUP_FORMAT_VERSION: 2,
    FOCUS_MAX_SESSIONS: 500,
    isValidCalendarDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value),
    isValidLocalTime: value => value === '' || /^\d{2}:\d{2}$/.test(value),
    isValidLocalDateTime: value => typeof value === 'string',
    validateDailyLog: () => true,
    _validateLastRecurringDates: () => true,
    _validateFocusTimerBackupSnapshot: () => ({ valid: true })
  };
  vm.runInNewContext([
    extractFunction('_validateTaskCreditFields'),
    extractFunction('_parseStrictFocusSessionTimestamp'),
    extractFunction('_validateFocusSessionRecordV2'),
    extractFunction('_validateFocusSessionRecord'),
    extractFunction('validateV2'),
    extractFunction('validateBackup')
  ].join('\n'), sandbox);
  return sandbox;
}

test('legacy task without any credit metadata remains valid before migration', () => {
  const app = context();
  const legacy = creditTask();
  delete legacy.actualSeconds;
  delete legacy.creditRevision;
  delete legacy.creditSchemaVersion;
  delete legacy.lastCreditOperationId;
  assert.equal(app._validateTaskCreditFields(legacy), true);
  assert.equal(app.validateV2({ schemaVersion: 2, tasks: [legacy], dailyLogs: [] }), true);
});

test('a complete seconds balance must match the legacy minutes mirror', () => {
  const app = context();
  assert.equal(app._validateTaskCreditFields(creditTask()), true);
  assert.equal(app._validateTaskCreditFields(creditTask({ actualSeconds: 1540, actual: 25 })), true);
  assert.equal(app._validateTaskCreditFields(creditTask({ actualSeconds: 1540, actual: 26 })), false);
});

test('null seconds preserve null and do not silently become zero', () => {
  const app = context();
  assert.equal(app._validateTaskCreditFields(creditTask({
    actual: null, actualSeconds: null, creditRevision: 0, lastCreditOperationId: null
  })), true);
  assert.equal(app._validateTaskCreditFields(creditTask({
    actual: 0, actualSeconds: null, creditRevision: 0, lastCreditOperationId: null
  })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({
    actual: null, actualSeconds: 0, creditRevision: 0, lastCreditOperationId: null
  })), false);
});

test('credit revision and last operation ID must represent the same operation history state', () => {
  const app = context();

  assert.equal(app._validateTaskCreditFields(creditTask({
    actual: null,
    actualSeconds: null,
    creditRevision: 0,
    lastCreditOperationId: null
  })), true, 'revision zero is valid only before the first accepted operation');

  assert.equal(app._validateTaskCreditFields(creditTask({
    creditRevision: 0,
    lastCreditOperationId: uuid
  })), false, 'revision zero cannot claim a previously applied operation');

  assert.equal(app._validateTaskCreditFields(creditTask({
    creditRevision: 1,
    lastCreditOperationId: null
  })), false, 'a positive revision must retain the ID of the latest operation');

  assert.equal(app._validateTaskCreditFields(creditTask({
    creditRevision: 2,
    lastCreditOperationId: uuid
  })), true, 'later revisions remain valid with a valid latest operation ID');
});

test('stored data and backup validation both reject revision-operation mismatches', () => {
  const app = context();
  const backup = {
    backupFormatVersion: 1,
    schemaVersion: 2,
    data: { tasks: [], dailyLogs: [] }
  };
  const invalidTasks = [
    creditTask({ creditRevision: 0, lastCreditOperationId: uuid }),
    creditTask({ creditRevision: 1, lastCreditOperationId: null })
  ];

  for (const task of invalidTasks) {
    assert.equal(app.validateV2({
      schemaVersion: 2, tasks: [task], dailyLogs: []
    }), false, 'stored V2 task data must reject a mismatched pair');
    assert.equal(app.validateBackup({
      ...backup,
      data: { tasks: [task], dailyLogs: [] }
    }).valid, false, 'backup task data must reject the same mismatch');
  }
});

test('partial or unsafe credit metadata is rejected instead of repaired or dropped', () => {
  const app = context();
  assert.equal(app._validateTaskCreditFields(creditTask({ creditRevision: undefined })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({ creditRevision: -1 })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({ creditRevision: Number.MAX_SAFE_INTEGER + 1 })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({ actualSeconds: -1 })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({ creditSchemaVersion: 2 })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({ lastCreditOperationId: 'not-a-uuid' })), false);
});

test('credit revision zero has no operation ID and positive revisions require one', () => {
  const app = context();
  assert.equal(app._validateTaskCreditFields(creditTask({
    creditRevision: 0,
    lastCreditOperationId: null
  })), true);
  assert.equal(app._validateTaskCreditFields(creditTask({
    creditRevision: 0,
    lastCreditOperationId: uuid
  })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({
    creditRevision: 1,
    lastCreditOperationId: null
  })), false);
});

test('stored V2 validation and backup validation both enforce the same task-credit contract', () => {
  const app = context();
  const valid = creditTask();
  assert.equal(app.validateV2({ schemaVersion: 2, tasks: [valid], dailyLogs: [] }), true);
  assert.equal(app.validateV2({
    schemaVersion: 2, tasks: [creditTask({ actualSeconds: 1560, actual: 25 })], dailyLogs: []
  }), false);
  const backup = {
    backupFormatVersion: 1,
    schemaVersion: 2,
    data: { tasks: [valid], dailyLogs: [] }
  };
  assert.equal(app.validateBackup(backup).valid, true);
  assert.equal(app.validateBackup({
    ...backup,
    data: { tasks: [creditTask({ actualSeconds: 1560, actual: 25 })], dailyLogs: [] }
  }).valid, false);
});

 
test('backup validation rejects duplicate V2 sessionId even when record IDs differ', () => {
  const app = context();
  const session = {
    id: 41,
    recordVersion: 2,
    sessionId: uuid,
    mode: 'pomodoro',
    phase: 'work',
    taskId: 1,
    taskName: 'جلسة اختبار',
    startedAt: '2026-11-26T10:00:00.000Z',
    endedAt: '2026-11-26T10:25:00.000Z',
    activeDurationMs: 25 * 60 * 1000,
    durationSec: 25 * 60,
    plannedDurationMs: 25 * 60 * 1000,
    creditedSeconds: 25 * 60,
    creditSource: 'measured',
    outcome: 'completed',
    clockSource: 'performance_now',
    clockTrust: 'trusted',
    clockAdjusted: false,
    completed: true
  };
  const backup = {
    backupFormatVersion: 1,
    schemaVersion: 2,
    data: {
      tasks: [creditTask()],
      dailyLogs: [],
      focusSessions: [session]
    }
  };

  assert.equal(app.validateBackup(backup).valid, true,
    'a single valid V2 session must remain importable');
  const duplicate = { ...session, id: session.id + 1 };
  const rejected = app.validateBackup({
    ...backup,
    data: { ...backup.data, focusSessions: [session, duplicate] }
  });
  assert.equal(rejected.valid, false);
  assert.match(rejected.reason, /هوية جلسة تركيز V2 مكررة/,
    'the rejection must identify the duplicated logical session identity');
});
