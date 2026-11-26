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

async function waitForSafeStartup(page, label, timeout = 20000) {
  let waitError = null;
  try {
    await page.waitForFunction(() =>
      window._appInitCompleted === true || window._startupStopwatchRecoveryFailed === true,
      null, { timeout }
    );
  } catch (error) {
    waitError = error && error.message ? error.message : String(error);
  }
  const state = await page.evaluate(async () => {
    let lockState = null;
    try { lockState = navigator.locks && navigator.locks.query
      ? await navigator.locks.query() : null; } catch (error) {
      lockState = { error: String(error) };
    }
    let startupPromise = "not-created";
    try {
      if (window._startupStopwatchRecoveryPromise) {
        startupPromise = await Promise.race([
          Promise.resolve(window._startupStopwatchRecoveryPromise).then(
            value => ({ status: "resolved", value }),
            error => ({ status: "rejected", error: String(error) })
          ),
          new Promise(resolve => setTimeout(() => resolve("pending"), 100))
        ]);
      }
    } catch (error) { startupPromise = { error: String(error) }; }
    const read = key => {
      try { return localStorage.getItem(key); } catch (error) { return "READ_ERROR:" + String(error); }
    };
    return {
      appInitCompleted: window._appInitCompleted,
      storageRecoveryRequired: typeof storageRecoveryRequired === 'undefined'
        ? 'undefined' : storageRecoveryRequired,
      startupInFlight: window._startupStopwatchRecoveryInFlight,
      startupFailed: window._startupStopwatchRecoveryFailed,
      startupPromise,
      mainBaselineReady: window._mainStorageBaselineReady,
      mainBaselineRaw: window._mainStorageBaselineRaw,
      mainRaw: read("timeTasksApp_v1"),
      timerRaw: read("timeTasksApp_focusTimer"),
      markerReset: read("timeTasksApp_resetInProgress"),
      markerRolling: read("timeTasksApp_rollingRestoreInProgress"),
      markerImport: read("timeTasksApp_importInProgress"),
      markerMigration: read("timeTasksApp_migrationInProgress"),
      pendingForensicCount: Array.isArray(window._pendingCorruptStorageSnapshots)
        ? window._pendingCorruptStorageSnapshots.length : null,
      rollingBackupFailure: window._rollingRecoveryBackupLastFailure,
      mainExternalChange: window._mainStorageExternalChangeObserved,
      timerExternalChange: window._focusTimerExternalConflict,
      lockState
    };
  });
  assert.equal(state.appInitCompleted, true,
    label + " did not reach safe startup. waitError=" + waitError
      + " diagnostics=" + JSON.stringify(state));
  assert.equal(state.storageRecoveryRequired, false,
    label + " completed startup while storage recovery remained required: "
      + JSON.stringify(state));
  assert.equal(state.mainBaselineReady, true,
    label + " did not establish the main storage baseline: " + JSON.stringify(state));
  return state;
}

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

    const staleMainAttempt = await pageB.evaluate(async () => {
      const before = localStorage.getItem('timeTasksApp_v1');
      const saved = await _withTaskStorageLock(() => {
        appSettings.themeMode = 'light';
        appSettings.darkMode = false;
        return saveData();
      });
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
      const saved = await _withTaskStorageLock(() => {
        tasks.push(task);
        appSettings.lastTaskId = task.id;
        return saveData();
      });
      if (!saved) throw new Error('Could not seed the task record');

      const timerSeeded = await _withTaskStorageLock(function() {
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
        return _saveFocusTimer();
      });
      if (!timerSeeded) throw new Error('Could not seed the paused Stopwatch');

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
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step',
  timeout: 30000
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
    await context.addInitScript(value => {
      if (localStorage.getItem('timeTasksApp_v1') === null)
        localStorage.setItem('timeTasksApp_v1', JSON.stringify(value.main));
      if (localStorage.getItem('timeTasksApp_focusTimer') === null)
        localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(value.timer));
      if (localStorage.getItem('timeTasksApp_focusSessions') === null)
        localStorage.setItem('timeTasksApp_focusSessions', '[]');
    }, initial);
    const pageA = await context.newPage(), pageB = await context.newPage();
    await Promise.all([pageA.goto(appUrl), pageB.goto(appUrl)]);
    await Promise.all([pageA, pageB].map((page, index) =>
      waitForSafeStartup(page, 'backup page ' + (index + 1))
    ));
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => typeof window.buildBackupObject === 'function',
      null, { timeout: 20000 }
    )));

    async function installTrace(page, label) {
      await page.evaluate(pageLabel => {
        const p = Storage.prototype;
        const get = p.getItem, set = p.setItem, remove = p.removeItem;
        const clip = value => value == null ? null : String(value).slice(0, 160);
        window.__f07Trace = { label: pageLabel, writes: [], events: [] };
        p.setItem = function(key, value) {
          const k = String(key), entry = {
            page: pageLabel, operation: 'setItem', key: k, at: performance.now(),
            before: clip(get.call(this, k)), attempted: clip(value),
            stack: String(new Error().stack || '').split('\n').slice(2, 6)
          };
          try { const result = set.call(this, key, value); entry.outcome = 'success'; return result; }
          catch (error) { entry.outcome = 'throw'; entry.error = String(error); throw error; }
          finally { entry.after = clip(get.call(this, k)); window.__f07Trace.writes.push(entry); }
        };
        p.removeItem = function(key) {
          const k = String(key), entry = {
            page: pageLabel, operation: 'removeItem', key: k, at: performance.now(),
            before: clip(get.call(this, k)),
            stack: String(new Error().stack || '').split('\n').slice(2, 6)
          };
          try { const result = remove.call(this, key); entry.outcome = 'success'; return result; }
          catch (error) { entry.outcome = 'throw'; entry.error = String(error); throw error; }
          finally { entry.after = clip(get.call(this, k)); window.__f07Trace.writes.push(entry); }
        };
        window.addEventListener('storage', event => window.__f07Trace.events.push({
          page: pageLabel, key: event.key, at: performance.now(),
          oldValue: clip(event.oldValue), newValue: clip(event.newValue), url: event.url
        }));
      }, label);
    }
    await Promise.all([installTrace(pageA, 'owner-page-A'), installTrace(pageB, 'stale-page-B')]);
    await Promise.all([pageA, pageB].map(page => page.evaluate(() => {
      window.__f07Trace.writes.length = 0;
      window.__f07Trace.events.length = 0;
    })));

    const pendingId = await pageA.evaluate(async () => {
      _mainStorageExternalChangeObserved = false;
      _focusTimerExternalConflict = false;
      _secondaryStorageConflicts = Object.create(null);
      const loaded = await _withStopwatchTransactionLock(() => loadData());
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

    const attempts = [];
    for (let index = 0; index < 3; index++) {
      attempts.push(await pageB.evaluate(async attempt => {
        const trace = window.__f07Trace, writeStart = trace.writes.length, eventStart = trace.events.length;
        const snapshot = () => {
          const value = {};
          Object.keys(localStorage).sort().forEach(key => { value[key] = localStorage.getItem(key); });
          return value;
        };
        const before = snapshot();
        let exportError = null;
        try { buildBackupObject(); } catch (error) { exportError = error.message; }
        const afterExport = snapshot();
        const exportChangedKeys = Array.from(new Set(Object.keys(before).concat(Object.keys(afterExport))))
          .filter(key => before[key] !== afterExport[key]);
        const rollingQueued = _storeRollingRecoveryBackup('stale-window-test-' + attempt, 0);
        const rollingSaved = window._rollingRecoveryBackupPending
          ? await window._rollingRecoveryBackupPending : rollingQueued;
        await new Promise(resolve => setTimeout(resolve, 0));
        const after = snapshot();
        const changedKeys = Array.from(new Set(Object.keys(before).concat(Object.keys(after))))
          .filter(key => before[key] !== after[key])
          .map(key => ({ key, before: before[key] == null ? null : before[key].slice(0, 160),
            after: after[key] == null ? null : after[key].slice(0, 160) }));
        return {
          attempt: attempt + 1, exportError, exportChangedKeys, rollingSaved,
          rollingFailure: _rollingRecoveryBackupLastFailure, changedKeys,
          stalePageWrites: trace.writes.slice(writeStart),
          storageEvents: trace.events.slice(eventStart),
          pending: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')).pendingStopwatchTransaction
        };
      }, index));
    }
    const ownerTrace = await pageA.evaluate(() => window.__f07Trace);
    const attributionFailures = [];
    for (const attempt of attempts) {
      for (const change of attempt.changedKeys) {
        const hasStorageEvent = attempt.storageEvents.some(event =>
          event.key === change.key && event.newValue === change.after);
        const hasOwnerWrite = ownerTrace.writes.some(write =>
          write.key === change.key && write.after === change.after && write.outcome === 'success');
        if (!hasStorageEvent || !hasOwnerWrite) attributionFailures.push({
          attempt: attempt.attempt, key: change.key, after: change.after,
          hasStorageEvent, hasOwnerWrite
        });
      }
    }
    console.log('F07_STALE_BACKUP_STORAGE_TRACE ' + JSON.stringify({
      pendingId, attempts: attempts.map(item => ({
        attempt: item.attempt, exportError: item.exportError,
        exportChangedKeys: item.exportChangedKeys, rollingSaved: item.rollingSaved,
        rollingFailure: item.rollingFailure, changedKeys: item.changedKeys,
        stalePageWrites: item.stalePageWrites, storageEvents: item.storageEvents
      })), ownerWrites: ownerTrace.writes, attributionFailures
    }));

    for (const attempt of attempts) {
      assert.ok(attempt.exportError
        && /نافذة أخرى|تغير سجل المهام|تغيرت بيانات|معاملة Stopwatch معلقة/.test(attempt.exportError),
        JSON.stringify(attempt));
      assert.deepEqual(attempt.exportChangedKeys, [],
        'manual export must not write from the stale page: ' + JSON.stringify(attempt));
      assert.equal(attempt.rollingSaved, false, JSON.stringify(attempt));
      assert.equal(attempt.rollingFailure, 'external_storage_conflict', JSON.stringify(attempt));
      assert.deepEqual(attempt.stalePageWrites, [],
        'the stale page must perform no Storage mutation: ' + JSON.stringify(attempt));
      assert.equal(attempt.pending.id, pendingId);
    }
    assert.deepEqual(attributionFailures, [],
      'all cross-page storage changes during async rolling-backup work must be traced to the owner page');
    await context.close();
  } finally {
    if (browserInstance) await browserInstance.close();
    await new Promise(resolve => server.close(resolve));
  }
});
test('two same-origin pages cannot commit duplicate task-linked Stopwatch transactions', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step',
  timeout: 25000
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
            '_saveFocusTimer', '_saveSessions', '_saveFocusSessions', 'saveData'
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
              transactionId: task && task.lastStopwatchTransactionId || null,
              recoveryRequired: storageRecoveryRequired,
              mainConflict: _mainStorageExternalChangeObserved === true,
              timerConflict: _focusTimerExternalConflict === true,
              sessionConflict: !!_secondaryStorageConflicts[FOCUS_SESSIONS_KEY]
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
    await Promise.all(pages.map((page, index) =>
      waitForSafeStartup(page, 'Stopwatch diagnostic page ' + (index + 1))
    ));
    await Promise.all(pages.map(page => page.waitForFunction(() =>
      window.__stopwatchDiagnosticReady === true
        && typeof window.__runStopwatchCommitAfterBarrier === 'function',
      null, { timeout: 20000 }
    )));
    const attempts = pages.map(page => page.evaluate(() => window.__runStopwatchCommitAfterBarrier()));
    await Promise.all(pages.map(page => page.waitForFunction(
      () => window.__stopwatchAttemptWaiting === true, null, { timeout: 10000 }
    )));
    // BroadcastChannel does not deliver a message back to its sender. Each
    // page must send once so both waiting pages receive the peer's start signal.
    await Promise.all(pages.map(page => page.evaluate(() =>
      window.__stopwatchDiagnosticChannel.postMessage('start-stopwatch-commit')
    )));
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
    console.log('STOPWATCH_MULTI_WINDOW_DIAGNOSTICS ' + JSON.stringify(diagnostics));
    const successful = settled.filter(item => item.status === 'fulfilled'
      && item.value && item.value.value === true);
    const rejected = settled.filter(item => item.status === 'fulfilled'
      && item.value && item.value.value === false);
    assert.equal(successful.length, 1,
      'exactly one page must commit; diagnostics=' + JSON.stringify(diagnostics));
    assert.equal(rejected.length, 1,
      'the stale competing page must return false; diagnostics=' + JSON.stringify(diagnostics));
    const losingAttempt = rejected[0].value;
    assert.ok(losingAttempt.recoveryRequired || losingAttempt.mainConflict
      || losingAttempt.timerConflict || losingAttempt.sessionConflict,
      'the losing attempt must expose a persisted-journal, storage-conflict, or recovery gate; diagnostics='
        + JSON.stringify(diagnostics));

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
    await Promise.all([pageA, pageB].map((page, index) =>
      waitForSafeStartup(page, 'lock ownership page ' + (index + 1))
    ));
    await Promise.all([pageA, pageB].map(page => page.waitForFunction(
      () => typeof window._pendingStopwatchWriteAllowed === 'function',
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


async function withBrowserPages(run, initialSeed = seed, pageCount = 2) {
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
        localStorage.setItem('timeTasksApp_focusSessions', JSON.stringify(initial.sessions || []));
    }, initialSeed);
    const appUrl = 'http://127.0.0.1:' + server.address().port + '/';
    const pageA = await context.newPage();
    const pageB = pageCount > 1 ? await context.newPage() : null;
    const pages = pageB ? [pageA, pageB] : [pageA];
    await Promise.all(pages.map(page => page.goto(appUrl)));
    await Promise.all(pages.map(page => page.waitForFunction(
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

function makeColdStartStopwatchSeed() {
  const now = Date.now();
  const initial = JSON.parse(JSON.stringify(seed));
  initial.main.tasks = [{
    id: 7011,
    name: 'Cold-start Stopwatch task',
    type: 'معرفية',
    status: 'pending',
    expected: 15,
    actual: 5,
    plannedDate: new Date(now).toISOString().slice(0, 10),
    plannedTime: '',
    completedAt: null,
    createdAt: now,
    projectId: null,
    priority: null,
    recurrence: null,
    checklist: null
  }];
  initial.timer = {
    ...initial.timer,
    mode: 'stopwatch',
    phase: 'work',
    running: true,
    baseElapsed: 77,
    startedAt: now - 77_000,
    taskId: 7011,
    sessionStartAt: now - 77_000,
    savedAt: now
  };
  initial.sessions = [{
    id: 1,
    mode: 'stopwatch',
    phase: 'work',
    taskId: 7011,
    taskName: 'Cold-start Stopwatch task',
    startedAt: new Date(now - 300_000).toISOString(),
    endedAt: new Date(now - 240_000).toISOString(),
    durationSec: 60,
    completed: true
  }];
  return initial;
}

test('cold-start restores a persisted running Stopwatch as paused and keeps start, stop and finish usable', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const initial = makeColdStartStopwatchSeed();
  await withBrowserPages(async ({ pageA }) => {
    await waitForSafeStartup(pageA, 'cold-start Stopwatch recovery');

    // Stopwatch lives inside the Tasks page, which is hidden on initial load.
    // Open the real page before asserting and exercising its controls.
    await pageA.locator('nav button[data-page="tasks"]').click();
    await pageA.locator('#timerCard').waitFor({ state: 'visible' });

    const restored = await pageA.evaluate(() => ({
      blocked: _isTimerControlBlocked(),
      running: _focusTimer.running,
      elapsed: _focusTimer.baseElapsed,
      externalConflict: _focusTimerExternalConflict,
      timerConflict: !!_secondaryStorageConflicts[FOCUS_TIMER_KEY],
      timer: JSON.parse(localStorage.getItem(FOCUS_TIMER_KEY)),
      sessions: JSON.parse(localStorage.getItem(FOCUS_SESSIONS_KEY) || '[]'),
      startDisabled: document.getElementById('timerStartBtn').disabled,
      finishDisabled: document.getElementById('timerFinishBtn').disabled,
      startButtonText: document.getElementById('timerStartBtn').textContent
    }));
    assert.equal(restored.blocked, false, 'verified cold-start restore must release timer controls');
    assert.equal(restored.running, false, 'a timer from a previous JS runtime must restore paused');
    assert.equal(restored.elapsed, 77, 'the durable Stopwatch checkpoint must be preserved');
    assert.equal(restored.externalConflict, false,
      'a cold-start checkpoint must not be mislabeled as a live cross-window conflict');
    assert.equal(restored.timerConflict, false,
      'the startup-owned timer baseline must remain writable');
    assert.equal(restored.timer.running, false,
      'the paused cold-start checkpoint must be persisted');
    assert.equal(restored.timer.baseElapsed, 77);
    assert.equal(restored.sessions.length, 1, 'the historical session must survive startup recovery');
    assert.equal(restored.startDisabled, false);
    assert.equal(restored.finishDisabled, false);
    assert.equal(restored.startButtonText, '▶ استئناف',
      'a restored paused Stopwatch with elapsed time must say resume');

    await pageA.locator('#timerStartBtn').click();
    await pageA.waitForFunction(() => _focusTimer.running === true
      && document.getElementById('timerStartBtn').textContent === '⏸ إيقاف');
    await pageA.locator('#timerStartBtn').click();
    await pageA.waitForFunction(() => _focusTimer.running === false
      && document.getElementById('timerStartBtn').textContent === '▶ استئناف');

    await pageA.locator('#timerFinishBtn').click();
    await pageA.locator('#modalFooter button.btn-primary').waitFor({ state: 'visible' });
    await pageA.locator('#modalFooter button.btn-primary').click();

    await pageA.waitForFunction(() => {
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      return main.tasks.find(task => task.id === 7011)?.actual === 6
        && sessions.length === 2
        && timer.running === false
        && timer.baseElapsed === 0
        && timer.pendingStopwatchTransaction === null
        && document.getElementById('timerStartBtn').textContent === '▶ ابدأ';
    }, null, { timeout: 15_000 });

    const committed = await pageA.evaluate(() => ({
      taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1'))
        .tasks.find(task => task.id === 7011).actual,
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]'),
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      blocked: _isTimerControlBlocked(),
      recoveryRequired: storageRecoveryRequired,
      startButtonText: document.getElementById('timerStartBtn').textContent
    }));
    assert.equal(committed.taskActual, 6, 'the task minutes must be added exactly once');
    assert.equal(committed.sessions.length, 2, 'the historical session and one new session must remain');
    assert.equal(committed.sessions[0].id, 1, 'the historical session must not be deleted');
    const newRows = committed.sessions.filter(session =>
      session.taskId === 7011 && session.durationSec >= 77 && session.id !== 1);
    assert.equal(newRows.length, 1, 'the finished Stopwatch session must be recorded exactly once');
    assert.equal(typeof newRows[0].transactionId, 'string',
      'the new task-linked session must retain its transaction identity');
    assert.equal(committed.timer.pendingStopwatchTransaction, null);
    assert.equal(committed.timer.baseElapsed, 0);
    assert.equal(committed.blocked, false);
    assert.equal(committed.recoveryRequired, false);
    assert.equal(committed.startButtonText, '▶ ابدأ',
      'a finished Stopwatch must return to the start label');
  }, initial, 1);
});

test('cold-start Stopwatch reset discards only the current interval and preserves historical sessions', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const initial = makeColdStartStopwatchSeed();
  await withBrowserPages(async ({ pageA }) => {
    await waitForSafeStartup(pageA, 'cold-start Stopwatch reset');

    // The reset control is also inside the initially hidden Tasks page.
    await pageA.locator('nav button[data-page="tasks"]').click();
    await pageA.locator('#timerCard').waitFor({ state: 'visible' });

    const before = await pageA.evaluate(() => ({
      blocked: _isTimerControlBlocked(),
      running: _focusTimer.running,
      elapsed: _focusTimer.baseElapsed,
      sessions: JSON.parse(localStorage.getItem(FOCUS_SESSIONS_KEY) || '[]')
    }));
    assert.equal(before.blocked, false);
    assert.equal(before.running, false);
    assert.equal(before.elapsed, 77);
    assert.equal(before.sessions.length, 1);

    await pageA.locator('.timer-controls button').nth(2).click();
    await pageA.locator('#modalFooter button.btn-danger').waitFor({ state: 'visible' });
    await pageA.locator('#modalFooter button.btn-danger').click();

    await pageA.waitForFunction(() => {
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      return timer.running === false && timer.baseElapsed === 0
        && timer.pendingStopwatchTransaction === null;
    }, null, { timeout: 10_000 });

    const after = await pageA.evaluate(() => ({
      timer: JSON.parse(localStorage.getItem(FOCUS_TIMER_KEY)),
      sessions: JSON.parse(localStorage.getItem(FOCUS_SESSIONS_KEY) || '[]'),
      blocked: _isTimerControlBlocked(),
      recoveryRequired: storageRecoveryRequired
    }));
    assert.equal(after.sessions.length, 1, 'reset must not delete prior session rows');
    assert.equal(after.sessions[0].id, 1);
    assert.equal(after.timer.baseElapsed, 0);
    assert.equal(after.timer.running, false);
    assert.equal(after.blocked, false);
    assert.equal(after.recoveryRequired, false);
  }, initial, 1);
});

test('Stopwatch button label distinguishes fresh, running and paused states without starting a new session on resume', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const initial = makeColdStartStopwatchSeed();
  initial.timer.running = false;
  initial.timer.baseElapsed = 0;
  initial.timer.startedAt = null;
  initial.timer.sessionStartAt = null;
  initial.timer.savedAt = Date.now();

  await withBrowserPages(async ({ pageA }) => {
    await waitForSafeStartup(pageA, 'Stopwatch button labels');
    await pageA.locator('nav button[data-page="tasks"]').click();
    await pageA.locator('#timerCard').waitFor({ state: 'visible' });

    const initialState = await pageA.evaluate(() => {
      const sessions = JSON.parse(localStorage.getItem(FOCUS_SESSIONS_KEY) || '[]');
      const task = tasks.find(item => item.id === _focusTimer.taskId);
      const timerRecord = JSON.parse(localStorage.getItem(FOCUS_TIMER_KEY));
      return {
        label: document.getElementById('timerStartBtn').textContent,
        elapsed: _focusTimer.baseElapsed,
        sessions: sessions.length,
        taskId: _focusTimer.taskId,
        persistedTimerTaskId: timerRecord ? timerRecord.taskId : null,
        taskActual: task ? task.actual : null,
        taskTransactionId: task ? task.lastStopwatchTransactionId || null : null,
        pendingTransactionId: _focusTimer.pendingStopwatchTransaction
          ? _focusTimer.pendingStopwatchTransaction.id : null,
        persistedPendingTransactionId: timerRecord && timerRecord.pendingStopwatchTransaction
          ? timerRecord.pendingStopwatchTransaction.id : null,
        historicalSessions: JSON.stringify(sessions)
      };
    });
    assert.equal(initialState.label, '▶ ابدأ', 'a fresh Stopwatch must say start');
    assert.equal(initialState.elapsed, 0);
    assert.equal(initialState.sessions, 1, 'the historical session must remain');
    assert.equal(initialState.taskId, 7011, 'the Stopwatch must remain linked to its original task');
    assert.equal(initialState.taskActual, 5, 'the test task starts with five accumulated minutes');
    assert.equal(initialState.taskTransactionId, null, 'a fresh interval has no prior task transaction marker');
    assert.equal(initialState.pendingTransactionId, null, 'a fresh interval has no pending save transaction');

    await pageA.locator('#timerStartBtn').click();
    await pageA.waitForFunction(() =>
      _focusTimer.running === true
      && document.getElementById('timerStartBtn').textContent === '⏸ إيقاف'
    );
    const firstStartAt = await pageA.evaluate(() => _focusTimer.sessionStartAt);

    await pageA.waitForTimeout(1200);
    await pageA.locator('#timerStartBtn').click();
    await pageA.waitForFunction(() =>
      _focusTimer.running === false
      && document.getElementById('timerStartBtn').textContent === '▶ استئناف'
    );
    const paused = await pageA.evaluate(() => {
      const sessions = JSON.parse(localStorage.getItem(FOCUS_SESSIONS_KEY) || '[]');
      const task = tasks.find(item => item.id === _focusTimer.taskId);
      return {
        elapsed: _focusTimer.baseElapsed,
        sessionStartAt: _focusTimer.sessionStartAt,
        sessions: sessions.length,
        taskId: _focusTimer.taskId,
        taskActual: task ? task.actual : null,
        taskTransactionId: task ? task.lastStopwatchTransactionId || null : null,
        pendingTransactionId: _focusTimer.pendingStopwatchTransaction
          ? _focusTimer.pendingStopwatchTransaction.id : null,
        historicalSessions: JSON.stringify(sessions)
      };
    });
    assert.ok(paused.elapsed > 0, 'pausing must preserve the elapsed interval');
    assert.equal(paused.sessionStartAt, firstStartAt,
      'pausing must retain the original session start');
    assert.equal(paused.sessions, 1, 'pausing must not create a session row');
    assert.equal(paused.taskId, initialState.taskId, 'pausing must keep the task link');
    assert.equal(paused.taskActual, initialState.taskActual,
      'pausing must not add minutes to the linked task');
    assert.equal(paused.taskTransactionId, initialState.taskTransactionId,
      'pausing must not create a task transaction marker');
    assert.equal(paused.pendingTransactionId, initialState.pendingTransactionId,
      'pausing must not create a pending Stopwatch save transaction');
    assert.equal(paused.historicalSessions, initialState.historicalSessions,
      'pausing must leave every historical session field unchanged');

    await pageA.locator('#timerStartBtn').click();
    await pageA.waitForFunction(() =>
      _focusTimer.running === true
      && document.getElementById('timerStartBtn').textContent === '⏸ إيقاف'
    );
    await pageA.waitForTimeout(1100);
    await pageA.locator('#timerStartBtn').click();
    await pageA.waitForFunction(() =>
      _focusTimer.running === false
      && document.getElementById('timerStartBtn').textContent === '▶ استئناف'
    );
    const resumed = await pageA.evaluate(() => {
      const sessions = JSON.parse(localStorage.getItem(FOCUS_SESSIONS_KEY) || '[]');
      const task = tasks.find(item => item.id === _focusTimer.taskId);
      return {
        elapsed: _focusTimer.baseElapsed,
        sessionStartAt: _focusTimer.sessionStartAt,
        sessions: sessions.length,
        taskId: _focusTimer.taskId,
        taskActual: task ? task.actual : null,
        taskTransactionId: task ? task.lastStopwatchTransactionId || null : null,
        pendingTransactionId: _focusTimer.pendingStopwatchTransaction
          ? _focusTimer.pendingStopwatchTransaction.id : null,
        historicalSessions: JSON.stringify(sessions)
      };
    });
    assert.ok(resumed.elapsed > paused.elapsed,
      'resuming must continue from the accumulated time rather than reset it');
    assert.equal(resumed.sessionStartAt, firstStartAt,
      'resuming must continue the same focus interval');
    assert.equal(resumed.sessions, 1, 'resuming must not create a new session');
    assert.equal(resumed.taskId, initialState.taskId, 'resuming must keep the original task link');
    assert.equal(resumed.taskActual, initialState.taskActual,
      'resuming must not add minutes to the linked task');
    assert.equal(resumed.taskTransactionId, initialState.taskTransactionId,
      'resuming must not create a task transaction marker');
    assert.equal(resumed.pendingTransactionId, initialState.pendingTransactionId,
      'resuming must not create a pending Stopwatch save transaction');
    assert.equal(resumed.historicalSessions, initialState.historicalSessions,
      'resuming must preserve every historical session field');

    await pageA.locator('.timer-controls button').nth(2).click();
    await pageA.locator('#modalFooter button.btn-danger').waitFor({ state: 'visible' });
    await pageA.locator('#modalFooter button.btn-danger').click();
    await pageA.waitForFunction(() =>
      _focusTimer.baseElapsed === 0
      && _focusTimer.running === false
      && document.getElementById('timerStartBtn').textContent === '▶ ابدأ'
    );
    const reset = await pageA.evaluate(() => {
      const sessions = JSON.parse(localStorage.getItem(FOCUS_SESSIONS_KEY) || '[]');
      const task = tasks.find(item => item.id === _focusTimer.taskId);
      const timerRecord = JSON.parse(localStorage.getItem(FOCUS_TIMER_KEY));
      return {
        sessionStartAt: _focusTimer.sessionStartAt,
        sessions: sessions.length,
        taskId: _focusTimer.taskId,
        persistedTimerTaskId: timerRecord ? timerRecord.taskId : null,
        taskActual: task ? task.actual : null,
        taskTransactionId: task ? task.lastStopwatchTransactionId || null : null,
        pendingTransactionId: _focusTimer.pendingStopwatchTransaction
          ? _focusTimer.pendingStopwatchTransaction.id : null,
        persistedPendingTransactionId: timerRecord && timerRecord.pendingStopwatchTransaction
          ? timerRecord.pendingStopwatchTransaction.id : null,
        historicalSessions: JSON.stringify(sessions)
      };
    });
    assert.equal(reset.sessionStartAt, null);
    assert.equal(reset.sessions, 1, 'reset must preserve prior sessions and create none');
    assert.equal(reset.taskId, initialState.taskId,
      'resetting the current interval must preserve the linked task in memory');
    assert.equal(reset.persistedTimerTaskId, initialState.persistedTimerTaskId,
      'resetting the current interval must preserve the persisted task link');
    assert.equal(reset.taskActual, initialState.taskActual,
      'resetting the current interval must not change the task total');
    assert.equal(reset.taskTransactionId, initialState.taskTransactionId,
      'resetting the current interval must not change the task transaction marker');
    assert.equal(reset.pendingTransactionId, initialState.pendingTransactionId,
      'resetting the current interval must not introduce or change a pending transaction in memory');
    assert.equal(reset.persistedPendingTransactionId, initialState.persistedPendingTransactionId,
      'resetting the current interval must not introduce or change a persisted pending transaction');
    assert.equal(reset.historicalSessions, initialState.historicalSessions,
      'resetting the current interval must preserve historical session records');
  }, initial, 1);
});

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
      mainWriteAllowed: _storageWriteAllowed(),
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
    if (otherWindowState.externalMain) {
      assert.equal(otherWindowState.mainWriteAllowed, false,
        'a late cross-window main-data event must keep the second page write gate closed');
    } else {
      assert.equal(otherWindowState.mainWriteAllowed, true,
        'a page without a late external-main event must have a synchronized write gate');
    }
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

test('D-01 Reset allows same-page thought, project and timer writes without stale baselines', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  await withBrowserPages(async ({ pageA, pageB }) => {
    await pageB.close();
    await waitForSafeStartup(pageA, 'D-01 Reset acceptance page');

    const result = await pageA.evaluate(async () => {
      const oldProjects = [{
        id: 404,
        name: 'Stale project before Reset',
        description: '',
        status: 'active',
        targetDate: '',
        createdAt: new Date().toISOString(),
        updatedAt: null,
        completedAt: null
      }];
      const oldProjectsSaved = await _withTaskStorageLock(function() {
        return _saveProjects(oldProjects);
      });
      if (!oldProjectsSaved) throw new Error('Could not seed old project cache');
      _loadProjects();
      if (!_projectsCache || !_projectsCache.some(project => project.id === 404)) {
        throw new Error('The pre-reset project cache was not populated');
      }
      _invalidFocusSessionsNoticeShown = true;

      const resetSucceeded = await _executeResetAllTransaction();
      const resetCleanup = {
        projectsCacheHasNoStaleProject: _projectsCache === null
          || (Array.isArray(_projectsCache)
            && !_projectsCache.some(project => project && project.id === 404)),
        invalidSessionsNotice: _invalidFocusSessionsNoticeShown,
        recoveryRequired: storageRecoveryRequired
      };
      if (!resetSucceeded) throw new Error('The real Reset transaction did not complete');

      const thoughtInput = document.getElementById('thoughtInput');
      const projectName = document.getElementById('projectName');
      const projectDesc = document.getElementById('projectDesc');
      const projectTarget = document.getElementById('projectTarget');
      if (!thoughtInput || !projectName || !projectDesc || !projectTarget) {
        throw new Error('Notebook inputs were not present in the loaded application');
      }
      thoughtInput.value = 'خاطرة بعد إعادة الضبط';
      await addThought();
      projectName.value = 'مشروع بعد إعادة الضبط';
      projectDesc.value = 'تحقق الكتابة في الصفحة نفسها دون إعادة تحميل';
      projectTarget.value = '';
      await saveProject();
      await toggleTimer();

      const thoughtsRaw = localStorage.getItem(THOUGHTS_KEY);
      const projectsRaw = localStorage.getItem(PROJECTS_KEY);
      const timerRaw = localStorage.getItem(FOCUS_TIMER_KEY);
      return {
        resetSucceeded,
        resetCleanup,
        thoughtsRaw,
        projectsRaw,
        timerRaw,
        thoughts: JSON.parse(thoughtsRaw || '[]'),
        projects: JSON.parse(projectsRaw || '[]'),
        timer: JSON.parse(timerRaw || 'null'),
        thoughtBaseline: _secondaryStorageBaselines[THOUGHTS_KEY],
        projectBaseline: _secondaryStorageBaselines[PROJECTS_KEY],
        timerBaseline: _secondaryStorageBaselines[FOCUS_TIMER_KEY],
        thoughtWritable: _secondaryStorageWriteAllowed(THOUGHTS_KEY),
        projectWritable: _secondaryStorageWriteAllowed(PROJECTS_KEY),
        timerWritable: _secondaryStorageWriteAllowed(FOCUS_TIMER_KEY),
        secondaryConflicts: Object.assign({}, _secondaryStorageConflicts),
        timerConflict: _focusTimerExternalConflict,
        mainExternalChange: _mainStorageExternalChangeObserved,
        recoveryRequired: storageRecoveryRequired
      };
    });

    assert.equal(result.resetSucceeded, true);
    assert.equal(result.resetCleanup.projectsCacheHasNoStaleProject, true);
    assert.equal(result.resetCleanup.invalidSessionsNotice, false);
    assert.equal(result.resetCleanup.recoveryRequired, false);
    assert.equal(result.thoughts.length, 1);
    assert.equal(result.thoughts[0].text, 'خاطرة بعد إعادة الضبط');
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].name, 'مشروع بعد إعادة الضبط');
    assert.equal(result.projects.some(project => project.id === 404), false);
    assert.ok(result.timer && result.timer.running === true,
      'starting the timer after Reset must persist the running state');
    assert.equal(result.thoughtBaseline, result.thoughtsRaw);
    assert.equal(result.projectBaseline, result.projectsRaw);
    assert.equal(result.timerBaseline, result.timerRaw);
    assert.equal(result.thoughtWritable, true);
    assert.equal(result.projectWritable, true);
    assert.equal(result.timerWritable, true);
    assert.equal(result.timerConflict, false);
    assert.equal(result.mainExternalChange, false);
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.secondaryConflicts['timeTasksApp_thoughts_v1'] || false, false);
    assert.equal(result.secondaryConflicts['timeTasksApp_projects_v1'] || false, false);
    assert.equal(result.secondaryConflicts['timeTasksApp_focusTimer'] || false, false);
  });
});

test('Reset baseline read failure retains its marker and write gate until a verified retry', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step',
  timeout: 30000
}, async () => {
  await withBrowserPages(async ({ pageA, pageB }) => {
    await Promise.all([pageA, pageB].map(page =>
      waitForSafeStartup(page, 'Reset baseline read-failure acceptance')
    ));
    await pageB.close();
    const outcome = await pageA.evaluate(async () => {
      const originalReload = _reloadAfterVerifiedOperation;
      const originalGet = Storage.prototype.getItem;
      const originalRemove = Storage.prototype.removeItem;
      let projectRemoved = false, projectRemovalReads = 0, injected = false;
      _reloadAfterVerifiedOperation = function() {};
      try {
        _projectsCache = [{
          id: 8801, name: 'Project cache must survive a failed baseline read',
          description: '', status: 'active', targetDate: '',
          createdAt: new Date().toISOString(), updatedAt: null, completedAt: null
        }];
        _invalidFocusSessionsNoticeShown = true;
        _focusTimerConflictNoticeShown = true;
        Storage.prototype.removeItem = function(key) {
          const result = originalRemove.call(this, key);
          if (String(key) === PROJECTS_KEY) { projectRemoved = true; projectRemovalReads = 0; }
          return result;
        };
        Storage.prototype.getItem = function(key) {
          if (projectRemoved && String(key) === PROJECTS_KEY) {
            projectRemovalReads++;
            // Read 1 verifies deletion; read 2 is the post-Reset baseline read.
            if (projectRemovalReads === 2 && !injected) {
              injected = true;
              throw new Error('INJECTED_RESET_BASELINE_READ_FAILURE');
            }
          }
          return originalGet.call(this, key);
        };

        const firstResult = await _executeResetAllTransaction();
        const firstState = {
          firstResult, injected,
          markerPresent: originalGet.call(localStorage, RESET_IN_PROGRESS_KEY) !== null,
          recoveryRequired: storageRecoveryRequired,
          projectConflict: _secondaryStorageConflicts[PROJECTS_KEY] === true,
          projectWritable: _secondaryStorageWriteAllowed(PROJECTS_KEY),
          staleProjectCacheRetained: Array.isArray(_projectsCache)
            && _projectsCache.some(project => project && project.id === 8801),
          invalidSessionsNoticeRetained: _invalidFocusSessionsNoticeShown,
          timerConflictNoticeRetained: _focusTimerConflictNoticeShown,
          projectRaw: originalGet.call(localStorage, PROJECTS_KEY)
        };
        Storage.prototype.getItem = originalGet;
        Storage.prototype.removeItem = originalRemove;

        const retryResult = await retryStorageRecovery();
        const retryState = {
          retryResult,
          marker: originalGet.call(localStorage, RESET_IN_PROGRESS_KEY),
          recoveryRequired: storageRecoveryRequired,
          appInitCompleted: _appInitCompleted,
          projectBaseline: _secondaryStorageBaselines[PROJECTS_KEY],
          projectConflict: _secondaryStorageConflicts[PROJECTS_KEY] === true,
          projectWritable: _secondaryStorageWriteAllowed(PROJECTS_KEY),
          projectsCache: _projectsCache,
          invalidSessionsNotice: _invalidFocusSessionsNoticeShown,
          timerConflictNotice: _focusTimerConflictNoticeShown
        };
        return { firstState, retryState };
      } finally {
        Storage.prototype.getItem = originalGet;
        Storage.prototype.removeItem = originalRemove;
        _reloadAfterVerifiedOperation = originalReload;
      }
    });

    assert.equal(outcome.firstState.firstResult, false);
    assert.equal(outcome.firstState.injected, true);
    assert.equal(outcome.firstState.markerPresent, true,
      'the durable Reset marker must survive a baseline read failure');
    assert.equal(outcome.firstState.recoveryRequired, true);
    assert.equal(outcome.firstState.projectConflict, true);
    assert.equal(outcome.firstState.projectWritable, false);
    assert.equal(outcome.firstState.staleProjectCacheRetained, true,
      'memory cleanup must not run before all secondary baselines are read');
    assert.equal(outcome.firstState.invalidSessionsNoticeRetained, true);
    assert.equal(outcome.firstState.timerConflictNoticeRetained, true);
    assert.equal(outcome.firstState.projectRaw, null,
      'the injected failure is after successful project-key deletion');

    assert.equal(outcome.retryState.retryResult, true,
      'retryStorageRecovery must complete the durable Reset after reads recover');
    assert.equal(outcome.retryState.marker, null);
    assert.equal(outcome.retryState.recoveryRequired, false);
    assert.equal(outcome.retryState.appInitCompleted, true);
    assert.equal(outcome.retryState.projectBaseline, null);
    assert.equal(outcome.retryState.projectConflict, false);
    assert.equal(outcome.retryState.projectWritable, true);
    assert.ok(outcome.retryState.projectsCache === null
      || !outcome.retryState.projectsCache.some(project => project && project.id === 8801));
    assert.equal(outcome.retryState.invalidSessionsNotice, false);
    assert.equal(outcome.retryState.timerConflictNotice, false);
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
        const pendingPromise = _stopwatchRetryRecoveryPromise;
        const lockStateWhileHeld = await navigator.locks.query();
        const waitingState = {
          hasPromise: !!pendingPromise && typeof pendingPromise.then === 'function',
          retryInFlight: _startupStopwatchRecoveryInFlight,
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
          retryInFlight: _startupStopwatchRecoveryInFlight,
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
          retryInFlight: _startupStopwatchRecoveryInFlight,
          recoveryRequired: storageRecoveryRequired,
          markerPresent: localStorage.getItem(RESET_IN_PROGRESS_KEY) !== null
        };

        // The fixture is isolated to this browser context; clean it after the
        // assertions have captured the intentionally failed recovery state.
        const cleanup = await _recoverInterruptedResetWithLock(
          { keepRecoveryLock: false },
          function() {
            storageRecoveryRequired = false;
            if (!loadData()) return false;
            return _captureMainStorageBaseline();
          }
        );
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
    await startupPage.waitForFunction(() => _startupStopwatchRecoveryInFlight === true,
      null, { timeout: 10000 });
    await startupPage.evaluate(() => {
      _projectsCache = [{
        id: 9901, name: 'stale pre-recovery project cache', status: 'active',
        description: '', targetDate: '', createdAt: new Date().toISOString()
      }];
      _invalidFocusSessionsNoticeShown = true;
    });
    await pageA.waitForFunction(async () => {
      const state = await navigator.locks.query();
      return (state.pending || []).some(lock =>
        lock.name === 'timeTasksApp-stopwatch-transaction'
      );
    }, null, { timeout: 5000 });
    const startupWaiting = await startupPage.evaluate(() => ({
      recoveryInFlight: _startupStopwatchRecoveryInFlight,
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
    const startupRecovered = await startupPage.evaluate(() => _startupStopwatchRecoveryPromise);
    await startupPage.waitForFunction(() => _appInitCompleted === true,
      null, { timeout: 20000 });
    await pageA.waitForFunction(() => _rollingRecoveryBackupPending === null,
      null, { timeout: 10000 });

    const recoveredState = await startupPage.evaluate(() => ({
      recoveryRequired: storageRecoveryRequired,
      marker: localStorage.getItem(RESET_IN_PROGRESS_KEY),
      generation: _readPersistedRollingBackupGeneration(),
      main: JSON.parse(localStorage.getItem(STORAGE_KEY)).tasks,
      projectsCache: _projectsCache,
      invalidSessionsNotice: _invalidFocusSessionsNoticeShown
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
    assert.ok(recoveredState.projectsCache === null
      || (Array.isArray(recoveredState.projectsCache)
        && !recoveredState.projectsCache.some(project => project && project.id === 9901)),
      'interrupted Reset recovery must not retain a pre-reset project cache');
    assert.equal(recoveredState.invalidSessionsNotice, false,
      'interrupted Reset recovery must clear the stale invalid-session notice');
    assert.equal(staleCallbackState.lastFailure, 'STALE_CALLBACK_SENTINEL');
    assert.equal(staleCallbackState.stale, false);
    await startupPage.close();
  });
});

test('Reset refuses to mutate storage when Web Locks is unavailable', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  await withBrowserPages(async ({ pageA, pageB }) => {
    await Promise.all([pageA, pageB].map((page, index) =>
      waitForSafeStartup(page, 'no-Web-Locks page ' + (index + 1))
    ));
    await pageB.close();
    const state = await pageA.evaluate(async () => {
      const generationBefore = _readPersistedRollingBackupGeneration();
      const mainBefore = localStorage.getItem(STORAGE_KEY);
      const timerBefore = localStorage.getItem(FOCUS_TIMER_KEY);
      const sessionsBefore = localStorage.getItem(FOCUS_SESSIONS_KEY);
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
        mainBefore,
        mainAfter: localStorage.getItem(STORAGE_KEY),
        timerBefore,
        timerAfter: localStorage.getItem(FOCUS_TIMER_KEY),
        sessionsBefore,
        sessionsAfter: localStorage.getItem(FOCUS_SESSIONS_KEY),
        resetInFlight: _resetInFlight,
        recoveryRequired: storageRecoveryRequired
      };
    });
    assert.equal(state.result, false,
      'Reset must fail closed instead of using an unprotected fallback');
    assert.equal(state.generationAfter, state.generationBefore);
    assert.equal(state.marker, null);
    assert.equal(state.mainAfter, state.mainBefore);
    assert.equal(state.timerAfter, state.timerBefore);
    assert.equal(state.sessionsAfter, state.sessionsBefore);
    assert.equal(state.resetInFlight, false);
    assert.equal(state.recoveryRequired, true);
  });
});


test('PWA visibility, pagehide, pageshow and failed pagehide persistence never resume or credit an untrusted interval', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step',
  timeout: 60000
}, async () => {
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
    const initial = JSON.parse(JSON.stringify(seed));
    initial.main.tasks = [{
      id: 9901,
      name: 'PWA lifecycle credit guard',
      type: 'معرفية',
      status: 'pending',
      expected: 30,
      actual: 7,
      plannedDate: '2026-11-26',
      plannedTime: '',
      completedAt: null,
      createdAt: Date.now(),
      projectId: null,
      priority: null,
      recurrence: null,
      checklist: null
    }];
    await context.addInitScript((value) => {
      if (localStorage.getItem('timeTasksApp_v1') === null)
        localStorage.setItem('timeTasksApp_v1', JSON.stringify(value.main));
      if (localStorage.getItem('timeTasksApp_focusTimer') === null)
        localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(value.timer));
      if (localStorage.getItem('timeTasksApp_focusSessions') === null)
        localStorage.setItem('timeTasksApp_focusSessions', '[]');
    }, initial);

    const page = await context.newPage();
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await waitForSafeStartup(page, 'PWA lifecycle page');

    async function startPwaWorkSegment() {
      const started = await page.evaluate(async () => {
        const result = await _withStopwatchTransactionLock(() => {
          _focusTimer.mode = 'pomodoro';
          _focusTimer.phase = 'work';
          _focusTimer.running = false;
          _focusTimer.baseElapsed = 83;
          _focusElapsedRemainderMs = 415;
          _focusTimer.startedAt = null;
          _focusTimer.cyclePosition = 0;
          _focusTimer.taskId = 9901;
          _focusTimer.sessionStartAt = Date.now() - 83_415;
          _focusTimer.awaitingConfirmation = false;
          _focusTimer.pendingPhaseEndedAt = null;
          _focusTimer.clockAdjusted = false;
          _focusTimer.nativeClockActive = false;
          _focusTimer.nativeRestorePending = false;
          _focusTimer.pendingStopwatchTransaction = null;
          _clearFocusTimerClock();
          return toggleTimer(true, true);
        });
        const toggleResult = await result;
        const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
        return {
          toggleResult,
          timer,
          sessionCount: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]').length,
          taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks
            .find(item => item.id === 9901).actual
        };
      });
      assert.equal(started.toggleResult, true, 'the PWA Pomodoro segment must start under the shared lock');
      assert.equal(started.timer.running, true);
      assert.equal(started.timer.nativeClockActive, false);
      assert.ok(Number.isInteger(started.timer.elapsedRemainderMs)
        && started.timer.elapsedRemainderMs >= 0 && started.timer.elapsedRemainderMs < 1000,
      'a running timer checkpoint must persist an integer millisecond remainder accepted by cold-start validation');
      return started;
    }

    const firstStart = await startPwaWorkSegment();
    await page.evaluate(() => {
      window.__testVisibilityState = 'hidden';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get() { return window.__testVisibilityState; }
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => {
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      return timer.running === false && timer.clockAdjusted === true && timer.startedAt === null;
    }, null, { timeout: 10000 });

    const hiddenCheckpoint = await page.evaluate(() => ({
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]'),
      taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks
        .find(item => item.id === 9901).actual
    }));
    assert.equal(hiddenCheckpoint.timer.baseElapsed, firstStart.timer.baseElapsed,
      'hiding must close at the last saved whole-second checkpoint');
    assert.equal(hiddenCheckpoint.timer.elapsedRemainderMs, Math.floor(firstStart.timer.elapsedRemainderMs),
      'hiding must retain the last saved remainder at the storage precision of whole milliseconds');
    assert.ok(firstStart.timer.elapsedRemainderMs - hiddenCheckpoint.timer.elapsedRemainderMs >= 0
      && firstStart.timer.elapsedRemainderMs - hiddenCheckpoint.timer.elapsedRemainderMs < 1,
    'hiding may discard only a fractional millisecond, never an additional millisecond');
    assert.equal(hiddenCheckpoint.timer.phase, firstStart.timer.phase);
    assert.equal(hiddenCheckpoint.sessions.length, firstStart.sessionCount,
      'hiding must not create or credit a session');
    assert.equal(hiddenCheckpoint.taskActual, 7, 'hiding must not change the linked task balance');

    await page.evaluate(() => {
      window.__testVisibilityState = 'visible';
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.waitForTimeout(300);
    const afterFirstRestore = await page.evaluate(() => ({
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]'),
      taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks
        .find(item => item.id === 9901).actual
    }));
    assert.equal(afterFirstRestore.timer.running, false,
      'pageshow and visible must not silently resume a paused PWA segment');
    assert.equal(afterFirstRestore.timer.baseElapsed, firstStart.timer.baseElapsed);
    assert.equal(afterFirstRestore.sessions.length, firstStart.sessionCount);
    assert.equal(afterFirstRestore.taskActual, 7);

    const secondStart = await startPwaWorkSegment();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForFunction(() => {
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      return timer.running === false && timer.clockAdjusted === true;
    }, null, { timeout: 10000 });
    const afterPageHide = await page.evaluate(() => ({
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks
        .find(item => item.id === 9901).actual
    }));
    assert.equal(afterPageHide.timer.baseElapsed, secondStart.timer.baseElapsed,
      'pagehide must persist the same last trusted checkpoint');
    assert.equal(afterPageHide.timer.elapsedRemainderMs, Math.floor(secondStart.timer.elapsedRemainderMs));
    assert.ok(secondStart.timer.elapsedRemainderMs - afterPageHide.timer.elapsedRemainderMs >= 0
      && secondStart.timer.elapsedRemainderMs - afterPageHide.timer.elapsedRemainderMs < 1);
    assert.equal(afterPageHide.taskActual, 7);

    await page.evaluate(() => {
      window.__testVisibilityState = 'visible';
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.waitForTimeout(250);
    const afterBfcacheReturn = await page.evaluate(() => ({
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks
        .find(item => item.id === 9901).actual
    }));
    assert.equal(afterBfcacheReturn.timer.running, false,
      'a bfcache pageshow must not resume the prior segment');
    assert.equal(afterBfcacheReturn.timer.baseElapsed, secondStart.timer.baseElapsed);
    assert.equal(afterBfcacheReturn.taskActual, 7);

    const thirdStart = await startPwaWorkSegment();
    const injectedFailure = await page.evaluate(() => {
      const before = localStorage.getItem('timeTasksApp_focusTimer');
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (String(key) === 'timeTasksApp_focusTimer')
          throw new Error('injected focus timer checkpoint failure');
        return originalSetItem.call(this, key, value);
      };
      window.dispatchEvent(new Event('pagehide'));
      return before;
    });
    await page.waitForFunction(() => storageRecoveryRequired === true, null, { timeout: 10000 });
    const failedPageHide = await page.evaluate(() => ({
      raw: localStorage.getItem('timeTasksApp_focusTimer'),
      inMemoryRunning: _focusTimer.running,
      recoveryRequired: storageRecoveryRequired,
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]'),
      taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks
        .find(item => item.id === 9901).actual
    }));
    assert.equal(failedPageHide.raw, injectedFailure,
      'failed pagehide persistence must not replace the durable running record');
    assert.equal(JSON.parse(failedPageHide.raw).running, true);
    assert.equal(failedPageHide.inMemoryRunning, false,
      'the current page must stop counting even when its checkpoint write fails');
    assert.equal(failedPageHide.recoveryRequired, true);
    assert.equal(failedPageHide.sessions.length, thirdStart.sessionCount);
    assert.equal(failedPageHide.taskActual, 7);

    // A real reload creates a fresh page runtime while retaining LocalStorage.
    // Cold-start normalization must conservatively stop the unclosed old record.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSafeStartup(page, 'PWA cold-start after failed pagehide');
    const afterColdStart = await page.evaluate(() => ({
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]'),
      taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks
        .find(item => item.id === 9901).actual
    }));
    assert.equal(afterColdStart.timer.running, false,
      'cold-start normalization must not continue a segment whose pagehide write failed');
    assert.equal(afterColdStart.timer.baseElapsed, thirdStart.timer.baseElapsed,
      'cold start must retain the durable checkpoint and discard the unverified hidden interval');
    assert.equal(afterColdStart.timer.elapsedRemainderMs, Math.floor(thirdStart.timer.elapsedRemainderMs));
    assert.ok(thirdStart.timer.elapsedRemainderMs - afterColdStart.timer.elapsedRemainderMs >= 0
      && thirdStart.timer.elapsedRemainderMs - afterColdStart.timer.elapsedRemainderMs < 1,
    'cold start may discard only the sub-millisecond fraction of the last checkpoint');
    assert.equal(afterColdStart.sessions.length, thirdStart.sessionCount,
      'neither failed pagehide nor cold-start recovery may create an uncommitted session');
    assert.equal(afterColdStart.taskActual, 7,
      'neither failed pagehide nor cold start may increase the linked task balance');

    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('closing a real Chromium page never resumes or credits a PWA timer on the next cold start', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step',
  timeout: 60000
}, async () => {
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
    const initial = JSON.parse(JSON.stringify(seed));
    initial.main.tasks = [{
      id: 9902,
      name: 'Real page close credit guard',
      type: 'معرفية',
      status: 'pending',
      expected: 25,
      actual: 11,
      plannedDate: '2026-11-26',
      plannedTime: '',
      completedAt: null,
      createdAt: Date.now(),
      projectId: null,
      priority: null,
      recurrence: null,
      checklist: null
    }];
    await context.addInitScript((value) => {
      if (localStorage.getItem('timeTasksApp_v1') === null)
        localStorage.setItem('timeTasksApp_v1', JSON.stringify(value.main));
      if (localStorage.getItem('timeTasksApp_focusTimer') === null)
        localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(value.timer));
      if (localStorage.getItem('timeTasksApp_focusSessions') === null)
        localStorage.setItem('timeTasksApp_focusSessions', '[]');
    }, initial);

    const sourcePage = await context.newPage();
    await sourcePage.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await waitForSafeStartup(sourcePage, 'real page-close source');
    const started = await sourcePage.evaluate(async () => {
      const result = await _withStopwatchTransactionLock(() => {
        _focusTimer.mode = 'pomodoro';
        _focusTimer.phase = 'work';
        _focusTimer.running = false;
        _focusTimer.baseElapsed = 41;
        _focusElapsedRemainderMs = 237;
        _focusTimer.startedAt = null;
        _focusTimer.cyclePosition = 0;
        _focusTimer.taskId = 9902;
        _focusTimer.sessionStartAt = Date.now() - 41_237;
        _focusTimer.awaitingConfirmation = false;
        _focusTimer.pendingPhaseEndedAt = null;
        _focusTimer.clockAdjusted = false;
        _focusTimer.nativeClockActive = false;
        _focusTimer.nativeRestorePending = false;
        _focusTimer.pendingStopwatchTransaction = null;
        _clearFocusTimerClock();
        return toggleTimer(true, true);
      });
      const toggleResult = await result;
      return {
        toggleResult,
        timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
        taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks
          .find(item => item.id === 9902).actual
      };
    });
    assert.equal(started.toggleResult, true);
    assert.equal(started.timer.running, true);
    assert.ok(Number.isInteger(started.timer.elapsedRemainderMs));
    assert.equal(started.taskActual, 11);

    // Exercise an actual browser page close. The observer snapshots LocalStorage
    // before application startup can normalize a possibly still-running checkpoint.
    await sourcePage.close();
    assert.equal(sourcePage.isClosed(), true);

    const observer = await context.newPage();
    await observer.addInitScript(() => {
      window.__timerRawBeforeAppInit = localStorage.getItem('timeTasksApp_focusTimer');
      window.__mainRawBeforeAppInit = localStorage.getItem('timeTasksApp_v1');
      window.__sessionsRawBeforeAppInit = localStorage.getItem('timeTasksApp_focusSessions');
    });
    await observer.goto(appUrl, { waitUntil: 'domcontentloaded' });
    const beforeNormalization = await observer.evaluate(() => ({
      timer: window.__timerRawBeforeAppInit,
      main: window.__mainRawBeforeAppInit,
      sessions: window.__sessionsRawBeforeAppInit
    }));
    assert.ok(beforeNormalization.timer, 'the closed page must leave a readable timer record');
    const timerBeforeStartup = JSON.parse(beforeNormalization.timer);
    const mainBeforeStartup = JSON.parse(beforeNormalization.main);
    const sessionsBeforeStartup = JSON.parse(beforeNormalization.sessions || '[]');
    assert.ok(Number.isInteger(timerBeforeStartup.elapsedRemainderMs)
      && timerBeforeStartup.elapsedRemainderMs >= 0 && timerBeforeStartup.elapsedRemainderMs < 1000,
    'the closed page must leave a checkpoint accepted by the cold-start validator');
    assert.equal(timerBeforeStartup.baseElapsed, started.timer.baseElapsed,
      'closing must not credit time beyond the last durable checkpoint');
    assert.equal(mainBeforeStartup.tasks.find(item => item.id === 9902).actual, 11,
      'closing must not change the linked task balance');
    assert.equal(sessionsBeforeStartup.length, 0,
      'closing must not synthesize a completed focus session');

    await waitForSafeStartup(observer, 'real page-close observer');
    const afterStartup = await observer.evaluate(() => ({
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      taskActual: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks
        .find(item => item.id === 9902).actual,
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]')
    }));
    assert.equal(afterStartup.timer.running, false,
      'cold start after a real page close must never resume the old untrusted interval');
    assert.equal(afterStartup.timer.startedAt, null);
    assert.equal(afterStartup.timer.clockAdjusted, true);
    assert.equal(afterStartup.timer.baseElapsed, started.timer.baseElapsed);
    assert.equal(afterStartup.timer.elapsedRemainderMs, started.timer.elapsedRemainderMs);
    assert.equal(afterStartup.taskActual, 11,
      'cold start after page close must preserve the linked task balance');
    assert.equal(afterStartup.sessions.length, 0,
      'cold start after page close must not create an uncommitted session');
    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('credit migration readiness gate is checked under the real shared Web Lock and after cross-page contention', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step',
  timeout: 60000
}, async () => {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const appUrl = 'http://127.0.0.1:' + server.address().port + '/';
  let browser;
  let context;
  let ownerPage;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ serviceWorkers: 'block' });
    const initial = JSON.parse(JSON.stringify(seed));
    initial.main.tasks = [{
      id: 9910,
      name: 'Credit migration lock baseline',
      type: 'معرفية',
      status: 'pending',
      expected: 30,
      actual: 7,
      plannedDate: '2026-11-26',
      plannedTime: '',
      completedAt: null,
      createdAt: Date.now(),
      projectId: null,
      priority: null,
      recurrence: null,
      checklist: null
    }];
    await context.addInitScript((value) => {
      if (localStorage.getItem('timeTasksApp_v1') === null)
        localStorage.setItem('timeTasksApp_v1', JSON.stringify(value.main));
      if (localStorage.getItem('timeTasksApp_focusTimer') === null)
        localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(value.timer));
      if (localStorage.getItem('timeTasksApp_focusSessions') === null)
        localStorage.setItem('timeTasksApp_focusSessions', '[]');
    }, initial);

    ownerPage = await context.newPage();
    const waitingPage = await context.newPage();
    await Promise.all([
      ownerPage.goto(appUrl, { waitUntil: 'domcontentloaded' }),
      waitingPage.goto(appUrl, { waitUntil: 'domcontentloaded' })
    ]);
    await Promise.all([
      waitForSafeStartup(ownerPage, 'migration lock owner page'),
      waitForSafeStartup(waitingPage, 'migration lock waiting page')
    ]);

    const outsideLock = await ownerPage.evaluate(() => _assertCreditMigrationReady());
    assert.deepEqual(JSON.parse(JSON.stringify(outsideLock)),
      { ok: false, reason: 'lock_required' },
      'the readiness gate must reject a call that does not own the real shared lock');

    const insideLock = await ownerPage.evaluate(async () => {
      const result = await _withStopwatchTransactionLock(() => ({
        readiness: _assertCreditMigrationReady(),
        lockDepth: _stopwatchTransactionLockDepth
      }));
      return {
        result,
        lockDepthAfterRelease: _stopwatchTransactionLockDepth
      };
    });
    assert.deepEqual(JSON.parse(JSON.stringify(insideLock.result.readiness)),
      { ok: true, reason: null },
      'the same readiness gate must accept a clean baseline while holding the real Web Lock');
    assert.equal(insideLock.result.lockDepth, 1,
      'the gate must execute while the shared-lock ownership depth is active');
    assert.equal(insideLock.lockDepthAfterRelease, 0,
      'the page-local ownership depth must return to zero after the lock is released');

    // Hold the lock in one real page while the second page queues its own
    // readiness check. The second page must not evaluate the gate before grant.
    await ownerPage.evaluate(() => {
      window.__migrationLockAcquired = false;
      window.__migrationLockReleased = false;
      window.__migrationLockError = null;
      window.__migrationLockPromise = _withStopwatchTransactionLock(async () => {
        window.__migrationLockAcquired = true;
        await new Promise(resolve => { window.__releaseMigrationLock = resolve; });
      }).then(() => {
        window.__migrationLockReleased = true;
      }, error => {
        window.__migrationLockError = String(error);
      });
      return true;
    });
    await ownerPage.waitForFunction(() =>
      window.__migrationLockAcquired === true
      && _stopwatchTransactionLockDepth === 1,
    null, { timeout: 10000 });

    await waitingPage.evaluate(() => {
      window.__migrationGateSettled = false;
      window.__migrationGateOutcome = null;
      window.__migrationGatePromise = _withStopwatchTransactionLock(() => ({
        readiness: _assertCreditMigrationReady(),
        lockDepth: _stopwatchTransactionLockDepth
      })).then(value => {
        window.__migrationGateOutcome = { status: 'resolved', value };
        window.__migrationGateSettled = true;
      }, error => {
        window.__migrationGateOutcome = { status: 'rejected', error: String(error) };
        window.__migrationGateSettled = true;
      });
      return true;
    });

    await waitingPage.waitForFunction(async () => {
      const state = await navigator.locks.query();
      return state.pending.some(request =>
        request.name === 'timeTasksApp-stopwatch-transaction');
    }, null, { timeout: 10000 });

    // Simulate a stale/legacy writer changing the task record while the second
    // page is waiting. Its storage event must invalidate the queued page baseline.
    const changedRaw = await ownerPage.evaluate(() => {
      const key = 'timeTasksApp_v1';
      const record = JSON.parse(localStorage.getItem(key));
      record.tasks[0].actual = 8;
      const raw = JSON.stringify(record);
      localStorage.setItem(key, raw);
      return raw;
    });
    await waitingPage.waitForFunction(() =>
      _mainStorageExternalChangeObserved === true,
    null, { timeout: 10000 });

    await ownerPage.evaluate(() => window.__releaseMigrationLock());
    await ownerPage.waitForFunction(() => window.__migrationLockReleased === true,
      null, { timeout: 10000 });
    await waitingPage.waitForFunction(() => window.__migrationGateSettled === true,
      null, { timeout: 10000 });

    const finalState = await waitingPage.evaluate(() => ({
      outcome: window.__migrationGateOutcome,
      lockDepth: _stopwatchTransactionLockDepth,
      mainRaw: localStorage.getItem('timeTasksApp_v1'),
      sessionsRaw: localStorage.getItem('timeTasksApp_focusSessions')
    }));
    assert.equal(finalState.outcome.status, 'resolved');
    assert.deepEqual(JSON.parse(JSON.stringify(finalState.outcome.value.readiness)),
      { ok: false, reason: 'main_baseline_conflict' },
      'a queued gate must reject the changed task baseline after it finally acquires the lock');
    assert.equal(finalState.outcome.value.lockDepth, 1,
      'the queued readiness gate must run only after the lock is granted');
    assert.equal(finalState.lockDepth, 0,
      'the queued page must release its lock after the readiness check');
    assert.equal(finalState.mainRaw, changedRaw,
      'the rejected readiness check must not overwrite or repair the changed task record');
    assert.equal(JSON.parse(finalState.mainRaw).tasks[0].actual, 8);
    assert.equal(JSON.parse(finalState.sessionsRaw || '[]').length, 0,
      'the readiness gate must not create or credit a focus session');

    await context.close();
    context = null;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});


function pendingFocusBrowserInitialState() {
  const now = Date.now();
  return {
    main: {
      schemaVersion: 2,
      createdByVersion: '2.9.0',
      settings: {
        operationalDayStart: 4,
        firstUseDate: new Date(now).toISOString().slice(0, 10),
        darkMode: false,
        themeMode: 'system',
        lastRecurringDates: {}
      },
      tasks: [{
        id: 1,
        name: 'V2 integration task',
        status: 'pending',
        type: 'معرفية',
        expected: 30,
        actual: 12,
        plannedDate: new Date(now).toISOString().slice(0, 10),
        plannedTime: '',
        completedAt: null,
        createdAt: now
      }],
      dailyLogs: []
    },
    timer: {
      mode: 'pomodoro',
      phase: 'work',
      running: false,
      baseElapsed: 300,
      elapsedRemainderMs: 0,
      startedAt: null,
      cyclePosition: 0,
      taskId: 1,
      sessionStartAt: now - 300000,
      awaitingConfirmation: false,
      pendingPhaseEndedAt: null,
      clockAdjusted: false,
      pendingStopwatchTransaction: null,
      pendingFocusCommit: null,
      nativeClockActive: false,
      nativeSessionToken: null,
      handledNotificationActionIds: [],
      pendingNotificationFinish: null,
      savedAt: now
    }
  };
}

async function openPendingFocusBrowserContext(server, initial) {
  const address = server.address();
  const appUrl = 'http://127.0.0.1:' + address.port + '/';
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript((value) => {
    if (localStorage.getItem('timeTasksApp_v1') === null)
      localStorage.setItem('timeTasksApp_v1', JSON.stringify(value.main));
    if (localStorage.getItem('timeTasksApp_focusTimer') === null)
      localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(value.timer));
    if (localStorage.getItem('timeTasksApp_focusSessions') === null)
      localStorage.setItem('timeTasksApp_focusSessions', '[]');
  }, initial);
  return { browser, context, appUrl };
}

test('real finishTimer saves one V2 Pomodoro credit operation and survives reload without duplication', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser, context;
  try {
    const opened = await openPendingFocusBrowserContext(server, pendingFocusBrowserInitialState());
    browser = opened.browser;
    context = opened.context;
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await Promise.all([
      pageA.goto(opened.appUrl, { waitUntil: 'domcontentloaded' }),
      pageB.goto(opened.appUrl, { waitUntil: 'domcontentloaded' })
    ]);
    await Promise.all([
      waitForSafeStartup(pageA, 'V2 real finish page'),
      waitForSafeStartup(pageB, 'V2 second window before finish')
    ]);

    await pageA.evaluate(async () => {
      await finishTimer();
    });
    await pageA.waitForFunction(() => {
      const overlay = document.getElementById('customModalOverlay');
      const footer = document.getElementById('modalFooter');
      return !!overlay && !overlay.classList.contains('hidden') && !!footer
        && Array.from(footer.querySelectorAll('button')).some(button =>
          button.textContent.indexOf('+ 5') >= 0);
    }, null, { timeout: 10000 });

    await pageA.evaluate(() => {
      const button = Array.from(document.querySelectorAll('#modalFooter button'))
        .find(item => item.textContent.indexOf('+ 5') >= 0);
      if (!button) throw new Error('The real Pomodoro finish confirmation button was not found.');
      button.click();
    });

    await pageA.waitForFunction(() => {
      try {
        const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
        const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
        const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
        return Array.isArray(main.creditOperations) && main.creditOperations.length === 1
          && main.tasks[0].actualSeconds === 1020
          && main.tasks[0].actual === 17
          && main.tasks[0].creditRevision === 1
          && timer.pendingFocusCommit == null && timer.baseElapsed === 0
          && sessions.filter(row => row && row.recordVersion === 2).length === 1;
      } catch (_error) { return false; }
    }, null, { timeout: 20000 });

    const committed = await pageA.evaluate(() => {
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      const operation = main.creditOperations[0];
      const session = sessions.find(row => row && row.recordVersion === 2);
      return {
        task: main.tasks[0],
        operations: main.creditOperations,
        operation,
        session,
        timer
      };
    });
    assert.equal(committed.task.actualSeconds, 1020,
      'legacy 12 minutes must migrate to 720 seconds, then the confirmed 5-minute session adds 300 seconds');
    assert.equal(committed.task.actual, 17);
    assert.equal(committed.task.creditRevision, 1);
    assert.equal(committed.task.lastCreditOperationId, committed.operation.operationId);
    assert.equal(committed.operations.length, 1);
    assert.equal(committed.operation.kind, 'session');
    assert.equal(committed.operation.previousSeconds, 720);
    assert.equal(committed.operation.targetSeconds, 1020);
    assert.equal(committed.operation.sessionId, committed.operation.operationId);
    assert.equal(committed.session.sessionId, committed.operation.operationId);
    assert.equal(committed.session.recordVersion, 2);
    assert.equal(committed.session.taskId, 1);
    assert.equal(committed.session.phase, 'work');
    assert.equal(committed.session.creditedSeconds, 300);
    assert.equal(committed.session.creditSource, 'measured');
    assert.equal(committed.timer.pendingFocusCommit, null);
    assert.equal(committed.timer.baseElapsed, 0);

    // Reload a different same-origin window that held the pre-commit snapshot.
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await waitForSafeStartup(pageB, 'V2 committed task after second-window reload');
    const afterReload = await pageB.evaluate(() => {
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      return {
        actualSeconds: main.tasks[0].actualSeconds,
        actual: main.tasks[0].actual,
        revision: main.tasks[0].creditRevision,
        operationCount: main.creditOperations.length,
        sessionCount: sessions.filter(row => row && row.recordVersion === 2).length,
        pending: timer.pendingFocusCommit
      };
    });
    assert.deepEqual(afterReload, {
      actualSeconds: 1020,
      actual: 17,
      revision: 1,
      operationCount: 1,
      sessionCount: 1,
      pending: null
    }, 'cold reload must not replay a completed operation or duplicate its V2 session');
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a real second Chromium window waits for a pending V2 journal and recovers it once after owner release', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser, context;
  try {
    const opened = await openPendingFocusBrowserContext(server, pendingFocusBrowserInitialState());
    browser = opened.browser;
    context = opened.context;
    const ownerPage = await context.newPage();
    const waitingPage = await context.newPage();
    await Promise.all([
      ownerPage.goto(opened.appUrl, { waitUntil: 'domcontentloaded' }),
      waitingPage.goto(opened.appUrl, { waitUntil: 'domcontentloaded' })
    ]);
    await Promise.all([
      waitForSafeStartup(ownerPage, 'V2 recovery lock owner'),
      waitForSafeStartup(waitingPage, 'V2 recovery waiting page')
    ]);

    await ownerPage.evaluate(() => {
      window.__pendingFocusOwnerPromise = _withStopwatchTransactionLock(async () => {
        const migration = _migrateLegacyTaskCreditMetadataLocked();
        if (!migration || migration.ok !== true)
          throw new Error('Legacy credit migration failed: ' + JSON.stringify(migration));
        const snapshot = _captureFocusTimerSnapshot();
        const task = tasks.find(row => row && row.id === snapshot.taskId);
        const fields = _buildPendingFocusSessionFields(snapshot, task, 5);
        if (!fields) throw new Error('Could not build a valid V2 session payload.');
        const originalRecovery = _recoverPendingFocusCommitLocked;
        _recoverPendingFocusCommitLocked = function() { return false; };
        try {
          window.__pendingFocusCommitStarted = _commitFocusSessionV2Locked(fields);
        } finally {
          _recoverPendingFocusCommitLocked = originalRecovery;
        }
        const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
        window.__pendingFocusJournal = timer.pendingFocusCommit;
        if (window.__pendingFocusCommitStarted !== false || !window.__pendingFocusJournal)
          throw new Error('The pending V2 journal was not durably written.');
        return await new Promise(resolve => { window.__releasePendingFocusOwner = resolve; });
      }).catch(error => {
        window.__pendingFocusOwnerError = String(error && error.stack || error);
      });
      return true;
    });

    await ownerPage.waitForFunction(() =>
      !!window.__pendingFocusJournal
      && _stopwatchTransactionLockDepth === 1
      && window.__pendingFocusOwnerError == null,
    null, { timeout: 10000 });

    const exportAttempt = await waitingPage.evaluate(() => {
      const before = localStorage.getItem('timeTasksApp_focusTimer');
      let exported = false, error = null;
      try {
        buildBackupObject();
        exported = true;
      } catch (caught) {
        error = String(caught && caught.message || caught);
      }
      const after = localStorage.getItem('timeTasksApp_focusTimer');
      return { exported, error, before, after };
    });
    assert.equal(exportAttempt.exported, false,
      'a window with a stale in-memory timer must not export while a V2 journal exists durably');
    assert.ok(exportAttempt.error);
    assert.equal(exportAttempt.after, exportAttempt.before,
      'the refused export must not modify the pending journal');

    const preRecoveryGuards = await ownerPage.evaluate(async () => {
      const rb = {
        main: localStorage.getItem('timeTasksApp_v1'),
        focusSessions: localStorage.getItem('timeTasksApp_focusSessions'),
        focusTimer: localStorage.getItem('timeTasksApp_focusTimer'),
        mentalInbox: null, thoughts: null, projects: null,
        focusSettings: null, notifications: null
      };
      const restore = _restoreStorageSnapshot(rb);
      const rollback = _rollbackRestore(rb);

      localStorage.setItem('timeTasksApp_importInProgress', '1');
      const importRecovery = _recoverInterruptedImport();
      const importMarkerAfter = localStorage.getItem('timeTasksApp_importInProgress');
      localStorage.removeItem('timeTasksApp_importInProgress');

      localStorage.setItem('timeTasksApp_resetInProgress', '{"version":1}');
      const resetRecovery = _recoverInterruptedReset();
      const resetMarkerAfter = localStorage.getItem('timeTasksApp_resetInProgress');
      localStorage.removeItem('timeTasksApp_resetInProgress');

      const manualRollingRestore = _restoreLatestRollingRecoveryBackup();
      const resetBeforeMarker = await _executeResetAllTransaction();
      const resetMarkerAfterTransaction = localStorage.getItem('timeTasksApp_resetInProgress');
      const timerAfter = localStorage.getItem('timeTasksApp_focusTimer');
      return {
        restore, rollback, importRecovery, importMarkerAfter,
        resetRecovery, resetMarkerAfter, manualRollingRestore,
        resetBeforeMarker, resetMarkerAfterTransaction, timerAfter
      };
    });
    assert.equal(preRecoveryGuards.restore, false);
    assert.equal(preRecoveryGuards.rollback, false);
    assert.equal(preRecoveryGuards.importRecovery, false);
    assert.equal(preRecoveryGuards.importMarkerAfter, '1',
      'interrupted import marker must be retained while the V2 transaction is pending');
    assert.equal(preRecoveryGuards.resetRecovery, false);
    assert.equal(preRecoveryGuards.resetMarkerAfter, '{"version":1}',
      'interrupted Reset marker must be retained while the V2 transaction is pending');
    assert.equal(preRecoveryGuards.manualRollingRestore, false);
    assert.equal(preRecoveryGuards.resetBeforeMarker, false,
      'normal Reset must reject the V2 journal before writing its reset marker');
    assert.equal(preRecoveryGuards.resetMarkerAfterTransaction, null,
      'blocked Reset must not create an overlapping recovery marker');
    assert.ok(JSON.parse(preRecoveryGuards.timerAfter).pendingFocusCommit,
      'all rejected backup/restore/import/reset paths must leave the durable journal intact');

    await waitingPage.reload({ waitUntil: 'domcontentloaded' });
    await waitingPage.waitForFunction(() =>
      _startupStopwatchRecoveryInFlight === true
      || _appInitCompleted === true
      || _startupStopwatchRecoveryFailed === true,
    null, { timeout: 10000 });
    const waitingState = await waitingPage.evaluate(async () => {
      const locks = await navigator.locks.query();
      return {
        initialized: _appInitCompleted === true,
        startupInFlight: _startupStopwatchRecoveryInFlight === true,
        startupFailed: _startupStopwatchRecoveryFailed === true,
        waitingForSharedLock: locks.pending.some(request =>
          request.name === 'timeTasksApp-stopwatch-transaction')
      };
    });
    assert.equal(waitingState.startupFailed, false);
    assert.equal(waitingState.initialized, false,
      'the reloading window must not initialize past a journal while another window owns the shared lock');
    assert.equal(waitingState.waitingForSharedLock, true,
      'the second window must be queued on the same Web Lock');

    await ownerPage.evaluate(() => window.__releasePendingFocusOwner());
    await waitForSafeStartup(waitingPage, 'V2 real cross-window journal recovery', 20000);

    const recovered = await waitingPage.evaluate(() => {
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      return {
        task: main.tasks[0],
        operations: main.creditOperations,
        v2Sessions: sessions.filter(row => row && row.recordVersion === 2),
        timer
      };
    });
    assert.equal(recovered.task.actualSeconds, 1020);
    assert.equal(recovered.task.actual, 17);
    assert.equal(recovered.task.creditRevision, 1);
    assert.equal(recovered.operations.length, 1);
    assert.equal(recovered.v2Sessions.length, 1);
    assert.equal(recovered.v2Sessions[0].sessionId, recovered.operations[0].operationId);
    assert.equal(recovered.timer.pendingFocusCommit, null);
    assert.equal(recovered.timer.baseElapsed, 0);

    await waitingPage.reload({ waitUntil: 'domcontentloaded' });
    await waitForSafeStartup(waitingPage, 'V2 transaction after a second reload');
    const finalCounts = await waitingPage.evaluate(() => ({
      operations: JSON.parse(localStorage.getItem('timeTasksApp_v1')).creditOperations.length,
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]')
        .filter(row => row && row.recordVersion === 2).length
    }));
    assert.deepEqual(finalCounts, { operations: 1, sessions: 1 });
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});


test('real finishTimer commits an exact measured linked Stopwatch session through V2 and survives reload once', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser, context;
  try {
    const initial = pendingFocusBrowserInitialState();
    initial.timer.mode = 'stopwatch';
    initial.timer.baseElapsed = 120;
    initial.timer.sessionStartAt = Date.now() - 120000;
    const opened = await openPendingFocusBrowserContext(server, initial);
    browser = opened.browser;
    context = opened.context;
    const page = await context.newPage();
    await page.goto(opened.appUrl, { waitUntil: 'domcontentloaded' });
    await waitForSafeStartup(page, 'V2 real Stopwatch finish page');

    await page.evaluate(() => finishTimer());
    await page.waitForFunction(() => {
      const overlay = document.getElementById('customModalOverlay');
      const footer = document.getElementById('modalFooter');
      return !!overlay && !overlay.classList.contains('hidden') && !!footer
        && Array.from(footer.querySelectorAll('button')).some(button =>
          button.textContent.indexOf('+ 2') >= 0);
    }, null, { timeout: 10000 });
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('#modalFooter button'))
        .find(item => item.textContent.indexOf('+ 2') >= 0);
      if (!button) throw new Error('The measured Stopwatch confirmation button was not found.');
      button.click();
    });

    await page.waitForFunction(() => {
      try {
        const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
        const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
        const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
        return Array.isArray(main.creditOperations) && main.creditOperations.length === 1
          && main.tasks[0].actualSeconds === 840
          && main.tasks[0].actual === 14
          && main.tasks[0].creditRevision === 1
          && sessions.filter(row => row && row.recordVersion === 2).length === 1
          && timer.pendingFocusCommit == null;
      } catch (_error) { return false; }
    }, null, { timeout: 20000 });

    const saved = await page.evaluate(() => {
      const main = JSON.parse(localStorage.getItem('timeTasksApp_v1'));
      const sessions = JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]');
      const timer = JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'));
      return {
        task: main.tasks[0],
        operation: main.creditOperations[0],
        session: sessions.find(row => row && row.recordVersion === 2),
        timer
      };
    });
    assert.equal(saved.task.actualSeconds, 840,
      'legacy 12 minutes migrate to 720 seconds and the measured two-minute Stopwatch adds 120 seconds');
    assert.equal(saved.task.actual, 14);
    assert.equal(saved.task.creditRevision, 1);
    assert.equal(saved.task.lastCreditOperationId, saved.operation.operationId);
    assert.equal(saved.operation.previousSeconds, 720);
    assert.equal(saved.operation.targetSeconds, 840);
    assert.equal(saved.operation.kind, 'session');
    assert.equal(saved.session.mode, 'stopwatch');
    assert.equal(saved.session.phase, 'work');
    assert.equal(saved.session.outcome, 'stopped');
    assert.equal(saved.session.completed, false);
    assert.equal(saved.session.plannedDurationMs, null);
    assert.equal(saved.session.creditSource, 'measured');
    assert.equal(saved.session.creditedSeconds, 120);
    assert.equal(saved.session.sessionId, saved.operation.operationId);
    assert.equal(saved.timer.pendingFocusCommit, null);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSafeStartup(page, 'V2 Stopwatch after reload');
    const afterReload = await page.evaluate(() => ({
      actualSeconds: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks[0].actualSeconds,
      operationCount: JSON.parse(localStorage.getItem('timeTasksApp_v1')).creditOperations.length,
      v2SessionCount: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]')
        .filter(row => row && row.recordVersion === 2).length
    }));
    assert.deepEqual(afterReload, { actualSeconds: 840, operationCount: 1, v2SessionCount: 1 });
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
