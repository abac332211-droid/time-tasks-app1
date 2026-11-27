'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractFunction(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, 'missing ' + name);
  const end = html.indexOf('\n}', start);
  assert.notEqual(end, -1, 'missing end for ' + name);
  return html.slice(start, end + 2);
}

test('task completion and reopening preserve the existing actual balance', () => {
  const task = { id: 1, status: 'pending', actual: 47, expected: 30, completedAt: null };
  let prompt;
  const sandbox = {
    tasks: [task], isTaskCancelled: () => false,
    showPromptModal(_title, _body, initial, _placeholder, callback) { prompt = { initial, callback }; },
    showToast() {}, showAlertModal() {},
    localDateTimeString: () => '2026-11-27T12:00:00',
    saveData: () => true, renderAll() {},
    _focusTimer: { taskId: null }
  };
  vm.runInNewContext(extractFunction('toggleTask'), sandbox);
  sandbox.toggleTask(1);
  assert.equal(prompt.initial, 47);
  prompt.callback('');
  assert.equal(task.status, 'done');
  assert.equal(task.actual, 47);
  sandbox.toggleTask(1);
  assert.equal(task.status, 'pending');
  assert.equal(task.actual, 47);
});

test('operational date parsing rolls pre-04:00 appointments to the next civil date', () => {
  const sandbox = { appSettings: { operationalDayStart: 4 }, isValidCalendarDate: () => true, isValidLocalTime: () => true };
  vm.runInNewContext(extractFunction('parseTaskDate'), sandbox);
  const parsed = sandbox.parseTaskDate('2026-11-26', '01:30');
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 10);
  assert.equal(parsed.getDate(), 27);
  assert.equal(parsed.getHours(), 1);
  assert.equal(parsed.getMinutes(), 30);
  const boundary = sandbox.parseTaskDate('2026-11-26', '04:00');
  assert.equal(boundary.getDate(), 26);
  assert.equal(boundary.getHours(), 4);
});

test('away confirmation dismissal releases the modal guard but preserves pending phase', () => {
  let onCancel;
  let opens = 0;
  const timer = { awaitingConfirmation: true, phase: 'work', baseElapsed: 1500, cyclePosition: 0,
    sessionStartAt: 1000, pendingPhaseEndedAt: 2500, running: false, taskId: 9, mode: 'pomodoro' };
  const sandbox = {
    _focusTimer: timer, _focusTimerExternalConflict: false, _focusElapsedRemainderMs: 0,
    _awaySessionPromptOpen: false, _phaseTargetSec: () => 1500,
    document: { getElementById: () => ({ classList: { contains: () => true } }) },
    showConfirmModal(_title, _body, _confirm, cancel) { onCancel = cancel; opens++; },
    _renderFocusTimer() {}, showToast() {}
  };
  vm.runInNewContext(extractFunction('_showAwaySessionConfirmation'), sandbox);
  sandbox._showAwaySessionConfirmation();
  assert.equal(sandbox._awaySessionPromptOpen, true);
  onCancel();
  assert.equal(sandbox._awaySessionPromptOpen, false);
  assert.equal(timer.awaitingConfirmation, true);
  assert.equal(timer.sessionStartAt, 1000);
  sandbox._showAwaySessionConfirmation();
  assert.equal(opens, 2);
});

test('timer decision modals expose their cancel controls to backdrop and Escape handling', () => {
  assert.match(extractFunction('_showSessionTransitionDialog'), /cancelBtn\.id = 'modalCancelBtn'/);
  assert.match(extractFunction('_showStopwatchSaveDialog'), /cancelBtn\.id = 'modalCancelBtn'/);
  assert.match(extractFunction('finishTimer'), /cancelBtn\.id = 'modalCancelBtn'/);
});

test('session history has no app-level count limit or automatic truncation', () => {
  assert.doesNotMatch(html, /FOCUS_MAX_SESSIONS/);
  assert.doesNotMatch(html, /valid.*slice\(/);
});


test('deleting a task linked to an active focus session is blocked without touching either store', () => {
  const task = { id: 9, name: 'مهمة بمؤقت جارٍ' };
  let confirms = 0, mainWrites = 0, timerWrites = 0;
  const sandbox = {
    tasks: [task], editingId: null, storageRecoveryRequired: false,
    _focusTimer: { taskId: 9, running: true, baseElapsed: 15, pendingStopwatchTransaction: null },
    _focusElapsedRemainderMs: 0,
    showConfirmModal() { confirms++; },
    _saveFocusTimer() { timerWrites++; return true; },
    saveData() { mainWrites++; return true; },
    _renderFocusTimer() {}, renderAll() {}, showToast() {}
  };
  vm.runInNewContext(extractFunction('deleteTask'), sandbox);
  sandbox.deleteTask(9);
  assert.equal(confirms, 0);
  assert.equal(mainWrites, 0);
  assert.equal(timerWrites, 0);
  assert.equal(sandbox.tasks[0], task);
  assert.equal(sandbox._focusTimer.taskId, 9);
});


test('focus commit lock serializes same-tab work and limits its write permit to the synchronous transaction', async () => {
  const execution = [];
  let nativeActive = 0, maxNativeActive = 0;
  const sandbox = {
    _focusTaskCommitQueue: Promise.resolve(),
    _focusTaskCommitPendingCount: 0,
    _focusTaskCommitExecuting: false,
    navigator: {
      locks: {
        request(name, options, callback) {
          assert.equal(name, 'timeTasksApp-focus-session-commit');
          assert.equal(options.mode, 'exclusive');
          nativeActive++;
          maxNativeActive = Math.max(maxNativeActive, nativeActive);
          return Promise.resolve().then(callback).finally(() => { nativeActive--; });
        }
      }
    }
  };
  const start = html.indexOf('function _withFocusTaskCommitLock(');
  const end = html.indexOf('\\n}\\n', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(html.slice(start, end + 2), sandbox);
  const first = sandbox._withFocusTaskCommitLock(() => {
    execution.push('first');
    assert.equal(sandbox._focusTaskCommitExecuting, true);
    return 1;
  });
  const second = sandbox._withFocusTaskCommitLock(() => {
    execution.push('second');
    assert.equal(sandbox._focusTaskCommitExecuting, true);
    return 2;
  });
  assert.equal(sandbox._focusTaskCommitPendingCount, 2);
  assert.equal(sandbox._focusTaskCommitExecuting, false,
    'the write permit is not held while waiting for a lock');
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(execution, ['first', 'second']);
  assert.equal(maxNativeActive, 1);
  assert.equal(sandbox._focusTaskCommitPendingCount, 0);
  assert.equal(sandbox._focusTaskCommitExecuting, false);
});

test('focus commit lock releases queue state after lock acquisition failure', async () => {
  let requests = 0;
  const sandbox = {
    _focusTaskCommitQueue: Promise.resolve(),
    _focusTaskCommitPendingCount: 0,
    _focusTaskCommitExecuting: false,
    navigator: {
      locks: {
        request() {
          requests++;
          return requests === 1
            ? Promise.reject(new Error('simulated Web Lock acquisition failure'))
            : Promise.resolve().then(() => 'recovered');
        }
      }
    }
  };
  const start = html.indexOf('function _withFocusTaskCommitLock(');
  const end = html.indexOf('\\n}\\n', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(html.slice(start, end + 2), sandbox);
  await assert.rejects(sandbox._withFocusTaskCommitLock(() => 'must not run'));
  assert.equal(sandbox._focusTaskCommitPendingCount, 0);
  assert.equal(sandbox._focusTaskCommitExecuting, false);
  assert.equal(await sandbox._withFocusTaskCommitLock(() => 'recovered'), 'recovered');
  assert.equal(sandbox._focusTaskCommitPendingCount, 0);
});
