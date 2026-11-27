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

function createStopwatchSaveHarness(options = {}) {
  const calls = [];
  const alerts = [];
  const toasts = [];
  const task = options.task === null
    ? null
    : { id: 7, name: 'Stopwatch task', actual: options.actual ?? 5 };
  const timer = {
    mode: 'stopwatch',
    phase: 'work',
    running: false,
    baseElapsed: 125,
    startedAt: null,
    cyclePosition: 0,
    taskId: task ? task.id : null,
    sessionStartAt: 1_700_000_000_000,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false,
    pendingStopwatchTransaction: null
  };
  let logged = !!options.alreadyLogged;
  let resetAttempts = 0;
  let releaseCalls = 0;
  let saveCalls = 0;
  const sandbox = {
    _focusTimer: timer,
    _focusElapsedRemainderMs: 250,
    _focusTimerExternalConflict: false,
    storageRecoveryRequired: false,
    tasks: task ? [task] : [],
    console: { error() {}, warn() {} },
    _sessionAlreadyLogged() { calls.push('alreadyLogged'); return logged; },
    _hasAmbiguousLegacyFocusSession: () => false,
    _validatePendingStopwatchTransaction: () => true,
    _saveFocusTimer() { calls.push('saveTimer'); return true; },
    _recoverPendingStopwatchSave(holdAlreadyAcquired) {
      const transaction = timer.pendingStopwatchTransaction;
      if (!transaction) return true;
      if (!sandbox._logSession('work', transaction.durationSec, true)) {
        sandbox.storageRecoveryRequired = true;
        sandbox.showAlertModal("لم يكتمل استرداد Stopwatch", "تعذر تسجيل الجلسة.");
        return false;
      }
      if (!sandbox._resetAfterSession()) return false;
      timer.pendingStopwatchTransaction = null;
      if (!sandbox._saveFocusTimer()) {
        timer.pendingStopwatchTransaction = transaction;
        sandbox.storageRecoveryRequired = true;
        return false;
      }
      if (!holdAlreadyAcquired) sandbox._completeRollingRecoveryCheckpoint('stopwatch-transaction-recovery');
      return true;
    },
    _acquireRollingRecoveryCheckpointHold(required) {
      calls.push('hold:' + required);
      let released = false;
      return function() {
        if (released) return;
        released = true;
        releaseCalls++;
        calls.push('release');
      };
    },
    saveData() {
      saveCalls++;
      calls.push('saveData');
      return typeof options.saveDataResult === 'function'
        ? options.saveDataResult(saveCalls)
        : options.saveDataResult !== false;
    },
    _logSession(...args) {
      calls.push('logSession');
      if (options.logResult === false) return false;
      if (!logged) sandbox.loggedArgs = args;
      logged = true;
      return true;
    },
    _completeRollingRecoveryCheckpoint(reason) {
      calls.push('checkpoint:' + reason);
      return options.checkpointResult !== false;
    },
    _resetAfterSession() {
      resetAttempts++;
      calls.push('reset');
      if (typeof options.resetResult === 'function') {
        const result = options.resetResult(resetAttempts);
        if (!result) return false;
      } else if (options.resetResult === false) {
        return false;
      }
      timer.running = false;
      timer.baseElapsed = 0;
      timer.startedAt = null;
      timer.sessionStartAt = null;
      sandbox._focusElapsedRemainderMs = 0;
      return true;
    },
    _renderFocusTimer() { calls.push('renderTimer'); },
    renderAll() { calls.push('renderAll'); },
    showToast(message) { toasts.push(message); },
    showAlertModal(...args) { alerts.push(args); }
  };
  vm.runInNewContext(extractFunction('_applyStopwatchSave'), sandbox);
  return {
    sandbox, timer, task, calls, alerts, toasts,
    get logged() { return logged; },
    get resetAttempts() { return resetAttempts; },
    get releaseCalls() { return releaseCalls; },
    get saveCalls() { return saveCalls; }
  };
}

test('Stopwatch save commits task time and session before resetting the paused timer', () => {
  const h = createStopwatchSaveHarness({ actual: 5 });

  h.sandbox._applyStopwatchSave(125, h.task, 3);

  assert.equal(h.task.actual, 8);
  assert.equal(h.logged, true);
  assert.deepEqual(h.sandbox.loggedArgs.slice(0, 3), ['work', 125, true]);
  assert.equal(h.resetAttempts, 1);
  assert.equal(h.timer.baseElapsed, 0);
  assert.equal(h.timer.running, false);
  assert.ok(h.calls.indexOf('saveData') < h.calls.indexOf('logSession'));
  assert.ok(h.calls.indexOf('logSession') < h.calls.indexOf('reset'));
  assert.ok(h.calls.indexOf('reset') < h.calls.indexOf('checkpoint:focus-session-commit'));
  assert.equal(h.releaseCalls, 1, 'checkpoint hold must be released exactly once');
  assert.ok(h.toasts.some(message => /أُضيفت 3 دقيقة/.test(message)));
});

test('Stopwatch does not log a session or retain task minutes when the task save fails', () => {
  const h = createStopwatchSaveHarness({ actual: 5, saveDataResult: false });

  h.sandbox._applyStopwatchSave(125, h.task, 3);

  assert.equal(h.task.actual, 5, 'the unverified main write must not remain as an in-memory commit');
  assert.equal(h.logged, false);
  assert.equal(h.saveCalls, 1);
  assert.equal(h.resetAttempts, 0);
  assert.equal(h.timer.baseElapsed, 125, 'the paused stopwatch time remains available');
  assert.ok(h.timer.pendingStopwatchTransaction, 'the durable timer journal remains available for restart recovery');
  assert.equal(h.sandbox.storageRecoveryRequired, true);
  assert.equal(h.releaseCalls, 1);
});

test('Stopwatch keeps committed task minutes and a pending journal when session logging fails', () => {
  const h = createStopwatchSaveHarness({ actual: 5, logResult: false });

  h.sandbox._applyStopwatchSave(125, h.task, 3);

  assert.equal(h.task.actual, 8, 'the verified task update remains committed while its session is pending');
  assert.equal(h.saveCalls, 1, 'the task update is written once; recovery must not roll it back and re-add it');
  assert.equal(h.resetAttempts, 0, 'a failed session write must not reset the stopwatch');
  assert.equal(h.timer.baseElapsed, 125);
  assert.ok(h.timer.pendingStopwatchTransaction, 'the persistent journal must remain until recovery completes');
  assert.equal(h.sandbox.storageRecoveryRequired, true);
  assert.equal(h.releaseCalls, 1);
  assert.equal(h.calls.some(call => String(call).indexOf('checkpoint:') === 0), false,
    'no rolling checkpoint may publish an incomplete transaction');
  assert.match(h.alerts[0][0], /لم يكتمل استرداد Stopwatch/);
});

test('retry after a logged session but failed timer reset does not add the task minutes twice', () => {
  const h = createStopwatchSaveHarness({
    actual: 5,
    resetResult(attempt) { return attempt > 1; }
  });

  h.sandbox._applyStopwatchSave(125, h.task, 3);
  assert.equal(h.task.actual, 8);
  assert.equal(h.resetAttempts, 1);
  assert.equal(h.timer.baseElapsed, 125);

  h.sandbox._applyStopwatchSave(125, h.task, 3);
  assert.equal(h.task.actual, 8, 'already-logged retry must not add the same minutes again');
  assert.equal(h.resetAttempts, 2);
  assert.equal(h.timer.baseElapsed, 0);
  assert.equal(h.releaseCalls, 1, 'the retry replays the durable transaction without acquiring a second save hold');
  assert.equal(h.timer.pendingStopwatchTransaction, null);
  assert.ok(h.toasts.some(message => /استُكملت معاملة جلسة التركيز المحفوظة دون تكرار/.test(message)));
});

test('an already logged Stopwatch session completes reset without changing task.actual', () => {
  const h = createStopwatchSaveHarness({ actual: 11, alreadyLogged: true });

  h.sandbox._applyStopwatchSave(125, h.task, 3);

  assert.equal(h.task.actual, 11);
  assert.equal(h.saveCalls, 0);
  assert.equal(h.resetAttempts, 1);
  assert.ok(h.toasts.some(message => /استُكمل تصفير جلسة مسجلة سابقًا/.test(message)));
});

test('resetTimer uses the Stopwatch save decision at 60 seconds, not below it', () => {
  const outcomes = [];
  const sandbox = {
    _focusTimerExternalConflict: false,
    STOPWATCH_SAVE_THRESHOLD_SEC: 60,
    _focusTimer: { mode: 'stopwatch', running: false },
    _getElapsedSec: () => sandbox.elapsed,
    _formatDuration: (elapsed) => String(elapsed) + ' sec',
    _showStopwatchSaveDialog: (elapsed) => outcomes.push(['stopwatch-dialog', elapsed]),
    showConfirmModal: (...args) => outcomes.push(['generic-confirm', ...args]),
    _resetAfterSession: () => true,
    showToast() {}
  };
  vm.runInNewContext(extractFunction('resetTimer'), sandbox);

  sandbox.elapsed = 59;
  sandbox.resetTimer();
  sandbox.elapsed = 60;
  sandbox.resetTimer();

  assert.equal(outcomes[0][0], 'generic-confirm');
  assert.deepEqual(outcomes[1], ['stopwatch-dialog', 60]);
});

function createStopwatchDialogHarness({ saveResult = true, logResult = true } = {}) {
  const nodes = new Map();
  let nextElementId = 0;
  function element(name) {
    if (!nodes.has(name)) {
      nodes.set(name, {
        name,
        className: '',
        textContent: '',
        innerHTML: '',
        children: [],
        classList: { removed: [], remove(value) { this.removed.push(value); } },
        appendChild(child) { this.children.push(child); }
      });
    }
    return nodes.get(name);
  }
  const calls = [];
  const timer = {
    mode: 'stopwatch', phase: 'work', running: true, baseElapsed: 10,
    startedAt: 1_700_000_000_000, cyclePosition: 0, taskId: null,
    sessionStartAt: 1_699_999_990_000, awaitingConfirmation: false,
    pendingPhaseEndedAt: null, clockAdjusted: false
  };
  const sandbox = {
    _focusTimer: timer,
    _focusTimerExternalConflict: false,
    _focusElapsedRemainderMs: 100,
    STOPWATCH_SAVE_THRESHOLD_SEC: 60,
    tasks: [],
    _getFocusTimerElapsedParts: () => ({ seconds: 75, remainderMs: 650 }),
    _stopDisplayTick: () => calls.push('stopTick'),
    _startDisplayTick: () => calls.push('startTick'),
    _saveFocusTimer: () => {
      calls.push('saveTimer');
      return typeof saveResult === 'function' ? saveResult(timer) : saveResult;
    },
    _renderFocusTimer: () => calls.push('renderTimer'),
    _formatDuration: (sec) => String(sec) + ' sec',
    escapeHTML: value => String(value),
    _logSession: (...args) => { calls.push(['logSession', ...args]); return logResult; },
    _resetAfterSession: () => {
      calls.push('reset');
      if (logResult === false) return false;
      timer.running = false;
      timer.baseElapsed = 0;
      timer.startedAt = null;
      sandbox._focusElapsedRemainderMs = 0;
      return true;
    },
    closeModal: () => calls.push('closeModal'),
    renderFocusSessionsCard: () => calls.push('renderSessions'),
    showToast: message => calls.push(['toast', message]),
    showAlertModal: (...args) => calls.push(['alert', ...args]),
    document: {
      getElementById: element,
      createElement: (name) => element('created-' + name + '-' + nextElementId++),
      addEventListener(type, handler) { calls.push(['addEventListener', type]); sandbox.modalHandler = handler; },
      removeEventListener(type, handler) { calls.push(['removeEventListener', type]); }
    },
    _setupModalFocusTrap: () => () => {},
    _modalKeyHandler: null
  };
  vm.runInNewContext(extractFunction('_showStopwatchSaveDialog'), sandbox);
  return { sandbox, nodes, calls, timer };
}

test('Stopwatch decision dialog freezes elapsed milliseconds and keeps the session paused on cancel', () => {
  const h = createStopwatchDialogHarness();

  h.sandbox._showStopwatchSaveDialog(75);

  assert.equal(h.timer.running, false);
  assert.equal(h.timer.baseElapsed, 75);
  assert.equal(h.sandbox._focusElapsedRemainderMs, 650);
  assert.equal(h.timer.startedAt, null);
  assert.ok(h.calls.includes('saveTimer'));

  const cancel = h.nodes.get('modalFooter').children[0];
  cancel.onclick();
  assert.equal(h.timer.running, false);
  assert.equal(h.timer.baseElapsed, 75);
  assert.ok(h.calls.includes('closeModal'));
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'logSession'), false);
  assert.equal(h.calls.includes('reset'), false);
});

test('Stopwatch decision dialog restores the running timer when its pause checkpoint fails', () => {
  const h = createStopwatchDialogHarness({ saveResult: false });

  h.sandbox._showStopwatchSaveDialog(75);

  assert.equal(h.timer.running, true);
  assert.equal(h.timer.baseElapsed, 10);
  assert.equal(h.timer.startedAt, 1_700_000_000_000);
  assert.equal(h.sandbox._focusElapsedRemainderMs, 100);
  assert.ok(h.calls.includes('startTick'));
  assert.equal(h.nodes.get('modalOverlay'), undefined);
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'alert'));
});


test('unlinked Stopwatch save records the frozen session before clearing the timer', () => {
  const h = createStopwatchDialogHarness();
  h.sandbox._showStopwatchSaveDialog(75);

  const save = h.nodes.get('modalFooter').children[2];
  save.onclick();

  assert.deepEqual(
    h.calls.find(call => Array.isArray(call) && call[0] === 'logSession'),
    ['logSession', 'work', 75, true]
  );
  assert.ok(h.calls.indexOf('logSession') < h.calls.indexOf('reset'));
  assert.ok(h.calls.includes('renderSessions'));
  assert.equal(h.timer.running, false);
  assert.equal(h.timer.baseElapsed, 0);
  assert.ok(h.calls.some(call => Array.isArray(call) && /حُفظت الجلسة/.test(call[1])));
});

test('unlinked Stopwatch save failure keeps the frozen session available and does not reset it', () => {
  const h = createStopwatchDialogHarness({ logResult: false });
  h.sandbox._showStopwatchSaveDialog(75);

  const save = h.nodes.get('modalFooter').children[2];
  save.onclick();

  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'logSession'));
  assert.equal(h.calls.includes('reset'), false);
  assert.equal(h.timer.running, false);
  assert.equal(h.timer.baseElapsed, 75);
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'alert' && /بقيت الجلسة متوقفة/.test(call[2])));
});

test('unlinked Stopwatch discard resets the timer without logging a session', () => {
  const h = createStopwatchDialogHarness();
  h.sandbox._showStopwatchSaveDialog(75);

  const discard = h.nodes.get('modalFooter').children[1];
  discard.onclick();

  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'logSession'), false);
  assert.ok(h.calls.includes('reset'));
  assert.equal(h.timer.running, false);
  assert.equal(h.timer.baseElapsed, 0);
});
