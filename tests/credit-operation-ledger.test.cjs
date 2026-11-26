'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = Array.from(html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi))
  .map(match => match[1]).filter(source => source.trim());
const appScript = scripts.find(source => source.includes('APP_VERSION'));
assert.ok(appScript, 'application script exists');

function extractFunction(name) {
  const pattern = new RegExp('function\\\\s+' + name + '\\\\s*\\\\([^)]*\\\\)\\\\s*\\\\{[\\\\s\\\\S]*?\\\\n\\\\}');
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
    extractFunction('_classifyCreditOperationAttempt')
  ].join('\\n'), sandbox);
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
    ...first, creditedSeconds: 41, targetSeconds: 41
  }).status, 'conflict');
  assert.equal(app._classifyCreditOperationAttempt(ledger, {
    ...second, operationId: ids.fourth, sessionId: ids.fourth
  }).status, 'conflict', 'a session identity cannot be rebound to another operation');
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
