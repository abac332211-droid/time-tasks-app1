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
const previousOperationId = '123e4567-e89b-42d3-a456-426614174001';
const sessionId = '123e4567-e89b-42d3-a456-426614174002';
const createdAt = Date.parse('2026-11-26T10:00:00.000Z');

function sessionCredit(overrides = {}) {
  return {
    version: 1,
    operationId,
    taskId: 7,
    kind: 'session_credit',
    sessionId,
    previousActualSeconds: null,
    targetActualSeconds: 90,
    previousCreditRevision: 0,
    targetCreditRevision: 1,
    previousLastCreditOperationId: null,
    creditedSeconds: 90,
    creditSource: 'measured',
    createdAt,
    ...overrides
  };
}

function manualAdjustment(overrides = {}) {
  return {
    version: 1,
    operationId,
    taskId: 7,
    kind: 'manual_adjustment',
    sessionId: null,
    previousActualSeconds: null,
    targetActualSeconds: 0,
    previousCreditRevision: 0,
    targetCreditRevision: 1,
    previousLastCreditOperationId: null,
    creditedSeconds: null,
    creditSource: 'user_adjusted',
    createdAt,
    ...overrides
  };
}

function creditTask(seconds, revision, lastOperationId) {
  return {
    id: 7,
    actual: seconds === null ? null : Math.floor(seconds / 60),
    actualSeconds: seconds,
    creditRevision: revision,
    creditSchemaVersion: 1,
    lastCreditOperationId: lastOperationId
  };
}

function context() {
  const sandbox = {};
  vm.runInNewContext([
    extractFunction('_validateTaskCreditFields'),
    extractFunction('_validateTaskCreditOperationV1'),
    extractFunction('_classifyTaskCreditOperationV1')
  ].join('\n'), sandbox);
  return sandbox;
}

test('session credit operation explicitly converts an unrecorded null balance into credited seconds', () => {
  const app = context();
  const operation = sessionCredit();
  assert.equal(app._validateTaskCreditOperationV1(operation), true);
  assert.equal(operation.previousActualSeconds, null);
  assert.equal(operation.targetActualSeconds, 90);
  assert.equal(operation.previousCreditRevision, 0);
  assert.equal(operation.targetCreditRevision, 1);
});

test('session credit uses recorded zero as a distinct previous balance', () => {
  const app = context();
  const operation = sessionCredit({
    previousActualSeconds: 0,
    targetActualSeconds: 45,
    creditedSeconds: 45,
    previousCreditRevision: 4,
    targetCreditRevision: 5,
    previousLastCreditOperationId: previousOperationId
  });
  assert.equal(app._validateTaskCreditOperationV1(operation), true);
});

test('user-adjusted session credit remains distinct from measured active duration', () => {
  const app = context();
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    previousActualSeconds: 120,
    targetActualSeconds: 150,
    creditedSeconds: 30,
    previousCreditRevision: 2,
    targetCreditRevision: 3,
    previousLastCreditOperationId: previousOperationId,
    creditSource: 'user_adjusted'
  })), true);
});

test('manual adjustment can explicitly record zero from null and can clear a recorded balance', () => {
  const app = context();
  assert.equal(app._validateTaskCreditOperationV1(manualAdjustment()), true);
  assert.equal(app._validateTaskCreditOperationV1(manualAdjustment({
    previousActualSeconds: 150,
    targetActualSeconds: null,
    previousCreditRevision: 8,
    targetCreditRevision: 9,
    previousLastCreditOperationId: previousOperationId
  })), true);
});

test('manual no-op cannot consume a credit revision', () => {
  const app = context();
  assert.equal(app._validateTaskCreditOperationV1(manualAdjustment({
    previousActualSeconds: null,
    targetActualSeconds: null
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(manualAdjustment({
    previousActualSeconds: 0,
    targetActualSeconds: 0
  })), false);
});

test('session credit target must equal previous numeric balance plus credited seconds', () => {
  const app = context();
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    targetActualSeconds: 89
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    previousActualSeconds: 10,
    targetActualSeconds: 90
  })), false);
});

test('session credit requires a positive integer amount, a UUID session identity and an explicit source', () => {
  const app = context();
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    creditedSeconds: 0, targetActualSeconds: 0
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    creditedSeconds: 1.5, targetActualSeconds: 1
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    sessionId: 'legacy-session'
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    creditSource: 'none'
  })), false);
});

test('manual adjustment is absolute, user-adjusted and not linked to a session credit', () => {
  const app = context();
  assert.equal(app._validateTaskCreditOperationV1(manualAdjustment({
    sessionId
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(manualAdjustment({
    creditSource: 'measured'
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(manualAdjustment({
    creditedSeconds: 30
  })), false);
});

test('operation identity, task identity and revision chain must be valid', () => {
  const app = context();
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    operationId: 'bad-id'
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    taskId: 0
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    previousLastCreditOperationId: 'bad-id'
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    previousLastCreditOperationId: operationId
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    targetCreditRevision: 2
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    previousCreditRevision: Number.MAX_SAFE_INTEGER,
    targetCreditRevision: Number.MAX_SAFE_INTEGER + 1
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    previousCreditRevision: 0,
    previousLastCreditOperationId: previousOperationId
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    previousCreditRevision: 1,
    previousLastCreditOperationId: null
  })), false);
});

test('credit operation rejects unsafe balance arithmetic and invalid timestamps', () => {
  const app = context();
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    previousActualSeconds: Number.MAX_SAFE_INTEGER - 2,
    targetActualSeconds: Number.MAX_SAFE_INTEGER - 1,
    creditedSeconds: 10
  })), false);
  assert.equal(app._validateTaskCreditOperationV1(sessionCredit({
    createdAt: Number.MAX_SAFE_INTEGER
  })), false);
});

test('recovery classifier distinguishes not-applied, already-applied and conflicting task states', () => {
  const app = context();
  const operation = sessionCredit();
  assert.equal(app._classifyTaskCreditOperationV1(
    creditTask(null, 0, null), operation
  ), 'not_applied');
  assert.equal(app._classifyTaskCreditOperationV1(
    creditTask(90, 1, operationId), operation
  ), 'already_applied');
  assert.equal(app._classifyTaskCreditOperationV1(
    creditTask(60, 1, operationId), operation
  ), 'conflict');
  assert.equal(app._classifyTaskCreditOperationV1(
    creditTask(90, 0, null), operation
  ), 'conflict');
});

test('recovery classifier preserves the null-to-zero distinction for manual adjustment', () => {
  const app = context();
  const operation = manualAdjustment();
  assert.equal(app._classifyTaskCreditOperationV1(
    creditTask(null, 0, null), operation
  ), 'not_applied');
  assert.equal(app._classifyTaskCreditOperationV1(
    creditTask(0, 1, operationId), operation
  ), 'already_applied');
  assert.equal(app._classifyTaskCreditOperationV1(
    creditTask(null, 1, operationId), operation
  ), 'conflict');
});

test('recovery classifier rejects legacy or inconsistent task credit metadata', () => {
  const app = context();
  const legacy = { id: 7, actual: null };
  assert.equal(app._classifyTaskCreditOperationV1(
    legacy, sessionCredit()
  ), 'invalid');
  assert.equal(app._classifyTaskCreditOperationV1(
    creditTask(90, 1, null),
    sessionCredit({
      previousActualSeconds: 90,
      targetActualSeconds: 180,
      creditedSeconds: 90,
      previousCreditRevision: 1,
      targetCreditRevision: 2,
      previousLastCreditOperationId: null
    })
  ), 'invalid');
});
