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
function validSession(overrides = {}) {
  return {
    id: 20,
    recordVersion: 2,
    sessionId: uuid,
    mode: 'pomodoro',
    phase: 'work',
    taskId: 2,
    taskName: 'جلسة V2',
    startedAt: '2026-11-26T10:00:00.000Z',
    endedAt: '2026-11-26T10:30:00.000Z',
    activeDurationMs: 25 * 60 * 1000,
    durationSec: 25 * 60,
    plannedDurationMs: 25 * 60 * 1000,
    creditedSeconds: 25 * 60,
    creditSource: 'measured',
    outcome: 'completed',
    clockSource: 'performance_now',
    clockTrust: 'trusted',
    clockAdjusted: false,
    completed: true,
    ...overrides
  };
}

function validatorContext() {
  const sandbox = {};
  vm.runInNewContext([
    extractFunction('_parseStrictFocusSessionTimestamp'),
    extractFunction('_validateFocusSessionRecordV2'),
    extractFunction('_validateFocusSessionRecord')
  ].join('\n'), sandbox);
  return sandbox;
}

test('V2 session permits civil timestamps to span pauses while active duration remains authoritative', () => {
  const app = validatorContext();
  const record = validSession();
  assert.equal(Date.parse(record.endedAt) - Date.parse(record.startedAt), 30 * 60 * 1000);
  assert.equal(record.activeDurationMs, 25 * 60 * 1000);
  assert.equal(app._validateFocusSessionRecord(record), true);
});

test('V2 session permits a reversed civil clock only when clockAdjusted is explicit', () => {
  const app = validatorContext();
  const record = validSession({
    outcome: 'ended_early',
    completed: false,
    activeDurationMs: 10 * 60 * 1000,
    durationSec: 10 * 60,
    creditedSeconds: 10 * 60,
    startedAt: '2026-11-26T10:05:00.000Z',
    endedAt: '2026-11-26T10:00:00.000Z',
    clockAdjusted: true
  });
  assert.equal(app._validateFocusSessionRecord(record), true);
  assert.equal(app._validateFocusSessionRecord({ ...record, clockAdjusted: false }), false);
});

test('V2 interrupted untrusted session may preserve no duration and never carry credit', () => {
  const app = validatorContext();
  const record = validSession({
    outcome: 'interrupted',
    completed: false,
    activeDurationMs: 0,
    durationSec: 0,
    creditedSeconds: 0,
    creditSource: 'none',
    clockTrust: 'untrusted',
    startedAt: null,
    endedAt: null
  });
  assert.equal(app._validateFocusSessionRecord(record), true);
  assert.equal(app._validateFocusSessionRecord({
    ...record, activeDurationMs: 1000, durationSec: 1
  }), false);
});

test('breaks and sessions without a task cannot carry task credit', () => {
  const app = validatorContext();
  assert.equal(app._validateFocusSessionRecord(validSession({
    phase: 'short-break',
    creditedSeconds: 0,
    creditSource: 'none'
  })), true);
  assert.equal(app._validateFocusSessionRecord(validSession({
    taskId: null, creditedSeconds: 0, creditSource: 'none'
  })), true);
  assert.equal(app._validateFocusSessionRecord(validSession({
    phase: 'short-break', creditedSeconds: 300, creditSource: 'measured'
  })), false);
  assert.equal(app._validateFocusSessionRecord(validSession({
    taskId: null, creditedSeconds: 300, creditSource: 'measured'
  })), false);
});

test('unknown record versions and inconsistent outcome fields are rejected', () => {
  const app = validatorContext();
  assert.equal(app._validateFocusSessionRecord({ ...validSession(), recordVersion: 3 }), false);
  assert.equal(app._validateFocusSessionRecord({ ...validSession(), completed: false }), false);
  assert.equal(app._validateFocusSessionRecord({
    ...validSession(), activeDurationMs: 20 * 60 * 1000, durationSec: 20 * 60
  }), false);
});

test('session loader preserves duplicate V2 session identities as a recovery conflict', () => {
  const first = validSession();
  const second = { ...first, id: first.id + 1 };
  const raw = JSON.stringify([first, second]);
  const sandbox = {
    _sessionsCache: null,
    _invalidFocusSessionsNoticeShown: false,
    FOCUS_SESSIONS_KEY: 'sessions',
    FOCUS_MAX_SESSIONS: 500,
    storageRecoveryRequired: false,
    localStorage: { getItem: () => raw },
    _trackSecondaryStorageRead: (_key, value) => value,
    _preserveCorruptStorageSnapshot() {},
    _validateFocusSessionRecord: validatorContext()._validateFocusSessionRecord,
    showAlertModal() {},
    console: { error() {} }
  };
  vm.runInNewContext(extractFunction('_loadSessions'), sandbox);
  const loaded = sandbox._loadSessions();
  assert.equal(loaded.length, 1);
  assert.equal(sandbox.storageRecoveryRequired, true);
});

test('session saver refuses duplicate V2 session identities before writing', () => {
  const first = validSession();
  const second = { ...first, id: first.id + 1 };
  let writes = 0;
  const sandbox = {
    FOCUS_MAX_SESSIONS: 500,
    FOCUS_SESSIONS_KEY: 'sessions',
    _sessionsCache: [],
    _isTaskStorageLockHeld: () => true,
    _storageWriteAllowed: () => true,
    _validateFocusSessionRecord: validatorContext()._validateFocusSessionRecord,
    _writeSecondaryStorageVerified: () => { writes++; return true; },
    _storeRollingRecoveryBackup: () => true
  };
  vm.runInNewContext(extractFunction('_saveSessions'), sandbox);
  assert.equal(sandbox._saveSessions([first, second]), false);
  assert.equal(writes, 0);
});
