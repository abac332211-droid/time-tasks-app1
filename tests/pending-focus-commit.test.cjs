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

const operationId = '123e4567-e89b-42d3-a456-426614174000';
const startedAtMs = Date.parse('2026-11-26T10:00:00.000Z');

function timerProjection(overrides = {}) {
  return {
    mode: 'stopwatch',
    phase: 'work',
    running: false,
    baseElapsed: 65,
    elapsedRemainderMs: 500,
    cyclePosition: 0,
    taskId: 7,
    sessionStartAt: startedAtMs,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false,
    nativeSessionToken: null,
    handledNotificationActionIds: [],
    pendingNotificationFinish: null,
    ...overrides
  };
}

function creditSnapshot(overrides = {}) {
  return {
    actualSeconds: null,
    actual: null,
    creditRevision: 0,
    creditSchemaVersion: 1,
    lastCreditOperationId: null,
    ...overrides
  };
}

function validPendingFocusCommit(overrides = {}) {
  const session = {
    recordVersion: 2,
    id: 21,
    sessionId: operationId,
    mode: 'stopwatch',
    phase: 'work',
    taskId: 7,
    taskName: 'مهمة اختبار',
    startedAt: '2026-11-26T10:00:00.000Z',
    endedAt: '2026-11-26T10:01:05.500Z',
    activeDurationMs: 65500,
    durationSec: 65,
    plannedDurationMs: null,
    creditedSeconds: 65,
    creditSource: 'measured',
    outcome: 'stopped',
    clockSource: 'performance_now',
    clockTrust: 'trusted',
    clockAdjusted: false,
    completed: false
  };
  const operation = {
    recordVersion: 1,
    operationId,
    kind: 'session',
    taskId: 7,
    revision: 1,
    previousSeconds: null,
    targetSeconds: 65,
    source: 'measured',
    sessionId: operationId,
    createdAt: '2026-11-26T10:01:05.500Z',
    measuredSeconds: 65,
    creditedSeconds: 65
  };
  return {
    protocolVersion: 1,
    operationId,
    taskId: 7,
    operation,
    session,
    creditBefore: creditSnapshot(),
    creditAfter: creditSnapshot({
      actualSeconds: 65,
      actual: 1,
      creditRevision: 1,
      lastCreditOperationId: operationId
    }),
    timerBefore: timerProjection(),
    timerAfter: timerProjection({
      baseElapsed: 0,
      elapsedRemainderMs: 0,
      cyclePosition: 0,
      sessionStartAt: null,
      awaitingConfirmation: false,
      pendingPhaseEndedAt: null,
      clockAdjusted: false,
      nativeSessionToken: null,
      pendingNotificationFinish: null
    }),
    stage: 'prepared',
    createdAt: '2026-11-26T10:01:05.500Z',
    updatedAt: '2026-11-26T10:01:05.500Z',
    ...overrides
  };
}

function validatorContext() {
  const sandbox = {};
  vm.runInNewContext([
    extractFunction('_parseStrictFocusSessionTimestamp'),
    extractFunction('_validateCreditOperationRecord'),
    extractFunction('_validateFocusSessionRecordV2'),
    extractFunction('_validatePendingFocusTimerProjection'),
    extractFunction('_validatePendingFocusCreditSnapshot'),
    extractFunction('_validatePendingFocusCommit')
  ].join('\n'), sandbox);
  return sandbox;
}

test('pending focus commit binds an exact V2 session, ledger operation, credit chain, and timer reset', () => {
  const app = validatorContext();
  assert.equal(app._validatePendingFocusCommit(validPendingFocusCommit()), true);
});

test('pending focus commit rejects an unknown stage or additional mutable payload field', () => {
  const app = validatorContext();
  assert.equal(app._validatePendingFocusCommit(validPendingFocusCommit({ stage: 'done' })), false);
  assert.equal(app._validatePendingFocusCommit(validPendingFocusCommit({ recoveredBy: 'another-tab' })), false);
});

test('pending focus commit requires operation ID and V2 session ID to be the same UUID', () => {
  const app = validatorContext();
  const record = validPendingFocusCommit();
  record.session.sessionId = '223e4567-e89b-42d3-a456-426614174001';
  assert.equal(app._validatePendingFocusCommit(record), false);
});

test('pending focus commit preserves null-versus-zero and advances the credit revision even for zero seconds', () => {
  const app = validatorContext();
  const record = validPendingFocusCommit();
  record.session.activeDurationMs = 0;
  record.session.durationSec = 0;
  record.session.creditedSeconds = 0;
  record.session.startedAt = '2026-11-26T10:01:05.500Z';
  record.session.endedAt = '2026-11-26T10:01:05.500Z';
  record.operation.measuredSeconds = 0;
  record.operation.creditedSeconds = 0;
  record.operation.targetSeconds = null;
  record.operation.createdAt = '2026-11-26T10:01:05.500Z';
  record.creditAfter = creditSnapshot({
    actualSeconds: null,
    actual: null,
    creditRevision: 1,
    lastCreditOperationId: operationId
  });
  record.timerBefore = timerProjection({
    baseElapsed: 0,
    elapsedRemainderMs: 0,
    sessionStartAt: Date.parse('2026-11-26T10:01:05.500Z')
  });
  assert.equal(app._validatePendingFocusCommit(record), true);
  assert.equal(record.creditAfter.actualSeconds, null);
  assert.equal(record.creditAfter.creditRevision, 1);
});

test('pending focus commit rejects a balance or revision that does not follow its operation', () => {
  const app = validatorContext();
  const wrongBalance = validPendingFocusCommit();
  wrongBalance.creditAfter.actualSeconds = 66;
  wrongBalance.creditAfter.actual = 1;
  wrongBalance.operation.targetSeconds = 66;
  assert.equal(app._validatePendingFocusCommit(wrongBalance), false);

  const skippedRevision = validPendingFocusCommit();
  skippedRevision.creditAfter.creditRevision = 2;
  skippedRevision.operation.revision = 2;
  assert.equal(app._validatePendingFocusCommit(skippedRevision), false);
});

test('pending focus commit binds operation time to session end and session start to frozen timer', () => {
  const app = validatorContext();
  const wrongOperationTime = validPendingFocusCommit();
  wrongOperationTime.operation.createdAt = '2026-11-26T10:01:06.000Z';
  assert.equal(app._validatePendingFocusCommit(wrongOperationTime), false);

  const wrongSessionStart = validPendingFocusCommit();
  wrongSessionStart.session.startedAt = '2026-11-26T09:59:59.000Z';
  assert.equal(app._validatePendingFocusCommit(wrongSessionStart), false);
});

test('pending focus commit may not drop already handled native notification action IDs', () => {
  const app = validatorContext();
  const record = validPendingFocusCommit();
  record.timerBefore.handledNotificationActionIds = [operationId];
  record.timerAfter.handledNotificationActionIds = [];
  assert.equal(app._validatePendingFocusCommit(record), false);
});

test('pending focus commit rejects a timer snapshot that does not represent the measured active duration', () => {
  const app = validatorContext();
  const record = validPendingFocusCommit();
  record.timerBefore.elapsedRemainderMs = 499;
  assert.equal(app._validatePendingFocusCommit(record), false);
});

test('pending focus commit requires the final timer projection to be reset but retain task identity', () => {
  const app = validatorContext();
  const wrongTimer = validPendingFocusCommit();
  wrongTimer.timerAfter.baseElapsed = 1;
  assert.equal(app._validatePendingFocusCommit(wrongTimer), false);

  const wrongTask = validPendingFocusCommit();
  wrongTask.timerAfter.taskId = 8;
  assert.equal(app._validatePendingFocusCommit(wrongTask), false);
});

test('credit snapshots preserve a numeric zero separately from null', () => {
  const app = validatorContext();
  assert.equal(app._validatePendingFocusCreditSnapshot(creditSnapshot()), true);
  assert.equal(app._validatePendingFocusCreditSnapshot(creditSnapshot({
    actualSeconds: 0, actual: 0
  })), true);
  assert.equal(app._validatePendingFocusCreditSnapshot(creditSnapshot({
    actualSeconds: null, actual: 0
  })), false);
  assert.equal(app._validatePendingFocusCreditSnapshot(creditSnapshot({
    creditRevision: 0, lastCreditOperationId: operationId
  })), false);
});

test('timer projections reject duplicated native notification IDs and malformed confirmation state', () => {
  const app = validatorContext();
  assert.equal(app._validatePendingFocusTimerProjection(timerProjection()), true);
  assert.equal(app._validatePendingFocusTimerProjection(timerProjection({
    handledNotificationActionIds: [operationId, operationId]
  })), false);
  assert.equal(app._validatePendingFocusTimerProjection(timerProjection({
    awaitingConfirmation: true,
    pendingPhaseEndedAt: null
  })), false);
});


function recoveryHarness(state) {
  const sandbox = {
    FOCUS_TIMER_KEY: 'timer',
    storageRecoveryRequired: false,
    _focusTimer: { pendingFocusCommit: JSON.parse(JSON.stringify(state.journal)) },
    _isTaskStorageLockHeld: () => true,
    _validatePendingFocusCommit: () => true,
    _withPendingFocusCommitWrite: (id, callback) =>
      id === operationId ? callback() : false,
    _writePendingFocusCommitCredit: () => {
      if (failOnce('credit')) return false;
      if (!state.creditApplied) {
        state.creditApplied = true;
        state.creditWrites++;
      }
      return true;
    },
    _persistPendingFocusCommitStage: (journal, stage) => {
      const order = { prepared: 0, credit_applied: 1, session_applied: 2, timer_applied: 3 };
      if (order[stage] <= order[journal.stage]) return true;
      if (failOnce('stage:' + stage)) return false;
      const next = { ...journal, stage, updatedAt: '2026-11-26T10:02:00.000Z' };
      state.journal = JSON.parse(JSON.stringify(next));
      sandbox._focusTimer.pendingFocusCommit = JSON.parse(JSON.stringify(next));
      return true;
    },
    _ensurePendingFocusCommitSession: () => {
      if (failOnce('session')) return false;
      if (!state.sessionApplied) {
        state.sessionApplied = true;
        state.sessionWrites++;
      }
      return true;
    },
    _capturePendingFocusTimerProjection: () =>
      JSON.parse(JSON.stringify(sandbox.memoryProjection)),
    _applyPendingFocusTimerProjection: projection => {
      sandbox.memoryProjection = JSON.parse(JSON.stringify(projection));
      return true;
    },
    _saveFocusTimer: () => {
      const isClearing = sandbox._focusTimer.pendingFocusCommit === null;
      const isTimerUpdate = !isClearing
        && sandbox._focusCommitDeepEqual(
          sandbox.memoryProjection, state.expectedTimerAfter
        );
      if (isClearing && failOnce('clear-save')) return false;
      if (isTimerUpdate && failOnce('timer-save')) return false;
      state.journal = sandbox._focusTimer.pendingFocusCommit === null
        ? null : JSON.parse(JSON.stringify(sandbox._focusTimer.pendingFocusCommit));
      state.durableProjection = JSON.parse(JSON.stringify(sandbox.memoryProjection));
      return true;
    },
    _verifyPendingFocusCommitStorage: (journal, requirePending) => {
      if (requirePending && failOnce('verify-before-clear')) return false;
      if (!requirePending && failOnce('verify-after-clear')) return false;
      return requirePending
        ? sandbox._focusCommitDeepEqual(state.journal, journal)
          && sandbox._focusCommitDeepEqual(state.durableProjection, journal.timerAfter)
        : state.journal === null
          && sandbox._focusCommitDeepEqual(state.durableProjection, journal.timerAfter);
    },
    _storeRollingRecoveryBackup: () => { state.backupCalls++; return true; },
    console: { error() {}, warn() {}, log() {} },
    localStorage: {
      getItem(key) {
        if (key !== 'timer') return null;
        return JSON.stringify({
          pendingFocusCommit: state.journal,
          pendingStopwatchTransaction: null
        });
      }
    }
  };
  sandbox.memoryProjection = JSON.parse(JSON.stringify(state.durableProjection));
  vm.runInNewContext([
    extractFunction('_focusCommitDeepEqual'),
    extractFunction('_recoverPendingFocusCommitLocked')
  ].join('\n'), sandbox);
  function failOnce(point) {
    if (state.failAt === point && !state.didFail) {
      state.didFail = true;
      return true;
    }
    return false;
  }
  return sandbox;
}

test('pending focus commit replays safely after interruption at every durable boundary', () => {
  const failurePoints = [
    'credit',
    'stage:credit_applied',
    'session',
    'stage:session_applied',
    'timer-save',
    'stage:timer_applied',
    'verify-before-clear',
    'clear-save',
    'verify-after-clear'
  ];

  for (const failAt of failurePoints) {
    const journal = validPendingFocusCommit();
    const state = {
      journal: JSON.parse(JSON.stringify(journal)),
      durableProjection: JSON.parse(JSON.stringify(journal.timerBefore)),
      expectedTimerAfter: JSON.parse(JSON.stringify(journal.timerAfter)),
      creditApplied: false,
      sessionApplied: false,
      creditWrites: 0,
      sessionWrites: 0,
      backupCalls: 0,
      failAt,
      didFail: false
    };

    const first = recoveryHarness(state);
    assert.equal(first._recoverPendingFocusCommitLocked(), false,
      'injected interruption at ' + failAt);
    assert.ok(state.journal,
      'the recovery journal must survive interruption at ' + failAt);
    if (failAt === 'timer-save') {
      assert.deepEqual(first.memoryProjection, journal.timerBefore,
        'failed timer checkpoint must restore the last proven in-memory state');
    }
    assert.equal(state.creditWrites <= 1, true);
    assert.equal(state.sessionWrites <= 1, true);

    state.failAt = null;
    state.didFail = false;
    const restarted = recoveryHarness(state);
    assert.equal(restarted._recoverPendingFocusCommitLocked(), true,
      'replay should finish after restart from ' + failAt);
    assert.equal(state.journal, null, 'journal clears only after verified completion');
    assert.equal(state.creditWrites, 1, 'credit side effect must apply once');
    assert.equal(state.sessionWrites, 1, 'session side effect must apply once');
    assert.deepEqual(state.durableProjection, journal.timerAfter);
    assert.equal(state.backupCalls, 1);
  }
});

function pendingFocusOwnerContext(options = {}) {
  const journal = validPendingFocusCommit();
  const persisted = options.persisted === false
    ? null : (options.persisted === 'malformed'
      ? { pendingFocusCommit: false } : { pendingFocusCommit: journal });
  const sandbox = {
    FOCUS_TIMER_KEY: 'timer',
    localStorage: {
      getItem(key) {
        return key === 'timer' && persisted !== null
          ? JSON.stringify(persisted) : null;
      }
    },
    _focusTimer: { pendingFocusCommit: journal },
    _isTaskStorageLockHeld: () => options.lockHeld !== false,
    _validatePendingFocusCommit: record =>
      options.valid !== false && !!record && typeof record === 'object',
    _pendingFocusCommitWriteDepth: 0,
    _pendingFocusCommitOwnerId: null
  };
  vm.runInNewContext([
    'var _pendingFocusCommitWriteDepth = 0;',
    'var _pendingFocusCommitOwnerId = null;',
    extractFunction('_withPendingFocusCommitWrite'),
    extractFunction('_pendingStopwatchWriteAllowed')
  ].join('\n'), sandbox);
  return sandbox;
}

test('pending focus writes require the shared lock and the exact durable operation owner', () => {
  const app = pendingFocusOwnerContext();
  assert.equal(app._pendingStopwatchWriteAllowed(), false);
  assert.equal(app._withPendingFocusCommitWrite(operationId, () =>
    app._pendingStopwatchWriteAllowed()), true);
  assert.equal(app._pendingFocusCommitWriteDepth, 0);
  assert.equal(app._pendingFocusCommitOwnerId, null);
  assert.equal(app._pendingStopwatchWriteAllowed(), false);
  assert.equal(app._withPendingFocusCommitWrite(
    '223e4567-e89b-42d3-a456-426614174001', () => true), false);

  const noLock = pendingFocusOwnerContext({ lockHeld: false });
  assert.equal(noLock._withPendingFocusCommitWrite(operationId, () => true), false);
});

test('a malformed persisted journal cannot be overwritten as an empty slot', () => {
  const app = pendingFocusOwnerContext({ persisted: 'malformed' });
  assert.equal(app._withPendingFocusCommitWrite(operationId, () => true, true), false);
});

test('the first pending focus journal write requires a validated in-memory intent', () => {
  const app = pendingFocusOwnerContext({ persisted: false });
  assert.equal(app._withPendingFocusCommitWrite(operationId, () =>
    app._pendingStopwatchWriteAllowed(), true), true);
  assert.equal(app._withPendingFocusCommitWrite(operationId, () => true, false), false);

  const invalid = pendingFocusOwnerContext({ persisted: false, valid: false });
  assert.equal(invalid._withPendingFocusCommitWrite(operationId, () => true, true), false);
});


function startupProbeContext(timerRecord) {
  const stored = new Map([
    ['timer', JSON.stringify(timerRecord)],
    ['main', JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [] })]
  ]);
  const sandbox = {
    RESET_IN_PROGRESS_KEY: 'reset',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling',
    IMPORT_IN_PROGRESS_KEY: 'import',
    MIGRATION_IN_PROGRESS_KEY: 'migration',
    FOCUS_TIMER_KEY: 'timer',
    STORAGE_KEY: 'main',
    CURRENT_SCHEMA_VERSION: 2,
    localStorage: {
      getItem(key) {
        return stored.has(key) ? stored.get(key) : null;
      }
    },
    _readPersistedRollingBackupGeneration: () => 4,
    _validatePendingStopwatchTransaction: () => true,
    validateV2: () => true
  };
  vm.runInNewContext([
    extractFunction('_parseStrictFocusSessionTimestamp'),
    extractFunction('_validateCreditOperationRecord'),
    extractFunction('_validateFocusSessionRecordV2'),
    extractFunction('_validatePendingFocusTimerProjection'),
    extractFunction('_validatePendingFocusCreditSnapshot'),
    extractFunction('_validatePendingFocusCommit'),
    extractFunction('_probeStartupStopwatchRecovery')
  ].join('\n'), sandbox);
  return sandbox;
}

test('startup probe recognizes a valid pending focus commit before normal storage loading', () => {
  const journal = validPendingFocusCommit();
  const app = startupProbeContext({
    mode: 'stopwatch',
    running: false,
    pendingStopwatchTransaction: null,
    pendingFocusCommit: journal
  });
  const result = app._probeStartupStopwatchRecovery();
  assert.equal(result.error, null);
  assert.equal(result.pending, true);
  assert.equal(JSON.stringify(result.expectedFocusCommit), JSON.stringify(journal));
  assert.equal(result.expectedTx, null);
  assert.equal(result.mainData.schemaVersion, 2);
});

test('startup probe fails closed on corrupt or overlapping focus journals', () => {
  const corrupt = validPendingFocusCommit({ stage: 'unknown-stage' });
  const corruptResult = startupProbeContext({
    mode: 'stopwatch',
    running: false,
    pendingFocusCommit: corrupt
  })._probeStartupStopwatchRecovery();
  assert.equal(corruptResult.pending, true);
  assert.ok(corruptResult.error);

  const overlapResult = startupProbeContext({
    mode: 'stopwatch',
    running: false,
    pendingStopwatchTransaction: { version: 1 },
    pendingFocusCommit: validPendingFocusCommit()
  })._probeStartupStopwatchRecovery();
  assert.equal(overlapResult.pending, true);
  assert.match(overlapResult.error, /متداخلتان/);
});


function creditWriterTask(overrides = {}) {
  return {
    id: 7,
    name: 'Credit writer task',
    status: 'pending',
    type: 'معرفية',
    expected: 30,
    actual: null,
    plannedDate: '2026-11-26',
    plannedTime: '',
    completedAt: null,
    createdAt: startedAtMs,
    ...overrides
  };
}

function creditWriterContext(task, operations, journal) {
  const main = {
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: {
      operationalDayStart: 4,
      firstUseDate: '2026-01-01',
      darkMode: false,
      themeMode: 'system',
      lastRecurringDates: {}
    },
    tasks: [JSON.parse(JSON.stringify(task))],
    dailyLogs: [],
    creditOperations: JSON.parse(JSON.stringify(operations))
  };
  const initialRaw = JSON.stringify(main);
  const values = new Map([['main', initialRaw]]);
  const writes = [];
  const sandbox = {
    CURRENT_SCHEMA_VERSION: 2,
    VALID_STATUS: ['pending', 'done', 'cancelled'],
    VALID_TYPES: ['معرفية', 'بدنية', 'إدارية'],
    STORAGE_KEY: 'main',
    _mainStorageBaselineReady: true,
    _mainStorageExternalChangeObserved: false,
    _mainStorageBaselineRaw: initialRaw,
    _focusTimer: { pendingFocusCommit: journal },
    _stopwatchTransactionLockDepth: 1,
    _pendingFocusCommitWriteDepth: 1,
    _pendingFocusCommitOwnerId: operationId,
    storageRecoveryRequired: false,
    tasks: JSON.parse(JSON.stringify(main.tasks)),
    console: { error() {}, warn() {}, log() {} },
    isValidCalendarDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value),
    isValidLocalTime: value => value === '' || /^\d{2}:\d{2}$/.test(value),
    isValidLocalDateTime: value => typeof value === 'string' && Number.isFinite(Date.parse(value)),
    validateDailyLog: () => true,
    _isTaskStorageLockHeld: () => true,
    _storageWriteAllowed: () => true,
    _validatePendingFocusCommit: value => value === journal,
    _setMainStorageBaseline(raw) {
      sandbox._mainStorageBaselineRaw = raw;
      sandbox._mainStorageBaselineReady = true;
      sandbox._mainStorageExternalChangeObserved = false;
    },
    _loadAppSettings() {},
    _queueAllTaskReminderSync() {},
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) {
        writes.push([key, String(value)]);
        values.set(String(key), String(value));
      },
      removeItem(key) { values.delete(String(key)); }
    }
  };
  const source = [
    extractFunction('_validateTaskCreditFields'),
    extractFunction('_validateCreditOperationRecord'),
    extractFunction('_validateCreditOperationLedger'),
    extractFunction('_classifyCreditOperationAttempt'),
    extractFunction('_creditOperationLedgerPreservesHistory'),
    extractFunction('_validateLastRecurringDates'),
    extractFunction('validateV2'),
    extractFunction('_validatePendingFocusCreditSnapshot'),
    extractFunction('_capturePendingFocusCreditSnapshot'),
    extractFunction('_pendingFocusTaskMatchesCreditSnapshot'),
    extractFunction('_focusCommitDeepEqual'),
    extractFunction('_focusCommitLedgerCanAcceptOperation'),
    extractFunction('_writePendingFocusCommitCredit')
  ].join('\n');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    app: sandbox,
    values,
    writes,
    readMain() { return JSON.parse(values.get('main')); },
    get originalRaw() { return initialRaw; }
  };
}

test('V2 credit writer rejects reuse of an existing operation identity with different content', () => {
  const journal = validPendingFocusCommit();
  const conflictingOperation = {
    ...journal.operation,
    source: 'user_adjusted',
    creditedSeconds: 66,
    targetSeconds: 66
  };
  const task = creditWriterTask({
    actual: 1,
    actualSeconds: 66,
    creditRevision: 1,
    creditSchemaVersion: 1,
    lastCreditOperationId: operationId
  });
  const runtime = creditWriterContext(task, [conflictingOperation], journal);
  assert.equal(runtime.app._writePendingFocusCommitCredit(journal), false);
  assert.equal(runtime.values.get('main'), runtime.originalRaw,
    'an identity collision with different ledger content must preserve exact main bytes');
  assert.equal(runtime.writes.length, 0,
    'an identity collision must be detected before the first durable write');
});

test('V2 credit writer rejects a changed balance even when the current task record is otherwise valid', () => {
  const journal = validPendingFocusCommit();
  const task = creditWriterTask({
    actual: 0,
    actualSeconds: 0,
    creditRevision: 0,
    creditSchemaVersion: 1,
    lastCreditOperationId: null
  });
  const runtime = creditWriterContext(task, [], journal);
  assert.equal(runtime.app._writePendingFocusCommitCredit(journal), false);
  assert.equal(runtime.values.get('main'), runtime.originalRaw,
    'a zero balance is not interchangeable with the journal null baseline');
  assert.equal(runtime.writes.length, 0,
    'an unexpected but schema-valid balance must fail before writing');
});

test('V2 credit writer refuses a new operation when the append-only ledger is full', () => {
  const records = [];
  let previousSeconds = null;
  let finalTarget = null;
  for (let i = 0; i < 10000; i++) {
    let targetSeconds;
    if (i === 9999) targetSeconds = 720;
    else targetSeconds = i % 2 === 0 ? 1 : 2;
    if (i > 0 && targetSeconds === previousSeconds)
      targetSeconds = targetSeconds === 1 ? 2 : 1;
    const operation = {
      recordVersion: 1,
      operationId: '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
      kind: 'manual_adjustment',
      taskId: 7,
      revision: i + 1,
      previousSeconds,
      targetSeconds,
      source: 'manual_adjustment',
      sessionId: null,
      createdAt: '2026-11-26T10:00:00.000Z'
    };
    records.push(operation);
    previousSeconds = targetSeconds;
    finalTarget = targetSeconds;
  }
  assert.equal(records.length, 10000);
  assert.equal(finalTarget, 720);

  const journal = validPendingFocusCommit();
  journal.creditBefore = creditSnapshot({
    actualSeconds: 720,
    actual: 12,
    creditRevision: 10000,
    creditSchemaVersion: 1,
    lastCreditOperationId: records[records.length - 1].operationId
  });
  journal.creditAfter = creditSnapshot({
    actualSeconds: 785,
    actual: 13,
    creditRevision: 10001,
    creditSchemaVersion: 1,
    lastCreditOperationId: operationId
  });
  journal.operation.previousSeconds = 720;
  journal.operation.targetSeconds = 785;
  journal.operation.revision = 10001;
  const task = creditWriterTask({
    actual: 12,
    actualSeconds: 720,
    creditRevision: 10000,
    creditSchemaVersion: 1,
    lastCreditOperationId: records[records.length - 1].operationId
  });
  const runtime = creditWriterContext(task, records, journal);
  assert.equal(runtime.app._focusCommitLedgerCanAcceptOperation(
    runtime.readMain(), 7, journal.creditBefore), false,
    'a full ledger must be rejected before the commit entry point writes a pending journal');
  assert.equal(runtime.app._writePendingFocusCommitCredit(journal), false);
  assert.equal(runtime.values.get('main'), runtime.originalRaw,
    'the full append-only ledger must be retained byte-for-byte');
  assert.equal(runtime.readMain().creditOperations.length, 10000);
  assert.equal(runtime.writes.length, 0,
    'the 10,001st identity must be refused without truncating history');
});


function sessionFinishRoutingContext(snapshot) {
  const calls = [];
  const migratedTask = {
    id: 7,
    name: 'Task',
    actual: 25,
    actualSeconds: 1500,
    creditRevision: 1,
    creditSchemaVersion: 1,
    lastCreditOperationId: operationId
  };
  const sandbox = {
    POMODORO_WORK_SEC: 25 * 60,
    _commitPendingFocusSessionV2: request => {
      calls.push({ writer: 'v2', request });
      return Promise.resolve('v2');
    },
    _commitFocusTaskSessionLocked: request => {
      calls.push({ writer: 'legacy', request });
      return Promise.resolve('legacy');
    },
    showAlertModal: (title, message) => calls.push({ writer: 'blocked', title, message }),
    tasks: [migratedTask]
  };
  vm.runInNewContext([
    extractFunction('_buildPendingFocusSessionFields'),
    extractFunction('_commitFocusTaskSession'),
    extractFunction('_applyTimerFinish')
  ].join('\n'), sandbox);
  return { app: sandbox, calls, migratedTask };
}

test('already-migrated task accepts adjusted Stopwatch credit through the durable V2 route', async () => {
  const snapshot = {
    mode: 'stopwatch',
    phase: 'work',
    running: false,
    baseElapsed: 125,
    elapsedRemainderMs: 0,
    taskId: 7,
    sessionStartAt: startedAtMs,
    pendingPhaseEndedAt: null,
    clockAdjusted: false,
    nativeSessionToken: null
  };
  const runtime = sessionFinishRoutingContext(snapshot);
  assert.equal(runtime.migratedTask.creditSchemaVersion, 1,
    'the task represents a prior successful Pomodoro migration and commit');
  assert.equal(await runtime.app._applyTimerFinish(
    125, runtime.migratedTask, 2, 'work', snapshot, false
  ), 'v2');
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].writer, 'v2',
    'the old minute writer must never receive a task-linked work session');
  const fields = runtime.app._buildPendingFocusSessionFields(
    snapshot, runtime.migratedTask, 2, false
  );
  assert.equal(fields.mode, 'stopwatch');
  assert.equal(fields.outcome, 'stopped');
  assert.equal(fields.durationSec, 125);
  assert.equal(fields.creditedSeconds, 120);
  assert.equal(fields.creditSource, 'user_adjusted');
});

test('exactly measured Stopwatch credit remains measured in V2', async () => {
  const snapshot = {
    mode: 'stopwatch', phase: 'work', running: false,
    baseElapsed: 120, elapsedRemainderMs: 0, taskId: 7,
    sessionStartAt: startedAtMs, pendingPhaseEndedAt: null,
    clockAdjusted: false, nativeSessionToken: null
  };
  const runtime = sessionFinishRoutingContext(snapshot);
  assert.equal(await runtime.app._applyTimerFinish(
    120, runtime.migratedTask, 2, 'work', snapshot, true
  ), 'v2');
  const fields = runtime.app._buildPendingFocusSessionFields(
    snapshot, runtime.migratedTask, 2, true
  );
  assert.equal(fields.creditedSeconds, 120);
  assert.equal(fields.creditSource, 'measured');
});

test('clock-adjusted legacy task sessions retain their explicit V1 transaction contract', async () => {
  const snapshot = {
    mode: 'stopwatch', phase: 'work', running: false,
    baseElapsed: 120, elapsedRemainderMs: 0, taskId: 7,
    sessionStartAt: startedAtMs, pendingPhaseEndedAt: null,
    clockAdjusted: true, nativeSessionToken: null
  };
  const runtime = sessionFinishRoutingContext(snapshot);
  runtime.app.tasks[0] = {
    id: 7, name: 'Legacy Task', actual: 5
  };
  runtime.app._focusCommitInFlight = false;
  runtime.app._startupResetRecoveryInFlight = false;
  runtime.app._resetRecoveryInFlight = false;
  runtime.app._resetInFlight = false;
  runtime.app.storageRecoveryRequired = false;
  runtime.app._focusTimerExternalConflict = false;
  runtime.app._focusTimer = { pendingStopwatchTransaction: null };
  runtime.app._acquireRollingRecoveryCheckpointHold = () => () => {};
  runtime.app._withStopwatchTransactionLock = callback => Promise.resolve().then(callback);
  runtime.app._renderFocusTimer = () => {};
  assert.equal(await runtime.app._applyTimerFinish(
    120, runtime.app.tasks[0], 2, 'work', snapshot, false
  ), 'legacy');
  assert.equal(runtime.calls[0].writer, 'legacy',
    'legacy task data remains on its compatible V1 transaction contract');
  assert.equal(runtime.calls[0].request.snapshot.clockAdjusted, true);
});

test('clock-adjusted task-linked sessions fail closed and never reach either writer', async () => {
  const snapshot = {
    mode: 'stopwatch', phase: 'work', running: false,
    baseElapsed: 120, elapsedRemainderMs: 0, taskId: 7,
    sessionStartAt: startedAtMs, pendingPhaseEndedAt: null,
    clockAdjusted: true, nativeSessionToken: null
  };
  const runtime = sessionFinishRoutingContext(snapshot);
  assert.equal(await runtime.app._applyTimerFinish(
    120, runtime.migratedTask, 2, 'work', snapshot, true
  ), false);
  assert.deepEqual(runtime.calls.map(call => call.writer), ['blocked']);
  assert.match(runtime.calls[0].message, /بقيت الجلسة متوقفة/);
});

test('a mismatched explicit task ID cannot divert a linked work session to the legacy writer', async () => {
  const snapshot = {
    mode: 'pomodoro', phase: 'work', running: false,
    baseElapsed: 1500, elapsedRemainderMs: 0, taskId: 7,
    sessionStartAt: startedAtMs, pendingPhaseEndedAt: null,
    clockAdjusted: false, nativeSessionToken: null
  };
  const runtime = sessionFinishRoutingContext(snapshot);
  assert.equal(await runtime.app._commitFocusTaskSession({
    snapshot, taskId: null, minutesToAdd: 25, completed: true
  }), false);
  assert.deepEqual(runtime.calls.map(call => call.writer), ['blocked']);
  assert.equal(runtime.calls[0].title, 'تعارض ربط المهمة');
  assert.match(runtime.calls[0].message, /لم نمرر الجلسة إلى أي كاتب/);
});

test('all focus-session save entry points preserve the shared V2/V1 dispatch boundary', () => {
  const routes = [
    ['_applyTimerFinish', /_commitFocusTaskSession/],
    ['_applyStopwatchSave', /_commitFocusTaskSession/],
    ['_applyStopwatchSaveLocked', /_commitFocusTaskSession/],
    ['_showStopwatchSaveDialog', /_applyStopwatchSave/],
    ['_showSessionTransitionDialog', /_commitFocusTaskSession/],
    ['_continueFocusTimerFinish', /_applyTimerFinish/],
    ['resetTimer', /_showStopwatchSaveDialog/]
  ];
  for (const [name, expectedRoute] of routes) {
    const source = extractFunction(name);
    assert.match(source, expectedRoute,
      name + ' must remain connected to the shared focus-session save route');
    assert.doesNotMatch(source, /_commitFocusTaskSessionLocked/,
      name + ' must not call the legacy locked writer directly');
  }

  const dispatcher = extractFunction('_commitFocusTaskSession');
  assert.match(dispatcher, /taskUsesV2CreditSchema/,
    'the dispatcher must detect tasks that have entered V2');
  assert.match(dispatcher, /return _commitPendingFocusSessionV2/,
    'V2 task-linked work saves must reach the durable V2 writer');
  assert.match(dispatcher, /_withStopwatchTransactionLock/,
    'non-V2 work saves must retain the locked V1 compatibility route');

  const legacyWriter = extractFunction('_commitFocusTaskSessionLocked');
  assert.match(legacyWriter, /actualSeconds/);
  assert.match(legacyWriter, /كاتب جلسة قديم غير متوافق/,
    'the legacy writer must refuse V2 task credit metadata');

  const finish = extractFunction('_continueFocusTimerFinish');
  assert.match(finish, /taskId:\s*null/);
  assert.match(finish, /minutesToAdd:\s*0/,
    'break and unlinked saves must not add minutes to a task');
});


test('pending V2 journal accepts Stopwatch user-adjusted credit with distinct measured and credited seconds', () => {
  const app = validatorContext();
  const journal = validPendingFocusCommit();
  journal.timerBefore.baseElapsed = 125;
  journal.timerBefore.elapsedRemainderMs = 0;
  journal.session.activeDurationMs = 125000;
  journal.session.durationSec = 125;
  journal.session.creditedSeconds = 120;
  journal.session.creditSource = 'user_adjusted';
  journal.session.endedAt = '2026-11-26T10:02:05.000Z';
  journal.operation.measuredSeconds = 125;
  journal.operation.creditedSeconds = 120;
  journal.operation.source = 'user_adjusted';
  journal.operation.targetSeconds = 120;
  journal.operation.createdAt = '2026-11-26T10:02:05.000Z';
  journal.creditAfter = creditSnapshot({
    actualSeconds: 120,
    actual: 2,
    creditRevision: 1,
    lastCreditOperationId: operationId
  });
  journal.createdAt = '2026-11-26T10:02:05.000Z';
  journal.updatedAt = '2026-11-26T10:02:05.000Z';

  assert.equal(app._validateCreditOperationRecord(journal.operation), true);
  assert.equal(app._validateFocusSessionRecordV2(journal.session), true);
  assert.equal(app._validatePendingFocusCommit(journal), true);

  const mismatchedJournal = JSON.parse(JSON.stringify(journal));
  mismatchedJournal.session.creditedSeconds = 125;
  assert.equal(app._validatePendingFocusCommit(mismatchedJournal), false,
    'session credit must exactly match its ledger operation while preserving measured duration');
});

test('successful V2 focus commit refreshes task cards and task-derived analytics immediately', async () => {
  const refreshed = [];
  const task = { id: 7, actual: 0, actualSeconds: 0 };
  const sandbox = {
    _focusCommitPendingPromise: null,
    _focusCommitInFlight: false,
    _startupResetRecoveryInFlight: false,
    _resetRecoveryInFlight: false,
    _resetInFlight: false,
    storageRecoveryRequired: false,
    _focusTimerExternalConflict: false,
    _focusTimer: { pendingFocusCommit: null },
    tasks: [task],
    _acquireRollingRecoveryCheckpointHold: () => () => {},
    _withStopwatchTransactionLock: callback => Promise.resolve().then(callback),
    _migrateLegacyTaskCreditMetadataLocked: () => ({ ok: true }),
    _focusTimerSnapshotMatchesState: () => true,
    _capturePendingFocusCreditSnapshot: () => ({ actualSeconds: 0 }),
    _focusCommitBaselinesMatch: () => true,
    _buildPendingFocusSessionFields: () => ({ sessionId: operationId }),
    _withFocusCommitWrite: callback => callback(),
    _commitFocusSessionV2Locked: () => {
      task.actual = 5;
      task.actualSeconds = 300;
      return true;
    },
    _completeRollingRecoveryCheckpoint: () => true,
    _renderFocusTimer() {},
    showToast() {},
    renderTasks: () => refreshed.push('tasks'),
    renderStats: () => refreshed.push('stats'),
    renderTypeGapAnalysis: () => refreshed.push('type-gap'),
    renderFocusSessionsCard: () => refreshed.push('sessions'),
    console: { warn() {}, error() {} }
  };
  vm.runInNewContext(extractFunction('_commitPendingFocusSessionV2'), sandbox);
  let transitionCallbackCalled = false;
  const committed = await sandbox._commitPendingFocusSessionV2({
    snapshot: { taskId: 7, mode: 'pomodoro', phase: 'work', running: false, clockAdjusted: false },
    minutesToAdd: 5,
    onCommitted: () => {
      transitionCallbackCalled = true;
      return true;
    },
    successToast: 'saved'
  });
  assert.equal(committed, true);
  assert.equal(transitionCallbackCalled, true);
  assert.deepEqual(refreshed, ['tasks', 'stats', 'type-gap', 'sessions']);
  assert.equal(task.actual, 5);
});

test('focus session list shows per-session remainder seconds instead of hiding them', () => {
  const container = { innerHTML: '' };
  const sandbox = {
    document: {
      getElementById() { return container; }
    },
    _todaySessionsStats: () => ({ count: 1, totalSec: 65 }),
    _weeklySessionsStats: () => ({ count: 1, totalSec: 65 }),
    _loadSessions: () => [{
      mode: 'pomodoro',
      phase: 'work',
      taskName: 'مهمة',
      durationSec: 65
    }],
    _formatDuration: () => '1 د',
    _formatFocusSessionDuration: sec => {
      assert.equal(sec, 65);
      return '1 د 5 ث';
    },
    escapeHTML: value => value
  };
  vm.runInNewContext(extractFunction('renderFocusSessionsCard'), sandbox);
  sandbox.renderFocusSessionsCard();
  assert.match(container.innerHTML, /1 د 5 ث/);
});

test('focus session duration formatter retains seconds across minute and hour boundaries', () => {
  const sandbox = {};
  vm.runInNewContext(extractFunction('_formatFocusSessionDuration'), sandbox);
  assert.equal(sandbox._formatFocusSessionDuration(65), '1 د 5 ث');
  assert.equal(sandbox._formatFocusSessionDuration(120), '2 د');
  assert.equal(sandbox._formatFocusSessionDuration(3665), '1س 1 د 5 ث');
});


test('default Pomodoro approval credits measured seconds rather than rounding each session to minutes', async () => {
  const snapshot = {
    mode: 'pomodoro', phase: 'work', running: false, baseElapsed: 72,
    elapsedRemainderMs: 0, taskId: 7, sessionStartAt: startedAtMs,
    pendingPhaseEndedAt: null, clockAdjusted: false, nativeSessionToken: null
  };
  const runtime = sessionFinishRoutingContext(snapshot);
  await runtime.app._applyTimerFinish(72, { id: 7, name: 'Task' }, 1, 'work', snapshot, true);
  assert.equal(runtime.calls[0].writer, 'v2');
  assert.equal(runtime.calls[0].request.useMeasuredCredit, true);
  const measured = runtime.app._buildPendingFocusSessionFields(snapshot, { id: 7, name: 'Task' }, 1, true);
  assert.equal(measured.durationSec, 72);
  assert.equal(measured.creditedSeconds, 72);
  assert.equal(measured.creditSource, 'measured');
  const manuallyAdjusted = runtime.app._buildPendingFocusSessionFields(snapshot, { id: 7, name: 'Task' }, 3, false);
  assert.equal(manuallyAdjusted.creditedSeconds, 180);
  assert.equal(manuallyAdjusted.creditSource, 'user_adjusted');
});

test('task credit retains seconds across multiple short Pomodoro sessions', () => {
  const snapshotA = {
    mode: 'pomodoro', phase: 'work', running: false, baseElapsed: 72,
    elapsedRemainderMs: 0, taskId: 7, sessionStartAt: startedAtMs,
    pendingPhaseEndedAt: null, clockAdjusted: false, nativeSessionToken: null
  };
  const snapshotB = { ...snapshotA, baseElapsed: 82, sessionStartAt: startedAtMs + 600000 };
  const sandbox = { POMODORO_WORK_SEC: 25 * 60 };
  vm.runInNewContext(extractFunction('_buildPendingFocusSessionFields'), sandbox);
  const a = sandbox._buildPendingFocusSessionFields(snapshotA, { id: 7, name: 'Task' }, 1, true);
  const b = sandbox._buildPendingFocusSessionFields(snapshotB, { id: 7, name: 'Task' }, 1, true);
  assert.equal(a.creditedSeconds + b.creditedSeconds, 154);
  assert.equal(Math.floor((a.creditedSeconds + b.creditedSeconds) / 60), 2);
});

test('focus session summary totals display seconds instead of truncating the aggregate to whole minutes', () => {
  const container = { innerHTML: '' };
  const sandbox = {
    document: { getElementById() { return container; } },
    _todaySessionsStats: () => ({ count: 2, totalSec: 154 }),
    _weeklySessionsStats: () => ({ count: 2, totalSec: 154 }),
    _loadSessions: () => [],
    _formatFocusSessionDuration: sec => sec === 154 ? '2 د 34 ث' : String(sec),
    _formatDuration: () => '2 د'
  };
  vm.runInNewContext(extractFunction('renderFocusSessionsCard'), sandbox);
  sandbox.renderFocusSessionsCard();
  assert.equal((container.innerHTML.match(/2 د 34 ث/g) || []).length, 2);
});
