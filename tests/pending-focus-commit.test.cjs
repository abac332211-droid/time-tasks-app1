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
  record.creditAfter = creditSnapshot({
    actualSeconds: null,
    actual: null,
    creditRevision: 1,
    lastCreditOperationId: operationId
  });
  record.timerBefore = timerProjection({
    baseElapsed: 0,
    elapsedRemainderMs: 0,
    sessionStartAt: startedAtMs
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
