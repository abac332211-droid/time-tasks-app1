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
  assert.ok(extractFunction('toggleTimer').includes('_runWithFreshNativeStopwatchClock'));
  assert.ok(extractFunction('finishTimer').includes('_runWithFreshNativeStopwatchClock'));
  assert.match(html, /var clockSync = _focusTimer\.nativeRestorePending/);
  assert.match(html, /_refreshNativeStopwatchClock\(false\)/);
  assert.match(html, /if \(_focusTimer\.nativeClockActive && \(fallbackDelta < 0 \|\| fallbackDelta > 120000\)\) \{\s*\/\/ The native monotonic clock will reconcile this interval/);
});
