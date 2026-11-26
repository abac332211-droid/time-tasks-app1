'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appScript = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map((match) => match[1])
  .find((source) => source.includes('APP_VERSION'));

assert.ok(appScript, 'application script exists');

function extractFunction(name) {
  const pattern = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

function createHarness({ saveOk = true, nativeClock = false, lockAvailable = true } = {}) {
  let lockDepth = 0;
  const writes = [];
  const events = [];
  let elapsedSamples = 0;
  const timer = {
    mode: 'pomodoro',
    phase: 'work',
    running: true,
    baseElapsed: 127,
    startedAt: 10_000,
    cyclePosition: 0,
    taskId: 42,
    sessionStartAt: 8_000,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false,
    nativeClockActive: nativeClock,
    nativeRestorePending: false
  };

  const sandbox = {
    _focusTimer: timer,
    _focusElapsedRemainderMs: 650,
    _focusTimerCheckpointAt: 25_000,
    storageRecoveryRequired: false,
    _isCapacitor: () => native,
    _stopDisplayTick() { events.push('stop-tick'); },
    _clearFocusTimerClock() { events.push('clear-clock'); },
    _renderFocusTimer() { events.push('render'); },
    _getFocusTimerElapsedParts() {
      elapsedSamples++;
      throw new Error('hidden lifecycle must not sample elapsed time');
    },
    _saveFocusTimer() {
      assert.equal(lockDepth, 1, 'timer persistence must run under the shared lock');
      writes.push({
        running: timer.running,
        baseElapsed: timer.baseElapsed,
        remainderMs: sandbox._focusElapsedRemainderMs,
        startedAt: timer.startedAt,
        clockAdjusted: timer.clockAdjusted
      });
      return saveOk;
    },
    _withStopwatchTransactionLock(callback) {
      if (!lockAvailable) return Promise.reject(new Error('simulated lock failure'));
      lockDepth++;
      let result;
      try { result = callback(); }
      catch (error) {
        lockDepth--;
        return Promise.reject(error);
      }
      return Promise.resolve(result).finally(() => { lockDepth--; });
    },
    console: { error() {}, warn() {} },
    showAlertModal(...args) { events.push(['alert', ...args]); }
  };

  vm.createContext(sandbox);
  const source = extractFunction('_pausePwaFocusTimerAtLastCheckpoint')
    + '\n({ pause: _pausePwaFocusTimerAtLastCheckpoint })';
  const api = vm.runInContext(source, sandbox);
  return { sandbox, api, timer, writes, events, get elapsedSamples() { return elapsedSamples; } };
}

test('PWA hidden pause closes at the last durable checkpoint without sampling hidden time', async () => {
  const h = createHarness();
  const result = await h.api.pause('visibilitychange-hidden');

  assert.equal(result, true);
  assert.equal(h.timer.running, false);
  assert.equal(h.timer.baseElapsed, 127, 'do not add time after the last durable checkpoint');
  assert.equal(h.sandbox._focusElapsedRemainderMs, 650, 'retain only the persisted remainder');
  assert.equal(h.timer.startedAt, null);
  assert.equal(h.timer.clockAdjusted, true, 'mark the closed segment as discontinuous');
  assert.equal(h.sandbox._focusTimerCheckpointAt, 0);
  assert.equal(h.elapsedSamples, 0, 'no elapsed sample is allowed after hiding');
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0], {
    running: false,
    baseElapsed: 127,
    remainderMs: 650,
    startedAt: null,
    clockAdjusted: true
  });
  assert.ok(h.events.includes('stop-tick'));
  assert.ok(h.events.includes('clear-clock'));
});

test('failed checkpoint persistence leaves the page paused and enables recovery protection', async () => {
  const h = createHarness({ saveOk: false });
  const result = await h.api.pause('pagehide');

  assert.equal(result, false);
  assert.equal(h.timer.running, false, 'do not resume counting an untrusted hidden interval');
  assert.equal(h.timer.baseElapsed, 127);
  assert.equal(h.timer.startedAt, null);
  assert.equal(h.timer.clockAdjusted, true);
  assert.equal(h.sandbox.storageRecoveryRequired, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.elapsedSamples, 0);
});

test('lock acquisition failure does not write outside the lock and keeps the in-memory timer paused', async () => {
  const h = createHarness({ lockAvailable: false });
  const result = await h.api.pause('pagehide');

  assert.equal(result, false);
  assert.equal(h.writes.length, 0, 'no fallback storage write is allowed');
  assert.equal(h.timer.running, false);
  assert.equal(h.timer.baseElapsed, 127);
  assert.equal(h.timer.startedAt, null);
  assert.equal(h.timer.clockAdjusted, true);
  assert.equal(h.sandbox.storageRecoveryRequired, true);
  assert.equal(h.elapsedSamples, 0);
});

test('native Android timer is not paused by the PWA lifecycle policy', async () => {
  const h = createHarness({ nativeClock: true });
  const result = await h.api.pause('visibilitychange-hidden');

  assert.equal(result, false);
  assert.equal(h.timer.running, true);
  assert.equal(h.timer.baseElapsed, 127);
  assert.equal(h.writes.length, 0);
  assert.equal(h.events.length, 0);
});

test('visibility, pagehide and pageshow listeners use the conservative lifecycle policy', () => {
  const source = extractFunction('_setupVisibilityListener');
  assert.match(source, /visibilitychange/);
  assert.match(source, /_pausePwaFocusTimerAtLastCheckpoint\\("visibilitychange-hidden"\\)/);
  assert.match(source, /addEventListener\\(['"]pagehide['"]/);
  assert.match(source, /_pausePwaFocusTimerAtLastCheckpoint\\("pagehide"\\)/);
  assert.match(source, /addEventListener\\(['"]pageshow['"]/);
  assert.match(source, /_onFocusTimerForegroundReturn\\(\\)/);
});

test('the PWA pause helper uses the durable baseElapsed checkpoint and never computes fresh elapsed time', () => {
  const source = extractFunction('_pausePwaFocusTimerAtLastCheckpoint');
  assert.match(source, /_focusTimer\\.baseElapsed/);
  assert.match(source, /_focusElapsedRemainderMs/);
  assert.doesNotMatch(source, /_getElapsedSec|_getFocusTimerElapsedParts|Date\\.now|performance\\.now/);
});
