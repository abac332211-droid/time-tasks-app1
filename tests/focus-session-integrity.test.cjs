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
  if (name === '_isTaskStorageLockHeld') return match[0];
  return [
    'function _isTaskStorageLockHeld() { return true; }',
    match[0]
  ].join('\n');
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

function createLogHarness({
  sessionStartAt = baseStart,
  initial = [],
  saveResult = true,
  maxSessions = 500
} = {}) {
  let sessions = initial.slice();
  let saveCalls = 0;
  const toasts = [];
  const sandbox = {
    FOCUS_MAX_SESSIONS: maxSessions,
    _stopwatchTransactionLockDepth: 1,
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
      if (!saveResult || !Array.isArray(records) || records.length > maxSessions) return false;
      sessions = records.slice();
      return true;
    },
    showToast: message => toasts.push(message),
    Date,
    console
  };
  vm.runInNewContext(
    extractFunction('_parseStrictFocusSessionTimestamp') + '\n' + extractFunction('_validateFocusSessionRecord') + '\n' +
    extractFunction('_logSession') + '\n' +
    extractFunction('_matchingFocusSessionRecords') + '\n' +
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
    extractFunction('_parseStrictFocusSessionTimestamp') + '\n' + extractFunction('_validateFocusSessionRecord') + '\n' + extractFunction('_loadSessions'),
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
    _stopwatchTransactionLockDepth: 1,
    _sessionsCache: [],
    _storageWriteAllowed: () => true,
    _writeSecondaryStorageVerified: () => { writes++; return true; },
    _storeRollingRecoveryBackup: () => true
  };
  vm.runInNewContext(
    extractFunction('_isTaskStorageLockHeld') + '\n' + extractFunction('_parseStrictFocusSessionTimestamp') + '\n' + extractFunction('_validateFocusSessionRecord') + '\n' + extractFunction('_saveSessions'),
    sandbox
  );

  assert.equal(sandbox._saveSessions([validSession(), validSession()]), false,
    'two records with the same ID cannot be committed');
  const inverted = validSession({ endedAt: new Date(baseStart - 1).toISOString() });
  assert.equal(sandbox._saveSessions([inverted]), false,
    'an end timestamp before its start must be rejected');
  const overLimit = Array.from({ length: 501 }, (_, index) => validSession({ id: index + 1 }));
  assert.equal(sandbox._saveSessions(overLimit), false,
    'the low-level saver must keep rejecting arrays above the retention limit');
  assert.equal(writes, 0);
  assert.deepEqual(sandbox._sessionsCache, []);
});

test('session saver refuses to write without shared Web Lock ownership', () => {
  let writes = 0;
  const sandbox = {
    FOCUS_MAX_SESSIONS: 500,
    FOCUS_SESSIONS_KEY: 'focus-sessions',
    _stopwatchTransactionLockDepth: 0,
    _sessionsCache: [],
    _storageWriteAllowed: () => true,
    _writeSecondaryStorageVerified: () => { writes++; return true; },
    _storeRollingRecoveryBackup: () => true,
    console
  };
  sandbox._isTaskStorageLockHeld = () => false;
  vm.runInNewContext(extractFunction('_saveSessions'), sandbox);
  assert.equal(sandbox._saveSessions([validSession()]), false);
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

test('session logging retains all 499 existing sessions when adding the 500th', () => {
  const initial = Array.from({ length: 499 }, (_, index) => validSession({
    id: index + 1,
    startedAt: new Date(baseStart + index * 120_000).toISOString(),
    endedAt: new Date(baseStart + index * 120_000 + 60_000).toISOString()
  }));
  const sessionStartAt = baseStart + 499 * 120_000;
  const h = createLogHarness({ sessionStartAt, initial });

  assert.equal(h.sandbox._logSession('work', 60, true), true);
  assert.equal(h.sessions.length, 500);
  assert.equal(h.sessions[0].id, 1, 'the oldest row remains while capacity is still available');
  assert.equal(h.sessions[499].id, 500);
  assert.equal(h.saveCalls, 1);
});

test('session logging evicts exactly the oldest row before adding session 501', () => {
  const initial = Array.from({ length: 500 }, (_, index) => validSession({
    id: index + 1,
    startedAt: new Date(baseStart + index * 120_000).toISOString(),
    endedAt: new Date(baseStart + index * 120_000 + 60_000).toISOString()
  }));
  const sessionStartAt = baseStart + 500 * 120_000;
  const h = createLogHarness({ sessionStartAt, initial });

  assert.equal(h.sandbox._logSession('work', 60, true), true);
  assert.equal(h.sessions.length, 500);
  assert.equal(h.sessions[0].id, 2, 'only the oldest stored row is evicted');
  assert.equal(h.sessions[499].id, 501, 'the new row receives an ID above the pre-trim maximum');
  assert.equal(new Set(h.sessions.map(row => row.id)).size, 500);
  assert.equal(h.sessions[499].startedAt, new Date(sessionStartAt).toISOString());
  assert.equal(h.saveCalls, 1);
});

test('failed FIFO save leaves all 500 persisted sessions represented in the in-memory harness', () => {
  const initial = Array.from({ length: 500 }, (_, index) => validSession({
    id: index + 1,
    startedAt: new Date(baseStart + index * 120_000).toISOString(),
    endedAt: new Date(baseStart + index * 120_000 + 60_000).toISOString()
  }));
  const before = initial.map(row => ({ ...row }));
  const h = createLogHarness({
    sessionStartAt: baseStart + 500 * 120_000,
    initial,
    saveResult: false
  });

  assert.equal(h.sandbox._logSession('work', 60, true), false);
  assert.deepEqual(h.sessions, before, 'a failed write must not commit the evicted view');
  assert.equal(h.saveCalls, 1);
});

test('duplicate session recognition at capacity does not rotate or write history', () => {
  const sessionStartAt = baseStart + 500 * 120_000;
  const initial = Array.from({ length: 500 }, (_, index) => validSession({
    id: index + 1,
    startedAt: index === 499
      ? new Date(sessionStartAt).toISOString()
      : new Date(baseStart + index * 120_000).toISOString(),
    endedAt: index === 499
      ? new Date(sessionStartAt + 60_000).toISOString()
      : new Date(baseStart + index * 120_000 + 60_000).toISOString()
  }));
  const h = createLogHarness({ sessionStartAt, initial });

  assert.equal(h.sandbox._logSession('work', 60, true), true);
  assert.equal(h.sessions.length, 500);
  assert.equal(h.sessions[0].id, 1);
  assert.equal(h.sessions[499].id, 500);
  assert.equal(h.saveCalls, 0, 'idempotent replay must not evict another historical row');
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

test('session record validation rejects impossible calendar dates instead of accepting Date.parse normalization', () => {
  const impossibleDates = [
    '2026-02-30T00:00:00.000Z',
    '2026-04-31T00:00:00.000Z',
    '2025-02-29T00:00:00.000Z'
  ];
  for (const invalidDate of impossibleDates) {
    assert.equal(
      hValidate(validSession({ startedAt: invalidDate })),
      false,
      'impossible start date must be rejected: ' + invalidDate
    );
    assert.equal(
      hValidate(validSession({ endedAt: invalidDate })),
      false,
      'impossible end date must be rejected: ' + invalidDate
    );
  }
});

test('session record validation accepts February 29 in a leap year', () => {
  assert.equal(hValidate(validSession({
    startedAt: '2024-02-29T00:00:00.000Z',
    endedAt: '2024-02-29T00:01:00.000Z'
  })), true);
});

test('session and task IDs must be safe integers', () => {
  assert.equal(hValidate(validSession({ id: Number.MAX_SAFE_INTEGER + 1 })), false);
  assert.equal(hValidate(validSession({ taskId: Number.MAX_SAFE_INTEGER + 1 })), false);
});

test('session logging refuses to allocate an ID beyond Number.MAX_SAFE_INTEGER', () => {
  const highestIdSession = validSession({
    id: Number.MAX_SAFE_INTEGER,
    startedAt: new Date(baseStart + 120_000).toISOString(),
    endedAt: new Date(baseStart + 180_000).toISOString()
  });
  const h = createLogHarness({ initial: [highestIdSession] });

  assert.equal(h.sandbox._logSession('work', 60, true, baseStart + 60_000), false);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.saveCalls, 0, 'no write may occur when a unique safe ID cannot be allocated');
  assert.ok(h.toasts.length > 0);
});

function hValidate(session) {
  const sandbox = {};
  vm.runInNewContext(
    extractFunction('_parseStrictFocusSessionTimestamp') + '\n' +
    extractFunction('_validateFocusSessionRecord'),
    sandbox
  );
  return sandbox._validateFocusSessionRecord(session);
}
