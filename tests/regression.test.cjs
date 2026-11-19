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
  assert.match(html, /<title>إدارة الوقت والمهام — 2\.9\.0<\/title>/);
  assert.match(appScript, /const APP_VERSION = "2\.9\.0";/);
  assert.equal(pkg.version, '2.9.0');
  assert.match(sw, /timetasks-cache-v2\.9\.0/);
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

test('service worker is isolated from unrelated origin caches', () => {
  assert.match(sw, /cache\.indexOf\('timetasks-cache-'\)\s*===\s*0/);
  assert.match(sw, /cache\.match\(req\)/);
  assert.doesNotMatch(sw, /caches\.match\(/);
});


function timerSandbox(saveSessions, saveTimer) {
  const saved = [];
  let promptCount = 0, alertCount = 0;
  const sandbox = {
    FOCUS_MAX_SESSIONS: 5000,
    _focusTimer: {
      running: true, mode: 'pomodoro', phase: 'short-break', taskId: null,
      startedAt: Date.now() - (4 * 3600 + 10) * 1000,
      sessionStartAt: Date.now() - (4 * 3600 + 10) * 1000,
      baseElapsed: 0, cyclePosition: 0, awaitingConfirmation: false, pendingPhaseEndedAt: null
    },
    tasks: [],
    _getElapsedSec: () => 4 * 3600 + 10,
    _phaseTargetSec: () => 5 * 60,
    _loadSessions: () => saved.slice(),
    _saveSessions: (arr) => {
      if (saveSessions && !saveSessions(arr)) return false;
      saved.splice(0, saved.length, ...arr);
      return true;
    },
    _saveFocusTimer: () => saveTimer ? saveTimer(sandbox._focusTimer) : true,
    _stopDisplayTick: () => {}, _renderFocusTimer: () => {}, renderFocusSessionsCard: () => {},
    _showAwaySessionConfirmation: () => { promptCount++; },
    showToast: () => {}, showAlertModal: () => { alertCount++; }
  };
  vm.runInNewContext(extractFunction('_logSession') + '\n' + extractFunction('_catchUp'), sandbox);
  sandbox.savedSessions = saved;
  Object.defineProperty(sandbox, 'promptCount', { get: () => promptCount });
  Object.defineProperty(sandbox, 'alertCount', { get: () => alertCount });
  return sandbox;
}

test('background return freezes one Pomodoro phase and waits for explicit approval', () => {
  const sandbox = timerSandbox(null, () => true);
  sandbox._catchUp(true);
  assert.equal(sandbox.savedSessions.length, 0);
  assert.equal(sandbox._focusTimer.running, false);
  assert.equal(sandbox._focusTimer.baseElapsed, 5 * 60);
  assert.equal(sandbox._focusTimer.awaitingConfirmation, true);
  assert.equal(sandbox.promptCount, 1);
});

test('long background absence never synthesizes repeated focus and break sessions', () => {
  const sandbox = timerSandbox(null, () => true);
  sandbox._catchUp(true);
  assert.equal(sandbox.savedSessions.length, 0);
  assert.equal(sandbox._focusTimer.awaitingConfirmation, true);
  assert.equal(sandbox._focusTimer.phase, 'short-break');
  assert.equal(sandbox._focusTimer.baseElapsed, 5 * 60);
  assert.equal(sandbox.promptCount, 1);
});

test('failed persistence of a pending background phase does not create a fake session', () => {
  const sandbox = timerSandbox(null, () => false);
  sandbox._catchUp(true);
  assert.equal(sandbox.savedSessions.length, 0);
  assert.equal(sandbox._focusTimer.running, false);
  assert.equal(sandbox._focusTimer.awaitingConfirmation, true);
  assert.equal(sandbox._focusTimer.baseElapsed, 5 * 60);
  assert.equal(sandbox.promptCount, 0);
  assert.equal(sandbox.alertCount, 1);
});


test('resume keeps the original sessionStartAt instead of drifting it forward', () => {
  const sandbox = {
    _focusTimer: { running: false, baseElapsed: 420, startedAt: null, sessionStartAt: 123456789, awaitingConfirmation: false },
    _getElapsedSec: () => 420, _unlockAudioContext: () => {}, _startDisplayTick: () => {},
    _stopDisplayTick: () => {}, _saveFocusTimer: () => true, _renderFocusTimer: () => {}, showToast: () => {}
  };
  vm.runInNewContext(extractFunction('toggleTimer'), sandbox);
  sandbox.toggleTimer();
  assert.equal(sandbox._focusTimer.sessionStartAt, 123456789);
  assert.equal(sandbox._focusTimer.running, true);
  assert.equal(typeof sandbox._focusTimer.startedAt, 'number');
});

test('legacy partial task status is healed to pending before strict stored validation', () => {
  const sandbox = {};
  vm.runInNewContext(extractFunction('_healTaskArray'), sandbox);
  const tasks = [{ id: 1, status: 'partial' }, { id: 2, status: 'done' }];
  assert.equal(sandbox._healTaskArray(tasks), true);
  assert.equal(tasks[0].status, 'pending');
  assert.equal(tasks[1].status, 'done');
  assert.match(appScript, /const VALID_STATUS = \["pending", "done", "cancelled"\]/);
});

test('recurring date pruning preserves valid historical dates and removes invalid values', () => {
  const sandbox = {
    appSettings: { lastRecurringDates: { 'series:1': '2026-10-01', 'series:2': '2026-11-04', 'series:3': 'yesterday', constructor: '2026-10-01' } },
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    todayStr: () => '2026-11-04'
  };
  vm.runInNewContext(extractFunction('_pruneLastRecurringDates'), sandbox);
  sandbox._pruneLastRecurringDates();
  assert.equal(sandbox.appSettings.lastRecurringDates['series:1'], '2026-10-01');
  assert.equal(sandbox.appSettings.lastRecurringDates['series:2'], '2026-11-04');
  assert.equal(sandbox.appSettings.lastRecurringDates['series:3'], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(sandbox.appSettings.lastRecurringDates, 'constructor'), false);
});

test('legacy theme preference is preserved and new data supports system color scheme', () => {
  let darkClass = false, dataTheme = null;
  const listeners = [];
  const sandbox = {
    appSettings: {},
    window: { matchMedia: () => ({ matches: true, addEventListener: (_name, fn) => listeners.push(fn) }) },
    document: {
      body: { classList: { toggle: (_name, enabled) => { darkClass = enabled; } } },
      documentElement: { setAttribute: (_name, value) => { dataTheme = value; } }
    },
    _syncThemeMeta: () => {}
  };
  vm.runInNewContext(extractFunction('_applyThemePreference') + '\n' + extractFunction('_loadAppSettings') + '\n' + extractFunction('_setupSystemThemeListener'), sandbox);
  sandbox._loadAppSettings({ darkMode: false });
  assert.equal(sandbox.appSettings.themeMode, 'light');
  assert.equal(darkClass, false);
  sandbox._loadAppSettings({ themeMode: 'system', darkMode: false });
  assert.equal(sandbox.appSettings.themeMode, 'system');
  assert.equal(darkClass, true);
  sandbox._setupSystemThemeListener();
  assert.equal(listeners.length, 1);
  assert.equal(dataTheme, 'system');
});

test('deferred phase notifications have a finite expiry, not periodic polling', () => {
  assert.match(appScript, /PENDING_PHASE_NOTIFICATION_TTL_MS = 10000/);
  const body = extractFunction('closeModal');
  assert.match(body, /Date\.now\(\) - queuedAt > PENDING_PHASE_NOTIFICATION_TTL_MS/);
  assert.doesNotMatch(body, /setInterval/);
});

test('backup validator accepts legacy partial for import healing', () => {
  const sandbox = {
    CURRENT_SCHEMA_VERSION: 2, BACKUP_FORMAT_VERSION: 1,
    VALID_STATUS: ['pending', 'done', 'cancelled'],
    VALID_TYPES: ['معرفية', 'إدارية', 'إبداعية', 'اجتماعية'],
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    isValidLocalTime: (value) => value === '' || /^\d{2}:\d{2}$/.test(value),
    isValidLocalDateTime: (value) => typeof value === 'string',
    validateDailyLog: () => true
  };
  vm.runInNewContext(extractFunction('validateBackup'), sandbox);
  const backup = { backupFormatVersion: 1, schemaVersion: 2, data: {
    tasks: [{ id: 1, name: 'قديم', status: 'partial', type: 'معرفية', expected: 20, actual: null, plannedDate: '2026-11-04', plannedTime: '', completedAt: null, createdAt: 1 }],
    dailyLogs: []
  } };
  assert.equal(sandbox.validateBackup(backup).valid, true);
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
    VALID_STATUS: ['pending', 'done', 'cancelled'],
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
    VALID_STATUS: ['pending', 'done', 'cancelled'],
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


test('backup and stored schema reject prototype-polluting settings keys', () => {
  const sandbox = {
    CURRENT_SCHEMA_VERSION: 2,
    BACKUP_FORMAT_VERSION: 1,
    VALID_STATUS: ['pending', 'done', 'cancelled'],
    VALID_TYPES: ['معرفية', 'إدارية', 'إبداعية', 'اجتماعية'],
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    isValidLocalTime: (value) => value === '' || /^\d{2}:\d{2}$/.test(value),
    isValidLocalDateTime: (value) => typeof value === 'string',
    validateDailyLog: () => true
  };
  const unsafeSettings = JSON.parse('{"__proto__":{"polluted":true}}');
  vm.runInNewContext(extractFunction('validateBackup'), sandbox);
  const backupResult = sandbox.validateBackup({
    backupFormatVersion: 1,
    schemaVersion: 2,
    data: { settings: unsafeSettings, tasks: [], dailyLogs: [] }
  });
  assert.equal(backupResult.valid, false);

  vm.runInNewContext(extractFunction('validateV2'), sandbox);
  const storedResult = sandbox.validateV2({
    schemaVersion: 2,
    settings: unsafeSettings,
    tasks: [],
    dailyLogs: []
  });
  assert.equal(storedResult, false);
});


test('stored schema rejects duplicate task IDs before normal app use', () => {
  const sandbox = {
    CURRENT_SCHEMA_VERSION: 2,
    VALID_STATUS: ['pending', 'done', 'cancelled'],
    VALID_TYPES: ['معرفية', 'إدارية', 'إبداعية', 'اجتماعية'],
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    isValidLocalTime: (value) => value === '' || /^\d{2}:\d{2}$/.test(value),
    isValidLocalDateTime: (value) => typeof value === 'string',
    validateDailyLog: () => true
  };
  vm.runInNewContext(extractFunction('validateV2'), sandbox);
  const task = {
    id: 1, name: 'مهمة', status: 'pending', type: 'معرفية',
    expected: 30, actual: null, plannedDate: '2026-11-04',
    plannedTime: '', completedAt: null, createdAt: 1
  };
  assert.equal(sandbox.validateV2({
    schemaVersion: 2, tasks: [task], dailyLogs: []
  }), true);
  assert.equal(sandbox.validateV2({
    schemaVersion: 2, tasks: [task, { ...task }], dailyLogs: []
  }), false);
});


test('release workflow creates a downloadable web ZIP and uses Node 24 compatible actions', () => {
  const verify = fs.readFileSync(path.join(root, '.github/workflows/verify-pwa.yml'), 'utf8');
  const apk = fs.readFileSync(path.join(root, '.github/workflows/build-apk.yml'), 'utf8');
  assert.match(verify, /actions\/checkout@v5/);
  assert.match(verify, /actions\/setup-node@v5/);
  assert.match(verify, /node-version:\s*'22'/);
  assert.match(verify, /zip -9 -r \.\.\/time-tasks-app-2\.9\.0-web\.zip/);
  assert.match(verify, /name:\s*time-tasks-app-2\.9\.0-web/);
  assert.match(verify, /retention-days:\s*90/);
  assert.match(verify, /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(apk, /actions\/checkout@v5/);
  assert.match(apk, /actions\/setup-node@v5/);
  assert.doesNotMatch(verify + apk, /actions\/(?:checkout|setup-node)@v4/);
});
