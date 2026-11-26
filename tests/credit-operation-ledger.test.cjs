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

const ids = {
  first: '123e4567-e89b-42d3-a456-426614174000',
  second: '223e4567-e89b-42d3-a456-426614174001',
  third: '323e4567-e89b-42d3-a456-426614174002',
  fourth: '423e4567-e89b-42d3-a456-426614174003'
};

function sessionOperation(overrides = {}) {
  return {
    recordVersion: 1,
    operationId: ids.first,
    kind: 'session',
    taskId: 1,
    revision: 1,
    previousSeconds: null,
    targetSeconds: null,
    measuredSeconds: 0,
    creditedSeconds: 0,
    source: 'measured',
    sessionId: ids.first,
    createdAt: '2026-11-26T10:00:00.000Z',
    ...overrides
  };
}

function manualOperation(overrides = {}) {
  return {
    recordVersion: 1,
    operationId: ids.second,
    kind: 'manual_adjustment',
    taskId: 1,
    revision: 2,
    previousSeconds: null,
    targetSeconds: 0,
    source: 'manual_adjustment',
    sessionId: null,
    createdAt: '2026-11-26T10:05:00.000Z',
    ...overrides
  };
}

function context() {
  const sandbox = {};
  vm.runInNewContext([
    extractFunction('_validateTaskCreditFields'),
    extractFunction('_validateCreditOperationRecord'),
    extractFunction('_validateCreditOperationLedger'),
    extractFunction('_classifyCreditOperationAttempt'),
    extractFunction('_getHighestCreditOperationTaskId'),
    extractFunction('_creditOperationLedgerPreservesHistory')
  ].join('\n'), sandbox);
  return sandbox;
}

test('session and manual operation records enforce their distinct schemas', () => {
  const app = context();
  assert.equal(app._validateCreditOperationRecord(sessionOperation()), true);
  assert.equal(app._validateCreditOperationRecord(manualOperation()), true);
  assert.equal(app._validateCreditOperationRecord(sessionOperation({
    sessionId: ids.second
  })), false, 'session identity must equal operation identity');
  assert.equal(app._validateCreditOperationRecord(sessionOperation({
    creditedSeconds: 1
  })), false, 'measured credit must equal measured duration');
  assert.equal(app._validateCreditOperationRecord(manualOperation({
    sessionId: ids.second
  })), false, 'manual adjustment is not a focus session');
});

test('operation record rejects malformed identity, amounts, dates and unknown fields', () => {
  const app = context();
  assert.equal(app._validateCreditOperationRecord(sessionOperation({
    operationId: 'not-a-uuid'
  })), false);
  assert.equal(app._validateCreditOperationRecord(sessionOperation({
    measuredSeconds: -1
  })), false);
  assert.equal(app._validateCreditOperationRecord(sessionOperation({
    targetSeconds: 10
  })), false, 'zero-credit first operation preserves null');
  assert.equal(app._validateCreditOperationRecord(sessionOperation({
    createdAt: '2026-11-26T10:00:00Z'
  })), false, 'the ledger timestamp must be canonical UTC ISO');
  assert.equal(app._validateCreditOperationRecord({
    ...sessionOperation(), unreviewedField: true
  }), false);
});

test('ledger links each task revision and previous balance to the durable history', () => {
  const app = context();
  const first = sessionOperation({
    previousSeconds: null,
    targetSeconds: 40,
    measuredSeconds: 40,
    creditedSeconds: 40
  });
  const second = manualOperation({
    previousSeconds: 40,
    targetSeconds: 90,
    createdAt: '2026-11-26T10:05:00.000Z'
  });
  const task = {
    id: 1,
    actualSeconds: 90,
    actual: 1,
    creditRevision: 2,
    creditSchemaVersion: 1,
    lastCreditOperationId: ids.second
  };

  assert.equal(app._validateCreditOperationLedger([first, second], [task]), true);
  assert.equal(app._validateCreditOperationLedger([first, second], [{
    ...task, actualSeconds: 91, actual: 1
  }]), false, 'latest ledger target must match the task balance');
  assert.equal(app._validateCreditOperationLedger([first, second], [{
    ...task, creditRevision: 1
  }]), false, 'task revision must match operation count');
  assert.equal(app._validateCreditOperationLedger([first, second], [{
    ...task, lastCreditOperationId: ids.first
  }]), false, 'latest operation identity must match the task');
});

test('zero-second operation keeps a null starting balance distinct from zero', () => {
  const app = context();
  const first = sessionOperation();
  const task = {
    id: 1,
    actualSeconds: null,
    actual: null,
    creditRevision: 1,
    creditSchemaVersion: 1,
    lastCreditOperationId: ids.first
  };
  assert.equal(app._validateCreditOperationLedger([first], [task]), true);

  const zeroBalanceTask = { ...task, actualSeconds: 0, actual: 0 };
  assert.equal(app._validateCreditOperationLedger([first], [zeroBalanceTask]), false,
    'a zero-duration approval on null must not silently materialize a zero balance');
});

test('historical retry after newer approvals is classified as duplicate', () => {
  const app = context();
  const first = sessionOperation({
    previousSeconds: null,
    targetSeconds: 40,
    measuredSeconds: 40,
    creditedSeconds: 40
  });
  const second = sessionOperation({
    operationId: ids.second,
    sessionId: ids.second,
    revision: 2,
    previousSeconds: 40,
    targetSeconds: 100,
    measuredSeconds: 60,
    creditedSeconds: 60,
    createdAt: '2026-11-26T10:30:00.000Z'
  });
  const third = manualOperation({
    operationId: ids.third,
    revision: 3,
    previousSeconds: 100,
    targetSeconds: 130,
    createdAt: '2026-11-26T10:35:00.000Z'
  });
  const ledger = [first, second, third];

  assert.equal(app._classifyCreditOperationAttempt(ledger, first).status, 'duplicate');
  assert.equal(app._classifyCreditOperationAttempt(ledger, {
    ...first, source: 'user_adjusted', creditedSeconds: 41, targetSeconds: 41
  }).status, 'conflict');
  assert.equal(app._classifyCreditOperationAttempt(ledger, {
    ...second, taskId: 2
  }).status, 'conflict', 'an existing identity cannot be rebound to another task');
  const newOperation = sessionOperation({
    operationId: ids.fourth,
    sessionId: ids.fourth,
    revision: 4,
    previousSeconds: 130,
    targetSeconds: 150,
    measuredSeconds: 20,
    creditedSeconds: 20,
    createdAt: '2026-11-26T10:40:00.000Z'
  });
  assert.equal(app._classifyCreditOperationAttempt(ledger, newOperation).status, 'new');
});

test('ledger rejects duplicate identities, revision gaps and broken balance chains', () => {
  const app = context();
  const first = sessionOperation({
    previousSeconds: null,
    targetSeconds: 40,
    measuredSeconds: 40,
    creditedSeconds: 40
  });
  const second = sessionOperation({
    operationId: ids.second,
    sessionId: ids.second,
    revision: 2,
    previousSeconds: 41,
    targetSeconds: 100,
    measuredSeconds: 59,
    creditedSeconds: 59,
    createdAt: '2026-11-26T10:30:00.000Z'
  });
  assert.equal(app._validateCreditOperationLedger([first, { ...first }]), false);
  assert.equal(app._validateCreditOperationLedger([first, second]), false);
  assert.equal(app._validateCreditOperationLedger([first, {
    ...second, revision: 3, previousSeconds: 40
  }]), false);
});

test('ledger requires an exact latest operation for every revisioned task', () => {
  const app = context();
  const first = sessionOperation({
    previousSeconds: null,
    targetSeconds: 40,
    measuredSeconds: 40,
    creditedSeconds: 40
  });
  const legacyTask = { id: 1 };
  assert.equal(app._validateCreditOperationLedger([first], [legacyTask]), false);
  assert.equal(app._validateCreditOperationLedger([], [{
    id: 1, actual: null, actualSeconds: null, creditRevision: 0,
    creditSchemaVersion: 1, lastCreditOperationId: null
  }]), true);
});


test('imports may extend but may never remove or rewrite previously accepted operation IDs', () => {
  const app = context();
  const first = sessionOperation({
    previousSeconds: null,
    targetSeconds: 40,
    measuredSeconds: 40,
    creditedSeconds: 40
  });
  const second = sessionOperation({
    operationId: ids.second,
    sessionId: ids.second,
    revision: 2,
    previousSeconds: 40,
    targetSeconds: 100,
    measuredSeconds: 60,
    creditedSeconds: 60,
    createdAt: '2026-11-26T10:30:00.000Z'
  });
  const third = manualOperation({
    operationId: ids.third,
    revision: 3,
    previousSeconds: 100,
    targetSeconds: 110,
    createdAt: '2026-11-26T10:35:00.000Z'
  });

  assert.equal(app._creditOperationLedgerPreservesHistory([first], [first, second]), true);
  assert.equal(app._creditOperationLedgerPreservesHistory([first, second], [first, second, third]), true);
  assert.equal(app._creditOperationLedgerPreservesHistory([first, second], [second]), false,
    'omitting an earlier identity must be rejected');
  assert.equal(app._creditOperationLedgerPreservesHistory([first], [{
    ...first, creditedSeconds: 41, targetSeconds: 41
  }]), false, 'rewriting a previously accepted operation must be rejected');
  assert.equal(app._creditOperationLedgerPreservesHistory([], [first]), true);
});


test('ledger enforces its documented hard limit without trimming historical identities', () => {
  const app = context();
  const makeRows = count => Array.from({ length: count }, (_, index) => ({
    recordVersion: 1,
    operationId: '00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0'),
    kind: 'manual_adjustment',
    taskId: index + 1,
    revision: 1,
    previousSeconds: null,
    targetSeconds: 0,
    source: 'manual_adjustment',
    sessionId: null,
    createdAt: '2026-11-26T10:00:00.000Z'
  }));

  assert.equal(app._validateCreditOperationLedger(makeRows(10000)), true);
  assert.equal(app._validateCreditOperationLedger(makeRows(10001)), false);
});


test('durable operation identity survives eviction from the 500-row session display history', () => {
  const app = context();
  const ledger = [];

  for (let index = 0; index < 501; index++) {
    const operationId = 'a0000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
    ledger.push(sessionOperation({
      operationId,
      sessionId: operationId,
      revision: index + 1,
      previousSeconds: index === 0 ? null : index,
      targetSeconds: index + 1,
      measuredSeconds: 1,
      creditedSeconds: 1,
      createdAt: new Date(Date.UTC(2026, 10, 26, 10, 0, index)).toISOString()
    }));
  }

  const task = {
    id: 1,
    actualSeconds: 501,
    actual: 8,
    creditRevision: 501,
    creditSchemaVersion: 1,
    lastCreditOperationId: ledger[500].operationId
  };
  const displaySessions = ledger.slice(-500).map(operation => ({
    sessionId: operation.sessionId
  }));

  assert.equal(displaySessions.length, 500);
  assert.equal(displaySessions.some(session => session.sessionId === ledger[0].sessionId), false,
    'the oldest session is no longer in the bounded display history');
  assert.equal(app._validateCreditOperationLedger(ledger, [task]), true,
    'the independent durable ledger retains all 501 operation identities');
  assert.equal(app._classifyCreditOperationAttempt(ledger, ledger[0]).status, 'duplicate',
    'retrying the evicted session is still recognized as already applied');
  assert.equal(app._classifyCreditOperationAttempt(ledger, {
    ...ledger[0], measuredSeconds: 2, creditedSeconds: 2, targetSeconds: 2
  }).status, 'conflict', 'the evicted identity cannot be reused with a different payload');
  assert.equal(app._creditOperationLedgerPreservesHistory(ledger, ledger.slice(0, 500)), false,
    'a backup that predates the latest accepted operation cannot roll the ledger back');
});


test('deleted task IDs remain reserved while their credit-operation history is retained', () => {
  const app = context();
  const operations = [
    { taskId: 17 },
    { taskId: 904 },
    { taskId: 3 }
  ];

  assert.equal(app._getHighestCreditOperationTaskId(operations), 904);
  assert.equal(app._getHighestCreditOperationTaskId([]), 0);
  assert.equal(app._getHighestCreditOperationTaskId(null), 0);
  assert.equal(app._getHighestCreditOperationTaskId([{ taskId: -1 }, { taskId: 1.5 }]), 0);
});
