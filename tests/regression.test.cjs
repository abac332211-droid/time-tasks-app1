const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const inlineScripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map((match) => match[1])
  .filter((source) => source.trim());
const appScript = inlineScripts.find((source) => source.includes('APP_VERSION'));
assert.ok(appScript, 'the application inline script exists');

function extractFunction(name) {
  const pattern = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists in index.html');
  return match[0];
}

test('inline application and service worker JavaScript parse', () => {
  for (const source of inlineScripts) new vm.Script(source);
  new vm.Script(sw);
});

test('application, package, and PWA cache versions agree', () => {
  assert.match(html, /<title>إدارة الوقت والمهام — 2\.8\.8<\/title>/);
  assert.match(appScript, /const APP_VERSION = "2\.8\.8";/);
  assert.equal(pkg.version, '2.8.8');
  assert.match(sw, /timetasks-cache-v2\.8\.8/);
});

test('service worker precache only references files that exist', () => {
  const block = sw.match(/const ASSETS_TO_CACHE\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(block, 'precache list exists');
  const assets = Array.from(block[1].matchAll(/['"]([^'"]+)['"]/g)).map((m) => m[1]);
  assert.ok(!assets.includes('./icon.svg'), 'no reference to missing icon.svg');
  for (const asset of assets) {
    if (asset === './') continue;
    assert.ok(fs.existsSync(path.join(root, asset)), 'precache asset exists: ' + asset);
  }
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(root, icon.src)), 'manifest icon exists: ' + icon.src);
  }
});

test('service worker does not delete unrelated origin caches', () => {
  assert.match(sw, /cache\.indexOf\('timetasks-cache-'\)\s*===\s*0/);
});

function timerSandbox(saveSessions, saveTimer) {
  const saved = [];
  const sandbox = {
    FOCUS_MAX_SESSIONS: 5000,
    _focusTimer: {
      running: true,
      mode: 'pomodoro',
      phase: 'short-break',
      taskId: null,
      startedAt: Date.now() - (4 * 3600 + 10) * 1000,
      sessionStartAt: Date.now() - (4 * 3600 + 10) * 1000,
      baseElapsed: 0,
      cyclePosition: 0
    },
    tasks: [],
    _getElapsedSec: () => 4 * 3600 + 10,
    _loadSessions: () => saved.slice(),
    _saveSessions: (arr) => {
      if (saveSessions && !saveSessions(arr)) return false;
      saved.splice(0, saved.length, ...arr);
      return true;
    },
    _saveFocusTimer: () => saveTimer ? saveTimer(sandbox._focusTimer) : true,
    _stopDisplayTick: () => {},
    _renderFocusTimer: () => {},
    renderFocusSessionsCard: () => {},
    showToast: () => {},
    showAlertModal: () => {}
  };
  vm.runInNewContext(extractFunction('_logSession') + '\n' + extractFunction('_catchUp'), sandbox);
  sandbox.savedSessions = saved;
  return sandbox;
}

test('long-background timer uses the idempotent session logger', () => {
  const sandbox = timerSandbox(null, () => false);
  const persistedRunningState = { ...sandbox._focusTimer };
  sandbox._catchUp();
  assert.equal(sandbox.savedSessions.length, 1);
  assert.equal(sandbox.savedSessions[0].durationSec, 4 * 3600 + 10);
  assert.equal(sandbox._focusTimer.running, false);
  assert.equal(sandbox._focusTimer.baseElapsed, 0);

  // Simulate reload after timer-state write failed: the previously persisted running
  // timer is restored, but logging the same start/task/mode/phase must not duplicate it.
  sandbox._focusTimer = { ...persistedRunningState };
  sandbox._catchUp();
  assert.equal(sandbox.savedSessions.length, 1);
});

test('failed long-background session save preserves elapsed time for recovery', () => {
  const sandbox = timerSandbox(() => false, () => true);
  sandbox._catchUp();
  assert.equal(sandbox.savedSessions.length, 0);
  assert.equal(sandbox._focusTimer.running, false);
  assert.equal(sandbox._focusTimer.baseElapsed, 4 * 3600 + 10);
  assert.equal(sandbox._focusTimer.phase, 'short-break', 'phase is not reset after failed session write');
});

function recurrenceSandbox(tasks) {
  const sandbox = {
    tasks,
    appSettings: { lastRecurringDates: {} },
    todayStr: () => '2026-11-04',
    getNextTaskId: (() => {
      let next = Math.max(0, ...tasks.map((task) => task.id)) + 1;
      return () => next++;
    })()
  };
  vm.runInNewContext(
    extractFunction('_shouldGenerateToday') + '\n' + extractFunction('_generateRecurringTasksForToday'),
    sandbox
  );
  return sandbox;
}

test('orphan recurring copies do not become new series roots', () => {
  const orphan = {
    id: 42, name: 'تابعة يتيمة', type: 'معرفية', status: 'pending',
    expected: 30, actual: null, plannedDate: '2026-01-01', plannedTime: '',
    completedAt: null, createdAt: 1, recurrence: 'daily',
    _recurringGenerated: true, _sourceTaskId: 7
  };
  const sandbox = recurrenceSandbox([orphan]);
  assert.equal(sandbox._generateRecurringTasksForToday(), 0);
  assert.equal(sandbox.tasks.length, 1);
});

test('valid recurring root generates one occurrence and never duplicates same day', () => {
  const rootTask = {
    id: 1, name: 'مهمة أصلية', type: 'معرفية', status: 'pending',
    expected: 25, actual: null, plannedDate: '2026-01-01', plannedTime: '',
    completedAt: null, createdAt: 1, recurrence: 'daily'
  };
  const sandbox = recurrenceSandbox([rootTask]);
  assert.equal(sandbox._generateRecurringTasksForToday(), 1);
  assert.equal(sandbox.tasks.length, 2);
  assert.equal(sandbox.tasks[1]._sourceTaskId, 1);
  assert.equal(sandbox._generateRecurringTasksForToday(), 0);
  assert.equal(sandbox.tasks.length, 2);
});

test('backup validator rejects malformed version and storage settings', () => {
  const sandbox = {
    CURRENT_SCHEMA_VERSION: 2,
    BACKUP_FORMAT_VERSION: 1,
    VALID_STATUS: ['pending', 'done', 'partial', 'cancelled'],
    VALID_TYPES: ['معرفية', 'إدارية', 'إبداعية', 'اجتماعية'],
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    isValidLocalTime: (value) => value === '' || /^\d{2}:\d{2}$/.test(value),
    isValidLocalDateTime: (value) => typeof value === 'string',
    validateDailyLog: () => true
  };
  vm.runInNewContext(extractFunction('validateBackup'), sandbox);
  assert.equal(sandbox.validateBackup({ backupFormatVersion: 1.5, schemaVersion: 2, data: { tasks: [], dailyLogs: [] } }).valid, false);
  assert.equal(sandbox.validateBackup({ backupFormatVersion: 1, schemaVersion: 2, data: { settings: { operationalDayStart: 24 }, tasks: [], dailyLogs: [] } }).valid, false);
  assert.equal(sandbox.validateBackup({ backupFormatVersion: 1, schemaVersion: 2, data: { tasks: [], dailyLogs: [] } }).valid, true);
});

test('backup validator rejects malformed focus-session timestamps', () => {
  const sandbox = {
    CURRENT_SCHEMA_VERSION: 2,
    BACKUP_FORMAT_VERSION: 1,
    VALID_STATUS: ['pending', 'done', 'partial', 'cancelled'],
    VALID_TYPES: ['معرفية', 'إدارية', 'إبداعية', 'اجتماعية'],
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    isValidLocalTime: (value) => value === '' || /^\d{2}:\d{2}$/.test(value),
    isValidLocalDateTime: (value) => typeof value === 'string',
    validateDailyLog: () => true
  };
  vm.runInNewContext(extractFunction('validateBackup'), sandbox);
  const result = sandbox.validateBackup({
    backupFormatVersion: 1,
    schemaVersion: 2,
    data: {
      tasks: [], dailyLogs: [],
      focusSessions: [{ durationSec: 60, startedAt: 'not-a-date', mode: 'pomodoro', phase: 'work' }]
    }
  });
  assert.equal(result.valid, false);
});


test('weekly report separates planned cohort from actual completion dates', () => {
  const weekDays = [
    '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04',
    '2026-11-05', '2026-11-06', '2026-11-07'
  ];
  const tasks = [
    {
      id: 1, plannedDate: '2026-11-02', status: 'done',
      completedAt: '2026-10-31T23:00:00', expected: 30, actual: 20
    },
    {
      id: 2, plannedDate: '2026-10-31', status: 'done',
      completedAt: '2026-11-04T10:00:00', expected: 30, actual: 25
    },
    {
      id: 3, plannedDate: '2026-11-03', status: 'pending',
      completedAt: null, expected: 20, actual: null
    }
  ];
  const sandbox = {
    getLast7OperationalDays: () => weekDays,
    localStorage: { getItem: () => JSON.stringify({ dailyLogs: [] }) },
    tasks,
    isTaskCancelled: (task) => task.status === 'cancelled',
    isTaskDone: (task) => task.status === 'done',
    _operationalDateFromIso: (value) => String(value).slice(0, 10)
  };
  vm.runInNewContext(extractFunction('computeWeeklyReport'), sandbox);
  const report = sandbox.computeWeeklyReport();
  assert.equal(report.totalTasks, 2, 'only tasks planned for this week belong to its plan cohort');
  assert.equal(report.doneTasks, 1, 'completed-plan count follows the planned cohort');
  assert.equal(report.completedThisWeek, 1, 'actual weekly completions follow completedAt, even for older planned tasks');
});


test('restored notebook records normalize imported IDs before inline event handlers use them', () => {
  const thoughtsSandbox = {
    THOUGHTS_KEY: 'thoughts',
    localStorage: {
      getItem: () => JSON.stringify([{
        id: '1);globalThis.pwned=true;//',
        text: '<img src=x onerror=alert(1)>',
        createdAt: '2026-11-04T10:00:00.000Z'
      }])
    }
  };
  vm.runInNewContext(extractFunction('_loadThoughts'), thoughtsSandbox);
  const thoughts = thoughtsSandbox._loadThoughts();
  assert.equal(thoughts.length, 1);
  assert.equal(typeof thoughts[0].id, 'number');
  assert.equal(thoughts[0].id, 1);
  assert.equal(thoughts[0].text, '<img src=x onerror=alert(1)>', 'raw text stays data and is escaped at render time');

  const inboxSandbox = {
    MENTAL_INBOX_KEY: 'inbox',
    localStorage: {
      getItem: () => JSON.stringify([{
        id: '2);globalThis.pwned=true;//',
        text: '<svg onload=alert(1)>',
        next: '',
        createdAt: '2026-11-04T10:00:00.000Z'
      }])
    }
  };
  vm.runInNewContext(extractFunction('_loadMentalInbox'), inboxSandbox);
  const inbox = inboxSandbox._loadMentalInbox();
  assert.equal(inbox.length, 1);
  assert.equal(typeof inbox[0].id, 'number');
  assert.equal(inbox[0].id, 1);
});


test('startup restores a valid snapshot when backup import was interrupted', () => {
  const markerKey = 'timeTasksApp_importInProgress';
  const backupKey = 'timeTasksApp_preImportBackup';
  const previous = {
    main: JSON.stringify({ schemaVersion: 2, tasks: [], dailyLogs: [] }),
    focusSessions: '[]',
    focusTimer: null,
    mentalInbox: '[]',
    thoughts: '[]',
    projects: '[]',
    focusSettings: null,
    notifications: null
  };
  const store = new Map([
    [markerKey, '1'],
    [backupKey, JSON.stringify(previous)]
  ]);
  let restored = null;
  const sandbox = {
    IMPORT_IN_PROGRESS_KEY: markerKey,
    PRE_IMPORT_KEY: backupKey,
    localStorage: {
      getItem: (key) => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key)
    },
    validateV2: (data) => data && data.schemaVersion === 2,
    _restoreStorageSnapshot: (snapshot) => {
      restored = snapshot;
      return true;
    }
  };
  vm.runInNewContext(extractFunction('_recoverInterruptedImport'), sandbox);
  assert.equal(sandbox._recoverInterruptedImport(), true);
  assert.equal(restored.main, previous.main);
  assert.equal(store.has(markerKey), false);
  assert.equal(store.has(backupKey), false);
});

test('startup does not touch storage when no import is in progress', () => {
  const store = new Map([['primary', 'new-data']]);
  let restoreCalled = false;
  const sandbox = {
    IMPORT_IN_PROGRESS_KEY: 'importing',
    PRE_IMPORT_KEY: 'rollback',
    localStorage: { getItem: (key) => store.has(key) ? store.get(key) : null },
    _restoreStorageSnapshot: () => { restoreCalled = true; return true; },
    validateV2: () => true
  };
  vm.runInNewContext(extractFunction('_recoverInterruptedImport'), sandbox);
  assert.equal(sandbox._recoverInterruptedImport(), true);
  assert.equal(restoreCalled, false);
  assert.equal(store.get('primary'), 'new-data');
});

test('startup preserves an invalid rollback snapshot and blocks recovery', () => {
  const markerKey = 'timeTasksApp_importInProgress';
  const backupKey = 'timeTasksApp_preImportBackup';
  const store = new Map([[markerKey, '1'], [backupKey, '{broken-json']]);
  const sandbox = {
    IMPORT_IN_PROGRESS_KEY: markerKey,
    PRE_IMPORT_KEY: backupKey,
    localStorage: { getItem: (key) => store.has(key) ? store.get(key) : null },
    validateV2: () => true,
    _restoreStorageSnapshot: () => { throw new Error('must not be called'); }
  };
  vm.runInNewContext(extractFunction('_recoverInterruptedImport'), sandbox);
  assert.equal(sandbox._recoverInterruptedImport(), false);
  assert.equal(store.get(markerKey), '1');
  assert.equal(store.get(backupKey), '{broken-json');
});


test('normal completed phase save failure preserves phase and elapsed time', () => {
  const sandbox = timerSandbox(() => false, () => true);
  const sessionStartAt = sandbox._focusTimer.sessionStartAt;
  sandbox._getElapsedSec = () => 420;
  sandbox._phaseTargetSec = () => 300;
  sandbox._catchUp();
  assert.equal(sandbox.savedSessions.length, 0);
  assert.equal(sandbox._focusTimer.running, false);
  assert.equal(sandbox._focusTimer.baseElapsed, 420);
  assert.equal(sandbox._focusTimer.phase, 'short-break');
  assert.equal(sandbox._focusTimer.sessionStartAt, sessionStartAt);
});
