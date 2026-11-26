'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = Array.from(html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi))
  .map(match => match[1])
  .filter(source => source.trim());
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
    id: 1,
    name: 'مهمة اختبار',
    status: 'pending',
    type: 'معرفية',
    expected: 30,
    actual: 25,
    plannedDate: '2026-11-26',
    plannedTime: '',
    completedAt: null,
    createdAt: 1,
    actualSeconds: 1540,
    creditRevision: 1,
    creditSchemaVersion: 1,
    lastCreditOperationId: uuid,
    ...overrides
  };
}

function createValidatorSandbox() {
  const sandbox = {
    VALID_STATUS: ['pending', 'done', 'cancelled'],
    VALID_TYPES: ['معرفية', 'بدنية', 'إدارية'],
    isValidCalendarDate: value => /^\\d{4}-\\d{2}-\\d{2}$/.test(value),
    isValidLocalTime: value => value === '' || /^\\d{2}:\\d{2}$/.test(value),
    isValidLocalDateTime: value => typeof value === 'string',
    validateDailyLog: () => true,
    _validateLastRecurringDates: () => true,
    _validateFocusTimerBackupSnapshot: () => ({ valid: true }),
    _validateFocusSessionRecord: () => true,
    FOCUS_MAX_SESSIONS: 500,
    CURRENT_SCHEMA_VERSION: 2,
    BACKUP_FORMAT_VERSION: 2
  };
  const source = [
    extractFunction('_validateTaskCreditFields'),
    extractFunction('validateV2'),
    extractFunction('validateBackup')
  ].join('\n');
  vm.runInNewContext(source, sandbox);
  return sandbox;
}

test('legacy tasks without credit fields remain valid', () => {
  const sandbox = createValidatorSandbox();
  const legacy = creditTask();
  delete legacy.actualSeconds;
  delete legacy.creditRevision;
  delete legacy.creditSchemaVersion;
  delete legacy.lastCreditOperationId;

  assert.equal(sandbox._validateTaskCreditFields(legacy), true);
});

test('task credit fields validate a non-null seconds balance against legacy minutes', () => {
  const sandbox = createValidatorSandbox();
  assert.equal(sandbox._validateTaskCreditFields(creditTask()), true);
  assert.equal(sandbox._validateTaskCreditFields(creditTask({
    actualSeconds: 1540,
    actual: 25
  })), true);
  assert.equal(sandbox._validateTaskCreditFields(creditTask({
    actualSeconds: 1540,
    actual: 26
  })), false);
});

test('a null seconds balance stays null and still requires a valid credit revision', () => {
  const sandbox = createValidatorSandbox();
  assert.equal(sandbox._validateTaskCreditFields(creditTask({
    actual: null,
    actualSeconds: null,
    creditRevision: 0,
    lastCreditOperationId: null
  })), true);
  assert.equal(sandbox._validateTaskCreditFields(creditTask({
    actual: 0,
    actualSeconds: null,
    creditRevision: 0,
    lastCreditOperationId: null
  })), false);
});

test('partial, negative, unsafe, or unknown credit metadata is rejected', () => {
  const sandbox = createValidatorSandbox();
  assert.equal(sandbox._validateTaskCreditFields(creditTask({ creditRevision: undefined })), false);
  assert.equal(sandbox._validateTaskCreditFields(creditTask({ creditRevision: -1 })), false);
  assert.equal(sandbox._validateTaskCreditFields(creditTask({ creditRevision: Number.MAX_SAFE_INTEGER + 1 })), false);
  assert.equal(sandbox._validateTaskCreditFields(creditTask({ actualSeconds: -1 })), false);
  assert.equal(sandbox._validateTaskCreditFields(creditTask({ creditSchemaVersion: 2 })), false);
  assert.equal(sandbox._validateTaskCreditFields(creditTask({ lastCreditOperationId: 'not-a-uuid' })), false);
});

test('stored schema validation accepts legacy tasks and rejects inconsistent credited seconds', () => {
  const sandbox = createValidatorSandbox();
  const base = {
    schemaVersion: 2,
    tasks: [creditTask()],
    dailyLogs: []
  };
  assert.equal(sandbox.validateV2(base), true);

  const legacy = creditTask();
  delete legacy.actualSeconds;
  delete legacy.creditRevision;
  delete legacy.creditSchemaVersion;
  delete legacy.lastCreditOperationId;
  assert.equal(sandbox.validateV2({ ...base, tasks: [legacy] }), true);

  assert.equal(sandbox.validateV2({
    ...base,
    tasks: [creditTask({ actualSeconds: 1500, actual: 25 })]
  }), false);
});

test('backup validation applies the same credit-balance contract without changing legacy backups', () => {
  const sandbox = createValidatorSandbox();
  const backup = {
    backupFormatVersion: 1,
    schemaVersion: 2,
    data: {
      tasks: [creditTask()],
      dailyLogs: []
    }
  };
  assert.equal(sandbox.validateBackup(backup).valid, true);

  const legacy = creditTask();
  delete legacy.actualSeconds;
  delete legacy.creditRevision;
  delete legacy.creditSchemaVersion;
  delete legacy.lastCreditOperationId;
  assert.equal(sandbox.validateBackup({
    ...backup,
    data: { tasks: [legacy], dailyLogs: [] }
  }).valid, true);

  const broken = sandbox.validateBackup({
    ...backup,
    data: { tasks: [creditTask({ actualSeconds: 1500, actual: 25 })], dailyLogs: [] }
  });
  assert.equal(broken.valid, false);
  assert.match(broken.reason, /رصيد الثواني/);
});
