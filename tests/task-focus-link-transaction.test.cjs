'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appScript = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map((match) => match[1]).find((source) => source.includes('APP_VERSION'));
assert.ok(appScript, 'application script exists');

function extract(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(re);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  extract('_taskFocusLinkComparableTask'),
  extract('_taskFocusLinkOtherTasksFingerprint'),
  extract('_validatePendingTaskFocusLinkMutation'),
  extract('_taskFocusLinkMutationState'),
  extract('_focusCommitDeepEqual')
].join('\n'), sandbox);

const before = {
  id: 7, name: 'مهمة مرتبطة', status: 'pending', type: 'معرفية',
  expected: 25, actual: null, plannedDate: '2026-11-28',
  plannedTime: '', completedAt: null, createdAt: 7
};
const target = { ...before, status: 'done', completedAt: '2026-11-28T10:00:00' };
const other = {
  id: 8, name: 'مهمة أخرى', status: 'pending', type: 'معرفية',
  expected: 25, actual: null, plannedDate: '2026-11-28',
  plannedTime: '', completedAt: null, createdAt: 8
};
const journal = {
  version: 1,
  id: '123e4567-e89b-42d3-a456-426614174000',
  taskId: 7,
  operation: 'complete',
  phase: 'FOCUS_DETACHED',
  beforeTask: before,
  targetTask: target,
  otherTasksFingerprint: JSON.stringify([other]),
  createdAt: 1795860000000,
  updatedAt: 1795860000000
};

test('Task–Focus journal schema validates and rejects corrupt or mismatched records', () => {
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation(journal), true);
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation({ ...journal, phase: 'UNKNOWN' }), false);
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation({ ...journal, otherTasksFingerprint: '{bad' }), false);
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation({
    ...journal, targetTask: { ...target, id: 99 }
  }), false);
});

test('journal classifier distinguishes pre-commit, committed, and conflicting task snapshots', () => {
  const base = { schemaVersion: 2, tasks: [before, other] };
  assert.equal(sandbox._taskFocusLinkMutationState(base, journal), 'before');
  assert.equal(sandbox._taskFocusLinkMutationState({
    ...base, tasks: [target, other]
  }, journal), 'target');
  assert.equal(sandbox._taskFocusLinkMutationState({
    ...base, tasks: [before, { ...other, name: 'تعديل خارجي' }]
  }, journal), 'conflict');
});

test('delete journal identifies an already-applied deletion but not a missing unrelated task', () => {
  const deletion = {
    ...journal,
    operation: 'delete',
    targetTask: null
  };
  assert.equal(sandbox._validatePendingTaskFocusLinkMutation(deletion), true);
  assert.equal(sandbox._taskFocusLinkMutationState({
    schemaVersion: 2, tasks: [other]
  }, deletion), 'target');
  assert.equal(sandbox._taskFocusLinkMutationState({
    schemaVersion: 2, tasks: [{ ...before, name: 'different' }, other]
  }, deletion), 'conflict');
});

test('main source recognizes the transaction journal in both startup and save paths', () => {
  assert.match(appScript, /pendingTaskFocusLinkMutation/);
  assert.match(appScript, /_recoverPendingTaskFocusLinkMutationFromStartup/);
  assert.match(appScript, /_runStorageRecoveryCoordinatorInsideLock/);
  assert.match(appScript, /if \(pendingTaskFocusLink\) v2\.pendingTaskFocusLinkMutation = pendingTaskFocusLink/);
});
