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
  assert.notEqual(end, -1, 'Could not find end of app function: ' + name);
  return html.slice(start, end + 2);
}

function createClockHarness(options = {}) {
  const clock = {
    wall: options.wallStart ?? 1_800_000_000_000,
    mono: options.monoStart ?? 0,
    performanceAvailable: options.performanceAvailable !== false,
    performanceThrows: false,
    performanceValue: options.performanceValue,
    storageWriteAdvanceMs: 0,
    storageWriteResult: true,
    writes: []
  };

  const timer = {
    mode: 'pomodoro',
    phase: 'work',
    running: true,
    baseElapsed: options.baseElapsed ?? 0,
    startedAt: clock.wall,
    cyclePosition: 0,
    taskId: null,
    sessionStartAt: clock.wall,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false
  };

  const sandbox = {
    Date: { now: () => clock.wall },
    performance: {
      now() {
        if (!clock.performanceAvailable) return null;
        if (clock.performanceThrows) throw new Error('performance clock unavailable');
        if (typeof clock.performanceValue === 'function') return clock.performanceValue();
        return clock.mono;
      }
    },
    _focusTimer: timer,
    _focusMonotonicStart: null,
    _focusWallClockAnchor: null,
    _focusFallbackLastWall: null,
    _focusFallbackElapsedMs: 0,
    _focusElapsedRemainderMs: 0,
    _focusTimerCheckpointAt: 0,
    FOCUS_TIMER_KEY: 'focus-timer',
    FOCUS_TIMER_CHECKPOINT_INTERVAL_MS: 5000,
    storageRecoveryRequired: false,
    _storageWriteAllowed: () => true,
    _writeSecondaryStorageVerified(key, raw) {
      clock.writes.push({ key, raw, wall: clock.wall, mono: clock.mono });
      clock.wall += clock.storageWriteAdvanceMs;
      clock.mono += clock.storageWriteAdvanceMs;
      return clock.storageWriteResult;
    },
    _storeRollingRecoveryBackup: () => true,
    console: { warn() {}, error() {} }
  };

  const functionNames = [
    '_readFocusMonotonicNow',
    '_anchorFocusTimerClock',
    '_clearFocusTimerClock',
    '_getFocusTimerElapsedParts',
    '_getElapsedSec',
    '_saveFocusTimer',
    '_handleFocusTimerClockDiscontinuity'
  ];
  vm.runInNewContext(
    functionNames.map((name) => {
      const marker = 'function ' + name + '(';
      return html.includes(marker) ? extractFunction(name) : '';
    }).filter(Boolean).join('\n'),
    sandbox
  );

  sandbox._anchorFocusTimerClock(clock.wall);
  return { clock, timer, sandbox };
}

test('monotonic elapsed time is unaffected by wall-clock jumps in either direction', () => {
  const h = createClockHarness();
  h.clock.mono = 5_000;
  h.clock.wall -= 30 * 60 * 1000;
  assert.equal(h.sandbox._getElapsedSec(), 5);
  assert.equal(h.timer.clockAdjusted, true);

  h.clock.mono = 10_000;
  h.clock.wall += 60 * 60 * 1000;
  assert.equal(h.sandbox._getElapsedSec(), 10);
});

test('wall-clock drift is flagged without replacing the monotonic elapsed measurement', () => {
  const h = createClockHarness();
  h.clock.mono = 42_000;
  h.clock.wall += 10 * 60 * 1000;

  assert.equal(h.sandbox._getElapsedSec(), 42);
  assert.equal(h.timer.clockAdjusted, true);
});

test('fallback clock accumulates ordinary positive deltas when performance.now is unavailable', () => {
  const h = createClockHarness({ performanceAvailable: false });
  h.clock.wall += 1_500;
  assert.equal(h.sandbox._getElapsedSec(), 1);
  h.clock.wall += 700;
  assert.equal(h.sandbox._getElapsedSec(), 2);
});

test('fallback clock handles a backward wall-clock jump without negative time or catch-up freeze', () => {
  const h = createClockHarness({ performanceAvailable: false });
  h.clock.wall += 2_500;
  assert.equal(h.sandbox._getElapsedSec(), 2);

  h.clock.wall -= 30 * 60 * 1000;
  assert.equal(h.sandbox._getElapsedSec(), 2);
  assert.equal(h.timer.clockAdjusted, true);

  h.clock.wall += 1_000;
  assert.equal(h.sandbox._getElapsedSec(), 3);
});

test('fallback clock treats a large unexplained forward jump as a discontinuity, not elapsed time', () => {
  const h = createClockHarness({ performanceAvailable: false });
  h.clock.wall += 30 * 60 * 1000;

  assert.equal(h.sandbox._getElapsedSec(), 0);
  assert.equal(h.timer.clockAdjusted, true);

  h.clock.wall += 1_000;
  assert.equal(h.sandbox._getElapsedSec(), 1);
});

test('B6: losing performance.now mid-session switches to fallback without losing or duplicating elapsed time', () => {
  const h = createClockHarness();
  h.clock.mono = 3_000;
  h.clock.wall += 3_000;
  assert.equal(h.sandbox._getElapsedSec(), 3);

  h.clock.performanceAvailable = false;
  h.clock.wall += 2_000;
  assert.equal(h.sandbox._getElapsedSec(), 5);

  h.clock.wall += 1_000;
  assert.equal(h.sandbox._getElapsedSec(), 6);
});

test('B6 fallback preserves the last monotonic sample across a wall-clock correction', () => {
  const backward = createClockHarness();
  backward.clock.mono = 3_000;
  backward.clock.wall += 3_000;
  assert.equal(backward.sandbox._getElapsedSec(), 3);
  backward.clock.performanceAvailable = false;
  backward.clock.wall -= 30 * 60 * 1000;
  assert.equal(backward.sandbox._getElapsedSec(), 3);
  backward.clock.wall += 1_000;
  assert.equal(backward.sandbox._getElapsedSec(), 4);

  const forward = createClockHarness();
  forward.clock.mono = 3_000;
  forward.clock.wall += 3_000;
  assert.equal(forward.sandbox._getElapsedSec(), 3);
  forward.clock.performanceAvailable = false;
  forward.clock.wall += 30 * 60 * 1000;
  assert.equal(forward.sandbox._getElapsedSec(), 3);
  forward.clock.wall += 1_000;
  assert.equal(forward.sandbox._getElapsedSec(), 4);
});

test('throwing or non-finite performance.now safely uses the fallback clock', () => {
  const throwing = createClockHarness();
  throwing.clock.performanceThrows = true;
  throwing.clock.wall += 2_000;
  assert.equal(throwing.sandbox._getElapsedSec(), 2);

  const invalid = createClockHarness();
  invalid.clock.performanceValue = () => Number.NaN;
  invalid.clock.wall += 2_000;
  assert.equal(invalid.sandbox._getElapsedSec(), 2);
});

test('a regressing monotonic clock is flagged and does not make elapsed time negative', () => {
  const h = createClockHarness();
  h.clock.mono = 4_000;
  h.clock.wall += 4_000;
  assert.equal(h.sandbox._getElapsedSec(), 4);

  h.clock.mono = 3_000;
  h.clock.wall += 1_000;
  assert.equal(h.sandbox._getElapsedSec(), 5);
  assert.equal(h.timer.clockAdjusted, true);
});

test('checkpoint preserves the fractional second across the re-anchor', () => {
  const h = createClockHarness();
  h.clock.mono = 4_900;
  h.clock.wall += 4_900;

  assert.equal(h.sandbox._getElapsedSec(), 4);
  assert.equal(h.sandbox._saveFocusTimer(), true);
  assert.equal(h.sandbox._focusTimer.baseElapsed, 4);

  h.clock.mono += 100;
  h.clock.wall += 100;
  assert.equal(
    h.sandbox._getElapsedSec(),
    5,
    'the 900 ms remainder from before the checkpoint must carry into the next second'
  );
});

test('repeated checkpoints do not discard fractional time', () => {
  const h = createClockHarness();
  h.clock.mono = 4_900;
  h.clock.wall += 4_900;
  assert.equal(h.sandbox._saveFocusTimer(), true);

  h.clock.mono += 5_000;
  h.clock.wall += 5_000;
  assert.equal(h.sandbox._getElapsedSec(), 9);
  assert.equal(h.sandbox._saveFocusTimer(), true);

  h.clock.mono += 100;
  h.clock.wall += 100;
  assert.equal(h.sandbox._getElapsedSec(), 10);
});

test('checkpoint anchor uses the elapsed-time sample, so storage-write latency is not lost', () => {
  const h = createClockHarness();
  h.clock.mono = 4_900;
  h.clock.wall += 4_900;
  h.clock.storageWriteAdvanceMs = 200;

  assert.equal(h.sandbox._saveFocusTimer(), true);
  assert.equal(h.clock.mono, 5_100);

  assert.equal(
    h.sandbox._getElapsedSec(),
    5,
    'time spent completing the verified checkpoint must remain measurable after re-anchoring'
  );
});

test('failed checkpoint does not reset the clock anchor or consume elapsed time', () => {
  const h = createClockHarness();
  h.clock.mono = 4_900;
  h.clock.wall += 4_900;
  h.clock.storageWriteResult = false;

  assert.equal(h.sandbox._saveFocusTimer(), false);
  assert.equal(h.sandbox._focusMonotonicStart, 0);

  h.clock.storageWriteResult = true;
  h.clock.mono = 5_100;
  h.clock.wall += 200;
  assert.equal(h.sandbox._getElapsedSec(), 5);
});

test('checkpoint stores a bounded millisecond remainder for cold-start restoration', () => {
  const h = createClockHarness();
  h.clock.mono = 7_650;
  h.clock.wall += 7_650;

  assert.equal(h.sandbox._saveFocusTimer(), true);
  const persisted = JSON.parse(h.clock.writes.at(-1).raw);
  assert.equal(persisted.baseElapsed, 7);
  assert.equal(persisted.elapsedRemainderMs, 650);
  assert.ok(persisted.elapsedRemainderMs >= 0 && persisted.elapsedRemainderMs < 1000);
});


test('cold start restores the durable millisecond remainder and resumes without losing it', () => {
  const h = createClockHarness();
  const stored = {
    mode: 'pomodoro',
    phase: 'work',
    running: true,
    baseElapsed: 7,
    elapsedRemainderMs: 650,
    startedAt: h.clock.wall - 7_650,
    cyclePosition: 0,
    taskId: null,
    sessionStartAt: h.clock.wall - 7_650,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false,
    savedAt: h.clock.wall
  };

  h.sandbox.localStorage = { getItem: () => JSON.stringify(stored) };
  h.sandbox._trackSecondaryStorageRead = (_key, raw) => raw;
  h.sandbox._focusTimerColdStartWasRunning = false;
  h.sandbox._focusTimerSavedAtAtLoad = null;
  h.sandbox.tasks = [];
  h.sandbox._phaseTargetSec = () => 1_500;
  vm.runInNewContext(extractFunction('_loadFocusTimer'), h.sandbox);
  h.sandbox._loadFocusTimer();

  assert.equal(h.timer.running, false, 'cold start must remain paused');
  assert.equal(h.timer.baseElapsed, 7);
  assert.equal(h.sandbox._focusElapsedRemainderMs, 650);

  h.timer.startedAt = h.clock.wall;
  h.timer.running = true;
  h.sandbox._anchorFocusTimerClock(h.clock.wall);
  h.clock.mono += 350;
  h.clock.wall += 350;
  assert.equal(h.sandbox._getElapsedSec(), 8);
});


test('background Pomodoro confirmation endpoint subtracts the saved millisecond remainder', () => {
  const state = {
    mode: 'pomodoro',
    phase: 'work',
    baseElapsed: 1_499,
    startedAt: 1_000,
    sessionStartAt: 0,
    running: true,
    cyclePosition: 0,
    taskId: null,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false
  };
  let shown = 0;
  const sandbox = {
    _focusTimer: state,
    _focusElapsedRemainderMs: 500,
    Date: { now: () => 8_000 },
    _getFocusTimerElapsedParts: () => ({ seconds: 1_500, remainderMs: 600 }),
    _phaseTargetSec: () => 1_500,
    _stopDisplayTick: () => {},
    _saveFocusTimer: () => true,
    _renderFocusTimer: () => {},
    _showAwaySessionConfirmation: () => { shown++; },
    showAlertModal: () => { throw new Error('save succeeds; no alert expected'); }
  };
  vm.runInNewContext(extractFunction('_catchUp'), sandbox);
  sandbox._catchUp(true);

  assert.equal(state.awaitingConfirmation, true);
  assert.equal(state.pendingPhaseEndedAt, 1_500);
  assert.equal(sandbox._focusElapsedRemainderMs, 0);
  assert.equal(shown, 1);
});

test('normal Pomodoro completion timestamp uses the millisecond remainder at its boundary', () => {
  const state = {
    mode: 'pomodoro',
    phase: 'work',
    baseElapsed: 1_499,
    startedAt: 1_000,
    sessionStartAt: 0,
    running: true,
    cyclePosition: 0,
    taskId: null,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false
  };
  let elapsedReads = 0;
  let loggedEnd = null;
  const sandbox = {
    _focusTimer: state,
    _focusElapsedRemainderMs: 500,
    Date: { now: () => 1_500 },
    _getFocusTimerElapsedParts: () => {
      elapsedReads++;
      return elapsedReads <= 2
        ? { seconds: 1_500, remainderMs: 600 }
        : { seconds: 0, remainderMs: 600 };
    },
    _phaseTargetSec: () => state.phase === 'work' ? 1_500 : 300,
    _logSession: (_phase, _duration, _completed, endedAt) => { loggedEnd = endedAt; return true; },
    _anchorFocusTimerClock: () => {},
    _saveFocusTimer: () => true,
    _stopDisplayTick: () => {},
    _renderFocusTimer: () => {},
    renderFocusSessionsCard: () => {},
    _notifyPhaseTransition: () => {}
  };
  vm.runInNewContext(extractFunction('_catchUp'), sandbox);
  sandbox._catchUp(false);

  assert.equal(loggedEnd, 1_500);
  assert.equal(state.phase, 'short-break');
  assert.equal(state.baseElapsed, 0);
  assert.equal(sandbox._focusElapsedRemainderMs, 600);
});

test('pause captures sub-second elapsed time and failed pause restores the prior remainder', () => {
  const state = {
    running: true,
    awaitingConfirmation: false,
    baseElapsed: 12,
    startedAt: 1_000,
    sessionStartAt: 500
  };
  const sandbox = {
    _focusTimerExternalConflict: false,
    _focusElapsedRemainderMs: 200,
    _focusTimer: state,
    _unlockAudioContext: () => {},
    _getFocusTimerElapsedParts: () => ({ seconds: 13, remainderMs: 700 }),
    _stopDisplayTick: () => {},
    _startDisplayTick: () => {},
    _saveFocusTimer: () => false,
    _renderFocusTimer: () => {},
    showAlertModal: () => {}
  };
  vm.runInNewContext(extractFunction('toggleTimer'), sandbox);
  sandbox.toggleTimer();

  assert.equal(state.running, true);
  assert.equal(state.baseElapsed, 12);
  assert.equal(state.startedAt, 1_000);
  assert.equal(sandbox._focusElapsedRemainderMs, 200);
});


test('an available but stalled monotonic clock pauses Pomodoro without logging or auto-transitioning after a long sleep', () => {
  const h = createClockHarness({ baseElapsed: 40 });
  h.clock.mono = 1_750;
  h.clock.wall += 1_750;
  assert.equal(h.sandbox._getElapsedSec(), 41);

  // Simulate a long Android sleep: Date.now advances, performance.now remains present and unchanged.
  h.clock.wall += 30 * 60 * 1000;
  let logged = 0;
  let confirmations = 0;
  let saved = 0;
  const alerts = [];
  h.sandbox._phaseTargetSec = () => 45;
  h.sandbox._stopDisplayTick = () => {};
  h.sandbox._saveFocusTimer = () => { saved++; return true; };
  h.sandbox._renderFocusTimer = () => {};
  h.sandbox._logSession = () => { logged++; return true; };
  h.sandbox._showAwaySessionConfirmation = () => { confirmations++; };
  h.sandbox.showAlertModal = (title, message) => alerts.push({ title, message });

  vm.runInNewContext(extractFunction('_handleFocusTimerClockDiscontinuity') + '\n' + extractFunction('_catchUp'), h.sandbox);
  h.sandbox._catchUp(true);

  assert.equal(h.timer.running, false, 'the timer must pause when the monotonic source is frozen');
  assert.equal(h.timer.clockAdjusted, true, 'the disagreement must be recorded');
  assert.equal(h.timer.baseElapsed, 41, 'only the last trusted monotonic sample is retained');
  assert.equal(h.sandbox._focusElapsedRemainderMs, 750, 'the trusted sub-second remainder is retained');
  assert.equal(h.timer.awaitingConfirmation, false, 'untrusted wall time must not complete a Pomodoro phase');
  assert.equal(h.timer.phase, 'work', 'untrusted wall time must not advance the phase');
  assert.equal(logged, 0, 'no session may be registered from the untrusted gap');
  assert.equal(confirmations, 0, 'no away-session completion prompt may be inferred from the wall-clock jump');
  assert.equal(saved, 1, 'the paused state must be checkpointed');
  assert.equal(alerts.length, 1, 'the user must receive an explicit explanation');
  assert.match(alerts[0].message, /آخر قراءة موثوقة/);
  assert.match(alerts[0].message, /ابدأ/);
});

test('a stalled available monotonic clock also pauses Stopwatch and excludes the wall-clock gap', () => {
  const h = createClockHarness();
  h.timer.mode = 'stopwatch';
  h.clock.mono = 2_250;
  h.clock.wall += 2_250;
  assert.equal(h.sandbox._getElapsedSec(), 2);

  h.clock.wall += 20 * 60 * 1000;
  const elapsed = h.sandbox._getFocusTimerElapsedParts();

  assert.equal(h.timer.running, false);
  assert.equal(h.timer.clockAdjusted, true);
  assert.equal(elapsed.seconds, 2);
  assert.equal(elapsed.remainderMs, 250);
});

test('a checkpoint persists paused state when it is the first caller to detect a stalled monotonic clock', () => {
  const h = createClockHarness();
  h.clock.mono = 2_250;
  h.clock.wall += 2_250;
  assert.equal(h.sandbox._getElapsedSec(), 2);

  h.clock.wall += 20 * 60 * 1000;
  assert.equal(h.sandbox._saveFocusTimer(), true);

  const persisted = JSON.parse(h.clock.writes.at(-1).raw);
  assert.equal(persisted.running, false, 'the outer checkpoint must not overwrite the conservative pause');
  assert.equal(persisted.baseElapsed, 2);
  assert.equal(persisted.elapsedRemainderMs, 250);
  assert.equal(persisted.clockAdjusted, true);
});
