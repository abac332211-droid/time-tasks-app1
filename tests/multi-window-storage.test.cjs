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

function createStorageHarness() {
  const values = new Map([
    ['main', 'main-snapshot'],
    ['focus-timer', 'timer-snapshot'],
    ['import-pending', null],
    ['migration-pending', null],
    ['reset-pending', null],
    ['rolling-restore-pending', null]
  ]);
  const listeners = [];
  const writes = [];
  const alerts = [];
  const refreshes = [];
  const calls = { stop: 0, render: 0 };

  const sandbox = {
    STORAGE_KEY: 'main',
    IMPORT_IN_PROGRESS_KEY: 'import-pending',
    MIGRATION_IN_PROGRESS_KEY: 'migration-pending',
    RESET_IN_PROGRESS_KEY: 'reset-pending',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore-pending',
    PROJECTS_KEY: 'projects',
    THOUGHTS_KEY: 'thoughts',
    MENTAL_INBOX_KEY: 'mental-inbox',
    FOCUS_SESSIONS_KEY: 'focus-sessions',
    FOCUS_TIMER_KEY: 'focus-timer',
    FOCUS_SETTINGS_KEY: 'focus-settings',
    NOTIFICATIONS_KEY: 'notifications',
    _secondaryStorageKeys: [
      'projects', 'thoughts', 'mental-inbox', 'focus-sessions',
      'focus-timer', 'focus-settings', 'notifications'
    ],
    _mainStorageBaselineRaw: 'main-snapshot',
    _mainStorageBaselineReady: true,
    _mainStorageExternalChangeObserved: false,
    _mainStorageConflictListenerInstalled: false,
    _secondaryStorageBaselines: Object.assign(Object.create(null), {
      'focus-timer': 'timer-snapshot'
    }),
    _secondaryStorageConflicts: Object.create(null),
    storageRecoveryRequired: false,
    _focusTimerExternalConflict: false,
    _focusTimerConflictNoticeShown: false,
    _focusElapsedRemainderMs: 250,
    _focusTimer: {
      running: true,
      mode: 'stopwatch',
      phase: 'work',
      baseElapsed: 10,
      startedAt: 1_000,
      sessionStartAt: 500,
      awaitingConfirmation: false
    },
    window: {
      addEventListener(type, handler) {
        if (type === 'storage') listeners.push(handler);
      }
    },
    localStorage: {
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        writes.push({ key, value: String(value) });
        values.set(key, String(value));
      }
    },
    _getFocusTimerElapsedParts: () => ({ seconds: 12, remainderMs: 750 }),
    _stopDisplayTick: () => { calls.stop++; },
    _renderFocusTimer: () => { calls.render++; },
    _unlockAudioContext: () => {},
    showAlertModal: (...args) => alerts.push(args),
    console: { warn() {}, error() {} }
  };

  vm.runInNewContext([
    '_setupMainStorageConflictListener',
    '_storageWriteAllowed',
    '_secondaryStorageWriteAllowed',
    '_writeSecondaryStorageVerified',
    '_refreshSecondaryStorageView',
    'toggleTimer',
    'resetTimer'
  ].map(extractFunction).join('\n'), sandbox);

  return { sandbox, values, listeners, writes, alerts, refreshes, calls };
}

test('storage listener is installed once, ignores unrelated keys, and records main and clear events', () => {
  const h = createStorageHarness();
  h.sandbox._refreshSecondaryStorageView = (key) => h.refreshes.push(key);

  h.sandbox._setupMainStorageConflictListener();
  h.sandbox._setupMainStorageConflictListener();
  assert.equal(h.listeners.length, 1, 'duplicate initialization must not install duplicate listeners');

  h.listeners[0]({ key: 'unrelated-key' });
  assert.equal(h.sandbox._mainStorageExternalChangeObserved, false);
  assert.deepEqual(h.refreshes, []);

  h.listeners[0]({ key: 'projects' });
  assert.equal(h.sandbox._secondaryStorageConflicts.projects, true);
  assert.deepEqual(h.refreshes, ['projects']);

  h.listeners[0]({ key: 'main' });
  assert.equal(h.sandbox._mainStorageExternalChangeObserved, true);

  h.sandbox._mainStorageExternalChangeObserved = false;
  h.listeners[0]({ key: null }); // localStorage.clear() in another same-origin tab
  assert.equal(h.sandbox._mainStorageExternalChangeObserved, true);
});

test('a main-record storage event blocks all later writes even when the observed bytes still match', () => {
  const h = createStorageHarness();
  h.sandbox._setupMainStorageConflictListener();

  // A storage event is authoritative evidence of another context's write.
  // The raw value may have returned to the same bytes; the old page must still reload.
  h.listeners[0]({ key: 'main', newValue: 'main-snapshot' });

  assert.equal(h.sandbox._storageWriteAllowed(), false);
  assert.equal(h.sandbox._writeSecondaryStorageVerified('focus-timer', 'local-overwrite'), false);
  assert.deepEqual(h.writes, [], 'neither primary nor secondary paths may continue writing');
  assert.equal(h.values.get('focus-timer'), 'timer-snapshot');
});

test('a remote focus-timer event freezes the local timer and blocks stale timer actions and writes', () => {
  const h = createStorageHarness();
  h.sandbox._setupMainStorageConflictListener();

  h.listeners[0]({ key: 'focus-timer', newValue: 'remote-timer-snapshot' });

  assert.equal(h.sandbox._secondaryStorageConflicts['focus-timer'], true);
  assert.equal(h.sandbox._focusTimerExternalConflict, true);
  assert.equal(h.sandbox._focusTimer.running, false);
  assert.equal(h.sandbox._focusTimer.baseElapsed, 12);
  assert.equal(h.sandbox._focusTimer.startedAt, null);
  assert.equal(h.sandbox._focusElapsedRemainderMs, 750);
  assert.equal(h.calls.stop, 1);
  assert.equal(h.calls.render, 1);
  assert.equal(h.alerts.length, 1, 'the first remote timer conflict is announced');

  h.sandbox.toggleTimer();
  h.sandbox.resetTimer();
  assert.equal(h.sandbox._focusTimer.running, false);
  assert.equal(h.sandbox._focusTimer.baseElapsed, 12);
  assert.equal(h.alerts.length, 3, 'attempts to resume or reset explain that reload is required');

  assert.equal(h.sandbox._writeSecondaryStorageVerified('focus-timer', 'local-overwrite'), false);
  assert.deepEqual(h.writes, [], 'the stale tab cannot overwrite the remote timer snapshot');
});

test('secondary baseline comparison blocks a write when a storage event was not observed', () => {
  const h = createStorageHarness();
  // Simulate a changed secondary record without dispatching its storage event.
  h.values.set('focus-timer', 'remote-timer-snapshot');

  assert.equal(h.sandbox._writeSecondaryStorageVerified('focus-timer', 'local-overwrite'), false);
  assert.equal(h.sandbox._secondaryStorageConflicts['focus-timer'], true);
  assert.equal(h.values.get('focus-timer'), 'remote-timer-snapshot');
  assert.deepEqual(h.writes, []);
});
