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
    const pendingId = await pageA.evaluate(() => {
      // Startup reconciliation in the second page may legitimately write default metadata.
      // Refresh the owner page's in-memory main record and durable-key baselines before the test.
      _mainStorageExternalChangeObserved = false;
      _focusTimerExternalConflict = false;
      _secondaryStorageConflicts = Object.create(null);
      loadData();
      _setMainStorageBaseline(localStorage.getItem(STORAGE_KEY));
      _secondaryStorageBaselines[FOCUS_TIMER_KEY] = localStorage.getItem(FOCUS_TIMER_KEY);
      _secondaryStorageBaselines[FOCUS_SESSIONS_KEY] = localStorage.getItem(FOCUS_SESSIONS_KEY);
      _loadFocusTimer();
      _setMainStorageBaseline(localStorage.getItem(STORAGE_KEY));
      _mainStorageExternalChangeObserved = false;
      _focusTimerExternalConflict = false;
      _secondaryStorageConflicts = Object.create(null);
      const task = tasks.find(item => item.id === 7021);
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
    const result = await pageB.evaluate(() => {
      window._mainStorageExternalChangeObserved = false;
      window._focusTimerExternalConflict = false;
      window._secondaryStorageConflicts = Object.create(null);
      const keys = Object.keys(localStorage).sort();
      const before = {};
      keys.forEach(key => { before[key] = localStorage.getItem(key); });
      let exportError = null;
      try { buildBackupObject(); } catch (error) { exportError = error.message; }
      const rollingSaved = _storeRollingRecoveryBackup('stale-window-test', 0);
      const after = {};
      Object.keys(localStorage).sort().forEach(key => { after[key] = localStorage.getItem(key); });
      return {
        exportError, rollingSaved, rollingFailure: _rollingRecoveryBackupLastFailure,
        storageUnchanged: JSON.stringify(before) === JSON.stringify(after),
        pending: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')).pendingStopwatchTransaction
      };
    });
    assert.ok(result.exportError && /نافذة أخرى|تغير سجل المهام|تغيرت بيانات|معاملة Stopwatch معلقة/.test(result.exportError));
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
  let browserInstance;
  try {
    browserInstance = await chromium.launch({ headless: true });
    const context = await browserInstance.newContext({ serviceWorkers: 'block' });
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
      () => window._mainStorageBaselineReady === true && typeof window._applyStopwatchSave === 'function',
      null, { timeout: 20000 }
    )));
    await Promise.all([
      pageA.evaluate(async () => await _applyStopwatchSave(125, tasks.find(item => item.id === 7031), 3)),
      pageB.evaluate(async () => await _applyStopwatchSave(125, tasks.find(item => item.id === 7031), 3))
    ]);
    const state = await pageA.evaluate(() => ({
      task: JSON.parse(localStorage.getItem('timeTasksApp_v1')).tasks.find(item => item.id === 7031),
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]')
        .filter(item => item.taskId === 7031),
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer'))
    }));
    assert.equal(state.task.actual, 8);
    assert.equal(typeof state.task.lastStopwatchTransactionId, 'string');
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].transactionId, state.task.lastStopwatchTransactionId);
    assert.equal(state.timer.pendingStopwatchTransaction, null);
    await context.close();
  } finally {
    if (browserInstance) await browserInstance.close();
    await new Promise(resolve => server.close(resolve));
  }
});
