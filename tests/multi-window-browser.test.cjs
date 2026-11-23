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
      localStorage.setItem('timeTasksApp_v1', JSON.stringify(initial.main));
      localStorage.setItem('timeTasksApp_focusTimer', JSON.stringify(initial.timer));
      localStorage.setItem('timeTasksApp_focusSessions', '[]');
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
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
