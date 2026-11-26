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
  const calls = [], alerts = [], toasts = [];
  const task = options.task === null ? null : { id: 7, name: 'Stopwatch task', actual: options.actual === undefined ? 5 : options.actual };
  const timer = {
    mode: 'stopwatch', phase: 'work', running: false, baseElapsed: 125, startedAt: null,
    cyclePosition: 0, taskId: task ? task.id : null, sessionStartAt: 1_700_000_000_000,
    awaitingConfirmation: false, pendingPhaseEndedAt: null, clockAdjusted: false
  };
  const snapshot = Object.freeze({
    mode: timer.mode, phase: timer.phase, running: false, baseElapsed: timer.baseElapsed,
    elapsedRemainderMs: 250, startedAt: null, cyclePosition: 0, taskId: timer.taskId,
    sessionStartAt: timer.sessionStartAt, awaitingConfirmation: false,
    pendingPhaseEndedAt: null, clockAdjusted: false
  });
  const sandbox = {
    _focusTimer: timer,
    _focusElapsedRemainderMs: 250,
    tasks: task ? [task] : [],
    _captureFocusTimerSnapshot: () => snapshot,
    _commitFocusTaskSession(params) {
      calls.push(params);
      return Promise.resolve(options.commitResult !== false);
    },
    showAlertModal(...args) { alerts.push(args); },
    showToast(message) { toasts.push(message); },
    console: { error() {}, warn() {} }
  };
  vm.runInNewContext(extractFunction('_applyStopwatchSave'), sandbox);
  return { sandbox, timer, task, calls, alerts, toasts, snapshot };
}

test('Stopwatch save wrapper delegates the frozen task-linked snapshot to the common engine', async () => {
  const h = createStopwatchSaveHarness();
  assert.equal(await h.sandbox._applyStopwatchSave(125, h.task, 3), true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].taskId, 7);
  assert.equal(h.calls[0].minutesToAdd, 3);
  assert.equal(h.calls[0].completed, true);
  assert.equal(h.calls[0].snapshot, h.snapshot);
  assert.equal(Object.isFrozen(h.calls[0].snapshot), true);
});

test('Stopwatch save wrapper propagates a failed common transaction without mutating the task', async () => {
  const h = createStopwatchSaveHarness({ commitResult: false });
  assert.equal(await h.sandbox._applyStopwatchSave(125, h.task, 3), false);
  assert.equal(h.task.actual, 5);
});

test('zero-minute Stopwatch save is still delegated as a task-linked transaction', async () => {
  const h = createStopwatchSaveHarness({ actual: null });
  assert.equal(await h.sandbox._applyStopwatchSave(125, h.task, 0), true);
  assert.equal(h.calls[0].minutesToAdd, 0);
  assert.equal(h.calls[0].taskId, 7);
  assert.equal(h.task.actual, null);
});

test('Stopwatch save uses the frozen task ID rather than a stale task argument', async () => {
  const h = createStopwatchSaveHarness();
  const staleTask = { id: 999, actual: 40 };
  await h.sandbox._applyStopwatchSave(125, staleTask, 2, h.snapshot);
  assert.equal(h.calls[0].taskId, 7);
  assert.equal(staleTask.actual, 40);
});

test('Stopwatch save refuses to delegate without a valid frozen snapshot', async () => {
  const h = createStopwatchSaveHarness();
  h.sandbox._captureFocusTimerSnapshot = () => null;
  assert.equal(await h.sandbox._applyStopwatchSave(125, h.task, 3), false);
  assert.equal(h.calls.length, 0);
});

function createResetTimerHarness(elapsed) {
  const calls = [];
  const sandbox = {
    _focusTimer: { mode: 'stopwatch', running: false, baseElapsed: elapsed },
    _focusTimerExternalConflict: false,
    _isTaskStorageLockHeld: () => true,
    _withTaskStorageLock: callback => callback(),
    _isFocusCommitBlocked: () => false,
    _getElapsedSec: () => elapsed,
    STOPWATCH_SAVE_THRESHOLD_SEC: 60,
    _formatDuration: String,
    showConfirmModal(...args) { calls.push(['confirm', ...args]); },
    _showStopwatchSaveDialog(value) { calls.push(['stopwatch-dialog', value]); },
    showAlertModal(...args) { calls.push(['alert', ...args]); },
    showToast(message) { calls.push(['toast', message]); }
  };
  vm.runInNewContext(extractFunction('resetTimer'), sandbox);
  return { sandbox, calls };
}

test('resetTimer uses the Stopwatch save decision at 60 seconds, not below it', () => {
  const below = createResetTimerHarness(59);
  below.sandbox.resetTimer();
  assert.equal(below.calls.some((call) => call[0] === 'confirm'), true);
  assert.equal(below.calls.some((call) => call[0] === 'stopwatch-dialog'), false);

  const atThreshold = createResetTimerHarness(60);
  atThreshold.sandbox.resetTimer();
  assert.deepEqual(atThreshold.calls[0], ['stopwatch-dialog', 60]);
});

function createStopwatchDialogHarness({ saveResult = true, logResult = true } = {}) {
  const nodes = new Map();
  let nextElementId = 0;
  function element(name) {
    if (!nodes.has(name)) {
      nodes.set(name, {
        name, className: '', textContent: '', innerHTML: '', children: [],
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
    pendingPhaseEndedAt: null, clockAdjusted: false, pendingStopwatchTransaction: null
  };
  const sandbox = {
    _focusTimer: timer,
    _focusTimerExternalConflict: false,
    storageRecoveryRequired: false,
    _focusElapsedRemainderMs: 100,
    STOPWATCH_SAVE_THRESHOLD_SEC: 60,
    tasks: [],
    _getFocusTimerElapsedParts: () => ({ seconds: 75, remainderMs: 650 }),
    _stopNativeStopwatchForegroundService: () => Promise.resolve(false),
    _stopDisplayTick: () => calls.push('stopTick'),
    _startDisplayTick: () => calls.push('startTick'),
    _saveFocusTimer: () => {
      calls.push('saveTimer');
      return typeof saveResult === 'function' ? saveResult(timer) : saveResult;
    },
    _renderFocusTimer: () => calls.push('renderTimer'),
    _formatDuration: (sec) => String(sec) + ' sec',
    escapeHTML: (value) => String(value),
    _logSession: (...args) => { calls.push(['logSession', ...args]); return logResult; },
    _resetAfterSession: () => {
      calls.push('reset');
      if (logResult === false) return false;
      timer.running = false;
      timer.baseElapsed = 0;
      timer.startedAt = null;
      timer.sessionStartAt = null;
      sandbox._focusElapsedRemainderMs = 0;
      return true;
    },
    _commitFocusTaskSession(params) {
      calls.push(['commit', params]);
      if (params.taskId === null) {
        const logged = sandbox._logSession(params.snapshot.phase, params.snapshot.baseElapsed, params.completed);
        if (!logged) {
          sandbox.showAlertModal('تعذر تسجيل الجلسة', 'بقيت الجلسة متوقفة ولم يتم تصفير المؤقت.');
          return Promise.resolve(false);
        }
        const reset = sandbox._resetAfterSession();
        if (!reset) return Promise.resolve(false);
        sandbox.renderFocusSessionsCard();
        sandbox.showToast(params.successToast);
        return Promise.resolve(true);
      }
      return Promise.resolve(true);
    },
    _discardShortFocusSession(params) {
      calls.push(['discard', params]);
      const reset = sandbox._resetAfterSession();
      return Promise.resolve(reset);
    },
    closeModal: () => calls.push('closeModal'),
    renderFocusSessionsCard: () => calls.push('renderSessions'),
    showToast: (message) => calls.push(['toast', message]),
    showAlertModal: (...args) => calls.push(['alert', ...args]),
    document: {
      getElementById: element,
      createElement: () => element('created-' + nextElementId++),
      addEventListener(type, handler) { calls.push(['addEventListener', type]); sandbox.modalHandler = handler; },
      removeEventListener(type) { calls.push(['removeEventListener', type]); }
    },
    _setupModalFocusTrap: () => () => {},
    _modalKeyHandler: null
  };
  const names = ['_captureFocusTimerSnapshot', '_freezeFocusTimerForDecision', '_applyStopwatchSave', '_showStopwatchSaveDialog'];
  vm.runInNewContext(names.map(extractFunction).join('\n'), sandbox);
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

  h.nodes.get('modalFooter').children[0].onclick();
  assert.equal(h.timer.running, false);
  assert.equal(h.timer.baseElapsed, 75);
  assert.ok(h.calls.includes('closeModal'));
  assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === 'logSession'), false);
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
  assert.equal(h.nodes.get('customModalOverlay'), undefined);
  assert.ok(h.calls.some((call) => Array.isArray(call) && call[0] === 'alert'));
});

test('unlinked Stopwatch save records the frozen session before clearing the timer through the common engine', () => {
  const h = createStopwatchDialogHarness();
  h.sandbox._showStopwatchSaveDialog(75);
  h.nodes.get('modalFooter').children[2].onclick();

  const commit = h.calls.find((call) => Array.isArray(call) && call[0] === 'commit');
  const log = h.calls.find((call) => Array.isArray(call) && call[0] === 'logSession');
  assert.equal(commit[1].taskId, null);
  assert.deepEqual(log, ['logSession', 'work', 75, true]);
  assert.ok(h.calls.indexOf(log) < h.calls.indexOf('reset'));
  assert.ok(h.calls.includes('renderSessions'));
  assert.equal(h.timer.running, false);
  assert.equal(h.timer.baseElapsed, 0);
  assert.ok(h.calls.some((call) => Array.isArray(call) && call[0] === 'toast'));
});

test('unlinked Stopwatch save failure keeps the frozen session available and does not reset it', () => {
  const h = createStopwatchDialogHarness({ logResult: false });
  h.sandbox._showStopwatchSaveDialog(75);
  h.nodes.get('modalFooter').children[2].onclick();

  assert.ok(h.calls.some((call) => Array.isArray(call) && call[0] === 'logSession'));
  assert.equal(h.calls.includes('reset'), false);
  assert.equal(h.timer.running, false);
  assert.equal(h.timer.baseElapsed, 75);
  assert.ok(h.calls.some((call) => Array.isArray(call) && call[0] === 'alert'));
});

test('unlinked Stopwatch discard resets the timer without logging a session', () => {
  const h = createStopwatchDialogHarness();
  h.sandbox._showStopwatchSaveDialog(75);
  h.nodes.get('modalFooter').children[1].onclick();

  assert.ok(h.calls.some((call) => Array.isArray(call) && call[0] === 'discard'));
  assert.equal(h.calls.includes('reset'), true);
  assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === 'logSession'), false);
  assert.equal(h.timer.baseElapsed, 0);
});
