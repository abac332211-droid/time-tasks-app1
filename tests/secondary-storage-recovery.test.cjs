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
function makeStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  const removed = [];
  return {
    values, removed,
    get length() { return values.size; },
    key(i) { return Array.from(values.keys())[i] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { removed.push(String(key)); values.delete(String(key)); }
  };
}
function storageHarness(seed = {}) {
  const localStorage = makeStorage(seed);
  const sandbox = {
    STORAGE_KEY: 'main',
    FOCUS_SESSIONS_KEY: 'sessions',
    MENTAL_INBOX_KEY: 'inbox',
    THOUGHTS_KEY: 'thoughts',
    PROJECTS_KEY: 'projects',
    FOCUS_TIMER_KEY: 'timer',
    FOCUS_SETTINGS_KEY: 'focus-settings',
    NOTIFICATIONS_KEY: 'notifications',
    _secondaryStorageBaselines: Object.create(null),
    _secondaryStorageConflicts: Object.create(null),
    _sessionsCache: null,
    _projectsCache: [],
    storageRecoveryRequired: true,
    _validatePendingStopwatchTransaction: () => true,
    _validateFocusSessionRecord: row => !!row && Number.isInteger(row.id) && Number.isFinite(row.durationSec),
    validateV2: data => !!data && data.schemaVersion === 2 && Array.isArray(data.tasks),
    _invalidateProjectsCache() { this._projectsCache = null; },
    localStorage
  };
  vm.runInNewContext([
    extractFunction('_hasExactCorruptStorageSnapshot'),
    extractFunction('_findForensicallyPreservedSecondaryRoots'),
    extractFunction('_quarantineForensicallyPreservedSecondaryRoot'),
    extractFunction('_secondaryStorageRecoveryReady')
  ].join('\n'), sandbox);
  return { sandbox, localStorage };
}

test('secondary recovery only offers a root when exact original bytes already exist in a forensic snapshot', () => {
  const rawMain = JSON.stringify({ schemaVersion: 2, tasks: [] });
  const broken = '{broken-json';
  const h = storageHarness({
    main: rawMain, inbox: broken, 'inbox_corrupt_1700000000000': broken,
    timer: JSON.stringify({ running: false, pendingStopwatchTransaction: null })
  });
  const scan = h.sandbox._findForensicallyPreservedSecondaryRoots();
  assert.equal(scan.unsupported.length, 0);
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].key, 'inbox');
  assert.equal(h.localStorage.getItem('inbox'), broken, 'scan is read-only');
});

test('secondary recovery refuses to replace a corrupt root without an exact forensic copy', () => {
  const broken = '{broken-json';
  const h = storageHarness({
    main: JSON.stringify({ schemaVersion: 2, tasks: [] }),
    inbox: broken,
    timer: JSON.stringify({ running: false, pendingStopwatchTransaction: null })
  });
  const scan = h.sandbox._findForensicallyPreservedSecondaryRoots();
  assert.equal(scan.candidates.length, 0);
  assert.ok(scan.unsupported.some(x => /لا توجد لقطة جنائية/.test(x)));
  assert.equal(h.localStorage.getItem('inbox'), broken);
});

test('quarantining a secondary root keeps exact forensic bytes and leaves the main record untouched', () => {
  const main = JSON.stringify({ schemaVersion: 2, tasks: [] });
  const broken = '{broken-json';
  const archive = 'inbox_corrupt_1700000000000';
  const h = storageHarness({
    main, inbox: broken, [archive]: broken,
    timer: JSON.stringify({ running: false, pendingStopwatchTransaction: null })
  });
  const scan = h.sandbox._findForensicallyPreservedSecondaryRoots();
  assert.equal(scan.candidates.length, 1);
  assert.equal(h.sandbox._quarantineForensicallyPreservedSecondaryRoot(scan.candidates[0]), true);
  assert.equal(h.localStorage.getItem('inbox'), '[]');
  assert.equal(h.localStorage.getItem(archive), broken);
  assert.equal(h.localStorage.getItem('main'), main);
  assert.deepEqual(h.localStorage.removed, []);
  assert.equal(h.sandbox._secondaryStorageBaselines.inbox, '[]');
});

test('secondary quarantine refuses stale bytes and never deletes forensic evidence', () => {
  const broken = '{broken-json';
  const h = storageHarness({
    main: JSON.stringify({ schemaVersion: 2, tasks: [] }),
    inbox: broken, 'inbox_corrupt_1700000000000': broken,
    timer: JSON.stringify({ running: false, pendingStopwatchTransaction: null })
  });
  const candidate = h.sandbox._findForensicallyPreservedSecondaryRoots().candidates[0];
  h.localStorage.setItem('inbox', '{"newer":"external"}');
  assert.equal(h.sandbox._quarantineForensicallyPreservedSecondaryRoot(candidate), false);
  assert.equal(h.localStorage.getItem('inbox'), '{"newer":"external"}');
  assert.equal(h.localStorage.getItem('inbox_corrupt_1700000000000'), broken);
  assert.deepEqual(h.localStorage.removed, []);
});

test('secondary recovery readiness refuses to clear the guard while timer state is malformed or pending', () => {
  const h = storageHarness({
    main: JSON.stringify({ schemaVersion: 2, tasks: [] }),
    timer: JSON.stringify({ running: false, pendingStopwatchTransaction: { version: 1 } })
  });
  assert.equal(h.sandbox._secondaryStorageRecoveryReady(), false);
  h.localStorage.setItem('timer', JSON.stringify({ running: false, pendingStopwatchTransaction: null }));
  assert.equal(h.sandbox._secondaryStorageRecoveryReady(), true);
});


test('retryStorageRecovery waits for explicit confirmation before quarantining a corrupt secondary root', () => {
  const main = JSON.stringify({ schemaVersion: 2, tasks: [] });
  const broken = '{broken-json';
  const archiveKey = 'inbox_corrupt_1700000000000';
  const h = storageHarness({ main, inbox: broken, [archiveKey]: broken,
    timer: JSON.stringify({ running: false, pendingStopwatchTransaction: null }) });
  let confirmation = null;
  let reloads = 0;
  Object.assign(h.sandbox, {
    RESET_IN_PROGRESS_KEY: 'reset-marker',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore-marker',
    _getLatestRollingRecoveryBackup: () => null,
    _resetSecondaryStorageTracking() {
      h.sandbox._secondaryStorageBaselines = Object.create(null);
      h.sandbox._secondaryStorageConflicts = Object.create(null);
    },
    _reloadAfterVerifiedOperation() { reloads++; },
    showConfirmModal(_title, _body, accept) { confirmation = accept; },
    showAlertModal() {},
    showToast() {},
    setTimeout(callback) { callback(); }
  });
  h.localStorage.values.delete('reset-marker');
  h.localStorage.values.delete('rolling-restore-marker');
  vm.runInNewContext(
    extractFunction('_hasExactCorruptStorageSnapshot') + '\n' +
    extractFunction('_findForensicallyPreservedSecondaryRoots') + '\n' +
    extractFunction('_quarantineForensicallyPreservedSecondaryRoot') + '\n' +
    extractFunction('_secondaryStorageRecoveryReady') + '\n' +
    extractFunction('retryStorageRecovery'),
    h.sandbox
  );
  h.sandbox.retryStorageRecovery();
  assert.equal(h.localStorage.getItem('inbox'), broken, 'no key changes before explicit consent');
  assert.equal(typeof confirmation, 'function');
  confirmation();
  assert.equal(h.localStorage.getItem('inbox'), '[]');
  assert.equal(h.localStorage.getItem(archiveKey), broken);
  assert.equal(h.localStorage.getItem('main'), main);
  assert.equal(h.sandbox.storageRecoveryRequired, false);
  assert.equal(reloads, 1);
});

test('each supported secondary collection root requires its own exact forensic archive', () => {
  const defs = [
    ['sessions', 'sessions_corrupt_1700000000000'],
    ['inbox', 'inbox_corrupt_1700000000000'],
    ['thoughts', 'thoughts_corrupt_1700000000000'],
    ['projects', 'projects_corrupt_1700000000000']
  ];
  for (const [key, archiveKey] of defs) {
    const broken = '{invalid-root-' + key;
    const h = storageHarness({
      main: JSON.stringify({ schemaVersion: 2, tasks: [] }),
      [key]: broken, [archiveKey]: broken,
      timer: JSON.stringify({ running: false, pendingStopwatchTransaction: null })
    });
    const scan = h.sandbox._findForensicallyPreservedSecondaryRoots();
    assert.equal(scan.unsupported.length, 0, key);
    assert.equal(scan.candidates.length, 1, key);
    assert.equal(scan.candidates[0].key, key);
  }
});

test('preserving a newer corrupt snapshot never deletes older forensic copies', () => {
  const values = new Map([
    ['sessions', '{new-corrupt-bytes'],
    ['sessions_corrupt_1', 'old-1'],
    ['sessions_corrupt_2', 'old-2'],
    ['sessions_corrupt_3', 'old-3']
  ]);
  const removed = [];
  const localStorage = {
    get length() { return values.size; },
    key(i) { return Array.from(values.keys())[i] ?? null; },
    getItem(k) { return values.has(k) ? values.get(k) : null; },
    setItem(k,v) { values.set(String(k), String(v)); },
    removeItem(k) { removed.push(k); values.delete(k); }
  };
  const sandbox = { localStorage, Date, console };
  vm.runInNewContext(extractFunction('_preserveCorruptStorageSnapshot'), sandbox);
  assert.equal(sandbox._preserveCorruptStorageSnapshot('sessions', '{new-corrupt-bytes'), true);
  assert.equal(values.get('sessions_corrupt_1'), 'old-1');
  assert.equal(values.get('sessions_corrupt_2'), 'old-2');
  assert.equal(values.get('sessions_corrupt_3'), 'old-3');
  assert.ok(Array.from(values.keys()).some(k => k.startsWith('sessions_corrupt_') && values.get(k) === '{new-corrupt-bytes'));
  assert.deepEqual(removed, []);
});
