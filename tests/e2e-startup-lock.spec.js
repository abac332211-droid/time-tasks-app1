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
    pendingStopwatchTransaction: tx,
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
    await context.addInitScript((initial, withoutLocks) => {
      const nativeSetItem = Storage.prototype.setItem;
      const nativeRemoveItem = Storage.prototype.removeItem;

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

      window.__startupStorageWrites = [];
      Storage.prototype.setItem = function(key, value) {
        window.__startupStorageWrites.push({ operation: 'set', key: String(key), value: String(value) });
        return nativeSetItem.call(this, key, value);
      };
      Storage.prototype.removeItem = function(key) {
        window.__startupStorageWrites.push({ operation: 'remove', key: String(key) });
        return nativeRemoveItem.call(this, key);
      };

      if (withoutLocks) {
        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          value: undefined
        });
      }
    }, seed, options.withoutLocks === true);
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

test('D-03.1 startup remains read-only and blocks writes while the Stopwatch lock is held', {
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
      beforeRelease.writesAfter.filter(item => item.key === MAIN_KEY || item.key === TIMER_KEY),
      [],
      'neither load/migration nor timer persistence may write protected keys while recovery waits'
    );

    await releaseStopwatchLock(controller);
    await waitForStartupSuccess(appPage);
    const afterRelease = await appPage.evaluate(() => ({
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      main: JSON.parse(localStorage.getItem('timeTasksApp_v1')),
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]')
    }));
    assert.equal(afterRelease.main.tasks[0].actual, 8);
    assert.equal(afterRelease.sessions.length, 1);
    assert.equal(afterRelease.timer.pendingStopwatchTransaction, null);
  } finally {
    if (controller) await releaseStopwatchLock(controller).catch(() => {});
    await closeBrowserContext(runtime);
  }
});

test('D-03.2 two same-origin tabs recover one transaction once and the waiter proves the sibling commit', {
  skip: chromium ? false : 'Playwright is installed only in the dedicated CI browser step'
}, async () => {
  const runtime = await startBrowserContext();
  let pageA;
  let pageB;
  try {
    pageA = await runtime.context.newPage();
    pageB = await runtime.context.newPage();
    await Promise.all([
      pageA.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' }),
      pageB.goto(runtime.appUrl, { waitUntil: 'domcontentloaded' })
    ]);
    await Promise.all([waitForStartupSuccess(pageA), waitForStartupSuccess(pageB)]);

    const result = await pageA.evaluate(() => ({
      main: JSON.parse(localStorage.getItem('timeTasksApp_v1')),
      timer: JSON.parse(localStorage.getItem('timeTasksApp_focusTimer')),
      sessions: JSON.parse(localStorage.getItem('timeTasksApp_focusSessions') || '[]')
    }));
    assert.equal(result.main.tasks[0].actual, 8,
      'the task must receive the three transaction minutes once, not twice');
    assert.equal(result.main.tasks[0].lastStopwatchTransactionId, runtime.seed.tx.id);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].transactionId, runtime.seed.tx.id);
    assert.equal(result.sessions[0].taskId, runtime.seed.tx.taskId);
    assert.equal(result.sessions[0].durationSec, runtime.seed.tx.durationSec);
    assert.equal(result.timer.pendingStopwatchTransaction, null);
  } finally {
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
