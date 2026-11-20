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

test('replayed pending confirmation does not log the same focus phase twice', () => {
  const startedAt = new Date(1_000).toISOString();
  const existing = {
    id: 1,
    mode: 'pomodoro',
    phase: 'work',
    taskId: 10,
    taskName: 'مهمة التركيز',
    startedAt,
    endedAt: new Date(55_000).toISOString(),
    durationSec: 1_500,
    completed: true
  };
  const sessions = [existing];
  let saveCalls = 0;
  const sandbox = {
    _focusTimer: {
      sessionStartAt: 1_000,
      taskId: 10,
      mode: 'pomodoro'
    },
    tasks: [{ id: 10, name: 'مهمة التركيز' }],
    _loadSessions: () => sessions.slice(),
    _saveSessions: () => { saveCalls++; return true; },
    showToast: () => { throw new Error('duplicate confirmation must not announce a new save'); }
  };
  vm.runInNewContext(extractFunction('_logSession'), sandbox);

  assert.equal(sandbox._logSession('work', 1_500, true, 55_000), true);
  assert.equal(sessions.length, 1);
  assert.equal(saveCalls, 0);
});

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
    isValidLocalTime: () => true,
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
  const release = fs.readFileSync(path.join(root, '.github/workflows/build-release-apk.yml'), 'utf8');
  assert.match(verify, /actions\/checkout@v5/);
  assert.match(verify, /actions\/setup-node@v5/);
  assert.match(verify, /node-version:\s*'22'/);
  assert.match(verify, /zip -9 -r \.\.\/time-tasks-app-2\.9\.0-web\.zip/);
  assert.match(verify, /name:\s*time-tasks-app-2\.9\.0-web/);
  assert.match(verify, /retention-days:\s*90/);
  assert.match(verify, /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(apk, /actions\/checkout@v5/);
  assert.match(apk, /actions\/setup-node@v5/);
  assert.match(release, /name: Run regression tests/);
  assert.match(release, /run: npm test/);
  assert.match(release, /apksigner verify --verbose/);
  for (const workflow of [verify, apk, release]) {
    assert.ok(workflow.includes('actions/upload-artifact@v7.0.2'));
    assert.ok(!workflow.includes('actions/upload-artifact@v4'));
  }
  assert.doesNotMatch(verify + apk + release, /actions\/(?:checkout|setup-node)@v4/);
});;;


test('monthly recurrence anchored on the 31st uses month-end fallback without drifting', () => {
  const sandbox = {};
  vm.runInNewContext(extractFunction('_shouldGenerateToday'), sandbox);
  const root = { recurrence: 'monthly', plannedDate: '2026-01-31' };

  assert.equal(sandbox._shouldGenerateToday(root, '2026-02-28'), true);
  assert.equal(sandbox._shouldGenerateToday(root, '2026-02-27'), false);
  assert.equal(sandbox._shouldGenerateToday(root, '2026-03-31'), true);
});

test('monthly recurrence handles leap February using the original anchor date', () => {
  const sandbox = {};
  vm.runInNewContext(extractFunction('_shouldGenerateToday'), sandbox);
  const leapAnchor = { recurrence: 'monthly', plannedDate: '2024-01-29' };
  const commonYearAnchor = { recurrence: 'monthly', plannedDate: '2025-01-29' };

  assert.equal(sandbox._shouldGenerateToday(leapAnchor, '2024-02-29'), true);
  assert.equal(sandbox._shouldGenerateToday(leapAnchor, '2024-02-28'), false);
  assert.equal(sandbox._shouldGenerateToday(commonYearAnchor, '2025-02-28'), true);
});

function recurrencePersistenceSandbox(tasks, saveResult) {
  const appSettings = {
    lastRecurringDates: {},
    lastTaskId: Math.max(0, ...tasks.map((task) => task.id))
  };
  let saveCalls = 0;
  let toastCalls = 0;
  const reminderSyncs = [];
  const sandbox = {
    tasks,
    appSettings,
    todayStr: () => '2026-11-04',
    getNextTaskId: () => ++appSettings.lastTaskId,
    saveData: () => {
      saveCalls++;
      return saveResult;
    },
    _queueTaskReminderSync: (task) => { reminderSyncs.push(task.id); },
    showToast: () => { toastCalls++; }
  };
  vm.runInNewContext(
    extractFunction('_shouldGenerateToday') + '\n' +
    extractFunction('_generateRecurringTasksForToday') + '\n' +
    extractFunction('_generateAndPersistRecurringTasks'),
    sandbox
  );
  return {
    sandbox,
    saveCalls: () => saveCalls,
    toastCalls: () => toastCalls,
    reminderSyncs: () => reminderSyncs.slice()
  };
}

test('failed recurring-task persistence rolls back tasks, series dates, and next ID', () => {
  const rootTask = {
    id: 5, name: 'مهمة يومية', type: 'معرفية', status: 'pending',
    expected: 25, actual: null, plannedDate: '2026-01-01', plannedTime: '',
    completedAt: null, createdAt: 1, recurrence: 'daily'
  };
  const harness = recurrencePersistenceSandbox([rootTask], false);

  assert.equal(harness.sandbox._generateAndPersistRecurringTasks(), 0);
  assert.equal(harness.sandbox.tasks.length, 1);
  assert.equal(Object.keys(harness.sandbox.appSettings.lastRecurringDates).length, 0);
  assert.equal(harness.sandbox.appSettings.lastTaskId, 5);
  assert.equal(harness.saveCalls(), 1);
  assert.equal(harness.toastCalls(), 1);
});

test('successful recurring-task persistence is idempotent on repeated startup', () => {
  const rootTask = {
    id: 5, name: 'مهمة يومية', type: 'معرفية', status: 'pending',
    expected: 25, actual: null, plannedDate: '2026-01-01', plannedTime: '',
    completedAt: null, createdAt: 1, recurrence: 'daily'
  };
  const harness = recurrencePersistenceSandbox([rootTask], true);

  assert.equal(harness.sandbox._generateAndPersistRecurringTasks(), 1);
  assert.equal(harness.sandbox.tasks.length, 2);
  assert.equal(harness.sandbox.tasks[1]._sourceTaskId, 5);
  assert.equal(harness.sandbox._generateAndPersistRecurringTasks(), 0);
  assert.equal(harness.sandbox.tasks.length, 2);
  assert.equal(harness.saveCalls(), 1);
  assert.deepEqual(harness.reminderSyncs(), [6]);
  assert.equal(harness.sandbox.appSettings.lastRecurringDates['series:5'], '2026-11-04');
});


function taskFormSandbox(options = {}) {
  const values = {
    taskName: 'مهمة اختبار',
    taskType: 'معرفية',
    taskExpected: '25',
    taskDate: '2026-11-19',
    taskTime: '09:00',
    taskProject: '',
    taskPriority: '',
    taskRecurrence: '',
    taskActual: '',
    ...(options.values || {})
  };
  const elements = Object.create(null);
  const tasks = options.tasks || [];
  const sandbox = {
    tasks,
    editingId: options.editingId ?? null,
    _pendingUncompleteConfirm: false,
    document: {
      getElementById(id) {
        if (!elements[id]) {
          elements[id] = {
            value: values[id] ?? '',
            attributes: Object.create(null),
            removeAttribute(name) { delete this.attributes[name]; },
            setAttribute(name, value) { this.attributes[name] = value; }
          };
        }
        return elements[id];
      }
    },
    todayStr: () => '2026-11-19',
    isValidCalendarDate: () => true,
    isValidLocalTime: () => true,
    localDateTimeString: () => '2026-11-19T09:00:00',
    getNextTaskId: options.getNextTaskId || (() => 10),
    saveData: options.saveData || (() => true),
    reminderSyncs: [],
    _queueTaskReminderSync: (task) => { sandbox.reminderSyncs.push(task.id); return Promise.resolve(true); },
    _queueTaskReminderCancellation: (id) => { sandbox.cancelledReminders = (sandbox.cancelledReminders || []).concat(id); },
    clearForm: () => { sandbox.clearFormCalls++; },
    clearFormCalls: 0,
    showAlertModal: (title, message) => {
      sandbox.alertCalls++;
      sandbox.alertMessages.push({ title, message });
    },
    alertCalls: 0,
    alertMessages: [],
    showToast: () => { sandbox.toastCalls++; },
    toastCalls: 0,
    renderAll: () => { sandbox.renderCalls++; },
    renderCalls: 0,
    cancelEdit: () => { sandbox.cancelEditCalls++; },
    cancelEditCalls: 0,
    showConfirmModal: (title, body, onConfirm) => { onConfirm(); }
  };
  vm.runInNewContext(extractFunction('saveTask'), sandbox);
  return { sandbox, elements };
}

test('new task is not retained in memory when persistence fails', () => {
  const harness = taskFormSandbox({ saveData: () => false });

  harness.sandbox.saveTask();

  assert.equal(harness.sandbox.tasks.length, 0);
  assert.equal(harness.sandbox.renderCalls, 0);
  assert.equal(harness.sandbox.toastCalls, 0);
});

test('new task is retained and rendered only after successful persistence', () => {
  const harness = taskFormSandbox({ saveData: () => true });

  harness.sandbox.saveTask();

  assert.equal(
    harness.sandbox.alertCalls,
    0,
    JSON.stringify(harness.sandbox.alertMessages)
  );
  assert.equal(harness.sandbox.tasks.length, 1);
  assert.equal(harness.sandbox.tasks[0].id, 10);
  assert.equal(harness.sandbox.tasks[0].name, 'مهمة اختبار');
  assert.equal(harness.sandbox.tasks[0].status, 'pending');
  assert.equal(harness.sandbox.tasks[0].plannedDate, '2026-11-19');
  assert.equal(harness.sandbox.renderCalls, 1);
  assert.equal(harness.sandbox.clearFormCalls, 1);
  assert.deepEqual(harness.sandbox.reminderSyncs, [10]);
});

test('editing a task restores every edited field when persistence fails', () => {
  const original = {
    id: 7, name: 'الاسم السابق', type: 'إدارية', expected: 40,
    plannedDate: '2026-11-10', plannedTime: '08:00',
    actual: null, status: 'pending', completedAt: null,
    projectId: null, priority: null, recurrence: null
  };
  const harness = taskFormSandbox({
    tasks: [original],
    editingId: 7,
    saveData: () => false,
    values: {
      taskName: 'اسم جديد',
      taskType: 'إبداعية',
      taskExpected: '60',
      taskDate: '2026-11-19',
      taskTime: '11:30',
      taskPriority: 'high',
      taskRecurrence: 'daily',
      taskActual: '35'
    }
  });

  harness.sandbox.saveTask();

  assert.equal(harness.sandbox.tasks.length, 1);
  assert.equal(original.name, 'الاسم السابق');
  assert.equal(original.type, 'إدارية');
  assert.equal(original.expected, 40);
  assert.equal(original.plannedDate, '2026-11-10');
  assert.equal(original.plannedTime, '08:00');
  assert.equal(original.actual, null);
  assert.equal(original.status, 'pending');
  assert.equal(original.priority, null);
  assert.equal(original.recurrence, null);
  assert.equal(harness.sandbox.renderCalls, 0);
});

test('task completion is rolled back when persistence fails', () => {
  const task = {
    id: 9, name: 'مهمة معلقة', expected: 25,
    actual: null, status: 'pending', completedAt: null
  };
  const sandbox = {
    tasks: [task],
    _focusTimer: { taskId: null },
    isTaskCancelled: () => false,
    showPromptModal: (title, body, value, placeholder, callback) => callback('30'),
    localDateTimeString: () => '2026-11-19T09:00:00',
    saveData: () => false,
    renderAll: () => { throw new Error('must not render unpersisted completion'); },
    showToast: () => { throw new Error('must not announce unpersisted completion'); },
    showAlertModal: () => {}
  };
  vm.runInNewContext(extractFunction('toggleTask'), sandbox);

  sandbox.toggleTask(9);

  assert.equal(task.actual, null);
  assert.equal(task.status, 'pending');
  assert.equal(task.completedAt, null);
});

test('task deletion restores the task and linked focus timer when persistence fails', () => {
  const task = { id: 12, name: 'مهمة مرتبطة', status: 'pending' };
  let timerSaveCalls = 0;
  const sandbox = {
    tasks: [task],
    editingId: null,
    _focusTimer: { taskId: 12 },
    showConfirmModal: (title, body, callback) => callback(),
    _saveFocusTimer: () => { timerSaveCalls++; return true; },
    _renderFocusTimer: () => {},
    saveData: () => false,
    renderAll: () => { throw new Error('must not render unpersisted deletion'); },
    showToast: () => {}
  };
  vm.runInNewContext(extractFunction('deleteTask'), sandbox);

  sandbox.deleteTask(12);

  assert.equal(sandbox.tasks.length, 1);
  assert.equal(sandbox.tasks[0], task);
  assert.equal(sandbox._focusTimer.taskId, 12);
  assert.equal(timerSaveCalls, 2);
});


test('weekday recurrence uses the intended Sunday-to-Thursday workweek', () => {
  const sandbox = {};
  vm.runInNewContext(extractFunction('_shouldGenerateToday'), sandbox);
  const root = { recurrence: 'weekdays', plannedDate: '2026-11-01' };

  assert.equal(sandbox._shouldGenerateToday(root, '2026-11-01'), true);
  assert.equal(sandbox._shouldGenerateToday(root, '2026-11-02'), true);
  assert.equal(sandbox._shouldGenerateToday(root, '2026-11-05'), true);
  assert.equal(sandbox._shouldGenerateToday(root, '2026-11-06'), false);
  assert.equal(sandbox._shouldGenerateToday(root, '2026-11-07'), false);
  assert.equal(sandbox._shouldGenerateToday(root, '2026-10-29'), false);
});

test('weekly recurrence stays on the original anchor weekday', () => {
  const sandbox = {};
  vm.runInNewContext(extractFunction('_shouldGenerateToday'), sandbox);
  const root = { recurrence: 'weekly', plannedDate: '2026-11-02' };

  assert.equal(sandbox._shouldGenerateToday(root, '2026-11-09'), true);
  assert.equal(sandbox._shouldGenerateToday(root, '2026-11-16'), true);
  assert.equal(sandbox._shouldGenerateToday(root, '2026-11-10'), false);
  assert.equal(sandbox._shouldGenerateToday(root, '2026-10-26'), false);
});


test('task completion and undo synchronize reminders after successful persistence', () => {
  const task = {
    id: 19, name: 'مهمة موعدها قادم', expected: 25,
    actual: null, status: 'pending', completedAt: null
  };
  const queued = [];
  const sandbox = {
    tasks: [task],
    _focusTimer: { taskId: null },
    isTaskCancelled: () => false,
    showPromptModal: (_title, _body, _value, _placeholder, callback) => callback('30'),
    localDateTimeString: () => '2026-11-19T09:00:00',
    saveData: () => true,
    renderAll: () => {},
    showToast: () => {},
    showAlertModal: () => {},
    _queueTaskReminderSync: (value) => { queued.push({ id: value.id, status: value.status }); }
  };
  vm.runInNewContext(extractFunction('toggleTask'), sandbox);

  sandbox.toggleTask(19);
  assert.equal(task.status, 'done');
  assert.deepEqual(queued, [{ id: 19, status: 'done' }]);

  sandbox.toggleTask(19);
  assert.equal(task.status, 'pending');
  assert.equal(task.actual, null);
  assert.deepEqual(queued, [
    { id: 19, status: 'done' },
    { id: 19, status: 'pending' }
  ]);
});

test('successful task deletion queues reminder cancellation after persistence', () => {
  const task = { id: 21, name: 'مهمة للحذف', status: 'pending' };
  const cancelled = [];
  const sandbox = {
    tasks: [task],
    editingId: null,
    _focusTimer: { taskId: null },
    showConfirmModal: (_title, _body, callback) => callback(),
    saveData: () => true,
    renderAll: () => {},
    showToast: () => {},
    _queueTaskReminderCancellation: (id) => { cancelled.push(id); }
  };
  vm.runInNewContext(extractFunction('deleteTask'), sandbox);

  sandbox.deleteTask(21);
  assert.equal(sandbox.tasks.length, 0);
  assert.deepEqual(cancelled, [21]);
});


test('home schedule separates overdue, today, and upcoming pending tasks', () => {
  const source = extractFunction('_getHomeScheduleBuckets');
  const today = '2026-11-19';
  const tasks = [
    { id: 1, name: 'موعد اليوم', status: 'pending', plannedDate: today, plannedTime: '18:00' },
    { id: 2, name: 'متأخرة', status: 'pending', plannedDate: '2026-11-18', plannedTime: '09:00' },
    { id: 3, name: 'قادمة', status: 'pending', plannedDate: '2026-11-20', plannedTime: '09:00' },
    { id: 4, name: 'منجزة اليوم', status: 'done', plannedDate: today, plannedTime: '10:00' },
    { id: 5, name: 'ملغاة اليوم', status: 'cancelled', plannedDate: today, plannedTime: '11:00' },
    { id: 6, name: 'تاريخ غير صالح', status: 'pending', plannedDate: '2026-02-30', plannedTime: '' }
  ];
  const sandbox = {
    todayStr: () => today,
    isTaskDone: (task) => task.status === 'done',
    isTaskCancelled: (task) => task.status === 'cancelled',
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
      && (() => {
        const [year, month, day] = value.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
      })(),
    isLate: (task) => task.id === 2,
    parseTaskDate: (date, time) => new Date(date + 'T' + (time || '23:59') + ':00'),
    priorityRank: () => 0
  };
  const result = vm.runInNewContext(
    source + '\n_getHomeScheduleBuckets(tasks, today, isLate)',
    { ...sandbox, tasks, today }
  );
  assert.deepEqual(JSON.parse(JSON.stringify({
    overdue: result.overdue.map((task) => task.id),
    today: result.today.map((task) => task.id),
    upcoming: result.upcoming.map((task) => task.id)
  })), { overdue: [2], today: [1], upcoming: [3] });
});

test('task search matches project, type, priority, recurrence, and checklist text', () => {
  const match = (query) => {
    const sandbox = {};
    vm.runInNewContext(extractFunction('_taskMatchesSearch'), sandbox);
    const task = {
      id: 3,
      name: 'مراجعة أسبوعية',
      type: 'إدارية',
      priority: 'urgent',
      recurrence: 'weekly',
      projectId: 7,
      checklist: [{ text: 'مراجعة الفواتير', done: false }],
      tags: ['ميزانية']
    };
    return sandbox._taskMatchesSearch(task, query, { 7: { name: 'مشروع التشغيل' } });
  };

  assert.equal(match('مراجعة أسبوعية'), true);
  assert.equal(match('إدارية'), true);
  assert.equal(match('urgent'), true);
  assert.equal(match('weekly'), true);
  assert.equal(match('مراجعة الفواتير'), true);
  assert.equal(match('ميزانية'), true);
  assert.equal(match('مشروع التشغيل'), true);
  assert.equal(match('غير موجود'), false);
});

test('task search treats an empty query as a match and safely ignores malformed task fields', () => {
  const sandbox = {};
  vm.runInNewContext(extractFunction('_taskMatchesSearch'), sandbox);

  assert.equal(sandbox._taskMatchesSearch(null, 'بحث', {}), false);
  assert.equal(sandbox._taskMatchesSearch({ name: null, tags: [null, 4], checklist: [null, {}] }, 'بحث', {}), false);
  assert.equal(sandbox._taskMatchesSearch({ name: null }, '   ', {}), true);
  assert.equal(sandbox._taskMatchesSearch({ name: 'قراءة' }, 'قراءة', {}), true);
});

test('task list offers a today filter based on operational todayStr', () => {
  assert.match(extractFunction('renderTasks'), /currentFilter === "today"[\s\S]*?t\.plannedDate === todayStr\(\)/);
  assert.match(html, /setFilter\('today', this\)/);
});


test('task search matches name, type, priority, recurrence, tags, checklist, and project', () => {
  const source = extractFunction('_taskMatchesSearch');
  const matcher = vm.runInNewContext('(' + source + ')');
  const task = {
    name: 'مراجعة خطة الإطلاق',
    type: 'إدارية',
    priority: 'urgent',
    recurrence: 'weekly',
    tags: ['منتج', 'مراجعة'],
    checklist: [{ text: 'تدقيق النسخة', done: false }],
    projectId: 7
  };
  const projects = { 7: { name: 'مشروع TimeTasks' } };

  for (const query of ['الإطلاق', 'إدارية', 'urgent', 'weekly', 'منتج', 'تدقيق النسخة', 'TimeTasks']) {
    assert.equal(matcher(task, query, projects), true, 'expected search match for ' + query);
  }
  assert.equal(matcher(task, 'غير موجود', projects), false);
  assert.equal(matcher(task, '   ', projects), true);
});

test('task search ignores malformed optional tags and checklist data safely', () => {
  const source = extractFunction('_taskMatchesSearch');
  const matcher = vm.runInNewContext('(' + source + ')');
  const task = {
    name: 'مهمة سليمة',
    tags: ['وسم', null, 123],
    checklist: [null, 'نص', { text: 10 }, { text: 'عنصر صحيح' }],
    projectId: 404
  };

  assert.equal(matcher(task, 'وسم', {}), true);
  assert.equal(matcher(task, 'عنصر صحيح', {}), true);
  assert.equal(matcher(task, 'غير موجود', {}), false);
  assert.equal(matcher(null, 'بحث', {}), false);
});
