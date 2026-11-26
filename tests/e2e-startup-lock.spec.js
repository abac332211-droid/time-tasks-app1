'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (_error) {
  // Playwright/Chromium are installed by the dedicated verify-pwa workflow.
}

const root = path.resolve(__dirname, '..');
const LOCK_NAME = 'timeTasksApp-stopwatch-transaction';
const MAIN_KEY = 'timeTasksApp_v1';
const TIMER_KEY = 'timeTasksApp_focusTimer';
const SESSIONS_KEY = 'timeTasksApp_focusSessions';

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  })[ext] || 'application/octet-stream';
}

function createStaticServer() {
  return http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch (_error) {
      response.writeHead(400).end('Bad request');
      return;
    }

    if (pathname === '/hold-lock.html') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end('<!doctype html><meta charset="utf-8"><title>Lock holder</title><p>Lock holder page</p>');
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    const resolved = path.resolve(root, '.' + pathname);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.stat(resolved, (statError, stat) => {
      if (statError || !stat.isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentType(resolved),
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(resolved).pipe(response);
    });
  });
}

function makeSeed(options = {}) {
  const now = Date.now();
  const task = {
    id: 7011,
    name: 'Startup recovery task',
    type: 'معرفية',
    status: 'pending',
    expected: 20,
    actual: 5,
    plannedDate: new Date(now).toISOString().slice(0, 10),
    plannedTime: '',
    completedAt: null,
    createdAt: now,
    projectId: null,
    priority: null,
    recurrence: null,
    checklist: null
  };
  const tx = {
    version: 1,
    id: 'startup-recovery-tx-0001',
    taskId: 7011,
    previousActual: 5,
    targetActual: 8,
    previousTransactionId: null,
    minutesToAdd: 3,
    durationSec: 125,
    sessionStartAt: now - 600_000,
    mode: 'stopwatch',
    phase: 'work',
    clockAdjusted: false,
    elapsedRemainderMs: 0,
    completed: true,
    createdAt: now
  };
  if (options.invalidTransaction === true) delete tx.taskId;

  const main = {
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: {
      operationalDayStart: 4,
      firstUseDate: new Date(now).toISOString().slice(0, 10),
      darkMode: false,
      themeMode: 'system',
      lastRecurringDates: {},
      lastTaskId: 7011
    },
    tasks: [task],
    dailyLogs: []
  };
  const timer = {
    mode: 'stopwatch',
    phase: 'work',
    running: false,
    baseElapsed: 125,
    elapsedRemainderMs: 0,
    startedAt: null,
    cyclePosition: 0,
    taskId: 7011,
    sessionStartAt: tx.sessionStartAt,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false,
    pendingStopwatchTransaction: options.withoutPendingStopwatchTransaction === true ? null : tx,
    savedAt: now
  };

  return { main, timer, tx };
}

async function startBrowserContext(options = {}) {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const appUrl = 'http://127.0.0.1:' + server.address().port + '/';
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const seed = makeSeed(options);
    const importRollback = options.recoveryMarker === 'import' ? {
      main: JSON.stringify(seed.main),
      focusSessions: '[]',
      focusTimer: JSON.stringify(seed.timer),
      mentalInbox: null,
      thoughts: null,
      projects: null,
      focusSettings: null,
      notifications: null
    } : null;
    const rollingRecord = options.recoveryMarker === 'rolling' ? {
      formatVersion: 1,
      sequence: 7,
      createdAtMs: Date.now(),
      reason: 'e2e-startup-marker',
      data: {
        main: JSON.stringify(seed.main),
        focusSessions: '[]',
        focusTimer: JSON.stringify(seed.timer),
        mentalInbox: null,
        thoughts: null,
        projects: null,
        focusSettings: null,
        notifications: null
      }
    } : null;
    const resetMain = { ...seed.main, tasks: [], dailyLogs: [] };
    const resetRecord = options.recoveryMarker === 'reset' ? {
      version: 1,
      main: JSON.stringify(resetMain),
      generation: 8
    } : null;
    await context.addInitScript(({ initial, withoutLocks, corruptSecondaryKey, recoveryMarker, importRollback, rollingRecord, resetRecord }) => {
      const nativeSetItem = Storage.prototype.setItem;
      const nativeRemoveItem = Storage.prototype.removeItem;
      const nativeClear = Storage.prototype.clear;

      // Seed through the native methods before recording application writes.
      if (localStorage.getItem('timeTasksApp_v1') === null) {
        nativeSetItem.call(localStorage, 'timeTasksApp_v1', JSON.stringify(initial.main));
      }
      if (localStorage.getItem('timeTasksApp_focusTimer') === null) {
        nativeSetItem.call(localStorage, 'timeTasksApp_focusTimer', JSON.stringify(initial.timer));
      }
      if (localStorage.getItem('timeTasksApp_focusSessions') === null) {
        nativeSetItem.call(localStorage, 'timeTasksApp_focusSessions', '[]');
      }
      if (corruptSecondaryKey) {
        nativeSetItem.call(localStorage, corruptSecondaryKey, '{broken-secondary');
      }
      if (recoveryMarker === 'import') {
        nativeSetItem.call(localStorage, 'timeTasksApp_preImportBackup', JSON.stringify(importRollback));
        nativeSetItem.call(localStorage, 'timeTasksApp_importInProgress', '1');
      } else if (recoveryMarker === 'rolling') {
        nativeSetItem.call(localStorage, 'timeTasksApp_recoveryBackupA', JSON.stringify(rollingRecord));
        nativeSetItem.call(localStorage, 'timeTasksApp_recoveryBackupGeneration', '7');
        nativeSetItem.call(localStorage, 'timeTasksApp_rollingRestoreInProgress',
          JSON.stringify({ version: 1, slot: 'a', sequence: 7 }));
      } else if (recoveryMarker === 'migration') {
        nativeSetItem.call(localStorage, 'timeTasksApp_migrationInProgress', '1');
      } else if (recoveryMarker === 'reset') {
        nativeSetItem.call(localStorage, 'timeTasksApp_recoveryBackupGeneration', '7');
        nativeSetItem.call(localStorage, 'timeTasksApp_resetInProgress', JSON.stringify(resetRecord));
      }

      window.__startupStorageWrites = [];
      Storage.prototype.setItem = function(key, value) {
        window.__startupStorageWrites.push({ operation: 'set', key: String(key), value: String(value) });
        return nativeSetItem.call(this, key, value);
      };
      Storage.prototype.removeItem = function(key) {
        window.__startupStorageWrites.push({ operation: 'remove', key: String(key) });
        return nativeRemoveItem.call(this, key);
      };
      Storage.prototype.clear = function() {
        window.__startupStorageWrites.push({ operation: 'clear', key: '*' });
        return nativeClear.call(this);
      };

      if (withoutLocks) {
        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          value: undefined
        });
      }
    }, {
      initial: seed,
      withoutLocks: options.withoutLocks === true,
      corruptSecondaryKey: options.corruptSecondaryKey || null,
      recoveryMarker: options.recoveryMarker || null,
      importRollback,
      rollingRecord,
      resetRecord
    });
    return { server, browser, context, appUrl, seed };
  } catch (error) {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
}

async function closeBrowserContext(runtime) {
  if (runtime.context) await runtime.context.close();
  if (runtime.browser) await runtime.browser.close();
  await new Promise(resolve => runtime.server.close(resolve));
}

async function waitForRecoveryState(page) {
  await page.waitForFunction(() =>
    window._startupStopwatchRecoveryInFlight === true
      || window._startupStopwatchRecoveryFailed === true
      || (typeof storageRecoveryRequired !== 'undefined' && storageRecoveryRequired === true),
  null, { timeout: 20_000 });
}

async function waitForStartupSuccess(page) {
  await page.waitForFunction(() =>
    window._appInitCompleted === true
      && typeof storageRecoveryRequired !== 'undefined'
      && storageRecoveryRequired === false,
  null, { timeout: 20_000 });
}

async function primeLinkedWorkTimer(page, {
  taskId = 7011, mode = 'stopwatch', durationSec = 180
} = {}) {
  await page.evaluate(async ({ taskId, mode, durationSec }) => {
    if (_focusTimer.running) toggleTimer();
    _focusTimer.mode = mode;
    _focusTimer.phase = 'work';
    _focusTimer.running = false;
    _focusTimer.baseElapsed = 0;
    _focusElapsedRemainderMs = 0;
    _focusTimer.startedAt = null;
    _focusTimer.sessionStartAt = null;
    _focusTimer.taskId = null;
    _focusTimer.awaitingConfirmation = false;
    _focusTimer.pendingStopwatchTransaction = null;
    _clearFocusTimerClock();
    if (!_saveFocusTimer()) throw new Error('Could not persist the clean timer fixture');

    if (mode === 'pomodoro') {
      const started = await startTimerForTask(taskId);
      if (started !== true) throw new Error('Pomodoro task timer did not start');
    } else {
      linkTimerToTask(taskId);
      toggleTimer();
    }
    if (!_focusTimer.running || _focusTimer.taskId !== taskId) {
      throw new Error('The linked work timer did not enter its running state');
    }

    const elapsedMs = durationSec * 1000;
    const startedAt = Date.now() - elapsedMs;
    const monotonicStart = performance.now() - elapsedMs;
    _focusTimer.startedAt = startedAt;
    _focusTimer.sessionStartAt = startedAt;
    _anchorFocusTimerClock(startedAt, 0, monotonicStart, startedAt);
    if (!_saveFocusTimer()) throw new Error('Could not persist the running timer fixture');
  }, { taskId, mode, durationSec });
}

async function addSecondTask(page) {
  await page.evaluate(async () => {
    await _withTaskStorageLock(() => {
    tasks.push({
      id: 7012,
      name: 'Next transition task',
      type: 'معرفية',
      status: 'pending',
      expected: 20,
      actual: null,
      plannedDate: new Date().toISOString().slice(0, 10),
      plannedTime: '',
      completedAt: null,
      createdAt: Date.now(),
      projectId: null,
      priority: null,
      recurrence: null,
      checklist: null
    });
    if (!saveData()) throw new Error('Could not persist the next task fixture');
    return true;
    });
  });
}

async function holdStopwatchLock(page) {
  await page.evaluate((lockName) => {
    window.__stopwatchLockAcquired = false;
    window.__releaseStopwatchLock = null;
    window.__stopwatchLockPromise = navigator.locks.request(
      lockName,
      { mode: 'exclusive' },
      () => new Promise(resolve => {
        window.__releaseStopwatchLock = resolve;
        window.__stopwatchLockAcquired = true;
      })
    );
  }, LOCK_NAME);
  await page.waitForFunction(() => window.__stopwatchLockAcquired === true);
}

async function releaseStopwatchLock(page) {
  await page.evaluate(() => {
    if (typeof window.__releaseStopwatchLock === 'function') {
      window.__releaseStopwatchLock();
      window.__releaseStopwatchLock = null;
    }
  });
}

test('D-03.1 startup remains read-only across every localStorage key while the Stopwatch lock is held', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext({ corruptSecondaryKey: 'timeTasksApp_mentalInbox' });
  let controller;
  let appPage;
  try {
    controller = await runtime.context.newPage();
    await controller.goto(runtime.appUrl + 'hold-lock.html');
    await holdStopwatchLock(controller);

    appPage = await runtime.context.newPage();
    await appPage.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await waitForRecoveryState(appPage);

    const beforeRelease = await appPage.evaluate(() => {
      const writesBefore = window.__startupStorageWrites.slice();
      const saved = saveData();
      return {
        startupInFlight: window._startupStopwatchRecoveryInFlight,
        startupFailed: window._startupStopwatchRecoveryFailed,
        initCompleted: window._appInitCompleted,
        timerBlocked: _isTimerControlBlocked(),
        saveResult: saved,
        writesBefore,
        writesAfter: window.__startupStorageWrites.slice()
      };
    });

    assert.equal(beforeRelease.startupInFlight, true);
    assert.equal(beforeRelease.initCompleted, false);
    assert.equal(beforeRelease.timerBlocked, true);
    assert.equal(beforeRelease.saveResult, false);
    assert.deepEqual(
      beforeRelease.writesAfter,
      [],
      'no localStorage key may be set, removed or cleared while startup recovery waits for the lock'
    );

    await controller.evaluate(() => {
      localStorage.setItem('timeTasksApp_mentalInbox', '[]');
    });
    const queued = await appPage.evaluate(() => ({
      queue: window._pendingCorruptStorageSnapshots.slice(),
      forensicKeys: Object.keys(localStorage).filter(key => key.startsWith('timeTasksApp_mentalInbox_corrupt_'))
    }));
    assert.equal(queued.queue.length, 1);
    assert.equal(queued.queue[0].raw, '{broken-secondary');
    assert.deepEqual(queued.forensicKeys, [],
      'the first render must not persist forensic bytes outside the Stopwatch lock');

    await releaseStopwatchLock(controller);
    await waitForStartupSuccess(appPage);
    const afterRelease = await appPage.evaluate(() => ({
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      main: JSON.parse(localStorage.getItem('timeTasksApp_v1')),
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]'),
      queue: window._pendingCorruptStorageSnapshots.slice(),
      forensic: Object.keys(localStorage)
        .filter(key => key.startsWith('timeTasksApp_mentalInbox_corrupt_'))
        .map(key => localStorage.getItem(key))
    }));
    assert.equal(afterRelease.main.tasks[0].actual, 8);
    assert.equal(afterRelease.sessions.length, 1);
    assert.equal(afterRelease.timer.pendingStopwatchTransaction, null);
    assert.equal(afterRelease.queue.length, 0);
    assert.ok(afterRelease.forensic.includes('{broken-secondary'),
      'the exact original raw record must be preserved after lock acquisition');
    assert.ok(afterRelease.main, 'startup recovered after the corrupted secondary record was repaired');
  } finally {
    if (controller) await releaseStopwatchLock(controller).catch(() => {});
    await closeBrowserContext(runtime);
  }
});

test('D-02 task-linked save waits for real startup and records every persistence attempt', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext({ withoutPendingStopwatchTransaction: true });
  let page;
  try {
    page = await runtime.context.newPage();
    await page.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await waitForStartupSuccess(page);

    const result = await page.evaluate(async () => {
      const task = tasks.find(item => item && item.id === 7011);
      const snapshot = _captureFocusTimerSnapshot();
      const diagnostics = { methods: [], storage: [] };
      const getMainActual = () => {
        try {
          const record = JSON.parse(localStorage.getItem('timeTasksApp_v1') || '{}');
          const current = Array.isArray(record.tasks)
            ? record.tasks.find(item => item && item.id === 7011) : null;
          return current ? current.actual : null;
        } catch (_error) { return null; }
      };
      const getPendingTransactionId = () => {
        try {
          const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer') || '{}');
          return timer.pendingStopwatchTransaction
            ? timer.pendingStopwatchTransaction.id : null;
        } catch (_error) { return 'unreadable'; }
      };
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        const name = String(key);
        const beforeActual = getMainActual();
        const beforeTransactionId = getPendingTransactionId();
        const lockDepth = window._stopwatchTransactionLockDepth;
        let outcome = 'success';
        try {
          return originalSetItem.call(this, key, value);
        } catch (error) {
          outcome = 'throw: ' + String(error && error.message ? error.message : error);
          throw error;
        } finally {
          diagnostics.storage.push({
            operation: 'set',
            key: name,
            lockDepth,
            beforeActual,
            afterActual: getMainActual(),
            beforeTransactionId,
            afterTransactionId: getPendingTransactionId(),
            outcome
          });
        }
      };
      const originalRemoveItem = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function(key) {
        const name = String(key);
        const lockDepth = window._stopwatchTransactionLockDepth;
        let outcome = 'success';
        try {
          return originalRemoveItem.call(this, key);
        } catch (error) {
          outcome = 'throw: ' + String(error && error.message ? error.message : error);
          throw error;
        } finally {
          diagnostics.storage.push({
            operation: 'remove',
            key: name,
            lockDepth,
            beforeActual: getMainActual(),
            afterActual: getMainActual(),
            beforeTransactionId: getPendingTransactionId(),
            afterTransactionId: getPendingTransactionId(),
            outcome
          });
        }
      };
      const originalClear = Storage.prototype.clear;
      Storage.prototype.clear = function() {
        const lockDepth = window._stopwatchTransactionLockDepth;
        let outcome = 'success';
        try {
          return originalClear.call(this);
        } catch (error) {
          outcome = 'throw: ' + String(error && error.message ? error.message : error);
          throw error;
        } finally {
          diagnostics.storage.push({
            operation: 'clear',
            key: '*',
            lockDepth,
            beforeActual: null,
            afterActual: getMainActual(),
            beforeTransactionId: null,
            afterTransactionId: getPendingTransactionId(),
            outcome
          });
        }
      };
      const wrapMethod = name => {
        const original = window[name];
        window[name] = function() {
          const entry = {
            method: name,
            lockDepth: window._stopwatchTransactionLockDepth,
            storedActualBefore: getMainActual(),
            inMemoryActualBefore: (tasks.find(item => item && item.id === 7011) || {}).actual
          };
          let returned;
          try {
            returned = original.apply(this, arguments);
            entry.returnValue = returned;
            return returned;
          } catch (error) {
            entry.error = String(error && error.message ? error.message : error);
            throw error;
          } finally {
            entry.storedActualAfter = getMainActual();
            entry.inMemoryActualAfter = (tasks.find(item => item && item.id === 7011) || {}).actual;
            entry.pendingTransactionId = getPendingTransactionId();
            diagnostics.methods.push(entry);
          }
        };
      };
      if (!task || !snapshot) {
        return { ready: false, reason: 'task_or_timer_snapshot_missing', diagnostics };
      }
      wrapMethod('saveData');
      wrapMethod('_saveFocusTimer');
      wrapMethod('_saveSessions');
      const saveResult = await _applyStopwatchSave(snapshot.baseElapsed, task, 3, snapshot);
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const savedTask = main.tasks.find(item => item && item.id === 7011);
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      return {
        ready: true,
        saveResult,
        appInitCompleted: window._appInitCompleted,
        storageRecoveryRequired,
        finalActual: savedTask && savedTask.actual,
        taskTransactionId: savedTask && savedTask.lastStopwatchTransactionId,
        pendingTransaction: timer.pendingStopwatchTransaction,
        sessions,
        diagnostics
      };
    });

    console.log('D02_TASK_LINKED_SAVE_DIAGNOSTICS=' + JSON.stringify(result));
    assert.equal(result.ready, true, 'the initialized app must expose the task and frozen timer snapshot');
    assert.equal(result.appInitCompleted, true);
    assert.equal(result.storageRecoveryRequired, false);
    assert.equal(result.saveResult, true);
    assert.equal(result.finalActual, 8);
    assert.equal(result.pendingTransaction, null);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].transactionId, result.taskTransactionId);
    assert.ok(result.diagnostics.methods.some(entry =>
      entry.method === 'saveData'
        && entry.lockDepth > 0
        && entry.storedActualBefore === 5
        && entry.inMemoryActualBefore === 8
        && entry.storedActualAfter === 8
        && entry.returnValue === true),
    'saveData must commit actual=8 and report success while owning the lock');
    assert.ok(result.diagnostics.methods.some(entry =>
      entry.method === '_saveFocusTimer' && entry.lockDepth > 0),
    'timer journal writes must occur under the Stopwatch lock');
    assert.ok(result.diagnostics.methods.some(entry =>
      entry.method === '_saveSessions' && entry.lockDepth > 0),
    'session writes must occur under the Stopwatch lock');
    assert.ok(result.diagnostics.storage.some(entry =>
      entry.key === 'timeTasksApp_v1'
        && entry.lockDepth > 0
        && entry.beforeActual === 5
        && entry.afterActual === 8),
    'the actual localStorage main-record mutation must be visible in the attempt log');
    assert.ok(result.diagnostics.storage.every(entry => entry.lockDepth > 0),
      'every recorded localStorage write in the transaction must be protected by the lock');
  } finally {
    await closeBrowserContext(runtime);
  }
});

test('D-02 resetTimer save dialog commits the linked Stopwatch transaction exactly once', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext({ withoutPendingStopwatchTransaction: true });
  let page;
  try {
    page = await runtime.context.newPage();
    await page.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await waitForStartupSuccess(page);
    await primeLinkedWorkTimer(page, { taskId: 7011, mode: 'stopwatch', durationSec: 180 });

    await page.evaluate(() => resetTimer());
    await page.waitForFunction(() => {
      const footer = document.getElementById('modalFooter');
      return footer && Array.from(footer.children).some(button =>
        button.textContent.includes('حفظ وإضافة'));
    }, null, { timeout: 5000 });
    await page.evaluate(() => {
      const save = Array.from(document.getElementById('modalFooter').children)
        .find(button => button.textContent.includes('حفظ وإضافة'));
      if (!save) throw new Error('resetTimer save choice was not rendered');
      save.click();
      window.__d02CommitPromise = window._focusCommitPendingPromise;
      if (!window.__d02CommitPromise) throw new Error('resetTimer save action did not start a commit promise');
    });
    const result = await page.evaluate(async () => {
      const pending = window.__d02CommitPromise;
      const commitResult = pending ? await pending : false;
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const savedTask = main.tasks.find(item => item.id === 7011);
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      return {
        commitResult,
        actual: savedTask && savedTask.actual,
        taskTransactionId: savedTask && savedTask.lastStopwatchTransactionId,
        sessions,
        timer,
        recoveryRequired: storageRecoveryRequired
      };
    });
    assert.equal(result.commitResult, true);
    assert.equal(result.actual, 8);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].taskId, 7011);
    assert.equal(result.sessions[0].transactionId, result.taskTransactionId);
    assert.ok(result.taskTransactionId);
    assert.equal(result.timer.pendingStopwatchTransaction, null);
    assert.equal(result.timer.running, false);
    assert.equal(result.timer.baseElapsed, 0);
    assert.equal(result.recoveryRequired, false);
  } finally {
    await closeBrowserContext(runtime);
  }
});

test('D-02 transition commits the old task before starting the next task timer', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext({ withoutPendingStopwatchTransaction: true });
  let page;
  try {
    page = await runtime.context.newPage();
    await page.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await waitForStartupSuccess(page);
    await addSecondTask(page);
    await primeLinkedWorkTimer(page, { taskId: 7011, mode: 'stopwatch', durationSec: 180 });

    await page.evaluate(() => startTimerForTask(7012));
    await page.waitForFunction(() => Array.from(document.getElementById('modalFooter').children)
      .some(button => button.textContent.includes('حفظ والانتقال')), null, { timeout: 5000 });
    await page.evaluate(() => {
      const nativeSetItem = Storage.prototype.setItem;
      const nativeGetItem = Storage.prototype.getItem;
      window.__nativeSetItemBeforeTransition = nativeSetItem;
      window.__transitionCommitBeforeStart = null;
      Storage.prototype.setItem = function(key, value) {
        if (String(key) === 'timeTasksApp_focusTimer') {
          try {
            const nextTimer = JSON.parse(String(value));
            if (nextTimer.taskId === 7012 && nextTimer.mode === 'pomodoro' && nextTimer.running === true) {
              const main = JSON.parse(nativeGetItem.call(localStorage, 'timeTasksApp_v1'));
              const sessions = JSON.parse(nativeGetItem.call(localStorage, 'timeTasksApp_focusSessions') || '[]');
              const oldTask = main.tasks.find(item => item.id === 7011);
              window.__transitionCommitBeforeStart = {
                actual: oldTask && oldTask.actual,
                taskTransactionId: oldTask && oldTask.lastStopwatchTransactionId,
                sessions,
                pending: nextTimer.pendingStopwatchTransaction
              };
            }
          } catch (_error) {}
        }
        return nativeSetItem.call(this, key, value);
      };
      const save = Array.from(document.getElementById('modalFooter').children)
        .find(button => button.textContent.includes('حفظ والانتقال'));
      if (!save) throw new Error('transition save choice was not rendered');
      save.click();
      window.__transitionCommitPromise = window._focusCommitPendingPromise;
      if (!window.__transitionCommitPromise) throw new Error('transition save action did not start a commit promise');
    });
    const commitResult = await page.evaluate(async () => {
      const pending = window.__transitionCommitPromise;
      return pending ? await pending : false;
    });
    const result = await page.evaluate(() => {
      Storage.prototype.setItem = window.__nativeSetItemBeforeTransition;
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const oldTask = main.tasks.find(item => item.id === 7011);
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      return {
        observation: window.__transitionCommitBeforeStart,
        actual: oldTask && oldTask.actual,
        taskTransactionId: oldTask && oldTask.lastStopwatchTransactionId,
        sessions,
        timer
      };
    });
    assert.equal(commitResult, true);
    assert.ok(result.observation);
    assert.equal(result.observation.actual, 8);
    assert.equal(result.observation.sessions.length, 1);
    assert.equal(result.observation.taskTransactionId, result.observation.sessions[0].transactionId);
    assert.equal(result.observation.pending, null);
    assert.equal(result.actual, 8);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].transactionId, result.taskTransactionId);
    assert.equal(result.timer.mode, 'pomodoro');
    assert.equal(result.timer.taskId, 7012);
    assert.equal(result.timer.running, true);
    assert.equal(result.timer.baseElapsed, 0);
    assert.equal(result.timer.pendingStopwatchTransaction, null);
  } finally {
    await closeBrowserContext(runtime);
  }
});

test('D-02 transition failure does not start the next task or report success', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext({ withoutPendingStopwatchTransaction: true });
  let page;
  try {
    page = await runtime.context.newPage();
    await page.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await waitForStartupSuccess(page);
    await addSecondTask(page);
    await primeLinkedWorkTimer(page, { taskId: 7011, mode: 'stopwatch', durationSec: 180 });

    await page.evaluate(() => startTimerForTask(7012));
    await page.waitForFunction(() => Array.from(document.getElementById('modalFooter').children)
      .some(button => button.textContent.includes('حفظ والانتقال')), null, { timeout: 5000 });
    await page.evaluate(() => {
      const nativeSetItem = Storage.prototype.setItem;
      window.__originalTransitionSetItem = nativeSetItem;
      window.__injectedMainWriteFailure = false;
      window.__transitionToasts = [];
      window.__originalTransitionToast = window.showToast;
      window.showToast = function(message) {
        window.__transitionToasts.push(String(message));
        return window.__originalTransitionToast.apply(this, arguments);
      };
      Storage.prototype.setItem = function(key, value) {
        if (String(key) === 'timeTasksApp_v1' && !window.__injectedMainWriteFailure) {
          window.__injectedMainWriteFailure = true;
          throw new Error('injected D-02 main-record write failure');
        }
        return nativeSetItem.call(this, key, value);
      };
      const save = Array.from(document.getElementById('modalFooter').children)
        .find(button => button.textContent.includes('حفظ والانتقال'));
      if (!save) throw new Error('transition save choice was not rendered');
      save.click();
    });
    const commitResult = await page.evaluate(async () => {
      const pending = window._focusCommitPendingPromise;
      return pending ? await pending : false;
    });
    const result = await page.evaluate(() => {
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const oldTask = main.tasks.find(item => item.id === 7011);
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      Storage.prototype.setItem = window.__originalTransitionSetItem;
      window.showToast = window.__originalTransitionToast;
      return {
        injected: window.__injectedMainWriteFailure,
        actual: oldTask && oldTask.actual,
        sessions,
        timer,
        recoveryRequired: storageRecoveryRequired,
        inMemoryTimer: {
          taskId: _focusTimer.taskId,
          mode: _focusTimer.mode,
          running: _focusTimer.running,
          baseElapsed: _focusTimer.baseElapsed
        },
        successToastShown: window.__transitionToasts.some(message => message.includes('حُفظت الجلسة وتم الانتقال'))
      };
    });
    assert.equal(commitResult, false);
    assert.equal(result.injected, true);
    assert.equal(result.actual, 5);
    assert.equal(result.sessions.length, 0);
    assert.ok(result.timer.pendingStopwatchTransaction);
    assert.equal(result.timer.taskId, 7011);
    assert.equal(result.timer.running, false);
    assert.ok(result.timer.baseElapsed >= 180);
    assert.equal(result.inMemoryTimer.taskId, 7011);
    assert.equal(result.inMemoryTimer.running, false);
    assert.ok(result.recoveryRequired);
    assert.equal(result.successToastShown, false);
  } finally {
    await closeBrowserContext(runtime);
  }
});

test('D-04 Pomodoro transaction at 500 sessions evicts once and startup retry does not evict another row', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext({ withoutPendingStopwatchTransaction: true });
  let page;
  try {
    page = await runtime.context.newPage();
    await page.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await waitForStartupSuccess(page);
    await page.evaluate(async () => {
      const now = Date.now();
      const history = Array.from({ length: 500 }, (_, index) => {
        const started = now - (501 - index) * 120000;
        return {
          id: index + 1,
          mode: 'pomodoro',
          phase: 'work',
          taskId: 7011,
          taskName: 'Historical Pomodoro task',
          startedAt: new Date(started).toISOString(),
          endedAt: new Date(started + 60000).toISOString(),
          durationSec: 60,
          completed: true
        };
      });
      const saved = await _withStopwatchTransactionLock(() => _saveSessions(history));
      if (!saved) throw new Error('Could not seed 500 valid Pomodoro sessions');
    });
    await primeLinkedWorkTimer(page, { taskId: 7011, mode: 'pomodoro', durationSec: 180 });

    await page.evaluate(() => finishTimer());
    await page.waitForFunction(() => {
      const footer = document.getElementById('modalFooter');
      return footer && footer.children.length >= 3;
    }, null, { timeout: 5000 });
    await page.evaluate(() => {
      const nativeSetItem = Storage.prototype.setItem;
      const nativeGetItem = Storage.prototype.getItem;
      window.__nativeSetItemBeforePomodoroFailure = nativeSetItem;
      window.__injectedJournalClearFailure = false;
      Storage.prototype.setItem = function(key, value) {
        if (String(key) === 'timeTasksApp_focusTimer' && !window.__injectedJournalClearFailure) {
          try {
            const next = JSON.parse(String(value));
            const durable = JSON.parse(nativeGetItem.call(localStorage, 'timeTasksApp_focusTimer') || '{}');
            if (durable.pendingStopwatchTransaction
                && !next.pendingStopwatchTransaction && next.baseElapsed === 0) {
              window.__injectedJournalClearFailure = true;
              throw new Error('injected Pomodoro journal-clear failure');
            }
          } catch (error) {
            if (window.__injectedJournalClearFailure) throw error;
          }
        }
        return nativeSetItem.call(this, key, value);
      };
      const save = document.getElementById('modalFooter').children[2];
      if (!save) throw new Error('Pomodoro finish save action was not rendered');
      save.click();
    });
    const firstAttempt = await page.evaluate(async () => {
      const pending = window._focusCommitPendingPromise;
      const commit = pending ? await pending : false;
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const task = main.tasks.find(item => item.id === 7011);
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      Storage.prototype.setItem = window.__nativeSetItemBeforePomodoroFailure;
      return {
        commit,
        actual: task && task.actual,
        taskTransactionId: task && task.lastStopwatchTransactionId,
        timer,
        sessions,
        recoveryRequired: storageRecoveryRequired,
        injected: window.__injectedJournalClearFailure
      };
    });
    assert.equal(firstAttempt.commit, false);
    assert.equal(firstAttempt.injected, true);
    assert.equal(firstAttempt.actual, 8);
    assert.equal(firstAttempt.sessions.length, 500);
    assert.equal(firstAttempt.sessions[0].id, 2);
    assert.equal(firstAttempt.sessions[499].id, 501);
    assert.equal(firstAttempt.sessions[499].mode, 'pomodoro');
    assert.equal(firstAttempt.sessions[499].transactionId, firstAttempt.taskTransactionId);
    assert.ok(firstAttempt.timer.pendingStopwatchTransaction);
    assert.equal(firstAttempt.recoveryRequired, true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForStartupSuccess(page);
    const recovered = await page.evaluate(() => {
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const task = main.tasks.find(item => item.id === 7011);
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      return {
        actual: task && task.actual,
        taskTransactionId: task && task.lastStopwatchTransactionId,
        timer,
        sessions,
        recoveryRequired: storageRecoveryRequired
      };
    });
    assert.equal(recovered.actual, 8);
    assert.equal(recovered.sessions.length, 500);
    const recoveredSessionIds = recovered.sessions.map(session => session.id);
    assert.deepEqual(recoveredSessionIds, Array.from({ length: 500 }, (_, index) => index + 2));
    assert.equal(new Set(recoveredSessionIds).size, 500,
      'the final 500 session IDs must be unique and remain in FIFO order');
    assert.equal(recovered.sessions[0].id, 2);
    assert.equal(recovered.sessions.filter(session => session.id === 1).length, 0);
    assert.equal(recovered.sessions.filter(session => session.id === 501).length, 1);
    assert.equal(recovered.sessions.filter(session => session.transactionId === recovered.taskTransactionId).length, 1);
    assert.equal(recovered.sessions[499].id, 501);
    assert.equal(recovered.sessions[499].mode, 'pomodoro');
    assert.equal(recovered.timer.pendingStopwatchTransaction, null);
    assert.equal(recovered.timer.baseElapsed, 0);
    assert.equal(recovered.recoveryRequired, false);
  } finally {
    await closeBrowserContext(runtime);
  }
});

for (const recoveryMarker of ['reset', 'import', 'rolling', 'migration']) {
  test('D-03 refuses ' + recoveryMarker + ' recovery when a Stopwatch journal is also pending', {
    skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
  }, async () => {
    const runtime = await startBrowserContext({ recoveryMarker });
    let controller, appPage;
    try {
      controller = await runtime.context.newPage();
      await controller.goto(runtime.appUrl + 'hold-lock.html');
      await holdStopwatchLock(controller);
      appPage = await runtime.context.newPage();
      await appPage.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
      await appPage.waitForFunction(() => window._startupStopwatchRecoveryInFlight === true);
      const waiting = await appPage.evaluate(() => ({
        writes: window.__startupStorageWrites.slice(), initialized: window._appInitCompleted
      }));
      assert.equal(waiting.initialized, false);
      assert.deepEqual(waiting.writes, []);
      await releaseStopwatchLock(controller);
      await appPage.waitForFunction(() => window._startupStopwatchRecoveryFailed === true);
      const blocked = await appPage.evaluate(marker => ({
        recoveryRequired: storageRecoveryRequired,
        initialized: window._appInitCompleted,
        main: JSON.parse(localStorage.getItem('timeTasksApp_v1')),
        timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
        sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]'),
        marker: localStorage.getItem(marker === 'reset'
          ? 'timeTasksApp_resetInProgress'
          : marker === 'import'
            ? 'timeTasksApp_importInProgress'
            : marker === 'rolling'
              ? 'timeTasksApp_rollingRestoreInProgress'
              : 'timeTasksApp_migrationInProgress'),
        importSnapshot: localStorage.getItem('timeTasksApp_preImportBackup'),
        backupA: localStorage.getItem('timeTasksApp_recoveryBackupA'),
        writes: window.__startupStorageWrites.slice()
      }), recoveryMarker);
      assert.equal(blocked.recoveryRequired, true);
      assert.equal(blocked.initialized, false);
      assert.equal(blocked.main.tasks[0].actual, 5);
      assert.equal(blocked.main.tasks[0].lastStopwatchTransactionId, undefined);
      assert.equal(blocked.timer.pendingStopwatchTransaction.id, runtime.seed.tx.id);
      assert.equal(blocked.sessions.length, 0);
      assert.ok(blocked.marker);
      if (recoveryMarker === 'reset') {
        const resetMarker = JSON.parse(blocked.marker);
        const resetMain = JSON.parse(resetMarker.main);
        assert.equal(resetMarker.version, 1);
        assert.equal(resetMarker.generation, 8);
        assert.deepEqual(resetMain.tasks, []);
        assert.deepEqual(resetMain.dailyLogs, []);
      }
      if (recoveryMarker === 'import') assert.ok(blocked.importSnapshot);
      if (recoveryMarker === 'rolling') assert.ok(blocked.backupA);
      if (recoveryMarker === 'migration') assert.equal(blocked.marker, '1');
      assert.deepEqual(blocked.writes, [],
        'journal+group marker overlap must fail before any storage mutation');
    } finally {
      if (controller) await releaseStopwatchLock(controller).catch(() => {});
      await closeBrowserContext(runtime);
    }
  });
}

for (const recoveryMarker of ['import', 'rolling']) {
  test('D-03 recovers a lone ' + recoveryMarker + ' marker under the Stopwatch lock', {
    skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
  }, async () => {
    const runtime = await startBrowserContext({
      recoveryMarker, withoutPendingStopwatchTransaction: true
    });
    let controller, appPage;
    try {
      controller = await runtime.context.newPage();
      await controller.goto(runtime.appUrl + 'hold-lock.html');
      await holdStopwatchLock(controller);
      appPage = await runtime.context.newPage();
      await appPage.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
      await appPage.waitForFunction(() => window._startupStopwatchRecoveryInFlight === true);
      assert.deepEqual(await appPage.evaluate(() => window.__startupStorageWrites.slice()), []);
      await releaseStopwatchLock(controller);
      await waitForStartupSuccess(appPage);
      const recovered = await appPage.evaluate(marker => ({
        main: JSON.parse(localStorage.getItem('timeTasksApp_v1')),
        timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
        sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]'),
        marker: localStorage.getItem(marker === 'import'
          ? 'timeTasksApp_importInProgress' : 'timeTasksApp_rollingRestoreInProgress'),
        importSnapshot: localStorage.getItem('timeTasksApp_preImportBackup'),
        backupA: localStorage.getItem('timeTasksApp_recoveryBackupA')
      }), recoveryMarker);
      assert.equal(recovered.main.tasks[0].actual, 5);
      assert.equal(recovered.timer.pendingStopwatchTransaction, null);
      assert.equal(recovered.sessions.length, 0);
      assert.equal(recovered.marker, null);
      if (recoveryMarker === 'import') assert.equal(recovered.importSnapshot, null);
      if (recoveryMarker === 'rolling') assert.ok(recovered.backupA);
    } finally {
      if (controller) await releaseStopwatchLock(controller).catch(() => {});
      await closeBrowserContext(runtime);
    }
  });
}

test('D-03 recovers a lone Migration marker under the Stopwatch lock', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext({
    recoveryMarker: 'migration', withoutPendingStopwatchTransaction: true
  });
  let page;
  try {
    page = await runtime.context.newPage();
    await page.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await waitForStartupSuccess(page);
    const state = await page.evaluate(() => ({
      marker: localStorage.getItem('timeTasksApp_migrationInProgress'),
      main: JSON.parse(localStorage.getItem('timeTasksApp_v1')),
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'))
    }));
    assert.equal(state.marker, null);
    assert.equal(state.main.tasks[0].actual, 5);
    assert.equal(state.timer.pendingStopwatchTransaction, null);
  } finally {
    await closeBrowserContext(runtime);
  }
});

test('D-03 refuses overlapping group-recovery markers without changing sources', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext({
    recoveryMarker: 'import', withoutPendingStopwatchTransaction: true
  });
  let controller, appPage;
  try {
    controller = await runtime.context.newPage();
    await controller.goto(runtime.appUrl + 'hold-lock.html');
    await holdStopwatchLock(controller);
    const rollingMarker = JSON.stringify({ version: 1, slot: 'a', sequence: 7 });
    await controller.evaluate(value => {
      localStorage.setItem('timeTasksApp_rollingRestoreInProgress', value);
    }, rollingMarker);
    appPage = await runtime.context.newPage();
    await appPage.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await appPage.waitForFunction(() => window._startupStopwatchRecoveryInFlight === true);
    await releaseStopwatchLock(controller);
    await appPage.waitForFunction(() => window._startupStopwatchRecoveryFailed === true);
    const state = await appPage.evaluate(() => ({
      importMarker: localStorage.getItem('timeTasksApp_importInProgress'),
      rollingMarker: localStorage.getItem('timeTasksApp_rollingRestoreInProgress'),
      preImport: localStorage.getItem('timeTasksApp_preImportBackup'),
      writes: window.__startupStorageWrites.slice(),
      initialized: window._appInitCompleted
    }));
    assert.equal(state.importMarker, '1');
    assert.equal(state.rollingMarker, rollingMarker);
    assert.ok(state.preImport);
    assert.equal(state.initialized, false);
    assert.deepEqual(state.writes, []);
  } finally {
    if (controller) await releaseStopwatchLock(controller).catch(() => {});
    await closeBrowserContext(runtime);
  }
});
test('D-03.2 two real same-origin tabs wait for Web Locks and the second page synchronizes memory, baselines and UI', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext();
  let controller;
  let pageA;
  let pageB;
  try {
    controller = await runtime.context.newPage();
    await controller.goto(runtime.appUrl + 'hold-lock.html');
    await holdStopwatchLock(controller);

    pageA = await runtime.context.newPage();
    await pageA.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await pageA.waitForFunction(() => _startupStopwatchRecoveryInFlight === true,
      null, { timeout: 10000 });

    pageB = await runtime.context.newPage();
    await pageB.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await pageB.waitForFunction(() => _startupStopwatchRecoveryInFlight === true,
      null, { timeout: 10000 });

    const lockQueue = await controller.evaluate(async () => {
      const state = await navigator.locks.query();
      return {
        held: (state.held || []).filter(lock => lock.name === 'timeTasksApp-stopwatch-transaction').length,
        pending: (state.pending || []).filter(lock => lock.name === 'timeTasksApp-stopwatch-transaction').length
      };
    });
    assert.equal(lockQueue.held, 1);
    assert.ok(lockQueue.pending >= 2,
      'both startup pages must wait behind the controller on the real same-origin Web Lock');

    await releaseStopwatchLock(controller);
    await controller.evaluate(() => window.__stopwatchLockPromise);
    await Promise.all([waitForStartupSuccess(pageA), waitForStartupSuccess(pageB)]);

    const persisted = await pageA.evaluate(() => ({
      main: JSON.parse(localStorage.getItem('timeTasksApp_v1')),
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]')
    }));
    assert.equal(persisted.main.tasks[0].actual, 8);
    assert.equal(persisted.sessions.length, 1);
    assert.equal(persisted.sessions[0].transactionId, runtime.seed.tx.id);
    assert.equal(persisted.timer.pendingStopwatchTransaction, null);

    const waiter = await pageB.evaluate(() => {
      const mainRaw = localStorage.getItem(STORAGE_KEY);
      const timerRaw = localStorage.getItem(FOCUS_TIMER_KEY);
      const sessionsRaw = localStorage.getItem(FOCUS_SESSIONS_KEY);
      const projectsRaw = localStorage.getItem(PROJECTS_KEY);
      return {
        tasks: tasks.map(task => ({
          id: task.id, actual: task.actual, transactionId: task.lastStopwatchTransactionId
        })),
        mainRaw,
        mainBaselineRaw: _mainStorageBaselineRaw,
        timerRaw,
        timerBaseline: _secondaryStorageBaselines[FOCUS_TIMER_KEY],
        sessionsRaw,
        sessionsBaseline: _secondaryStorageBaselines[FOCUS_SESSIONS_KEY],
        projectsRaw,
        projectsBaseline: _secondaryStorageBaselines[PROJECTS_KEY],
        sessionsCache: _sessionsCache,
        sessionConflicts: !!_secondaryStorageConflicts[FOCUS_SESSIONS_KEY],
        timerConflicts: !!_secondaryStorageConflicts[FOCUS_TIMER_KEY],
        projectConflicts: !!_secondaryStorageConflicts[PROJECTS_KEY],
        timerExternalConflict: _focusTimerExternalConflict,
        mainExternalChange: _mainStorageExternalChangeObserved,
        appInitCompleted: _appInitCompleted,
        recoveryRequired: storageRecoveryRequired,
        uiHasRecoveredTask: document.body.innerText.includes('Startup recovery task'),
        uiTimerDisplay: document.getElementById('timerDisplay2')
          ? document.getElementById('timerDisplay2').textContent : '',
        expectedTimerDisplay: _formatFocusTime(_getElapsedSec()),
        uiTimerPhaseLabel: document.getElementById('timerPhaseLabel')
          ? document.getElementById('timerPhaseLabel').textContent : '',
        uiSessionsCard: document.getElementById('focusSessionsCard')
          ? document.getElementById('focusSessionsCard').innerText : ''
      };
    });
    assert.equal(waiter.tasks.length, 1);
    assert.equal(waiter.tasks[0].actual, 8);
    assert.equal(waiter.tasks[0].transactionId, runtime.seed.tx.id);
    assert.equal(waiter.mainBaselineRaw, waiter.mainRaw);
    assert.equal(waiter.timerBaseline, waiter.timerRaw);
    assert.equal(waiter.sessionsBaseline, waiter.sessionsRaw);
    assert.equal(waiter.projectsBaseline, waiter.projectsRaw);
    assert.equal(waiter.sessionsCache.length, 1);
    assert.equal(waiter.sessionsCache[0].transactionId, runtime.seed.tx.id);
    assert.equal(waiter.sessionConflicts, false);
    assert.equal(waiter.timerConflicts, false);
    assert.equal(waiter.projectConflicts, false);
    assert.equal(waiter.timerExternalConflict, false);
    assert.equal(waiter.mainExternalChange, false);
    assert.equal(waiter.appInitCompleted, true);
    assert.equal(waiter.recoveryRequired, false);
    assert.equal(waiter.uiHasRecoveredTask, true);
    assert.equal(waiter.uiTimerDisplay, waiter.expectedTimerDisplay,
      'the rendered timer display must reflect the recovered in-memory timer');
    assert.ok(waiter.uiTimerPhaseLabel.includes('ساعة توقيت'),
      'the rendered timer mode must reflect the recovered Stopwatch mode');
    assert.ok(waiter.uiSessionsCard.includes('Startup recovery task'),
      'the rendered recent-sessions card must show the recovered session');

    const writer = await pageA.evaluate(async () => {
      const saved = await _withTaskStorageLock(() => {
        appSettings.themeMode = 'dark';
        appSettings.darkMode = true;
        return saveData();
      });
      return { saved, raw: localStorage.getItem(STORAGE_KEY) };
    });
    assert.equal(writer.saved, true);
    await pageB.waitForFunction(() => _mainStorageExternalChangeObserved === true);
    const stale = await pageB.evaluate(async () => {
      const before = localStorage.getItem(STORAGE_KEY);
      const saved = await _withTaskStorageLock(() => {
        appSettings.themeMode = 'light';
        appSettings.darkMode = false;
        return saveData();
      });
      return { saved, before, after: localStorage.getItem(STORAGE_KEY) };
    });
    assert.equal(stale.saved, false);
    assert.equal(stale.after, stale.before);
    assert.equal(stale.before, writer.raw);

    const lockStateAfter = await pageB.evaluate(async () => {
      const state = await navigator.locks.query();
      return {
        held: (state.held || []).filter(lock => lock.name === 'timeTasksApp-stopwatch-transaction').length,
        pending: (state.pending || []).filter(lock => lock.name === 'timeTasksApp-stopwatch-transaction').length
      };
    });
    assert.deepEqual(lockStateAfter, { held: 0, pending: 0 });
  } finally {
    if (controller) await releaseStopwatchLock(controller).catch(() => {});
    await closeBrowserContext(runtime);
  }
});

test('D-03.3 a journal removed while waiting for the lock without proof remains blocked', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext();
  let controller;
  let appPage;
  try {
    controller = await runtime.context.newPage();
    await controller.goto(runtime.appUrl + 'hold-lock.html');
    await holdStopwatchLock(controller);

    appPage = await runtime.context.newPage();
    await appPage.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await appPage.waitForFunction(() => window._startupStopwatchRecoveryInFlight === true);

    await controller.evaluate((timerKey) => {
      const timer = JSON.parse(localStorage.getItem(timerKey));
      timer.pendingStopwatchTransaction = null;
      localStorage.setItem(timerKey, JSON.stringify(timer));
    }, TIMER_KEY);

    await releaseStopwatchLock(controller);
    await appPage.waitForFunction(() => window._startupStopwatchRecoveryFailed === true);
    const state = await appPage.evaluate(() => ({
      recoveryRequired: storageRecoveryRequired,
      initCompleted: window._appInitCompleted,
      failed: window._startupStopwatchRecoveryFailed,
      task: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks[0],
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]')
    }));
    assert.equal(state.recoveryRequired, true);
    assert.equal(state.initCompleted, false);
    assert.equal(state.failed, true);
    assert.equal(state.task.actual, 5,
      'unproven disappearance must not cause a replay or task-minute change');
    assert.equal(state.task.lastStopwatchTransactionId, undefined);
    assert.equal(state.sessions.length, 0);
  } finally {
    if (controller) await releaseStopwatchLock(controller).catch(() => {});
    await closeBrowserContext(runtime);
  }
});

test('D-03.4 invalid or orphaned transaction fails closed while reset remains callable', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext({ invalidTransaction: true });
  let page;
  try {
    page = await runtime.context.newPage();
    await page.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._startupStopwatchRecoveryFailed === true);

    const state = await page.evaluate(() => ({
      recoveryRequired: storageRecoveryRequired,
      initCompleted: window._appInitCompleted,
      failed: window._startupStopwatchRecoveryFailed,
      timerBlocked: _isTimerControlBlocked(),
      taskBlocked: _isTaskWriteBlocked(),
      resetAvailable: typeof resetAll === 'function',
      main: localStorage.getItem('timeTasksApp_v1'),
      timer: localStorage.getItem('timeTasksApp_focusTimer'),
      writes: window.__startupStorageWrites.slice()
    }));
    assert.equal(state.recoveryRequired, true);
    assert.equal(state.initCompleted, false);
    assert.equal(state.failed, true);
    assert.equal(state.timerBlocked, true);
    assert.equal(state.taskBlocked, true);
    assert.equal(state.resetAvailable, true);
    assert.equal(state.main, JSON.stringify(runtime.seed.main));
    assert.equal(state.timer, JSON.stringify(runtime.seed.timer));
    assert.deepEqual(
      state.writes.filter(item => item.key === MAIN_KEY || item.key === TIMER_KEY),
      [],
      'invalid transaction must be preserved byte-for-byte'
    );
  } finally {
    await closeBrowserContext(runtime);
  }
});

test('D-03.6 missing Web Locks at startup preserves the journal and performs no protected writes', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext({ withoutLocks: true });
  let page;
  try {
    page = await runtime.context.newPage();
    await page.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._startupStopwatchRecoveryFailed === true);

    const state = await page.evaluate(() => ({
      locksUnavailable: !navigator.locks,
      recoveryRequired: storageRecoveryRequired,
      initCompleted: window._appInitCompleted,
      failed: window._startupStopwatchRecoveryFailed,
      main: localStorage.getItem('timeTasksApp_v1'),
      timer: localStorage.getItem('timeTasksApp_focusTimer'),
      writes: window.__startupStorageWrites.slice()
    }));
    assert.equal(state.locksUnavailable, true);
    assert.equal(state.recoveryRequired, true);
    assert.equal(state.initCompleted, false);
    assert.equal(state.failed, true);
    assert.equal(state.main, JSON.stringify(runtime.seed.main));
    assert.equal(state.timer, JSON.stringify(runtime.seed.timer));
    assert.deepEqual(
      state.writes.filter(item => item.key === MAIN_KEY || item.key === TIMER_KEY),
      []
    );
  } finally {
    await closeBrowserContext(runtime);
  }
});
