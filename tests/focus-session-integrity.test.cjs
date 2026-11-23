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

const baseStart = 1_700_000_000_000;
function validSession(overrides = {}) {
  return {
    id: 1,
    mode: 'stopwatch',
    phase: 'work',
    taskId: 2,
    taskName: 'جلسة اختبار',
    startedAt: new Date(baseStart).toISOString(),
    endedAt: new Date(baseStart + 60_000).toISOString(),
    durationSec: 60,
    completed: true,
    ...overrides
  };
}

function createLogHarness({ sessionStartAt = baseStart, initial = [], saveResult = true } = {}) {
  let sessions = initial.slice();
  let saveCalls = 0;
  const toasts = [];
  const sandbox = {
    _focusTimer: {
      mode: 'stopwatch',
      phase: 'work',
      taskId: 2,
      sessionStartAt,
      clockAdjusted: false
    },
    tasks: [{ id: 2, name: 'مهمة الاختبار' }],
    _loadSessions: () => sessions.slice(),
    _saveSessions(records) {
      saveCalls++;
      if (!saveResult) return false;
      sessions = records.slice();
      return true;
    },
    showToast: message => toasts.push(message),
    Date,
    console
  };
  vm.runInNewContext(
    extractFunction('_validateFocusSessionRecord') + '\n' +
    extractFunction('_logSession') + '\n' +
    extractFunction('_sessionAlreadyLogged'),
    sandbox
  );
  return {
    sandbox, toasts,
    get sessions() { return sessions; },
    get saveCalls() { return saveCalls; }
  };
}

test('session loader preserves the exact corrupt source and locks storage instead of silently replacing records', () => {
  const good = validSession({ id: 1 });
  const duplicateId = validSession({
    id: 1,
    startedAt: new Date(baseStart + 120_000).toISOString(),
    endedAt: new Date(baseStart + 180_000).toISOString()
  });
  const raw = JSON.stringify([good, duplicateId]);
  let preserved = null;
  let writes = 0;
  const alerts = [];
  const sandbox = {
    FOCUS_SESSIONS_KEY: 'focus-sessions',
    FOCUS_MAX_SESSIONS: 500,
    _sessionsCache: null,
    _invalidFocusSessionsNoticeShown: false,
    storageRecoveryRequired: false,
    _trackSecondaryStorageRead: (_key, value) => value,
    localStorage: {
      getItem: () => raw,
      setItem: () => { writes++; }
    },
    _preserveCorruptStorageSnapshot: (key, value) => { preserved = { key, value }; return true; },
    showAlertModal: (...args) => alerts.push(args),
    console
  };
  vm.runInNewContext(
    extractFunction('_validateFocusSessionRecord') + '\n' + extractFunction('_loadSessions'),
    sandbox
  );

  const loaded = sandbox._loadSessions();
  assert.equal(loaded.length, 1, 'only the valid unique record is exposed to the app');
  assert.equal(loaded[0].id, 1);
  assert.equal(sandbox.storageRecoveryRequired, true);
  assert.deepEqual(preserved, { key: 'focus-sessions', value: raw });
  assert.equal(writes, 0, 'corrupt raw data must not be rewritten from the filtered in-memory view');
  assert.equal(alerts.length, 1);
});

test('session saver rejects duplicate IDs and invalid end-before-start records before writing', () => {
  let writes = 0;
  const sandbox = {
    FOCUS_MAX_SESSIONS: 500,
    FOCUS_SESSIONS_KEY: 'focus-sessions',
    storageRecoveryRequired: false,
    _sessionsCache: [],
    _storageWriteAllowed: () => true,
    _writeSecondaryStorageVerified: () => { writes++; return true; },
    _storeRollingRecoveryBackup: () => true
  };
  vm.runInNewContext(
    extractFunction('_validateFocusSessionRecord') + '\n' + extractFunction('_saveSessions'),
    sandbox
  );

  assert.equal(sandbox._saveSessions([validSession(), validSession()]), false,
    'two records with the same ID cannot be committed');
  const inverted = validSession({ endedAt: new Date(baseStart - 1).toISOString() });
  assert.equal(sandbox._saveSessions([inverted]), false,
    'an end timestamp before its start must be rejected');
  assert.equal(writes, 0);
  assert.deepEqual(sandbox._sessionsCache, []);
});

test('session logging corrects a supplied endpoint that disagrees with the measured duration', () => {
  const h = createLogHarness();
  const suppliedEnd = baseStart + 90_000;

  assert.equal(h.sandbox._logSession('work', 60, true, suppliedEnd), true);
  assert.equal(h.sessions.length, 1);
  const record = h.sessions[0];
  assert.equal(Date.parse(record.endedAt), baseStart + 60_000);
  assert.equal(Date.parse(record.endedAt) - Date.parse(record.startedAt), record.durationSec * 1000);
  assert.equal(record.clockAdjusted, true);
  assert.equal(h.sandbox._validateFocusSessionRecord(record), true);
  assert.equal(h.saveCalls, 1);
});

test('session logging is idempotent for an already saved session identity', () => {
  const existing = validSession({ id: 8 });
  const h = createLogHarness({ initial: [existing] });

  assert.equal(h.sandbox._logSession('work', 60, true, baseStart + 60_000), true);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.saveCalls, 0, 'duplicate recognition must not write a second record');
});

test('session logging rejects timestamps outside the JavaScript Date range without throwing', () => {
  const h = createLogHarness({ sessionStartAt: 9_000_000_000_000_000 });

  let result;
  assert.doesNotThrow(() => { result = h.sandbox._logSession('work', 60, true); });
  assert.equal(result, false);
  assert.equal(h.saveCalls, 0);
  assert.equal(h.sessions.length, 0);
  assert.ok(h.toasts.length > 0);
});

test('session logging rejects a computed end outside the JavaScript Date range without writing', () => {
  const h = createLogHarness();

  let result;
  assert.doesNotThrow(() => { result = h.sandbox._logSession('work', Number.MAX_VALUE, true); });
  assert.equal(result, false);
  assert.equal(h.saveCalls, 0);
  assert.equal(h.sessions.length, 0);
});

test('duplicate lookup safely returns false for an invalid session start timestamp', () => {
  const h = createLogHarness({ sessionStartAt: 9_000_000_000_000_000 });

  let result;
  assert.doesNotThrow(() => { result = h.sandbox._sessionAlreadyLogged('work', 60); });
  assert.equal(result, false);
});
