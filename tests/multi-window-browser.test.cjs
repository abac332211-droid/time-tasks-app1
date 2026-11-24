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
  // Local Node-only runs may not install Playwright. The required CI workflow
  // installs the pinned package and Chromium before running this suite.
}

const root = path.resolve(__dirname, '..');

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

const seed = {
  main: {
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: {
      operationalDayStart: 4,
      firstUseDate: '2026-11-23',
      darkMode: false,
      themeMode: 'system',
      lastRecurringDates: {}
    },
    tasks: [],
    dailyLogs: []
  },
  timer: {
    mode: 'stopwatch',
    phase: 'work',
    running: false,
    baseElapsed: 0,
    elapsedRemainderMs: 0,
    startedAt: null,
    cyclePosition: 0,
    taskId: null,
    sessionStartAt: null,
    awaitingConfirmation: false,
    pendingPhaseEndedAt: null,
    clockAdjusted: false,
    pendingStopwatchTransaction: null,
    savedAt: 1_795_000_000_000
  }
};

test('two real same-origin pages exchange storage events and block stale main/timer writes', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const appUrl = 'http://127.0.0.1:' + address.port + '/';

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript((initial) => {
      if (localStorage.getItem('timeTasksApp_v1') === null) {
        localStorage.setItem('timeTasksApp_v1', JSON.stringify(initial.main));
      }
      if (localStorage.getItem('timeTasksApp_focusTimer') === null) {
        localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(initial.timer));
      }
      if (localStorage.getItem('timeTasksApp_focusSessions') === null) {
        localStorage.setItem('timeTasksApp_focusSessions', '[]');
      }
    }, seed);

    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await Promise.all([
      pageA.goto(appUrl, { waitUntil: 'domcontentloaded' }),
      pageB.goto(appUrl, { waitUntil: 'domcontentloaded' })
    ]);
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => typeof window.saveData === 'function'
        && window._mainStorageBaselineReady === true
        && window._mainStorageConflictListenerInstalled === true,
      null,
      { timeout: 20_000 }
    )));

    const writerMainRaw = await pageA.evaluate(() => {
      const latest = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      latest.settings.themeMode = 'dark';
      latest.settings.darkMode = true;
      const raw = JSON.stringify(latest);
      localStorage.setItem('timeTasksApp_v1', raw);
      return raw;
    });

    await pageB.waitForFunction(
      () => window._mainStorageExternalChangeObserved === true,
      null,
      { timeout: 5_000 }
    );

    const staleMainAttempt = await pageB.evaluate(() => {
      appSettings.themeMode = 'light';
      appSettings.darkMode = false;
      const before = localStorage.getItem('timeTasksApp_v1');
      const saved = saveData();
      const after = localStorage.getItem('timeTasksApp_v1');
      return { saved, before, after };
    });
    assert.equal(staleMainAttempt.saved, false,
      'the stale page must refuse its main-data write after the real storage event');
    assert.equal(staleMainAttempt.before, writerMainRaw);
    assert.equal(staleMainAttempt.after, writerMainRaw,
      'the first page committed value must remain untouched by the stale page');

    const remoteTimerRaw = JSON.stringify({
      ...seed.timer,
      baseElapsed: 45,
      sessionStartAt: 1_795_000_000_000
    });
    await pageA.evaluate(raw => {
      localStorage.setItem('timeTasksApp_focusTimer', raw);
    }, remoteTimerRaw);

    await pageB.waitForFunction(
      () => window._focusTimerExternalConflict === true
        && window._secondaryStorageConflicts['timeTasksApp_focusTimer'] === true,
      null,
      { timeout: 5_000 }
    );

    const staleTimerAttempt = await pageB.evaluate(() => {
      const before = localStorage.getItem('timeTasksApp_focusTimer');
      toggleTimer();
      const after = localStorage.getItem('timeTasksApp_focusTimer');
      return {
        conflict: window._focusTimerExternalConflict,
        running: _focusTimer.running,
        before,
        after
      };
    });
    assert.equal(staleTimerAttempt.conflict, true);
    assert.equal(staleTimerAttempt.running, false);
    assert.equal(staleTimerAttempt.before, remoteTimerRaw);
    assert.equal(staleTimerAttempt.after, remoteTimerRaw,
      'a stale timer action must not overwrite the other page’s committed timer');

    await context.close();

    const recoveryContext = await browser.newContext({ serviceWorkers: 'block' });
    await recoveryContext.addInitScript((initial) => {
      if (localStorage.getItem('timeTasksApp_v1') === null) {
        localStorage.setItem('timeTasksApp_v1', JSON.stringify(initial.main));
      }
      if (localStorage.getItem('timeTasksApp_focusTimer') === null) {
        localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(initial.timer));
      }
      if (localStorage.getItem('timeTasksApp_focusSessions') === null) {
        localStorage.setItem('timeTasksApp_focusSessions', '[]');
      }
    }, seed);
    const recoveryPage = await recoveryContext.newPage();
    await recoveryPage.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await recoveryPage.waitForFunction(
      () => typeof window._applyStopwatchSave === 'function'
        && window._mainStorageBaselineReady === true,
      null,
      { timeout: 20_000 }
    );

    const interrupted = await recoveryPage.evaluate(async () => {
      const task = {
        id: 7011,
        name: 'Crash recovery task',
        type: 'معرفية',
        status: 'pending',
        expected: 15,
        actual: 5,
        plannedDate: todayStr(),
        plannedTime: '',
        completedAt: null,
        createdAt: Date.now(),
        projectId: null,
        priority: null,
        recurrence: null,
        checklist: null
      };
      tasks.push(task);
      appSettings.lastTaskId = task.id;
      if (!saveData()) throw new Error('Could not seed the task record');

      _focusTimer.mode = 'stopwatch';
      _focusTimer.phase = 'work';
      _focusTimer.running = false;
      _focusTimer.baseElapsed = 125;
      _focusElapsedRemainderMs = 0;
      _focusTimer.startedAt = null;
      _focusTimer.taskId = task.id;
      _focusTimer.sessionStartAt = Date.now() - 125_000;
      _focusTimer.awaitingConfirmation = false;
      _focusTimer.pendingPhaseEndedAt = null;
      _focusTimer.clockAdjusted = false;
      if (!_saveFocusTimer()) throw new Error('Could not seed the paused Stopwatch');

      // Simulate a process death at the exact boundary under review:
      // task.actual is committed, but the focus-session row is not yet saved.
      window._logSession = function() {
        throw new Error('simulated abrupt process termination before session write');
      };
      await _applyStopwatchSave(125, task, 3);

      const committedMain = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const timerRecord = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      return {
        taskActual: committedMain.tasks.find(item => item.id === task.id).actual,
        pendingJournal: !!timerRecord.pendingStopwatchTransaction,
        sessionCount: sessions.length
      };
    });

    assert.equal(interrupted.taskActual, 8);
    assert.equal(interrupted.pendingJournal, true);
    assert.equal(interrupted.sessionCount, 0);

    // A real page reload re-creates the app runtime but keeps this BrowserContext's LocalStorage.
    await recoveryPage.reload({ waitUntil: 'domcontentloaded' });
    await recoveryPage.waitForFunction(() => {
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const timerRecord = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      return main.tasks.find(item => item.id === 7011)?.actual === 8
        && sessions.some(item => item.taskId === 7011 && item.durationSec === 125)
        && timerRecord.pendingStopwatchTransaction === null;
    }, null, { timeout: 20_000 });

    const recovered = await recoveryPage.evaluate(() => ({
      taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks
        .find(item => item.id === 7011).actual,
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]')
        .filter(item => item.taskId === 7011 && item.durationSec === 125),
      journal: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')).pendingStopwatchTransaction
    }));
    assert.equal(recovered.taskActual, 8, 'the task update must not be applied twice after reload');
    assert.equal(recovered.sessions.length, 1, 'the interrupted session must be recorded exactly once');
    assert.equal(recovered.journal, null);
    await recoveryContext.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('a stale page refuses manual and rolling backups while another page has a pending Stopwatch journal', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const appUrl = 'http://127.0.0.1:' + server.address().port + '/';
  let browserInstance;
  try {
    browserInstance = await chromium.launch({ headless: true });
    const context = await browserInstance.newContext({ serviceWorkers: 'block' });
    const initial = JSON.parse(JSON.stringify(seed));
    initial.main.tasks = [{
      id: 7021, name: 'Pending backup task', type: 'معرفية', status: 'pending',
      expected: 15, actual: 5, plannedDate: '2026-11-23', plannedTime: '',
      completedAt: null, createdAt: Date.now(), projectId: null, priority: null,
      recurrence: null, checklist: null
    }];
    initial.timer.taskId = 7021;
    initial.timer.baseElapsed = 125;
    initial.timer.sessionStartAt = Date.now() - 125000;
    await context.addInitScript((value) => {
      if (localStorage.getItem('timeTasksApp_v1') === null)
        localStorage.setItem('timeTasksApp_v1', JSON.stringify(value.main));
      if (localStorage.getItem('timeTasksApp_focusTimer') === null)
        localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(value.timer));
      if (localStorage.getItem('timeTasksApp_focusSessions') === null)
        localStorage.setItem('timeTasksApp_focusSessions', '[]');
    }, initial);
    const pageA = await context.newPage(), pageB = await context.newPage();
    await Promise.all([pageA.goto(appUrl), pageB.goto(appUrl)]);
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => window._mainStorageBaselineReady === true && typeof window.buildBackupObject === 'function',
      null, { timeout: 20000 }
    )));
    const pendingId = await pageA.evaluate(async () => {
      // Startup reconciliation in the second page may legitimately write default metadata.
      // Refresh the owner page's in-memory main record and durable-key baselines before the test.
      _mainStorageExternalChangeObserved = false;
      _focusTimerExternalConflict = false;
      _secondaryStorageConflicts = Object.create(null);
      const loaded = await _withStopwatchTransactionLock(function() {
        return loadData();
      });
      if (loaded !== true) throw new Error('loadData did not complete under Stopwatch Web Lock');
      _setMainStorageBaseline(localStorage.getItem(STORAGE_KEY));
      _secondaryStorageBaselines[FOCUS_TIMER_KEY] = localStorage.getItem(FOCUS_TIMER_KEY);
      _secondaryStorageBaselines[FOCUS_SESSIONS_KEY] = localStorage.getItem(FOCUS_SESSIONS_KEY);
      _loadFocusTimer();
      _setMainStorageBaseline(localStorage.getItem(STORAGE_KEY));
      _mainStorageExternalChangeObserved = false;
      _focusTimerExternalConflict = false;
      _secondaryStorageConflicts = Object.create(null);
      const task = tasks.find(item => item.id === 7021);
      return _withStopwatchTransactionLock(async () => {
        const release = _acquireRollingRecoveryCheckpointHold(true);
        try {
        const tx = {
          version: 1, id: 'stopwatch-export-test-7021', taskId: task.id,
          previousActual: 5, targetActual: 8, minutesToAdd: 3, durationSec: 125,
          sessionStartAt: _focusTimer.sessionStartAt, mode: 'stopwatch', phase: 'work',
          clockAdjusted: false, elapsedRemainderMs: 0, createdAt: Date.now()
        };
        _focusTimer.pendingStopwatchTransaction = tx;
        if (!_saveFocusTimer()) throw new Error('could not persist pending journal');
        task.actual = 8;
        task.lastStopwatchTransactionId = tx.id;
        if (!saveData()) throw new Error('could not commit task with transaction marker');
        return tx.id;
        } finally { release(); }
      });
    });
    const result = await pageB.evaluate(async () => {
      window._mainStorageExternalChangeObserved = false;
      window._focusTimerExternalConflict = false;
      window._secondaryStorageConflicts = Object.create(null);
      const keys = Object.keys(localStorage).sort();
      const before = {};
      keys.forEach(key => { before[key] = localStorage.getItem(key); });
      let exportError = null;
      try { buildBackupObject(); } catch (error) { exportError = error.message; }
      const rollingQueued = _storeRollingRecoveryBackup('stale-window-test', 0);
      const rollingSaved = window._rollingRecoveryBackupPending
        ? await window._rollingRecoveryBackupPending : rollingQueued;
      const after = {};
      Object.keys(localStorage).sort().forEach(key => { after[key] = localStorage.getItem(key); });
      return {
        exportError, rollingSaved, rollingFailure: _rollingRecoveryBackupLastFailure,
        storageUnchanged: JSON.stringify(before) === JSON.stringify(after),
        pending: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')).pendingStopwatchTransaction
      };
    });
    assert.ok(result.exportError && /نافذة أخرى|تغير سجل المهام|تغيرت بيانات|معاملة Stopwatch معلقة/.test(result.exportError),
      JSON.stringify(result));
    assert.equal(result.rollingSaved, false);
    assert.equal(result.rollingFailure, 'external_storage_conflict');
    assert.equal(result.storageUnchanged, true);
    assert.equal(result.pending.id, pendingId);
    await context.close();
  } finally {
    if (browserInstance) await browserInstance.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('two same-origin pages cannot commit duplicate task-linked Stopwatch transactions', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const appUrl = 'http://127.0.0.1:' + server.address().port + '/';
  let browserInstance, context;
  const nodeDiagnostics = { pageA: [], pageB: [] };
  try {
    browserInstance = await chromium.launch({ headless: true });
    context = await browserInstance.newContext({ serviceWorkers: 'block' });
    const initial = JSON.parse(JSON.stringify(seed));
    initial.main.tasks = [{
      id: 7031, name: 'Concurrent stopwatch task', type: 'معرفية', status: 'pending',
      expected: 20, actual: 5, plannedDate: '2026-11-23', plannedTime: '',
      completedAt: null, createdAt: Date.now(), projectId: null, priority: null,
      recurrence: null, checklist: null
    }];
    initial.timer.taskId = 7031;
    initial.timer.baseElapsed = 125;
    initial.timer.sessionStartAt = Date.now() - 125000;

    async function setupPage(label) {
      const page = await context.newPage();
      page.on('console', message => {
        if (message.type() === 'error') nodeDiagnostics[label].push({
          type: 'console.error', text: message.text()
        });
      });
      page.on('pageerror', error => nodeDiagnostics[label].push({
        type: 'pageerror', text: error && error.stack ? error.stack : String(error)
      }));
      await page.addInitScript(({ windowLabel, seedValue, channelName }) => {
        const nativeGet = Storage.prototype.getItem;
        const nativeSet = Storage.prototype.setItem;
        const nativeRemove = Storage.prototype.removeItem;
        const nativeClear = Storage.prototype.clear;
        const tracked = new Set([
          'timeTasksApp_v1', 'timeTasksApp_focusTimer', 'timeTasksApp_focusSessions'
        ]);
        if (nativeGet.call(localStorage, 'timeTasksApp_v1') === null)
          nativeSet.call(localStorage, 'timeTasksApp_v1', JSON.stringify(seedValue.main));
        if (nativeGet.call(localStorage, 'timeTasksApp_focusTimer') === null)
          nativeSet.call(localStorage, 'timeTasksApp_focusTimer', JSON.stringify(seedValue.timer));
        if (nativeGet.call(localStorage, 'timeTasksApp_focusSessions') === null)
          nativeSet.call(localStorage, 'timeTasksApp_focusSessions', '[]');

        window.__stopwatchDiagnostic = {
          window: windowLabel, calls: [], storage: [], events: [], errors: [], wrapped: []
        };
        function summarize(value) {
          if (value === null || value === undefined || typeof value !== 'object') return value;
          const out = {};
          ['id','taskId','minutesToAdd','durationSec','mode','phase','sessionStartAt',
            'previousActual','targetActual','transactionId','baseElapsed'].forEach(key => {
            if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
          });
          if (value.snapshot && typeof value.snapshot === 'object') {
            out.snapshot = {};
            ['taskId','mode','phase','sessionStartAt','baseElapsed'].forEach(key => {
              if (Object.prototype.hasOwnProperty.call(value.snapshot, key))
                out.snapshot[key] = value.snapshot[key];
            });
          }
          return out;
        }
        Storage.prototype.getItem = function(key) {
          const value = nativeGet.call(this, key);
          if (tracked.has(String(key))) window.__stopwatchDiagnostic.storage.push({
            at: performance.now(), op: 'get', key: String(key), value
          });
          return value;
        };
        Storage.prototype.setItem = function(key, value) {
          const name = String(key);
          const before = tracked.has(name) ? nativeGet.call(this, key) : undefined;
          const result = nativeSet.call(this, key, value);
          if (tracked.has(name)) {
            const after = nativeGet.call(this, key);
            window.__stopwatchDiagnostic.storage.push({
              at: performance.now(), op: 'set', key: name, before,
              attempted: String(value), after, verified: after === String(value)
            });
          }
          return result;
        };
        Storage.prototype.removeItem = function(key) {
          const name = String(key);
          const before = tracked.has(name) ? nativeGet.call(this, key) : undefined;
          const result = nativeRemove.call(this, key);
          if (tracked.has(name)) {
            const after = nativeGet.call(this, key);
            window.__stopwatchDiagnostic.storage.push({
              at: performance.now(), op: 'remove', key: name, before,
              after, verified: after === null
            });
          }
          return result;
        };
        Storage.prototype.clear = function() {
          const before = {};
          tracked.forEach(key => { before[key] = nativeGet.call(this, key); });
          const result = nativeClear.call(this);
          window.__stopwatchDiagnostic.storage.push({
            at: performance.now(), op: 'clear', before,
            after: Object.fromEntries(Array.from(tracked).map(key => [key, nativeGet.call(this, key)]))
          });
          return result;
        };
        window.addEventListener('unhandledrejection', event => {
          window.__stopwatchDiagnostic.errors.push({
            at: performance.now(), type: 'unhandledrejection',
            reason: event.reason && event.reason.stack ? event.reason.stack : String(event.reason)
          });
        });
        window.addEventListener('storage', event => {
          if (tracked.has(String(event.key))) window.__stopwatchDiagnostic.events.push({
            at: performance.now(), type: 'storage', key: event.key,
            oldValue: event.oldValue, newValue: event.newValue
          });
        });
        const channel = new BroadcastChannel(channelName);
        window.__stopwatchDiagnosticChannel = channel;
        window.__stopwatchStartGate = new Promise(resolve => {
          channel.addEventListener('message', event => {
            if (event.data === 'start-stopwatch-commit') resolve();
          });
        });
        document.addEventListener('DOMContentLoaded', () => {
          const names = [
            '_commitFocusTaskSession', '_commitFocusTaskSessionLocked',
            'finishTimer', '_applyTimerFinish', '_applyStopwatchSave',
            '_saveFocusTimer', '_saveSessions', '_saveFocusSessions'
          ];
          names.forEach(name => {
            const original = window[name];
            if (typeof original !== 'function' || original.__stopwatchDiagnosticWrapped) return;
            const wrapped = function(...args) {
              const record = {
                window: windowLabel, method: name, startedAt: performance.now(),
                args: args.map(summarize), transactionId: null
              };
              args.forEach(arg => {
                if (!record.transactionId && arg && typeof arg === 'object')
                  record.transactionId = arg.id
                    || (arg.pendingStopwatchTransaction && arg.pendingStopwatchTransaction.id)
                    || (arg.snapshot && arg.snapshot.transactionId) || null;
              });
              window.__stopwatchDiagnostic.calls.push(record);
              try {
                const value = Reflect.apply(original, this, args);
                if (value && typeof value.then === 'function') {
                  return value.then(result => {
                    record.endedAt = performance.now();
                    record.result = summarize(result);
                    return result;
                  }, error => {
                    record.endedAt = performance.now();
                    record.error = error && error.stack ? error.stack : String(error);
                    throw error;
                  });
                }
                record.endedAt = performance.now();
                record.result = summarize(value);
                return value;
              } catch (error) {
                record.endedAt = performance.now();
                record.error = error && error.stack ? error.stack : String(error);
                throw error;
              }
            };
            wrapped.__stopwatchDiagnosticWrapped = true;
            window[name] = wrapped;
            window.__stopwatchDiagnostic.wrapped.push(name);
          });
          window.__stopwatchDiagnosticReady = true;
          window.__runStopwatchCommitAfterBarrier = async function() {
            window.__stopwatchAttemptWaiting = true;
            await window.__stopwatchStartGate;
            const task = tasks.find(item => item && item.id === 7031);
            const before = task ? task.actual : null;
            const value = await _applyStopwatchSave(125, task, 3);
            return {
              value, before, after: task ? task.actual : null,
              pending: !!_focusTimer.pendingStopwatchTransaction,
              recoveryRequired: storageRecoveryRequired
            };
          };
        }, { once: true });
      }, {
        windowLabel: label,
        seedValue: initial,
        channelName: 'stopwatch-duplicate-commit-diagnostics-7031'
      });
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      return page;
    }

    const pageA = await setupPage('pageA');
    const pageB = await setupPage('pageB');
    const pages = [pageA, pageB];
    await Promise.all(pages.map(page => page.waitForFunction(() =>
      window._appInitCompleted === true
        && typeof storageRecoveryRequired !== 'undefined'
        && storageRecoveryRequired === false
        && window._startupStopwatchRecoveryInFlight !== true
        && window._startupStopwatchRecoveryFailed !== true
        && window._mainStorageBaselineReady === true
        && window.__stopwatchDiagnosticReady === true
        && typeof window.__runStopwatchCommitAfterBarrier === 'function',
      null, { timeout: 20000 }
    )));
    const attempts = pages.map(page => page.evaluate(() => window.__runStopwatchCommitAfterBarrier()));
    await Promise.all(pages.map(page => page.waitForFunction(
      () => window.__stopwatchAttemptWaiting === true, null, { timeout: 10000 }
    )));
    await pageA.evaluate(() => window.__stopwatchDiagnosticChannel.postMessage('start-stopwatch-commit'));
    const settled = await Promise.allSettled(attempts);
    const pageDiagnostics = await Promise.all(pages.map(page => page.evaluate(() => ({
      calls: window.__stopwatchDiagnostic.calls,
      storage: window.__stopwatchDiagnostic.storage,
      events: window.__stopwatchDiagnostic.events,
      errors: window.__stopwatchDiagnostic.errors,
      wrapped: window.__stopwatchDiagnostic.wrapped
    }))));
    const diagnostics = {
      pageResults: settled.map(item => item.status === 'fulfilled'
        ? { status: item.status, value: item.value }
        : { status: item.status, reason: item.reason && item.reason.message ? item.reason.message : String(item.reason) }),
      pages: pageDiagnostics,
      node: nodeDiagnostics
    };
    const successful = settled.filter(item => item.status === 'fulfilled'
      && item.value && item.value.value === true);
    const rejected = settled.filter(item => item.status === 'fulfilled'
      && item.value && item.value.value === false);
    assert.equal(successful.length, 1,
      'exactly one page must commit; diagnostics=' + JSON.stringify(diagnostics));
    assert.equal(rejected.length, 1,
      'the stale competing page must return false; diagnostics=' + JSON.stringify(diagnostics));

    const verifyPage = await context.newPage();
    await verifyPage.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await verifyPage.waitForFunction(() =>
      window._appInitCompleted === true && storageRecoveryRequired === false
        && window._startupStopwatchRecoveryInFlight !== true
        && window._startupStopwatchRecoveryFailed !== true,
      null, { timeout: 20000 }
    );
    const state = await verifyPage.evaluate(() => {
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      const task = main && main.tasks.find(item => item.id === 7031);
      return { task, timer, linked: sessions.filter(item => item.taskId === 7031) };
    });
    assert.ok(state.task, 'task must remain in storage; diagnostics=' + JSON.stringify(diagnostics));
    assert.equal(state.task.actual, 8, 'minutes must be committed exactly once; diagnostics=' + JSON.stringify(diagnostics));
    assert.equal(typeof state.task.lastStopwatchTransactionId, 'string');
    assert.equal(state.timer.pendingStopwatchTransaction, null);
    assert.equal(state.linked.length, 1);
    assert.equal(state.linked[0].transactionId, state.task.lastStopwatchTransactionId);
    assert.equal(state.linked[0].taskId, 7031);
    assert.equal(state.linked[0].mode, 'stopwatch');
    assert.equal(state.linked[0].phase, 'work');
    assert.equal(state.linked[0].durationSec, 125);
    assert.equal(state.linked[0].startedAt, new Date(initial.timer.sessionStartAt).toISOString());
  } finally {
    if (context) await context.close().catch(() => {});
    if (browserInstance) await browserInstance.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('non-owner page cannot write main, timer or Pomodoro sessions while a Stopwatch journal is locked elsewhere', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const appUrl = 'http://127.0.0.1:' + server.address().port + '/';
  let browserInstance;
  try {
    browserInstance = await chromium.launch({ headless: true });
    const context = await browserInstance.newContext({ serviceWorkers: 'block' });
    const initial = JSON.parse(JSON.stringify(seed));
    initial.main.tasks = [{
      id: 7041, name: 'Lock ownership task', type: 'معرفية', status: 'pending',
      expected: 20, actual: 5, plannedDate: '2026-11-23', plannedTime: '',
      completedAt: null, createdAt: Date.now(), projectId: null, priority: null,
      recurrence: null, checklist: null
    }];
    initial.timer.taskId = 7041;
    initial.timer.baseElapsed = 125;
    initial.timer.sessionStartAt = Date.now() - 125000;
    await context.addInitScript((value) => {
      if (localStorage.getItem('timeTasksApp_v1') === null)
        localStorage.setItem('timeTasksApp_v1', JSON.stringify(value.main));
      if (localStorage.getItem('timeTasksApp_focusTimer') === null)
        localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(value.timer));
      if (localStorage.getItem('timeTasksApp_focusSessions') === null)
        localStorage.setItem('timeTasksApp_focusSessions', '[]');
    }, initial);
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await Promise.all([pageA.goto(appUrl), pageB.goto(appUrl)]);
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => window._mainStorageBaselineReady === true
        && typeof window._pendingStopwatchWriteAllowed === 'function',
      null, { timeout: 20000 }
    )));
    const tx = {
      version: 1, id: 'stopwatch-lock-owner-7041', taskId: 7041,
      previousActual: 5, targetActual: 8, minutesToAdd: 3, durationSec: 125,
      sessionStartAt: initial.timer.sessionStartAt, mode: 'stopwatch', phase: 'work',
      clockAdjusted: false, elapsedRemainderMs: 0, createdAt: Date.now()
    };

    await pageA.evaluate(async transaction => {
      _mainStorageExternalChangeObserved = false;
      _focusTimerExternalConflict = false;
      _secondaryStorageConflicts = Object.create(null);
      window._ownerLockReady = false;
      window._ownerLockRelease = null;
      window._ownerLockPromise = _withStopwatchTransactionLock(async () => {
        const releaseHold = _acquireRollingRecoveryCheckpointHold(true);
        try {
          _focusTimer.pendingStopwatchTransaction = transaction;
          if (!_saveFocusTimer()) throw new Error('lock owner could not persist its journal');
          window._ownerLockReady = true;
          await new Promise(resolve => { window._ownerLockRelease = resolve; });
        } finally { releaseHold(); }
      });
    }, tx);
    await pageA.waitForFunction(() => window._ownerLockReady === true, null, { timeout: 5000 });

    const before = await pageB.evaluate(transaction => {
      _focusTimer.pendingStopwatchTransaction = transaction;
      _mainStorageBaselineRaw = localStorage.getItem(STORAGE_KEY);
      _mainStorageBaselineReady = true;
      _mainStorageExternalChangeObserved = false;
      _focusTimerExternalConflict = false;
      _secondaryStorageConflicts = Object.create(null);
      _secondaryStorageBaselines[FOCUS_TIMER_KEY] = localStorage.getItem(FOCUS_TIMER_KEY);
      _secondaryStorageBaselines[FOCUS_SESSIONS_KEY] = localStorage.getItem(FOCUS_SESSIONS_KEY);
      const pomodoroSession = {
        id: 9001, mode: 'pomodoro', phase: 'work', taskId: null, taskName: '',
        startedAt: new Date(Date.now() - 60000).toISOString(),
        endedAt: new Date().toISOString(), durationSec: 60, completed: true
      };
      const beforeMain = localStorage.getItem(STORAGE_KEY);
      const beforeTimer = localStorage.getItem(FOCUS_TIMER_KEY);
      const beforeSessions = localStorage.getItem(FOCUS_SESSIONS_KEY);
      return {
        sameId: _focusTimer.pendingStopwatchTransaction.id,
        allowed: _pendingStopwatchWriteAllowed(),
        mainWrite: saveData(),
        timerWrite: _saveFocusTimer(),
        pomodoroWrite: _saveSessions([pomodoroSession]),
        mainUnchanged: beforeMain === localStorage.getItem(STORAGE_KEY),
        timerUnchanged: beforeTimer === localStorage.getItem(FOCUS_TIMER_KEY),
        sessionsUnchanged: beforeSessions === localStorage.getItem(FOCUS_SESSIONS_KEY)
      };
    }, tx);
    assert.equal(before.sameId, tx.id);
    assert.equal(before.allowed, false);
    assert.equal(before.mainWrite, false);
    assert.equal(before.timerWrite, false);
    assert.equal(before.pomodoroWrite, false);
    assert.equal(before.mainUnchanged, true);
    assert.equal(before.timerUnchanged, true);
    assert.equal(before.sessionsUnchanged, true);

    await pageB.evaluate(() => {
      window._recoveryResult = null;
      window._recoveryAlerts = [];
      window._recoveryFlagsBefore = {
        storageRecoveryRequired: storageRecoveryRequired,
        mainExternal: _mainStorageExternalChangeObserved,
        timerExternal: _focusTimerExternalConflict
      };
      window.showAlertModal = function() { window._recoveryAlerts.push(Array.from(arguments)); };
      window._recoveryPromise = _withStopwatchTransactionLock(function() {
        window._recoveryResult = _pendingStopwatchWriteAllowed()
          ? _recoverPendingStopwatchSave(false) : false;
        return window._recoveryResult;
      });
    });
    assert.equal(await pageB.evaluate(() => window._recoveryResult), null,
      'the second page must wait until the owner releases the exclusive lock');
    await pageA.evaluate(() => window._ownerLockRelease());
    await pageA.evaluate(() => window._ownerLockPromise);
    const recoveryOutcome = await pageB.evaluate(async () => ({
      result: await window._recoveryPromise,
      flagsBefore: window._recoveryFlagsBefore,
      flagsAfter: {
        storageRecoveryRequired: storageRecoveryRequired,
        mainExternal: _mainStorageExternalChangeObserved,
        timerExternal: _focusTimerExternalConflict,
        lockDepth: _stopwatchTransactionLockDepth
      },
      alerts: window._recoveryAlerts
    }));
    assert.equal(recoveryOutcome.result, true, JSON.stringify(recoveryOutcome));
    const recovered = await pageB.evaluate(() => ({
      task: JSON.parse(localStorage.getItem(STORAGE_KEY)).tasks.find(item => item.id === 7041),
      sessions: JSON.parse(localStorage.getItem(FOCUS_SESSIONS_KEY) || '[]')
        .filter(item => item.taskId === 7041),
      timer: JSON.parse(localStorage.getItem(FOCUS_TIMER_KEY))
    }));
    assert.equal(recovered.task.actual, 8);
    assert.equal(recovered.task.lastStopwatchTransactionId, tx.id);
    assert.equal(recovered.sessions.length, 1);
    assert.equal(recovered.sessions[0].transactionId, tx.id);
    assert.equal(recovered.timer.pendingStopwatchTransaction, null);
    await context.close();
  } finally {
    if (browserInstance) await browserInstance.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a rejected rolling snapshot is rolled back and cannot outrank the previous valid slot', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const appUrl = 'http://127.0.0.1:' + server.address().port + '/';
  let browserInstance;
  try {
    browserInstance = await chromium.launch({ headless: true });
    const context = await browserInstance.newContext({ serviceWorkers: 'block' });
    await context.addInitScript((initial) => {
      if (localStorage.getItem('timeTasksApp_v1') === null)
        localStorage.setItem('timeTasksApp_v1', JSON.stringify(initial.main));
      if (localStorage.getItem('timeTasksApp_focusTimer') === null)
        localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(initial.timer));
      if (localStorage.getItem('timeTasksApp_focusSessions') === null)
        localStorage.setItem('timeTasksApp_focusSessions', '[]');
    }, seed);
    const page = await context.newPage();
    await page.goto(appUrl);
    await page.waitForFunction(() => window._mainStorageBaselineReady === true
      && typeof window._storeRollingRecoveryBackupLocked === 'function', null, { timeout: 20000 });

    const outcome = await page.evaluate(async () => _withStopwatchTransactionLock(function() {
      const initialSaved = _storeRollingRecoveryBackupLocked('initial-valid-slot', 0);
      if (!initialSaved) throw new Error('could not create a previous valid rolling checkpoint');
      const oldA = localStorage.getItem(ROLLING_BACKUP_A_KEY);
      const oldB = localStorage.getItem(ROLLING_BACKUP_B_KEY);
      const originalSetItem = Storage.prototype.setItem;
      let injected = false;
      Storage.prototype.setItem = function(key, value) {
        originalSetItem.call(this, key, value);
        if (!injected && (key === ROLLING_BACKUP_A_KEY || key === ROLLING_BACKUP_B_KEY)) {
          injected = true;
          const timer = JSON.parse(localStorage.getItem(FOCUS_TIMER_KEY));
          timer.pendingStopwatchTransaction = {
            version: 1, id: 'stopwatch-appeared-during-backup', taskId: 99,
            previousActual: 1, targetActual: 2, minutesToAdd: 1, durationSec: 60,
            sessionStartAt: Date.now() - 60000, mode: 'stopwatch', phase: 'work',
            clockAdjusted: false, elapsedRemainderMs: 0, createdAt: Date.now()
          };
          originalSetItem.call(this, FOCUS_TIMER_KEY, JSON.stringify(timer));
        }
      };
      let saved = false;
      try { saved = _storeRollingRecoveryBackupLocked('interleaved-final-check', 0); }
      finally { Storage.prototype.setItem = originalSetItem; }
      const latest = _getLatestRollingRecoveryBackup();
      return {
        saved,
        failure: _rollingRecoveryBackupLastFailure,
        injected,
        oldA, oldB,
        currentA: localStorage.getItem(ROLLING_BACKUP_A_KEY),
        currentB: localStorage.getItem(ROLLING_BACKUP_B_KEY),
        latestSequence: latest && latest.record ? latest.record.sequence : null,
        priorMaxSequence: Math.max(
          _parseRollingRecoveryBackup(oldA)?.sequence || 0,
          _parseRollingRecoveryBackup(oldB)?.sequence || 0
        ),
        timerHasPending: !!JSON.parse(localStorage.getItem(FOCUS_TIMER_KEY)).pendingStopwatchTransaction
      };
    }));
    assert.equal(outcome.saved, false);
    assert.equal(outcome.failure, 'snapshot_conflict');
    assert.equal(outcome.injected, true);
    assert.equal(outcome.currentA, outcome.oldA);
    assert.equal(outcome.currentB, outcome.oldB);
    assert.equal(outcome.latestSequence, outcome.priorMaxSequence);
    assert.equal(outcome.timerHasPending, true);
    await context.close();
  } finally {
    if (browserInstance) await browserInstance.close();
    await new Promise(resolve => server.close(resolve));
  }
});


async function withBrowserPages(run) {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browserInstance;
  try {
    browserInstance = await chromium.launch({ headless: true });
    const context = await browserInstance.newContext({ serviceWorkers: 'block' });
    await context.addInitScript((initial) => {
      if (localStorage.getItem('timeTasksApp_v1') === null)
        localStorage.setItem('timeTasksApp_v1', JSON.stringify(initial.main));
      if (localStorage.getItem('timeTasksApp_focusTimer') === null)
        localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(initial.timer));
      if (localStorage.getItem('timeTasksApp_focusSessions') === null)
        localStorage.setItem('timeTasksApp_focusSessions', '[]');
    }, seed);
    const appUrl = 'http://127.0.0.1:' + server.address().port + '/';
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await Promise.all([pageA.goto(appUrl), pageB.goto(appUrl)]);
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => window._mainStorageBaselineReady === true
        && typeof window._withStopwatchTransactionLock === 'function',
      null, { timeout: 20000 }
    )));
    await run({ pageA, pageB, context });
    await context.close();
  } finally {
    if (browserInstance) await browserInstance.close();
    await new Promise(resolve => server.close(resolve));
  }
}

test('real Chromium pages release Web Lock after owner callback throws synchronously', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  await withBrowserPages(async ({ pageA, pageB }) => {
    await pageA.evaluate(() => {
      window.__ownerFailure = _withStopwatchTransactionLock(() => {
        window.__ownerDepthDuringCallback = _stopwatchTransactionLockDepth;
        throw new Error('chromium synchronous owner failure');
      }).then(() => 'unexpected-success', error => error.message);
    });
    assert.equal(await pageA.evaluate(() => window.__ownerFailure),
      'chromium synchronous owner failure');
    const waiter = await pageB.evaluate(async () => _withStopwatchTransactionLock(() => ({
      acquired: true,
      depth: _stopwatchTransactionLockDepth
    })));
    assert.equal(waiter.acquired, true, 'the second real page must acquire the released browser lock');
    assert.equal(waiter.depth, 1);
    assert.equal(await pageA.evaluate(() => _stopwatchTransactionLockDepth), 0,
      'the failed owner page must not retain its local ownership depth');
    assert.equal(await pageB.evaluate(() => _stopwatchTransactionLockDepth), 0);
  });
});

test('real Chromium pages release Web Lock after owner callback Promise rejects', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  await withBrowserPages(async ({ pageA, pageB }) => {
    await pageA.evaluate(() => {
      window.__ownerFailure = _withStopwatchTransactionLock(() => new Promise((_resolve, reject) => {
        window.__rejectOwnerLock = () => reject(new Error('chromium owner Promise rejection'));
      })).then(() => 'unexpected-success', error => error.message);
    });
    await pageA.waitForFunction(() => typeof window.__rejectOwnerLock === 'function',
      null, { timeout: 5000 });
    await pageB.evaluate(() => {
      window.__waiterSettled = false;
      window.__waiterPromise = _withStopwatchTransactionLock(() => ({
        acquired: true,
        depth: _stopwatchTransactionLockDepth
      })).then(value => {
        window.__waiterSettled = true;
        return value;
      });
    });
    assert.equal(await pageB.evaluate(() => window.__waiterSettled), false,
      'the second page must wait while the first page owns the exclusive lock');
    await pageA.evaluate(() => window.__rejectOwnerLock());
    assert.equal(await pageA.evaluate(() => window.__ownerFailure),
      'chromium owner Promise rejection');
    const waiter = await pageB.evaluate(() => window.__waiterPromise);
    assert.equal(waiter.acquired, true);
    assert.equal(waiter.depth, 1);
    assert.equal(await pageA.evaluate(() => _stopwatchTransactionLockDepth), 0,
      'the rejected owner page must clear its ownership state before the waiter proceeds');
    assert.equal(await pageB.evaluate(() => _stopwatchTransactionLockDepth), 0);
  });
});


test('two real Chromium pages serialize concurrent Reset transactions and both report success', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  await withBrowserPages(async ({ pageA, pageB }) => {
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => window._appInitCompleted === true && window._rollingRecoveryBackupPending === null,
      null, { timeout: 20000 }
    )));
    const generationBefore = await pageA.evaluate(() => _readPersistedRollingBackupGeneration());
    const retainedSettingsRaw = JSON.stringify({ workMin: 35, shortMin: 7, longMin: 20 });
    const retainedNotificationsRaw = JSON.stringify({ enabled: true, permission: 'granted' });
    await pageA.evaluate(({ settingsRaw, notificationsRaw }) => {
      localStorage.setItem(FOCUS_SETTINGS_KEY, settingsRaw);
      localStorage.setItem(NOTIFICATIONS_KEY, notificationsRaw);
    }, { settingsRaw: retainedSettingsRaw, notificationsRaw: retainedNotificationsRaw });
    await Promise.all([pageA, pageB].map(page => page.evaluate(() => {
      _focusTimer.mode = 'stopwatch';
      _focusTimer.running = true;
      _focusTimer.baseElapsed = 120;
      _focusTimer.startedAt = Date.now() - 120000;
      _focusTimer.taskId = 7041;
      _focusTimer.sessionStartAt = Date.now() - 120000;
      _focusTimer.pendingStopwatchTransaction = { id: 'stale-reset-sentinel' };
      _focusTimerExternalConflict = true;
      _mainStorageExternalChangeObserved = true;
      _secondaryStorageConflicts[FOCUS_TIMER_KEY] = true;
      _sessionsCache = [{ id: 'stale-session-cache' }];
    })));
    await pageA.evaluate(() => {
      window.__resetLockAcquired = false;
      window.__releaseResetLock = null;
      window.__resetLockHolder = navigator.locks.request(
        'timeTasksApp-stopwatch-transaction', { mode: 'exclusive' }, async () => {
          window.__resetLockAcquired = true;
          await new Promise(resolve => { window.__releaseResetLock = resolve; });
        }
      );
    });
    await pageA.waitForFunction(() => window.__resetLockAcquired === true,
      null, { timeout: 5000 });

    await pageA.evaluate(() => { window.__resetPromiseA = _executeResetAllTransaction(); });
    await pageB.evaluate(() => { window.__resetPromiseB = _executeResetAllTransaction(); });
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => window._resetInFlight === true,
      null, { timeout: 5000 }
    )));
    await pageA.waitForFunction(async () => {
      const state = await navigator.locks.query();
      return (state.pending || []).filter(lock =>
        lock.name === 'timeTasksApp-stopwatch-transaction'
      ).length >= 2;
    }, null, { timeout: 5000 });

    const started = await Promise.all([
      pageA.evaluate(() => ({
        promise: !!window.__resetPromiseA && typeof window.__resetPromiseA.then === 'function',
        inFlight: _resetInFlight
      })),
      pageB.evaluate(() => ({
        promise: !!window.__resetPromiseB && typeof window.__resetPromiseB.then === 'function',
        inFlight: _resetInFlight
      }))
    ]);
    assert.deepEqual(started, [
      { promise: true, inFlight: true },
      { promise: true, inFlight: true }
    ], 'both Reset operations must have started before the shared lock is released');

    await pageA.evaluate(() => window.__releaseResetLock());
    await pageA.evaluate(() => window.__resetLockHolder);
    const results = await Promise.all([
      pageA.evaluate(() => window.__resetPromiseA),
      pageB.evaluate(() => window.__resetPromiseB)
    ]);
    assert.deepEqual(results, [true, true],
      'both reset operations must resolve explicitly to true');

    const finalState = await pageA.evaluate(() => ({
      generation: _readPersistedRollingBackupGeneration(),
      marker: localStorage.getItem(RESET_IN_PROGRESS_KEY),
      main: JSON.parse(localStorage.getItem(STORAGE_KEY)),
      resetInFlight: _resetInFlight,
      timer: {
        mode: _focusTimer.mode,
        running: _focusTimer.running,
        baseElapsed: _focusTimer.baseElapsed,
        taskId: _focusTimer.taskId,
        sessionStartAt: _focusTimer.sessionStartAt,
        pending: _focusTimer.pendingStopwatchTransaction
      },
      externalMain: _mainStorageExternalChangeObserved,
      externalTimer: _focusTimerExternalConflict,
      timerConflict: !!_secondaryStorageConflicts[FOCUS_TIMER_KEY],
      sessionsCache: _sessionsCache,
      focusSettingsRaw: localStorage.getItem(FOCUS_SETTINGS_KEY),
      focusSettingsBaseline: _secondaryStorageBaselines[FOCUS_SETTINGS_KEY],
      focusSettingsWritable: _secondaryStorageWriteAllowed(FOCUS_SETTINGS_KEY),
      notificationsRaw: localStorage.getItem(NOTIFICATIONS_KEY),
      notificationsBaseline: _secondaryStorageBaselines[NOTIFICATIONS_KEY],
      notificationsWritable: _secondaryStorageWriteAllowed(NOTIFICATIONS_KEY),
      focusWorkSeconds: POMODORO_WORK_SEC,
      focusShortBreakSeconds: POMODORO_SHORT_BREAK_SEC,
      focusLongBreakSeconds: POMODORO_LONG_BREAK_SEC
    }));
    const otherWindowState = await pageB.evaluate(() => ({
      resetInFlight: _resetInFlight,
      timer: {
        mode: _focusTimer.mode,
        running: _focusTimer.running,
        baseElapsed: _focusTimer.baseElapsed,
        taskId: _focusTimer.taskId,
        pending: _focusTimer.pendingStopwatchTransaction
      },
      externalMain: _mainStorageExternalChangeObserved,
      externalTimer: _focusTimerExternalConflict,
      timerConflict: !!_secondaryStorageConflicts[FOCUS_TIMER_KEY],
      timerWriteAllowed: _secondaryStorageWriteAllowed(FOCUS_TIMER_KEY)
    }));
    assert.equal(finalState.generation, generationBefore + 2,
      'each completed reset must advance the shared generation exactly once');
    assert.equal(finalState.marker, null, 'the durable reset marker must be removed');
    assert.deepEqual(finalState.main.tasks, []);
    assert.deepEqual(finalState.main.dailyLogs, []);
    assert.equal(finalState.resetInFlight, false);
    assert.deepEqual(finalState.timer, {
      mode: 'pomodoro',
      running: false,
      baseElapsed: 0,
      taskId: null,
      sessionStartAt: null,
      pending: null
    }, 'the active window timer state must be reset in memory');
    assert.equal(finalState.externalMain, false);
    assert.equal(finalState.externalTimer, false);
    assert.equal(finalState.timerConflict, false);
    assert.ok(finalState.sessionsCache === null
      || (Array.isArray(finalState.sessionsCache) && finalState.sessionsCache.length === 0),
      'the old session-cache entries must be cleared; a fresh empty cache is valid');
    assert.equal(finalState.focusSettingsRaw, retainedSettingsRaw);
    assert.equal(finalState.focusSettingsBaseline, retainedSettingsRaw);
    assert.equal(finalState.focusSettingsWritable, true,
      'preserved focus settings must have a synchronized secondary baseline after Reset');
    assert.equal(finalState.notificationsRaw, retainedNotificationsRaw);
    assert.equal(finalState.notificationsBaseline, retainedNotificationsRaw);
    assert.equal(finalState.notificationsWritable, true,
      'preserved notification settings must remain writable after Reset');
    assert.equal(finalState.focusWorkSeconds, 35 * 60);
    assert.equal(finalState.focusShortBreakSeconds, 7 * 60);
    assert.equal(finalState.focusLongBreakSeconds, 20 * 60);
    assert.equal(otherWindowState.resetInFlight, false);
    assert.deepEqual(otherWindowState.timer, {
      mode: 'pomodoro',
      running: false,
      baseElapsed: 0,
      taskId: null,
      pending: null
    }, 'the second reset window must also clear stale in-memory timer state');
    assert.equal(otherWindowState.externalMain, false);
    if (otherWindowState.externalTimer) {
      // A late cross-window storage event is a new conflict, not the stale
      // pre-reset flag. It must keep the secondary timer write gate closed.
      assert.equal(otherWindowState.timerConflict, true);
      assert.equal(otherWindowState.timerWriteAllowed, false);
    } else {
      assert.equal(otherWindowState.timerConflict, false);
      assert.equal(otherWindowState.timerWriteAllowed, true);
    }
  });
});

test('retryStorageRecovery keeps writes blocked while queued and after injected cleanup failure', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  await withBrowserPages(async ({ pageA, pageB }) => {
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => window._appInitCompleted === true && window._rollingRecoveryBackupPending === null,
      null, { timeout: 20000 }
    )));
    const outcome = await pageA.evaluate(async () => {
      const originalReload = _reloadAfterVerifiedOperation;
      _reloadAfterVerifiedOperation = function() {};
      let holder = null;
      let originalRemove = null;
      try {
        const emptyMain = JSON.stringify(buildEmptyV2());
        const generationBefore = _readPersistedRollingBackupGeneration();
        localStorage.setItem(RESET_IN_PROGRESS_KEY, JSON.stringify({
          version: 1,
          main: emptyMain,
          generation: generationBefore + 1
        }));
        localStorage.setItem(THOUGHTS_KEY,
          '[{"id":1,"text":"must be removed","createdAt":"2026-01-01T00:00:00Z"}]');
        storageRecoveryRequired = true;

        let releaseHolder;
        let acquiredHolder;
        const acquired = new Promise(resolve => { acquiredHolder = resolve; });
        const hold = new Promise(resolve => { releaseHolder = resolve; });
        holder = navigator.locks.request(
          'timeTasksApp-stopwatch-transaction', { mode: 'exclusive' }, async () => {
            acquiredHolder();
            await hold;
          }
        );
        await acquired;

        const retryPromise = retryStorageRecovery();
        const pendingPromise = _retryResetRecoveryPromise;
        const lockStateWhileHeld = await navigator.locks.query();
        const waitingState = {
          hasPromise: !!pendingPromise && typeof pendingPromise.then === 'function',
          retryInFlight: _resetRecoveryInFlight,
          recoveryRequired: storageRecoveryRequired,
          writesAllowed: _storageWriteAllowed(),
          saveResult: saveData(),
          markerStillPresent: localStorage.getItem(RESET_IN_PROGRESS_KEY) !== null,
          thoughtsStillPresent: localStorage.getItem(THOUGHTS_KEY) !== null,
          pendingLockCount: (lockStateWhileHeld.pending || []).filter(lock =>
            lock.name === 'timeTasksApp-stopwatch-transaction'
          ).length,
          mainUnchanged: localStorage.getItem(STORAGE_KEY) !== null
        };
        releaseHolder();
        await holder;
        const recovered = await retryPromise;
        const successState = {
          recovered,
          retryInFlight: _resetRecoveryInFlight,
          recoveryRequired: storageRecoveryRequired,
          marker: localStorage.getItem(RESET_IN_PROGRESS_KEY),
          thoughts: localStorage.getItem(THOUGHTS_KEY),
          generation: _readPersistedRollingBackupGeneration()
        };

        const nextGeneration = _readPersistedRollingBackupGeneration();
        localStorage.setItem(RESET_IN_PROGRESS_KEY, JSON.stringify({
          version: 1,
          main: emptyMain,
          generation: nextGeneration + 1
        }));
        localStorage.setItem(THOUGHTS_KEY,
          '[{"id":2,"text":"retain marker on failure","createdAt":"2026-01-01T00:00:00Z"}]');
        // Simulate a stale tab: the durable marker is visible, but this
        // window has not yet received/processed the recovery-state update.
        storageRecoveryRequired = false;
        const staleWindowWriteBlocked = _storageWriteAllowed() === false;
        originalRemove = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function(key) {
          if (String(key) === THOUGHTS_KEY) throw new Error('INJECTED_REMOVE_FAILURE');
          return originalRemove.call(this, key);
        };
        let failedRetry;
        try {
          failedRetry = await retryStorageRecovery();
        } finally {
          Storage.prototype.removeItem = originalRemove;
          originalRemove = null;
        }
        const failureState = {
          result: failedRetry,
          staleWindowWriteBlocked,
          retryInFlight: _resetRecoveryInFlight,
          recoveryRequired: storageRecoveryRequired,
          markerPresent: localStorage.getItem(RESET_IN_PROGRESS_KEY) !== null
        };

        // The fixture is isolated to this browser context; clean it after the
        // assertions have captured the intentionally failed recovery state.
        const cleanup = await _recoverInterruptedResetWithLock({ keepRecoveryLock: false });
        if (cleanup) {
          storageRecoveryRequired = false;
          loadData();
          _captureMainStorageBaseline();
        }
        return { waitingState, successState, failureState, cleanup };
      } finally {
        if (originalRemove) Storage.prototype.removeItem = originalRemove;
        _reloadAfterVerifiedOperation = originalReload;
      }
    });

    assert.equal(outcome.waitingState.hasPromise, true);
    assert.equal(outcome.waitingState.retryInFlight, true,
      'retry must set its in-flight guard before requesting the lock');
    assert.equal(outcome.waitingState.recoveryRequired, true);
    assert.equal(outcome.waitingState.writesAllowed, false);
    assert.equal(outcome.waitingState.saveResult, false);
    assert.equal(outcome.waitingState.markerStillPresent, true);
    assert.equal(outcome.waitingState.thoughtsStillPresent, true);
    assert.ok(outcome.waitingState.pendingLockCount >= 1,
      'retry must be queued behind the held Web Lock rather than recovering outside it');
    assert.equal(outcome.waitingState.mainUnchanged, true);
    assert.equal(outcome.successState.recovered, true);
    assert.equal(outcome.successState.retryInFlight, false);
    assert.equal(outcome.successState.recoveryRequired, false);
    assert.equal(outcome.successState.marker, null);
    assert.equal(outcome.successState.thoughts, null);
    assert.equal(outcome.failureState.staleWindowWriteBlocked, true,
      'the durable marker must block writes even before a stale window sets its memory flag');
    assert.equal(outcome.failureState.result, false);
    assert.equal(outcome.failureState.retryInFlight, false);
    assert.equal(outcome.failureState.recoveryRequired, true);
    assert.equal(outcome.failureState.markerPresent, true,
      'a failed delete must retain the durable marker and write protection');
    assert.equal(outcome.cleanup, true);
  });
});

test('startup reset recovery waits for the shared lock and makes an older queued backup callback inert', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  await withBrowserPages(async ({ pageA, pageB, context }) => {
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => window._appInitCompleted === true && window._rollingRecoveryBackupPending === null,
      null, { timeout: 20000 }
    )));
    await pageA.waitForFunction(
      () => window._appInitCompleted === true && window._rollingRecoveryBackupPending === null,
      null, { timeout: 20000 }
    );
    const generationBefore = await pageA.evaluate(() => _readPersistedRollingBackupGeneration());
    await pageA.evaluate(() => {
      window.__startupLockAcquired = false;
      window.__releaseStartupLock = null;
      window.__startupLockHolder = navigator.locks.request(
        'timeTasksApp-stopwatch-transaction', { mode: 'exclusive' }, async () => {
          window.__startupLockAcquired = true;
          await new Promise(resolve => { window.__releaseStartupLock = resolve; });
        }
      );
    });
    await pageA.waitForFunction(() => window.__startupLockAcquired === true,
      null, { timeout: 5000 });

    await pageA.evaluate(() => {
      const current = _readPersistedRollingBackupGeneration();
      localStorage.setItem(RESET_IN_PROGRESS_KEY, JSON.stringify({
        version: 1,
        main: JSON.stringify(buildEmptyV2()),
        generation: current + 1
      }));
    });
    const startupPage = await context.newPage();
    const appUrl = await pageA.evaluate(() => location.href);
    await startupPage.goto(appUrl);
    await startupPage.waitForFunction(() => _startupResetRecoveryInFlight === true,
      null, { timeout: 10000 });
    await pageA.waitForFunction(async () => {
      const state = await navigator.locks.query();
      return (state.pending || []).some(lock =>
        lock.name === 'timeTasksApp-stopwatch-transaction'
      );
    }, null, { timeout: 5000 });
    const startupWaiting = await startupPage.evaluate(() => ({
      recoveryInFlight: _startupResetRecoveryInFlight,
      writesAllowed: _storageWriteAllowed(),
      appInitCompleted: _appInitCompleted
    }));
    assert.equal(startupWaiting.recoveryInFlight, true);
    assert.equal(startupWaiting.writesAllowed, false);
    assert.equal(startupWaiting.appInitCompleted, false,
      'normal application initialization must wait for reset recovery');

    await pageA.evaluate(() => {
      _storeRollingRecoveryBackup('queued-before-startup-reset-recovery', 0);
      if (!_rollingRecoveryBackupPending
          || typeof _rollingRecoveryBackupPending.then !== 'function') {
        throw new Error('Expected an older rolling-backup request queued behind the lock');
      }
      // These sentinels are installed after queueing. A stale callback must
      // not clear or overwrite them when it resumes after the reset generation.
      _rollingRecoveryBackupLastFailure = 'STALE_CALLBACK_SENTINEL';
      _rollingRecoveryBackupStale = false;
    });
    await pageA.evaluate(() => window.__releaseStartupLock());
    await pageA.evaluate(() => window.__startupLockHolder);
    const startupRecovered = await startupPage.evaluate(() => _startupResetRecoveryPromise);
    await startupPage.waitForFunction(() => _appInitCompleted === true,
      null, { timeout: 20000 });
    await pageA.waitForFunction(() => _rollingRecoveryBackupPending === null,
      null, { timeout: 10000 });

    const recoveredState = await startupPage.evaluate(() => ({
      recoveryRequired: storageRecoveryRequired,
      marker: localStorage.getItem(RESET_IN_PROGRESS_KEY),
      generation: _readPersistedRollingBackupGeneration(),
      main: JSON.parse(localStorage.getItem(STORAGE_KEY)).tasks
    }));
    const staleCallbackState = await pageA.evaluate(() => ({
      lastFailure: _rollingRecoveryBackupLastFailure,
      stale: _rollingRecoveryBackupStale
    }));
    assert.equal(startupRecovered, true);
    assert.equal(recoveredState.recoveryRequired, false);
    assert.equal(recoveredState.marker, null);
    assert.equal(recoveredState.generation, generationBefore + 1);
    assert.deepEqual(recoveredState.main, []);
    assert.equal(staleCallbackState.lastFailure, 'STALE_CALLBACK_SENTINEL');
    assert.equal(staleCallbackState.stale, false);
    await startupPage.close();
  });
});

test('Reset uses a documented best-effort path when Web Locks is unavailable', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  await withBrowserPages(async ({ pageA, pageB }) => {
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => window._appInitCompleted === true && window._rollingRecoveryBackupPending === null,
      null, { timeout: 20000 }
    )));
    await pageB.close();
    const state = await pageA.evaluate(async () => {
      const generationBefore = _readPersistedRollingBackupGeneration();
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: undefined
      });
      const result = await _executeResetAllTransaction();
      return {
        result,
        generationBefore,
        generationAfter: _readPersistedRollingBackupGeneration(),
        marker: localStorage.getItem(RESET_IN_PROGRESS_KEY),
        main: JSON.parse(localStorage.getItem(STORAGE_KEY)),
        resetInFlight: _resetInFlight,
        recoveryRequired: storageRecoveryRequired
      };
    });
    assert.equal(state.result, true);
    assert.equal(state.generationAfter, state.generationBefore + 1);
    assert.equal(state.marker, null);
    assert.deepEqual(state.main.tasks, []);
    assert.deepEqual(state.main.dailyLogs, []);
    assert.equal(state.resetInFlight, false);
    assert.equal(state.recoveryRequired, false);
  });
});
