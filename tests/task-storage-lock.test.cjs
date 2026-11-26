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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(options = {}) {
  const alerts = [];
  const toasts = [];
  const requests = [];
  const gate = options.gate || null;
  const lockRequest = options.lockRequest || ((name, lockOptions, callback) => {
    requests.push({ name, lockOptions });
    return Promise.resolve().then(() => callback({ name, mode: lockOptions.mode }));
  });
  const sandbox = {
    Promise,
    console: { error() {}, warn() {} },
    showToast: (...args) => toasts.push(args),
    showAlertModal: (...args) => alerts.push(args),
    storageRecoveryRequired: false,
    _startupStopwatchRecoveryInFlight: false,
    _startupStopwatchRecoveryFailed: false,
    _startupResetRecoveryInFlight: false,
    _resetRecoveryInFlight: false,
    _resetInFlight: false,
    _mainStorageExternalChangeObserved: false,
    _stopwatchTransactionLockDepth: 0,
    _taskStorageWriteInFlight: false,
    _isFocusCommitBlocked: () => false,
    navigator: {
      locks: {
        request(name, lockOptions, callback) {
          requests.push({ name, lockOptions });
          if (options.unavailable) return Promise.reject(new Error('Web Locks unavailable'));
          if (options.lockRequest) return options.lockRequest(name, lockOptions, callback);
          return (gate ? gate.promise : Promise.resolve()).then(() => callback({ name, mode: lockOptions.mode }));
        }
      }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction('_isTaskStorageLockHeld'),
    extractFunction('_withStopwatchTransactionLock'),
    extractFunction('_withTaskStorageLock'),
    extractFunction('_isTaskWriteBlocked')
  ].join('\n'), sandbox);

  return { sandbox, alerts, toasts, requests };
}

test('task mutation waits for the existing exclusive Stopwatch Web Lock before running', async () => {
  const gate = deferred();
  const h = createHarness({ gate });
  let mutations = 0;

  const pending = h.sandbox._withTaskStorageLock(() => {
    mutations++;
    assert.equal(h.sandbox._stopwatchTransactionLockDepth, 1);
    assert.equal(h.sandbox._isTaskStorageLockHeld(), true);
    return true;
  });

  assert.equal(mutations, 0, 'mutation must not run while lock acquisition is pending');
  assert.equal(h.sandbox._isTaskWriteBlocked(), true, 'other task writers remain blocked while waiting');
  assert.equal(h.sandbox._taskStorageWriteInFlight, true);

  gate.resolve();
  assert.equal(await pending, true);
  assert.equal(mutations, 1);
  assert.equal(h.sandbox._stopwatchTransactionLockDepth, 0, 'page-local lock ownership is released');
  assert.equal(h.sandbox._taskStorageWriteInFlight, false, 'same-tab writer guard is released');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].name, 'timeTasksApp-stopwatch-transaction');
  assert.equal(h.requests[0].lockOptions.mode, 'exclusive');
});

test('a second same-tab task write fails closed while the first is waiting for the shared lock', async () => {
  const gate = deferred();
  const h = createHarness({ gate });
  let firstMutations = 0;
  let secondMutations = 0;

  const first = h.sandbox._withTaskStorageLock(() => { firstMutations++; return true; });
  const second = await h.sandbox._withTaskStorageLock(() => { secondMutations++; return true; });

  assert.equal(second, false);
  assert.equal(firstMutations, 0);
  assert.equal(secondMutations, 0);
  assert.equal(h.toasts.length, 1);

  gate.resolve();
  assert.equal(await first, true);
  assert.equal(firstMutations, 1);
  assert.equal(secondMutations, 0);
  assert.equal(h.sandbox._taskStorageWriteInFlight, false);
});

test('nested task writer reuses existing lock ownership without requesting a second Web Lock', async () => {
  const h = createHarness();
  let innerRuns = 0;

  const result = await h.sandbox._withTaskStorageLock(() => {
    assert.equal(h.sandbox._stopwatchTransactionLockDepth, 1);
    return h.sandbox._withTaskStorageLock(() => {
      innerRuns++;
      assert.equal(h.sandbox._stopwatchTransactionLockDepth, 1);
      return true;
    });
  });

  assert.equal(result, true);
  assert.equal(innerRuns, 1);
  assert.equal(h.requests.length, 1, 'nested writes must not deadlock by reacquiring the non-reentrant Web Lock');
  assert.equal(h.sandbox._stopwatchTransactionLockDepth, 0);
});

test('task mutation is not run when Web Locks is unavailable', async () => {
  const h = createHarness({ unavailable: true });
  let mutations = 0;

  const result = await h.sandbox._withTaskStorageLock(() => { mutations++; return true; });

  assert.equal(result, false);
  assert.equal(mutations, 0);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0][0], /تعذر تأمين حفظ المهام/);
  assert.equal(h.sandbox._stopwatchTransactionLockDepth, 0);
  assert.equal(h.sandbox._taskStorageWriteInFlight, false);
});

test('task mutation failure releases both lock ownership and same-tab writer guard', async () => {
  const h = createHarness();
  const result = await h.sandbox._withTaskStorageLock(() => {
    throw new Error('simulated task writer failure');
  });

  assert.equal(result, false);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.sandbox._stopwatchTransactionLockDepth, 0);
  assert.equal(h.sandbox._taskStorageWriteInFlight, false);
});

test('saveData refuses a direct write unless the shared transaction lock is already held', () => {
  const alerts = [];
  const errors = [];
  const sandbox = {
    _isTaskStorageLockHeld: () => false,
    showAlertModal: (...args) => alerts.push(args),
    console: { error: (...args) => errors.push(args) }
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('saveData'), sandbox);

  assert.equal(sandbox.saveData(), false);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][0], /حفظ غير محمي/);
  assert.equal(errors.length, 1);
});
