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
  assert.notEqual(start, -1, 'Missing app function: ' + name);
  const end = html.indexOf('\n}', start);
  assert.notEqual(end, -1, 'Could not locate end of function: ' + name);
  return html.slice(start, end + 2);
}

function makeHarness(anchor = {}) {
  const focusTimer = {
    nativeAnchorElapsedRealtimeMs: anchor.elapsedRealtimeMs ?? 120_000,
    nativeAnchorBootCount: anchor.bootCount ?? 17,
    nativeAnchorBaseMs: anchor.baseMs ?? 9_500
  };
  const sandbox = { _focusTimer: focusTimer };
  vm.runInNewContext(extractFunction('_computeNativeFocusElapsedMs'), sandbox);
  return { focusTimer, compute: sandbox._computeNativeFocusElapsedMs };
}

test('native monotonic clock counts deep-sleep time on the same boot', () => {
  const h = makeHarness();
  const result = h.compute({
    elapsedRealtimeMs: 900_250,
    bootCountAvailable: true,
    bootCount: 17
  }, true);
  assert.equal(result.ok, true);
  assert.equal(result.totalElapsedMs, 789_750);
});

test('native monotonic restore rejects a different boot instead of counting across reboot', () => {
  const h = makeHarness();
  const result = h.compute({
    elapsedRealtimeMs: 70_000,
    bootCountAvailable: true,
    bootCount: 18
  }, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    reason: 'device_rebooted'
  });
});

test('cold restore fails closed when boot identity is unavailable', () => {
  const h = makeHarness({ bootCount: null });
  const result = h.compute({
    elapsedRealtimeMs: 800_000,
    bootCountAvailable: false,
    bootCount: -1
  }, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    reason: 'boot_identity_unavailable'
  });
});

test('same-session refresh can use elapsedRealtime when BOOT_COUNT is unavailable', () => {
  const h = makeHarness({ bootCount: null });
  const result = h.compute({
    elapsedRealtimeMs: 300_000,
    bootCountAvailable: false,
    bootCount: -1
  }, false);
  assert.equal(result.ok, true);
  assert.equal(result.totalElapsedMs, 189_500);
});

test('native clock rejects elapsedRealtime regression', () => {
  const h = makeHarness({ elapsedRealtimeMs: 300_000 });
  const result = h.compute({
    elapsedRealtimeMs: 299_999,
    bootCountAvailable: true,
    bootCount: 17
  }, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    reason: 'elapsed_realtime_regressed'
  });
});

test('native clock refuses missing or malformed persisted anchors', () => {
  const h = makeHarness({ elapsedRealtimeMs: Number.NaN });
  const result = h.compute({
    elapsedRealtimeMs: 500_000,
    bootCountAvailable: true,
    bootCount: 17
  }, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    reason: 'native_anchor_missing'
  });
});

test('timer integration resynchronizes before destructive actions and foreground return', () => {
  assert.match(html, /function _runWithFreshNativeStopwatchClock\(action\)/);
  const freshSource = extractFunction('_runWithFreshNativeStopwatchClock');
  assert.ok(freshSource.includes('peekNotificationAction'));
  assert.ok(freshSource.indexOf('_consumeNativeStopwatchNotificationAction')
    < freshSource.lastIndexOf('return refreshThenAct()'),
    'the pending-action branch must return before the no-action refresh branch');
  assert.ok(extractFunction('toggleTimer').includes('_runWithFreshNativeStopwatchClock'));
  assert.ok(extractFunction('finishTimer').includes('_runWithFreshNativeStopwatchClock'));
  assert.match(html, /function syncClockAfterQueue\(\)/);
  assert.match(html, /_consumeNativeStopwatchNotificationAction\(\)/);
  assert.match(html, /var clockSync = _focusTimer\.nativeRestorePending/);
  assert.match(html, /_refreshNativeStopwatchClock\(false\)/);
  assert.match(html, /function _scheduleNativeStopwatchRestore\(\)/);
  assert.match(html, /if \(_focusTimer\.nativeClockActive && \(fallbackDelta < 0 \|\| fallbackDelta > 120000\)\) \{\s*\/\/ The native monotonic clock will reconcile this interval/);
});

const UUID_ACTION = '11111111-1111-4111-8111-111111111111';
const UUID_OLD = '33333333-3333-4333-8333-333333333333';
const UUID_SESSION = '22222222-2222-4222-8222-222222222222';
const UUID_NEW_SESSION = '44444444-4444-4444-8444-444444444444';

function loadNativeIdentityHarness(overrides = {}) {
  const sandbox = {
    window: {
      crypto: {
        getRandomValues(bytes) {
          bytes.fill(0x11);
          return bytes;
        }
      }
    },
    _validatePendingStopwatchTransaction: () => true,
    ...overrides
  };
  for (const name of [
    '_isNativeStopwatchUuid',
    '_createNativeStopwatchSessionToken',
    '_normalizeFocusTimerRecord',
    '_applyHydratedFocusTimerRecord'
  ]) {
    vm.runInNewContext(extractFunction(name), sandbox);
  }
  return sandbox;
}

test('native clock refresh preserves the fixed service anchor used by notification actions', async () => {
  const timer = {
    mode: 'stopwatch', phase: 'work', running: true, baseElapsed: 5,
    startedAt: 2000, sessionStartAt: 1000, nativeClockActive: true,
    nativeRestorePending: false, nativeBootMismatch: false,
    nativeAnchorElapsedRealtimeMs: 1000, nativeAnchorBootCount: 17,
    nativeAnchorBaseMs: 5000, nativeAnchorWallMs: 2000
  };
  const originalAnchor = {
    elapsed: timer.nativeAnchorElapsedRealtimeMs,
    boot: timer.nativeAnchorBootCount,
    base: timer.nativeAnchorBaseMs,
    wall: timer.nativeAnchorWallMs
  };
  let anchorUpdates = 0;
  const sandbox = {
    _focusTimer: timer,
    _focusElapsedRemainderMs: 0,
    _nativeStopwatchSyncPromise: null,
    _nativeStopwatchSyncInFlight: false,
    _nativeStopwatchPlugin: () => ({}),
    _readNativeStopwatchClock: async () => ({
      elapsedRealtimeMs: 19000, wallTimeMs: 30000,
      bootCount: 17, bootCountAvailable: true
    }),
    _withStopwatchTransactionLock: (callback) => Promise.resolve().then(callback),
    _captureFocusTimerClockState: () => ({
      timer: { ...timer }, remainderMs: sandbox._focusElapsedRemainderMs
    }),
    _restoreFocusTimerClockState: () => true,
    _computeNativeFocusElapsedMs: () => ({ ok: true, totalElapsedMs: 23000 }),
    _setNativeFocusClockAnchor: () => { anchorUpdates++; return true; },
    _anchorFocusTimerClock: () => {},
    _saveFocusTimer: () => true,
    _renderFocusTimer: () => {}
  };
  vm.runInNewContext(extractFunction('_refreshNativeStopwatchClock'), sandbox);

  assert.equal(await sandbox._refreshNativeStopwatchClock(false), true);
  assert.equal(anchorUpdates, 0);
  assert.deepEqual({
    elapsed: timer.nativeAnchorElapsedRealtimeMs,
    boot: timer.nativeAnchorBootCount,
    base: timer.nativeAnchorBaseMs,
    wall: timer.nativeAnchorWallMs
  }, originalAnchor);
  assert.equal(timer.baseElapsed, 23);
});

test('timer normalization distinguishes a valid empty record from a corrupt record', () => {
  const h = loadNativeIdentityHarness();
  const empty = h._normalizeFocusTimerRecord(null, []);
  const corrupt = h._normalizeFocusTimerRecord({ mode: 'not-a-mode', running: true }, []);

  assert.equal(empty.valid, true);
  assert.equal(empty.timer.running, false);
  assert.equal(empty.timer.baseElapsed, 0);
  assert.equal(empty.timer.nativeSessionToken, null);
  assert.deepEqual(JSON.parse(JSON.stringify(empty.timer.handledNotificationActionIds)), []);
  assert.equal(corrupt.valid, false);
  assert.equal(corrupt.reason, 'invalid_mode');
});

test('timer normalization rejects references not present in the candidate main bundle', () => {
  const h = loadNativeIdentityHarness();
  const candidate = h._normalizeFocusTimerRecord({
    mode: 'stopwatch', phase: 'work', running: false, baseElapsed: 30,
    cyclePosition: 0, taskId: 91, sessionStartAt: 1000,
    awaitingConfirmation: false, pendingPhaseEndedAt: null
  }, [], true);

  assert.equal(candidate.valid, false);
  assert.equal(candidate.reason, 'task_reference_invalid');
});

test('legacy native timer without a session token migrates conservatively to a paused checkpoint', () => {
  const h = loadNativeIdentityHarness();
  const candidate = h._normalizeFocusTimerRecord({
    mode: 'stopwatch', phase: 'work', running: true, baseElapsed: 75,
    cyclePosition: 0, taskId: null, sessionStartAt: 1000,
    awaitingConfirmation: false, pendingPhaseEndedAt: null,
    nativeClockActive: true, nativeAnchorElapsedRealtimeMs: 20000,
    nativeAnchorBootCount: 17, nativeAnchorBaseMs: 75000,
    nativeAnchorWallMs: 80000, nativeRestorePending: true
  }, []);

  assert.equal(candidate.valid, true);
  assert.equal(candidate.migrated, true);
  assert.equal(candidate.coldStartWasRunning, true);
  assert.equal(candidate.timer.running, false);
  assert.equal(candidate.timer.baseElapsed, 75);
  assert.equal(candidate.timer.nativeClockActive, false);
  assert.equal(candidate.timer.nativeRestorePending, false);
  assert.equal(candidate.timer.nativeSessionToken, null);
  assert.equal(candidate.timer.clockAdjusted, true);
});

test('native session token generation uses Web Crypto UUID v4 and validates identity', () => {
  const h = loadNativeIdentityHarness();
  const token = h._createNativeStopwatchSessionToken();

  assert.equal(token, '11111111-1111-4111-9111-111111111111');
  assert.equal(h._isNativeStopwatchUuid(token), true);
  assert.equal(h._isNativeStopwatchUuid('11111111-1111-1111-1111-111111111111'), false);
  assert.doesNotMatch(extractFunction('_createNativeStopwatchSessionToken'), /Math\\.random/);
});

test('resync bundle validates the timer candidate before mutating task state', () => {
  const source = extractFunction('_applyValidatedResyncBundle');
  const validateAt = source.indexOf('_normalizeFocusTimerRecord(bundle.timerObj, bundle.mainData.tasks, true)');
  const mutateAt = source.indexOf('tasks = bundle.mainData.tasks;');
  assert.ok(validateAt >= 0);
  assert.ok(mutateAt > validateAt);
  assert.ok(source.includes('_applyHydratedFocusTimerRecord(timerCandidate)'));
});

function makeNotificationActionHarness(action, options = {}) {
  const focusTimer = {
    mode: 'stopwatch', phase: 'work', running: true, baseElapsed: 5,
    startedAt: 2000, cyclePosition: 0, taskId: null, sessionStartAt: 1000,
    awaitingConfirmation: false, pendingPhaseEndedAt: null, clockAdjusted: false,
    pendingStopwatchTransaction: null, nativeClockActive: true,
    nativeAnchorElapsedRealtimeMs: 1000, nativeAnchorBootCount: 17,
    nativeAnchorBaseMs: 5000, nativeAnchorWallMs: 2000,
    nativeRestorePending: false, nativeBootMismatch: false,
    nativeSessionToken: UUID_SESSION, handledNotificationActionIds: [],
    pendingNotificationFinish: null
  };
  const ackCalls = [];
  let finishCalls = 0;
  let saveCalls = 0;
  const plugin = {
    peekNotificationAction: async () => action,
    acknowledgeNotificationAction: async (args) => {
      ackCalls.push(args);
      return { acknowledged: options.acknowledged !== false, serviceStopped: !!args.stopMatchingService };
    }
  };
  const sandbox = {
    window: {},
    console,
    _focusTimer: focusTimer,
    _focusElapsedRemainderMs: 0,
    _focusMonotonicStart: 10,
    _focusMonotonicLastSample: 20,
    _focusMonotonicLastWallSample: 30,
    _focusMonotonicClockFailed: false,
    _focusWallClockAnchor: 40,
    _focusFallbackLastWall: 50,
    _focusFallbackElapsedMs: 60,
    _focusDisplayInterval: null,
    _nativeStopwatchActionSyncPromise: null,
    _pendingFinishDialogShown: false,
    storageRecoveryRequired: false,
    _nativeStopwatchPlugin: () => plugin,
    _stopDisplayTick() { sandbox._focusDisplayInterval = null; },
    _startDisplayTick() { sandbox._focusDisplayInterval = 1; },
    _clearFocusTimerClock() {
      sandbox._focusMonotonicStart = null;
      sandbox._focusMonotonicLastSample = null;
      sandbox._focusMonotonicLastWallSample = null;
      sandbox._focusMonotonicClockFailed = false;
      sandbox._focusWallClockAnchor = null;
      sandbox._focusFallbackLastWall = null;
      sandbox._focusFallbackElapsedMs = 0;
    },
    _saveFocusTimer() { saveCalls++; return options.saveOk !== false; },
    _renderFocusTimer() {},
    showToast() {},
    showAlertModal() {},
    finishTimer() { finishCalls++; return true; }
  };
  for (const name of [
    '_isNativeStopwatchUuid',
    '_captureFocusTimerClockState',
    '_restoreFocusTimerClockState',
    '_consumeNativeStopwatchNotificationAction'
  ]) vm.runInNewContext(extractFunction(name), sandbox);
  return { sandbox, focusTimer, ackCalls, get finishCalls() { return finishCalls; },
    get saveCalls() { return saveCalls; } };
}

function makeNotificationAction(overrides = {}) {
  return {
    hasAction: true,
    actionId: UUID_ACTION,
    sessionToken: UUID_SESSION,
    action: 'pause',
    elapsedRealtimeMs: 11000,
    wallTimeMs: 20000,
    bootCount: 17,
    bootCountAvailable: true,
    anchorElapsedRealtimeMs: 1000,
    anchorBaseMs: 5000,
    anchorBootCount: 17,
    elapsedMs: 15000,
    ...overrides
  };
}

test('queued notification action is consumed before any fresh native clock sample', async () => {
  const calls = [];
  const sandbox = {
    _focusTimer: { running: true, nativeClockActive: true },
    _nativeStopwatchPlugin: () => ({
      peekNotificationAction: async () => ({ hasAction: true })
    }),
    _consumeNativeStopwatchNotificationAction: async () => {
      calls.push('consume');
      return 'pause';
    },
    _refreshNativeStopwatchClock: async () => {
      calls.push('refresh');
      return true;
    },
    showToast() {},
    showAlertModal() {},
    console
  };
  vm.runInNewContext(extractFunction('_runWithFreshNativeStopwatchClock'), sandbox);
  let actionCalls = 0;
  const result = await sandbox._runWithFreshNativeStopwatchClock(() => {
    actionCalls++;
    return true;
  });

  assert.equal(result, false);
  assert.deepEqual(calls, ['consume']);
  assert.equal(actionCalls, 0);
});

test('native receiver timestamp remains authoritative after a later volatile clock sample', async () => {
  const h = makeNotificationActionHarness(makeNotificationAction());
  // The page refreshed its live elapsed value after the user tapped Pause,
  // but Android recorded the tap time against the unchanged durable anchor.
  h.focusTimer.baseElapsed = 50;
  const result = await h.sandbox._consumeNativeStopwatchNotificationAction();

  assert.equal(result, 'pause');
  assert.equal(h.focusTimer.baseElapsed, 15);
  assert.equal(h.ackCalls.length, 1);
  assert.equal(h.ackCalls[0].stopMatchingService, true);
  assert.equal(h.sandbox.storageRecoveryRequired, false);
});

test('notification Pause persists exact receiver-time elapsed value before ACK', async () => {
  const h = makeNotificationActionHarness(makeNotificationAction());
  const result = await h.sandbox._consumeNativeStopwatchNotificationAction();

  assert.equal(result, 'pause');
  assert.equal(h.focusTimer.running, false);
  assert.equal(h.focusTimer.baseElapsed, 15);
  assert.equal(h.focusTimer.nativeClockActive, false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.focusTimer.handledNotificationActionIds)), [UUID_ACTION]);
  assert.equal(h.ackCalls.length, 1);
  assert.equal(h.ackCalls[0].actionId, UUID_ACTION);
  assert.equal(h.ackCalls[0].sessionToken, UUID_SESSION);
  assert.equal(h.ackCalls[0].stopMatchingService, true);
  assert.equal(h.saveCalls, 1);
});

test('notification action is not ACKed when JavaScript durable save fails and full state is rolled back', async () => {
  const h = makeNotificationActionHarness(makeNotificationAction(), { saveOk: false });
  const before = JSON.stringify(h.focusTimer);
  const result = await h.sandbox._consumeNativeStopwatchNotificationAction();

  assert.equal(result, 'untrusted');
  assert.equal(h.ackCalls.length, 0);
  assert.equal(JSON.stringify(h.focusTimer), before);
  assert.equal(h.focusTimer.running, true);
  assert.equal(h.sandbox.storageRecoveryRequired, true);
});

test('stale notification session ACK cannot request stopping the current session service', async () => {
  const h = makeNotificationActionHarness(makeNotificationAction({
    sessionToken: UUID_OLD
  }));
  const result = await h.sandbox._consumeNativeStopwatchNotificationAction();

  assert.equal(result, 'stale');
  assert.equal(h.ackCalls.length, 1);
  assert.equal(h.ackCalls[0].sessionToken, UUID_OLD);
  assert.equal(h.ackCalls[0].stopMatchingService, true,
    'native service implementation must stop only if its active token still equals this stale token');
  assert.equal(h.focusTimer.running, true);
  assert.equal(h.focusTimer.nativeSessionToken, UUID_SESSION);
});

test('notification action with different boot identity stays queued and unacknowledged', async () => {
  const h = makeNotificationActionHarness(makeNotificationAction({
    bootCount: 18, anchorBootCount: 18
  }));
  const result = await h.sandbox._consumeNativeStopwatchNotificationAction();

  assert.equal(result, 'untrusted');
  assert.equal(h.ackCalls.length, 0);
  assert.equal(h.focusTimer.running, true);
  assert.equal(h.focusTimer.nativeBootMismatch, true);
  assert.equal(h.sandbox.storageRecoveryRequired, true);
});

test('notification Finish records a pending confirmation and never commits automatically', async () => {
  const h = makeNotificationActionHarness(makeNotificationAction({ action: 'finish' }));
  const result = await h.sandbox._consumeNativeStopwatchNotificationAction();

  assert.equal(result, 'finish');
  assert.equal(h.focusTimer.running, false);
  assert.equal(h.focusTimer.pendingNotificationFinish.actionId, UUID_ACTION);
  assert.equal(h.focusTimer.pendingNotificationFinish.sessionToken, UUID_SESSION);
  assert.equal(h.focusTimer.pendingNotificationFinish.elapsedMs, 15000);
  assert.equal(h.finishCalls, 1);
  assert.equal(h.ackCalls[0].stopMatchingService, true);
});

test('notification action anchored to a different native checkpoint is rejected without ACK', async () => {
  const h = makeNotificationActionHarness(makeNotificationAction({
    anchorElapsedRealtimeMs: 1001
  }));
  const result = await h.sandbox._consumeNativeStopwatchNotificationAction();

  assert.equal(result, 'untrusted');
  assert.equal(h.ackCalls.length, 0);
  assert.equal(h.focusTimer.running, true);
  assert.equal(h.sandbox.storageRecoveryRequired, true);
});

test('a second FIFO notification action can be applied to the already-paused session', async () => {
  const second = makeNotificationAction({
    actionId: UUID_OLD, action: 'finish',
    elapsedRealtimeMs: 16000, wallTimeMs: 25000, elapsedMs: 20000
  });
  const h = makeNotificationActionHarness(makeNotificationAction());
  const originalPeek = h.sandbox._nativeStopwatchPlugin;
  let index = 0;
  const actions = [makeNotificationAction(), second];
  const plugin = {
    peekNotificationAction: async () => actions[index++] || { hasAction: false },
    acknowledgeNotificationAction: async (args) => {
      h.ackCalls.push(args);
      return { acknowledged: true };
    }
  };
  h.sandbox._nativeStopwatchPlugin = () => plugin;
  assert.equal(await h.sandbox._consumeNativeStopwatchNotificationAction(), 'pause');
  assert.equal(await h.sandbox._consumeNativeStopwatchNotificationAction(), 'finish');
  assert.equal(h.focusTimer.baseElapsed, 20);
  assert.equal(h.focusTimer.pendingNotificationFinish.actionId, UUID_OLD);
  assert.equal(h.finishCalls, 1);
});

test('full clock snapshot restores every monotonic fallback field and display tick state', () => {
  const focusTimer = { mode: 'stopwatch', running: true, baseElapsed: 9,
    nativeSessionToken: UUID_SESSION, handledNotificationActionIds: [], pendingNotificationFinish: null };
  const sandbox = {
    _focusTimer: focusTimer, _focusElapsedRemainderMs: 345,
    _focusMonotonicStart: 1, _focusMonotonicLastSample: 2,
    _focusMonotonicLastWallSample: 3, _focusMonotonicClockFailed: true,
    _focusWallClockAnchor: 4, _focusFallbackLastWall: 5,
    _focusFallbackElapsedMs: 6, _focusDisplayInterval: 123,
    _startDisplayTick() { sandbox._focusDisplayInterval = 999; },
    _stopDisplayTick() { sandbox._focusDisplayInterval = null; }
  };
  vm.runInNewContext(
    extractFunction('_captureFocusTimerClockState') + '\n' +
    extractFunction('_restoreFocusTimerClockState'),
    sandbox
  );
  const snapshot = sandbox._captureFocusTimerClockState();
  sandbox._focusTimer.baseElapsed = 0;
  sandbox._focusElapsedRemainderMs = 0;
  sandbox._focusMonotonicStart = null;
  sandbox._focusMonotonicLastSample = null;
  sandbox._focusMonotonicLastWallSample = null;
  sandbox._focusMonotonicClockFailed = false;
  sandbox._focusWallClockAnchor = null;
  sandbox._focusFallbackLastWall = null;
  sandbox._focusFallbackElapsedMs = 0;
  sandbox._focusDisplayInterval = null;
  assert.equal(sandbox._restoreFocusTimerClockState(snapshot), true);
  assert.equal(sandbox._focusTimer.baseElapsed, 9);
  assert.equal(sandbox._focusElapsedRemainderMs, 345);
  assert.equal(sandbox._focusMonotonicStart, 1);
  assert.equal(sandbox._focusMonotonicLastSample, 2);
  assert.equal(sandbox._focusMonotonicLastWallSample, 3);
  assert.equal(sandbox._focusMonotonicClockFailed, true);
  assert.equal(sandbox._focusWallClockAnchor, 4);
  assert.equal(sandbox._focusFallbackLastWall, 5);
  assert.equal(sandbox._focusFallbackElapsedMs, 6);
  assert.equal(sandbox._focusDisplayInterval, 999);
});


test('Android foreground start must be confirmed by the service before the JS timer considers it running', () => {
  const source = html.slice(html.indexOf('function _startNativeStopwatchForegroundService('),
    html.indexOf('function _stopNativeStopwatchForegroundService('));
  assert.match(source, /plugin\.startForegroundTimer\(args\)/);
  assert.match(source, /return true/);
  assert.match(source, /catch\(error\)/);
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'configure-android-stopwatch.py'), 'utf8');
  assert.match(script, /waitForForegroundServiceStart\(call, prefs, sessionToken, 0\)/);
  assert.match(script, /SERVICE_STARTED_SESSION_TOKEN_KEY/);
  assert.match(script, /\.putString\(\{PLUGIN\}\.SERVICE_STARTED_SESSION_TOKEN_KEY, token\)/);
  assert.match(script, /stopSelf\(startId\)/);
});

