'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appScript = Array.from(html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi))
  .map((match) => match[1])
  .find((source) => source.includes('APP_VERSION'));

assert.ok(appScript, 'application script exists');

function extractFunction(name) {
  const pattern = new RegExp(
    'function\\\\s+' + name + '\\\\s*\\\\([^)]*\\\\)\\\\s*\\\\{[\\\\s\\\\S]*?\\\\n\\\\}'
  );
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

function extractTopLevelFunction(name) {
  const pattern = new RegExp('^(?:async\\\\s+)?function\\\\s+' + name + '\\\\s*\\\\(', 'm');
  const start = appScript.search(pattern);
  assert.notEqual(start, -1, 'top-level function ' + name + ' exists');
  const nextFunction = appScript.slice(start + 1).search(/^function\\s+|^async function\\s+/m);
  return nextFunction === -1
    ? appScript.slice(start)
    : appScript.slice(start, start + 1 + nextFunction);
}

function writerHarness(lockHeld) {
  const writes = [];
  const values = new Map();
  const sandbox = {
    _isTaskStorageLockHeld: () => lockHeld,
    _storageWriteAllowed: () => true,
    _secondaryStorageWriteAllowed: () => true,
    _secondaryStorageBaselines: {},
    _secondaryStorageConflicts: {},
    storageRecoveryRequired: false,
    localStorage: {
      setItem(key, value) {
        const serialized = String(value);
        writes.push({ key, value: serialized });
        values.set(key, serialized);
      },
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      }
    },
    console: { error() {}, warn() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('_writeSecondaryStorageVerified'), sandbox);
  return { sandbox, writes, values };
}

test('the shared secondary writer refuses every application key without lock ownership', () => {
  const h = writerHarness(false);
  const keys = [
    'timeTasksApp_mentalInbox',
    'timeTasksApp_focusSettings',
    'timeTasksApp_notifications',
    'timeTasksApp_thoughts_v1',
    'timeTasksApp_projects_v1',
    'timeTasksApp_focusSessions',
    'timeTasksApp_focusTimer'
  ];

  for (const key of keys) {
    assert.equal(
      h.sandbox._writeSecondaryStorageVerified(key, JSON.stringify({ value: key })),
      false,
      key + ' must fail closed without the shared lock'
    );
  }

  assert.deepEqual(h.writes, [], 'no key may be written without the shared lock');
  assert.equal(h.values.size, 0);
});

test('the shared secondary writer verifies and advances the baseline while the lock is held', () => {
  const h = writerHarness(true);
  const keys = [
    'timeTasksApp_mentalInbox',
    'timeTasksApp_focusSettings',
    'timeTasksApp_notifications',
    'timeTasksApp_thoughts_v1',
    'timeTasksApp_projects_v1',
    'timeTasksApp_focusSessions',
    'timeTasksApp_focusTimer'
  ];

  for (const key of keys) {
    const serialized = JSON.stringify({ value: key });
    assert.equal(h.sandbox._writeSecondaryStorageVerified(key, serialized), true);
    assert.equal(h.values.get(key), serialized);
    assert.equal(h.sandbox._secondaryStorageBaselines[key], serialized);
  }

  assert.equal(h.writes.length, keys.length);
  assert.deepEqual(h.writes.map((entry) => entry.key), keys);
});

test('each secondary collection save helper independently requires lock ownership', () => {
  for (const name of [
    '_saveMentalInbox',
    '_saveFocusSettings',
    '_setNotificationsPref',
    '_saveThoughts',
    '_saveProjects'
  ]) {
    assert.match(
      extractFunction(name),
      /_isTaskStorageLockHeld\\s*\\(\\s*\\)/,
      name + ' must reject calls outside the shared lock'
    );
  }
});

test('mental inbox, thought, project, and duration mutators acquire the shared lock before mutation', () => {
  for (const name of [
    'addMentalItem',
    'archiveMentalItem',
    'restoreMentalItem',
    'editMentalItem',
    'deleteMentalItem',
    'addThought',
    'editThought',
    'deleteThought',
    'saveProject',
    'setProjectStatus',
    'toggleProjectStatus',
    'applyTimerDurations',
    'applyTimerPreset',
    'resetTimerDurationsToDefault'
  ]) {
    assert.match(
      extractTopLevelFunction(name),
      /_withTaskStorageLock\\s*\\(/,
      name + ' must acquire the shared lock before writing'
    );
  }
});

test('notification preference writes use the shared lock without holding it during permission prompts', () => {
  assert.match(extractFunction('_setNotificationsPrefWithLock'), /_withTaskStorageLock\\s*\\(/);
  assert.match(extractTopLevelFunction('_setCapacitorNotificationsEnabled'), /_setNotificationsPrefWithLock/);
  assert.match(extractTopLevelFunction('toggleNotifications'), /_setNotificationsPrefWithLock/);
  assert.match(extractTopLevelFunction('_applyNotifPermissionResult'), /_setNotificationsPrefWithLock/);

  const directCalls = appScript.split('\\n').filter((line) =>
    /_setNotificationsPref\\s*\\(/.test(line)
    && !/^function _setNotificationsPref\\s*\\(/.test(line)
    && !/_setNotificationsPrefWithLock/.test(line)
  );
  assert.deepEqual(directCalls, [
    '  return _withTaskStorageLock(function() { return _setNotificationsPref(enabled); });'
  ], 'all preference writes must pass through the lock-aware wrapper');
});
