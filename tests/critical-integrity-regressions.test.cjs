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
  const end = html.indexOf('\\n}', start);
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
  assert.match(extractFunction('_showSessionTransitionDialog'), /cancelBtn\\.id = 'modalCancelBtn'/);
  assert.match(extractFunction('_showStopwatchSaveDialog'), /cancelBtn\\.id = 'modalCancelBtn'/);
  assert.match(extractFunction('finishTimer'), /cancelBtn\\.id = 'modalCancelBtn'/);
});

test('session history safety ceiling is raised without automatic truncation', () => {
  assert.match(html, /FOCUS_MAX_SESSIONS = 10000/);
  assert.doesNotMatch(html, /valid\\s*=\\s*valid\\.slice\\(-FOCUS_MAX_SESSIONS\\)/);
});
