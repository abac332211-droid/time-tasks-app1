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
  const pattern = new RegExp('function\\\\s+' + name + '\\\\s*\\\\([^)]*\\\\)\\\\s*\\\\{[\\\\s\\\\S]*?\\\\n\\\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

function createHarness(lockHeld, initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  const storage = {
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) {
      writes.push({ operation: 'setItem', key: String(key), value: String(value) });
      values.set(String(key), String(value));
    },
    removeItem(key) {
      writes.push({ operation: 'removeItem', key: String(key) });
      values.delete(String(key));
    }
  };
  const sandbox = {
    localStorage: storage,
    _isTaskStorageLockHeld() { return lockHeld; },
    _setMainStorageBaseline(raw) {
      sandbox._mainStorageBaselineRaw = raw;
      sandbox._mainStorageBaselineReady = true;
    },
    _mainStorageBaselineRaw: null,
    _mainStorageBaselineReady: false,
    _secondaryStorageBaselines: {},
    _secondaryStorageConflicts: {},
    _invalidateProjectsCache() {},
    _sessionsCache: null,
    STORAGE_KEY: 'main',
    PROJECTS_KEY: 'projects',
    FOCUS_SESSIONS_KEY: 'sessions',
    ROLLING_BACKUP_GENERATION_KEY: 'generation',
    console: { error() {}, warn() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction('_restoreStorageValueIfUnchanged'),
    extractFunction('_readPersistedRollingBackupGeneration'),
    extractFunction('_setPersistedRollingBackupGeneration')
  ].join('\n'), sandbox);
  return { sandbox, storage, writes };
}

test('conditional storage rollback refuses to write without the shared lock', () => {
  const h = createHarness(false, { main: 'candidate' });
  assert.equal(h.sandbox._restoreStorageValueIfUnchanged('main', 'candidate', 'previous'), false);
  assert.equal(h.storage.getItem('main'), 'candidate');
  assert.deepEqual(h.writes, []);
});

test('conditional storage rollback restores and verifies the prior value under the shared lock', () => {
  const h = createHarness(true, { main: 'candidate' });
  assert.equal(h.sandbox._restoreStorageValueIfUnchanged('main', 'candidate', 'previous'), true);
  assert.equal(h.storage.getItem('main'), 'previous');
  assert.equal(h.sandbox._mainStorageBaselineRaw, 'previous');
  assert.equal(h.sandbox._mainStorageBaselineReady, true);
  assert.deepEqual(h.writes, [{ operation: 'setItem', key: 'main', value: 'previous' }]);
});

test('conditional storage rollback refuses to overwrite a value changed after the expected candidate', () => {
  const h = createHarness(true, { main: 'newer-writer' });
  assert.equal(h.sandbox._restoreStorageValueIfUnchanged('main', 'candidate', 'previous'), false);
  assert.equal(h.storage.getItem('main'), 'newer-writer');
  assert.deepEqual(h.writes, []);
});

test('rolling backup generation refuses to write without the shared lock', () => {
  const h = createHarness(false, { generation: '4' });
  assert.equal(h.sandbox._setPersistedRollingBackupGeneration(4, 5), false);
  assert.equal(h.storage.getItem('generation'), '4');
  assert.deepEqual(h.writes, []);
});

test('rolling backup generation advances only the expected value under the shared lock', () => {
  const h = createHarness(true, { generation: '4' });
  assert.equal(h.sandbox._setPersistedRollingBackupGeneration(4, 5), true);
  assert.equal(h.storage.getItem('generation'), '5');
  assert.deepEqual(h.writes, [{ operation: 'setItem', key: 'generation', value: '5' }]);
});

test('rolling backup generation refuses a stale expected generation without writing', () => {
  const h = createHarness(true, { generation: '7' });
  assert.equal(h.sandbox._setPersistedRollingBackupGeneration(4, 5), false);
  assert.equal(h.storage.getItem('generation'), '7');
  assert.deepEqual(h.writes, []);
});
