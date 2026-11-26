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
    isValidCalendarDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value),
    isValidLocalTime: value => value === '' || /^\d{2}:\d{2}$/.test(value),
    isValidLocalDateTime: value => typeof value === 'string',
    validateDailyLog: () => true,
    _validateLastRecurringDates: () => true,
    _validateFocusTimerBackupSnapshot: () => ({ valid: true }),
    _validateFocusSessionRecord: () => true
  };
  vm.runInNewContext([
    extractFunction('_validateTaskCreditFields'),
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

test('partial or unsafe credit metadata is rejected instead of repaired or dropped', () => {
  const app = context();
  assert.equal(app._validateTaskCreditFields(creditTask({ creditRevision: undefined })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({ creditRevision: -1 })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({ creditRevision: Number.MAX_SAFE_INTEGER + 1 })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({ actualSeconds: -1 })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({ creditSchemaVersion: 2 })), false);
  assert.equal(app._validateTaskCreditFields(creditTask({ lastCreditOperationId: 'not-a-uuid' })), false);
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
