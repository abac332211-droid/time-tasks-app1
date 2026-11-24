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
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

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

test('npm lockfile pins the root package manifest and uses lockfile version 3', () => {
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
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
    _focusElapsedRemainderMs: 0,
    tasks: [],
    _getElapsedSec: () => 4 * 3600 + 10,
    _getFocusTimerElapsedParts: () => ({
      seconds: sandbox._getElapsedSec(),
      remainderMs: sandbox._focusElapsedRemainderMs || 0
    }),
    _phaseTargetSec: () => 5 * 60,
    _anchorFocusTimerClock: () => {},
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
    _focusElapsedRemainderMs: 0,
    _focusTimerExternalConflict: false,
    _anchorFocusTimerClock: () => {},
    _getElapsedSec: () => 420, _unlockAudioContext: () => {}, _startDisplayTick: () => {},
    _stopDisplayTick: () => {}, _saveFocusTimer: () => true, _renderFocusTimer: () => {}, showToast: () => {}
  };
  vm.runInNewContext(extractFunction('toggleTimer'), sandbox);
  sandbox.toggleTimer();
  assert.equal(sandbox._focusTimer.sessionStartAt, 123456789);
  assert.equal(sandbox._focusTimer.running, true);
  assert.equal(typeof sandbox._focusTimer.startedAt, 'number');
});

test('focus commit guard blocks saveData and side-storage writes before reading storage', () => {
  let reads = 0, writes = 0;
  const sandbox = {
    storageRecoveryRequired: false,
    STORAGE_KEY: 'main',
    IMPORT_IN_PROGRESS_KEY: 'import-in-progress',
    _stopwatchTransactionLockDepth: 1,
    MIGRATION_IN_PROGRESS_KEY: 'migration-in-progress',
    RESET_IN_PROGRESS_KEY: 'reset-in-progress',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore-in-progress',
    _isFocusCommitBlocked: () => true,
    localStorage: { getItem() { reads++; return null; }, setItem() { writes++; } },
    showAlertModal() {}, showToast() {}, console
  };
  vm.runInNewContext([
    extractFunction('saveData'),
    extractFunction('_storageWriteAllowed'),
    extractFunction('persistDailyLog')
  ].join('\n'), sandbox);
  assert.equal(sandbox.saveData(), false);
  assert.equal(reads, 0, 'saveData must block before reading recovery markers or data');
  assert.equal(sandbox._storageWriteAllowed(), false);
  assert.equal(reads, 0, '_storageWriteAllowed must stop before side-storage reads');
  assert.equal(sandbox.persistDailyLog({ date: '2026-11-23' }), false);
  assert.equal(reads, 0, 'daily log persistence must stop before reading main storage');
  assert.equal(writes, 0);
});

test('saveData refuses to overwrite a malformed main record', () => {
  const original = '{broken-json';
  let stored = original;
  let writes = 0;
  const alerts = [];
  const sandbox = {
    storageRecoveryRequired: false,
    STORAGE_KEY: 'main',
    CURRENT_SCHEMA_VERSION: 2,
    _mainStorageBaselineReady: false,
    _mainStorageExternalChangeObserved: false,
    _mainStorageBaselineRaw: null,
    localStorage: {
      getItem: () => stored,
      setItem: (_key, value) => { writes++; stored = String(value); }
    },
    showAlertModal: (...args) => alerts.push(args),
    console
  };
  vm.runInNewContext(extractFunction('saveData'), sandbox);

  assert.equal(sandbox.saveData(), false);
  assert.equal(stored, original);
  assert.equal(writes, 0);
  assert.equal(sandbox.storageRecoveryRequired, true);
  assert.equal(alerts.length, 1);
});

test('saveData refuses writes while an import recovery marker remains', () => {
  const original = '{"schemaVersion":2,"tasks":[],"dailyLogs":[]}';
  let writes = 0;
  let recoveryRequired = false;
  const alerts = [];
  const sandbox = {
    storageRecoveryRequired: false,
    STORAGE_KEY: 'main',
    IMPORT_IN_PROGRESS_KEY: 'import-in-progress',
    _stopwatchTransactionLockDepth: 1,
    localStorage: {
      getItem: (key) => key === 'import-in-progress' ? '1' : original,
      setItem: () => { writes++; }
    },
    showAlertModal: (...args) => alerts.push(args),
    console
  };
  vm.runInNewContext(extractFunction('saveData'), sandbox);

  assert.equal(sandbox.saveData(), false);
  assert.equal(writes, 0);
  assert.equal(sandbox.storageRecoveryRequired, true);
  assert.equal(alerts.length, 1);
});

test('saveData refuses a stale tab when the main record changed after its baseline', () => {
  const stored = '{"schemaVersion":2,"tasks":[{"id":2}],"dailyLogs":[]}';
  let writes = 0;
  const alerts = [];
  const sandbox = {
    storageRecoveryRequired: false,
    STORAGE_KEY: 'main',
    _mainStorageBaselineReady: true,
    _mainStorageBaselineRaw: '{"schemaVersion":2,"tasks":[{"id":1}],"dailyLogs":[]}',
    _mainStorageExternalChangeObserved: false,
    localStorage: {
      getItem: () => stored,
      setItem: () => { writes++; }
    },
    showAlertModal: (...args) => alerts.push(args),
    console
  };
  vm.runInNewContext(extractFunction('saveData'), sandbox);

  assert.equal(sandbox.saveData(), false);
  assert.equal(writes, 0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][0], /تعارض بين النوافذ/);
});

function createSaveDataHarness({ transformWrite, rollingFailure } = {}) {
  const original = JSON.stringify({
    schemaVersion: 2,
    createdByVersion: '2.9.0',
    settings: { operationalDayStart: 4, firstUseDate: '2026-11-21', darkMode: false },
    tasks: [],
    dailyLogs: []
  });
  let stored = original;
  let setCalls = 0, checkpointCalls = 0;
  const baselineUpdates = [], reminderSyncs = [], alerts = [], toasts = [];
  const sandbox = {
    storageRecoveryRequired: false,
    STORAGE_KEY: 'main',
    CURRENT_SCHEMA_VERSION: 2,
    APP_VERSION: '2.9.0',
    _mainStorageBaselineReady: true,
    _mainStorageBaselineRaw: original,
    _mainStorageExternalChangeObserved: false,
    _rollingRecoveryBackupLastFailure: null,
    appSettings: { firstUseDate: '2026-11-21', lastRecurringDates: {} },
    tasks: [],
    localStorage: {
      getItem(key) { return key === 'main' ? stored : null; },
      setItem(key, value) {
        setCalls++;
        const raw = String(value);
        stored = typeof transformWrite === 'function' ? transformWrite(raw) : raw;
      }
    },
    _pruneLastRecurringDates() {},
    todayStr: () => '2026-11-21',
    validateV2(data) {
      return !!data && data.schemaVersion === 2
        && Array.isArray(data.tasks) && Array.isArray(data.dailyLogs);
    },
    _setMainStorageBaseline(raw) {
      sandbox._mainStorageBaselineRaw = raw;
      baselineUpdates.push(raw);
    },
    _queueAllTaskReminderSync() { reminderSyncs.push(true); },
    _storeRollingRecoveryBackup() {
      checkpointCalls++;
      if (rollingFailure) {
        sandbox._rollingRecoveryBackupLastFailure = rollingFailure;
        return false;
      }
      return true;
    },
    _isOptionalRollingRecoveryBackupFailure() {
      return sandbox._rollingRecoveryBackupLastFailure === 'backup_write_failed'
        || sandbox._rollingRecoveryBackupLastFailure === 'backup_verification_failed';
    },
    showAlertModal: (...args) => alerts.push(args),
    showToast: (message) => toasts.push(message),
    console
  };
  vm.runInNewContext(extractFunction('saveData'), sandbox);
  return {
    sandbox, original,
    get stored() { return stored; },
    get setCalls() { return setCalls; },
    get checkpointCalls() { return checkpointCalls; },
    baselineUpdates, reminderSyncs, alerts, toasts
  };
}

test('saveData refuses an unverified primary write and does not advance the baseline', () => {
  const harness = createSaveDataHarness({
    transformWrite(raw) {
      const data = JSON.parse(raw);
      data.tasks = [{ id: 91, name: 'unexpected read-back value' }];
      return JSON.stringify(data);
    }
  });

  assert.equal(harness.sandbox.saveData(), false);
  assert.notEqual(harness.stored, harness.original);
  assert.equal(harness.sandbox.storageRecoveryRequired, true);
  assert.equal(harness.sandbox._mainStorageBaselineReady, false);
  assert.equal(harness.sandbox._mainStorageBaselineRaw, harness.original);
  assert.deepEqual(harness.baselineUpdates, []);
  assert.deepEqual(harness.reminderSyncs, []);
  assert.equal(harness.checkpointCalls, 0);
  assert.match(harness.alerts[0][0], /تعذر التحقق من الحفظ/);
});

test('saveData keeps a verified primary commit when only the rolling slot write fails', () => {
  const harness = createSaveDataHarness({ rollingFailure: 'backup_write_failed' });

  assert.equal(harness.sandbox.saveData(), true);
  assert.equal(harness.stored, harness.sandbox._mainStorageBaselineRaw);
  assert.notEqual(harness.stored, harness.original);
  assert.equal(harness.sandbox.storageRecoveryRequired, false);
  assert.deepEqual(harness.baselineUpdates, [harness.stored]);
  assert.deepEqual(harness.reminderSyncs, [true]);
  assert.equal(harness.checkpointCalls, 1);
  assert.equal(harness.alerts.length, 0);
  assert.ok(harness.toasts.some((message) => /النسخة الاحتياطية الدوّارة لم تُحدّث/.test(message)));
});

test('saveData locks later writes when a rolling snapshot conflict prevents a consistent backup', () => {
  const harness = createSaveDataHarness({ rollingFailure: 'snapshot_conflict' });

  assert.equal(harness.sandbox.saveData(), true,
    'the verified primary record remains committed even when the supplemental snapshot cannot be trusted');
  assert.equal(harness.stored, harness.sandbox._mainStorageBaselineRaw);
  assert.equal(harness.sandbox.storageRecoveryRequired, true);
  assert.deepEqual(harness.baselineUpdates, [harness.stored]);
  assert.deepEqual(harness.reminderSyncs, [true]);
  assert.match(harness.alerts[0][0], /تحذير اتساق التخزين/);
});

test('mental-item conversion locks storage if its committed main record cannot be read for compensation', () => {
  const originalMain = JSON.stringify({ schemaVersion: 2, settings: {}, tasks: [], dailyLogs: [] });
  const committedMain = JSON.stringify({ schemaVersion: 2, settings: {}, tasks: [{ id: 1 }], dailyLogs: [] });
  const originalInbox = JSON.stringify([{ id: 7, text: 'فكرة', createdAt: '2026-11-21' }]);
  const values = new Map([['main', originalMain], ['inbox', originalInbox]]);
  let mainReads = 0, hold = 0, secondarySaves = 0;
  const alerts = [];
  const tasks = [];
  const sandbox = {
    STORAGE_KEY: 'main',
    MENTAL_INBOX_KEY: 'inbox',
    storageRecoveryRequired: false,
    appSettings: { lastTaskId: 0 },
    tasks,
    Date,
    _loadMentalInbox: () => [{ id: 7, text: 'فكرة', createdAt: '2026-11-21' }],
    _acquireRollingRecoveryCheckpointHold(enabled) {
      if (enabled) hold++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (enabled) hold = Math.max(0, hold - 1);
      };
    },
    localStorage: {
      getItem(key) {
        if (key === 'main') {
          mainReads++;
          if (mainReads > 1) throw new Error('simulated post-commit read failure');
        }
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    },
    saveData() {
      values.set('main', committedMain);
      return true;
    },
    getNextTaskId: () => 1,
    todayStr: () => '2026-11-21',
    _saveMentalInbox() { secondarySaves++; return true; },
    showToast() {},
    showAlertModal: (...args) => alerts.push(args),
    console
  };
  vm.runInNewContext(extractFunction('convertMentalItemToTask'), sandbox);
  sandbox.convertMentalItemToTask(7);

  assert.equal(values.get('main'), committedMain,
    'the test simulates a primary commit that cannot safely be compensated without a readable baseline');
  assert.equal(sandbox.tasks.length, 0, 'in-memory task state is restored');
  assert.equal(secondarySaves, 0, 'the second store must not be written after the compensation baseline read fails');
  assert.equal(sandbox.storageRecoveryRequired, true,
    'a partial multi-store commit must block subsequent writes');
  assert.equal(hold, 0, 'the checkpoint hold must always be released');
  assert.match(alerts[0][1], /حاجز الحماية/);
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

test('storage record copies discard prototype-sensitive property names', () => {
  const source = JSON.parse('{"name":"safe","__proto__":{"polluted":true},"constructor":"bad","hasOwnProperty":null,"toString":null}');
  const sandbox = {};
  vm.runInNewContext(extractFunction('_copyStorageRecord'), sandbox);
  const copied = sandbox._copyStorageRecord(source);

  assert.equal(copied.name, 'safe');
  assert.equal(copied.polluted, undefined);
  assert.equal(copied.constructor, Object.getPrototypeOf(copied).constructor);
  assert.equal(typeof copied.hasOwnProperty, 'function');
  assert.equal(copied.hasOwnProperty('name'), true);
  assert.equal(copied.toString(), '[object Object]');
});

test('V2 and backup recurring-date metadata share strict bounds and key validation', () => {
  const sandbox = {
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  };
  vm.runInNewContext(extractFunction('_validateLastRecurringDates'), sandbox);
  const validate = sandbox._validateLastRecurringDates;

  assert.equal(validate(undefined), true);
  assert.equal(validate(null), true);
  assert.equal(validate({ 'series:12': '2026-11-21' }), true);
  assert.equal(validate({ 'series:12': 'yesterday' }), false);
  assert.equal(validate([]), false);
  assert.equal(validate(JSON.parse('{"constructor":"2026-11-21"}')), false);
  assert.equal(validate(JSON.parse('{"__proto__":"2026-11-21"}')), false);

  const tooMany = {};
  for (let i = 0; i < 501; i++) tooMany['series:' + i] = '2026-11-21';
  assert.equal(validate(tooMany), false);
});

test('recurring task refresh uses an app-lifetime interval independent of the focus timer', () => {
  let callback = null, delay = null, generated = 0, rendered = 0, notified = 0;
  const sandbox = {
    _recurringTaskRefreshInterval: null,
    setInterval: (fn, ms) => { callback = fn; delay = ms; return 42; },
    storageRecoveryRequired: false,
    document: { visibilityState: 'visible' },
    _generateAndPersistRecurringTasks: () => { generated++; return 1; },
    renderAll: () => { rendered++; },
    showToast: () => { notified++; }
  };
  vm.runInNewContext(extractFunction('_setupRecurringTaskRefresh'), sandbox);
  sandbox._setupRecurringTaskRefresh();

  assert.equal(delay, 60 * 1000);
  assert.equal(typeof callback, 'function');
  callback();
  assert.equal(generated, 1);
  assert.equal(rendered, 1);
  assert.equal(notified, 1);

  sandbox.document.visibilityState = 'hidden';
  callback();
  assert.equal(generated, 1, 'hidden tabs do not run recurring generation');
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
  vm.runInNewContext(extractFunction('_copyStorageRecord') + '\n' + extractFunction('_applyThemePreference') + '\n' + extractFunction('_loadAppSettings') + '\n' + extractFunction('_setupSystemThemeListener'), sandbox);
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

test('cancelling one recurring occurrence preserves the series and its future schedule', () => {
  const root = { id: 5, recurrence: 'daily', status: 'pending' };
  const occurrence = {
    id: 6, recurrence: 'daily', status: 'pending', actual: 12,
    completedAt: null, _recurringGenerated: true, _sourceTaskId: 5
  };
  const sandbox = {
    tasks: [root, occurrence],
    editingId: 6,
    showConfirmModal: (_title, _body, accept) => accept(),
    saveData: () => true,
    cancelEdit: () => { sandbox.editingId = null; },
    renderAll: () => {},
    showToast: () => {}
  };
  vm.runInNewContext(extractFunction('cancelRecurringOccurrence'), sandbox);

  assert.equal(sandbox.cancelRecurringOccurrence(6), true);
  assert.equal(occurrence.status, 'cancelled');
  assert.equal(occurrence.actual, 12, 'elapsed work time is preserved');
  assert.equal(occurrence.recurrence, 'daily', 'the cancelled occurrence keeps its series reference');
  assert.equal(root.recurrence, 'daily', 'future occurrences remain enabled');
});

test('failed one-occurrence cancellation restores its prior status and completion timestamp', () => {
  const occurrence = {
    id: 6, recurrence: 'weekly', status: 'pending', actual: null,
    completedAt: null, _recurringGenerated: true, _sourceTaskId: 5
  };
  const sandbox = {
    tasks: [occurrence],
    editingId: 6,
    showConfirmModal: (_title, _body, accept) => accept(),
    saveData: () => false,
    cancelEdit: () => {},
    renderAll: () => {},
    showToast: () => {}
  };
  vm.runInNewContext(extractFunction('cancelRecurringOccurrence'), sandbox);

  assert.equal(sandbox.cancelRecurringOccurrence(6), true, 'the confirmation dialog was opened');
  assert.equal(occurrence.status, 'pending');
  assert.equal(occurrence.completedAt, null);
  assert.equal(occurrence.recurrence, 'weekly');
});

test('stopping a recurring series clears recurrence from the root and all generated occurrences', () => {
  const root = { id: 5, status: 'cancelled', recurrence: 'daily' };
  const occurrence = { id: 6, status: 'pending', recurrence: 'daily', _recurringGenerated: true, _sourceTaskId: 5 };
  const sandbox = {
    tasks: [root, occurrence],
    editingId: null,
    showConfirmModal: (_title, _body, accept) => accept(),
    saveData: () => true,
    renderAll: () => {},
    showToast: () => {}
  };
  vm.runInNewContext(extractFunction('stopRecurringSeries'), sandbox);

  assert.equal(sandbox.stopRecurringSeries(6), true);
  assert.equal(root.recurrence, null);
  assert.equal(occurrence.recurrence, null);
});

test('failed recurring-series stop restores recurrence for every member', () => {
  const root = { id: 5, recurrence: 'weekly' };
  const occurrence = { id: 6, recurrence: 'weekly', _recurringGenerated: true, _sourceTaskId: 5 };
  const sandbox = {
    tasks: [root, occurrence],
    editingId: null,
    showConfirmModal: (_title, _body, accept) => accept(),
    saveData: () => false,
    renderAll: () => {},
    showToast: () => {}
  };
  vm.runInNewContext(extractFunction('stopRecurringSeries'), sandbox);

  assert.equal(sandbox.stopRecurringSeries(6), true, 'the confirmation dialog was opened');
  assert.equal(root.recurrence, 'weekly');
  assert.equal(occurrence.recurrence, 'weekly');
});

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
    FOCUS_MAX_SESSIONS: 5000,
    VALID_STATUS: ['pending', 'done', 'cancelled'],
    VALID_TYPES: ['معرفية', 'إدارية', 'إبداعية', 'اجتماعية'],
    isValidCalendarDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    isValidLocalTime: (value) => value === '' || /^\d{2}:\d{2}$/.test(value),
    isValidLocalDateTime: (value) => typeof value === 'string',
    validateDailyLog: () => true,
    _validateFocusSessionRecord(session) {
      return !!session && Number.isFinite(session.durationSec) && session.durationSec >= 0
        && typeof session.startedAt === 'string' && Number.isFinite(Date.parse(session.startedAt))
        && typeof session.endedAt === 'string' && Number.isFinite(Date.parse(session.endedAt))
        && Date.parse(session.endedAt) >= Date.parse(session.startedAt)
        && ['pomodoro', 'stopwatch'].includes(session.mode)
        && ['work', 'short-break', 'long-break'].includes(session.phase);
    }
  };
  vm.runInNewContext(extractFunction('validateBackup'), sandbox);
  const result = sandbox.validateBackup({
    backupFormatVersion: 1,
    schemaVersion: 2,
    data: {
      tasks: [], dailyLogs: [],
      focusSessions: [{ durationSec: 60, startedAt: 'not-a-date', endedAt: 'not-a-date', mode: 'pomodoro', phase: 'work' }]
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
    _trackSecondaryStorageRead: (_key, raw) => raw,
    localStorage: {
      getItem: () => JSON.stringify([{
        id: '1);globalThis.pwned=true;//',
        text: '<img src=x onerror=alert(1)>',
        createdAt: '2026-11-04T10:00:00.000Z'
      }])
    }
  };
  vm.runInNewContext(extractFunction('_copyStorageRecord') + '\n' + extractFunction('_loadThoughts'), thoughtsSandbox);
  const thoughts = thoughtsSandbox._loadThoughts();
  assert.equal(thoughts.length, 1);
  assert.equal(typeof thoughts[0].id, 'number');
  assert.equal(thoughts[0].id, 1);
  assert.equal(thoughts[0].text, '<img src=x onerror=alert(1)>', 'raw text stays data and is escaped at render time');

  const inboxSandbox = {
    MENTAL_INBOX_KEY: 'inbox',
    _trackSecondaryStorageRead: (_key, raw) => raw,
    localStorage: {
      getItem: () => JSON.stringify([{
        id: '2);globalThis.pwned=true;//',
        text: '<svg onload=alert(1)>',
        next: '',
        createdAt: '2026-11-04T10:00:00.000Z'
      }])
    }
  };
  vm.runInNewContext(extractFunction('_copyStorageRecord') + '\n' + extractFunction('_loadMentalInbox'), inboxSandbox);
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
    _stopwatchTransactionLockDepth: 1,
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
    _stopwatchTransactionLockDepth: 1,
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
    _stopwatchTransactionLockDepth: 1,
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


test('npm lockfile is committed, pinned, and matches the package manifest', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.version, pkg.version);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
});

test('release workflow creates a downloadable web ZIP and uses Node 24 compatible actions', () => {
  const verify = fs.readFileSync(path.join(root, '.github/workflows/verify-pwa.yml'), 'utf8');
  const apk = fs.readFileSync(path.join(root, '.github/workflows/build-apk.yml'), 'utf8');
  const release = fs.readFileSync(path.join(root, '.github/workflows/build-release-apk.yml'), 'utf8');
  assert.match(verify, /actions\/checkout@v7/);
  assert.match(verify, /actions\/setup-node@v7/);
  assert.match(verify, /node-version:\s*'22'/);
  assert.match(verify, /zip -9 -r \.\.\/time-tasks-app-2\.9\.0-web\.zip/);
  assert.match(verify, /name:\s*time-tasks-app-2\.9\.0-web/);
  assert.match(verify, /retention-days:\s*90/);
  assert.match(verify, /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(apk, /actions\/checkout@v7/);
  assert.match(apk, /actions\/setup-node@v7/);
  assert.match(apk, /actions\/setup-java@v6/);
  assert.match(apk, /name: Run regression tests/);
  assert.match(apk, /run: npm test/);
  assert.match(apk, /run: npm ci --no-audit --no-fund/);
  assert.doesNotMatch(apk, /run: npm install/);
  assert.match(apk, /permissions:\s*\n\s*contents: read/);
  assert.match(release, /actions\/setup-java@v6/);
  assert.doesNotMatch(apk + release, /actions\/setup-java@v5/);
  assert.match(release, /name: Run regression tests/);
  assert.match(release, /run: npm test/);
  assert.match(release, /name: Install dependencies from lockfile/);
  assert.match(release, /run: npm ci --no-audit --no-fund/);
  assert.doesNotMatch(release, /run: npm install/);
  assert.match(apk, /run: npm ci --no-audit --no-fund/);
  assert.match(release, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(release, /environment:\s*\n\s*name: android-release/);
  assert.match(release, /ref: \$\{\{\s*github\.sha\s*\}\}/);
  assert.doesNotMatch(release, /inputs\.ref/);
  assert.ok(release.includes('ANDROID_EXPECTED_CERT_SHA256'));
  assert.ok(release.includes('Signer #[0-9]+ certificate SHA-256 digest'));
  assert.ok(release.includes('verify --verbose --print-certs'));
  for (const workflow of [verify, apk, release]) {
    assert.ok(workflow.includes('actions/upload-artifact@v7.0.2'));
    assert.ok(!workflow.includes('actions/upload-artifact@v4'));
  }
  assert.doesNotMatch(verify + apk + release, /actions\/(?:checkout|setup-node)@v5/);
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
  assert.deepEqual(harness.reminderSyncs(), [], 'saveData owns the single full reminder reconciliation');
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
  assert.deepEqual(harness.sandbox.reminderSyncs, [], 'saveData owns the one full reminder reconciliation');
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


test('task completion and undo rely on one centralized full reminder sync per save', () => {
  const task = {
    id: 19, name: 'مهمة موعدها قادم', expected: 25,
    actual: null, status: 'pending', completedAt: null
  };
  const singleSyncs = [];
  let fullSyncs = 0;
  const sandbox = {
    tasks: [task],
    _focusTimer: { taskId: null },
    isTaskCancelled: () => false,
    showPromptModal: (_title, _body, _value, _placeholder, callback) => callback('30'),
    localDateTimeString: () => '2026-11-19T09:00:00',
    saveData: () => { fullSyncs++; return true; },
    renderAll: () => {},
    showToast: () => {},
    showAlertModal: () => {},
    _queueTaskReminderSync: (value) => { singleSyncs.push({ id: value.id, status: value.status }); }
  };
  vm.runInNewContext(extractFunction('toggleTask'), sandbox);

  sandbox.toggleTask(19);
  assert.equal(task.status, 'done');
  assert.equal(fullSyncs, 1);
  assert.deepEqual(singleSyncs, []);

  sandbox.toggleTask(19);
  assert.equal(task.status, 'pending');
  assert.equal(task.actual, null);
  assert.equal(fullSyncs, 2);
  assert.deepEqual(singleSyncs, []);
});

test('task deletion does not cancel a derived reminder ID directly', () => {
  const task = { id: 21, name: 'مهمة للحذف', status: 'pending' };
  const cancelled = [];
  let persistenceCalls = 0;
  const sandbox = {
    tasks: [task],
    editingId: null,
    _focusTimer: { taskId: null },
    showConfirmModal: (_title, _body, callback) => callback(),
    saveData: () => { persistenceCalls++; return true; },
    renderAll: () => {},
    showToast: () => {},
    _queueTaskReminderCancellation: (id) => { cancelled.push(id); }
  };
  vm.runInNewContext(extractFunction('deleteTask'), sandbox);

  sandbox.deleteTask(21);
  assert.equal(sandbox.tasks.length, 0);
  assert.equal(persistenceCalls, 1);
  assert.deepEqual(cancelled, [], 'full reconciliation owned by saveData avoids cancelling another colliding task reminder');
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


function transitionDialogHarness({ commitResult = true, checkpointResult = true, initiallyRunning = true, switchResult = true } = {}) {
  const elements = Object.create(null);
  function element() {
    return { children: [], classList: { add() {}, remove() {}, contains() { return false; } },
      appendChild(child) { this.children.push(child); }, style: {}, innerHTML: '', textContent: '', focus() {} };
  }
  const document = {
    getElementById(id) { if (!elements[id]) elements[id] = element(); return elements[id]; },
    createElement() { return element(); }, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, contains() { return true; }
  };
  const task = { id: 1, name: 'المهمة الحالية', actual: null };
  const timer = { mode: 'stopwatch', phase: 'work', taskId: 1, running: initiallyRunning,
    baseElapsed: 120, startedAt: initiallyRunning ? 1000 : null, sessionStartAt: 1,
    cyclePosition: 0, awaitingConfirmation: false, pendingPhaseEndedAt: null, clockAdjusted: false };
  const alerts = [], toasts = [], commits = [];
  let freezeCalls = 0, switchCalls = 0, renderCalls = 0;
  const sandbox = {
    _modalKeyHandler: null, storageRecoveryRequired: false, document,
    tasks: [task, { id: 2, name: 'المهمة التالية' }], _focusTimer: timer,
    _focusElapsedRemainderMs: 0,
    _freezeFocusTimerForDecision() {
      freezeCalls++;
      if (!checkpointResult) { alerts.push(['تعذر حفظ حالة المؤقت', 'لم يتم تأكيد التجميد.']); return null; }
      timer.running = false; timer.startedAt = null;
      return Object.freeze({ mode: timer.mode, phase: timer.phase, taskId: timer.taskId, running: false,
        baseElapsed: timer.baseElapsed, elapsedRemainderMs: 0, startedAt: null,
        cyclePosition: timer.cyclePosition, sessionStartAt: timer.sessionStartAt,
        awaitingConfirmation: false, pendingPhaseEndedAt: null, clockAdjusted: false });
    },
    _commitFocusTaskSession(params) {
      commits.push(params);
      if (!commitResult) return Promise.resolve(false);
      if (typeof params.onCommitted === 'function' && params.onCommitted() !== true) return Promise.resolve(false);
      return Promise.resolve(true);
    },
    _discardShortFocusSession(params) {
      if (typeof params.onDiscarded === 'function' && params.onDiscarded() !== true) return Promise.resolve(false);
      return Promise.resolve(true);
    },
    _renderFocusTimer() { renderCalls++; }, _formatDuration: String, escapeHTML: String,
    showAlertModal(...args) { alerts.push(args); }, showToast(message) { toasts.push(message); },
    _setupModalFocusTrap: () => () => {}, closeModal() {},
    _startDisplayTick() {}, _saveFocusTimer: () => true, _anchorFocusTimerClock() {},
    _stopDisplayTick() {}, renderFocusSessionsCard() {},
    console
  };
  vm.runInNewContext(extractFunction('_showSessionTransitionDialog'), sandbox);
  sandbox._showSessionTransitionDialog(2, () => { switchCalls++; return switchResult; });
  return { sandbox, task, timer, alerts, toasts, commits, elements,
    counts: () => ({ freezeCalls, switchCalls, renderCalls }) };
}

test('transition save delegates a frozen snapshot and switches only after an explicit true callback', () => {
  const h=transitionDialogHarness({switchResult:true});
  assert.equal(h.elements.modalFooter.children.length,3);
  h.elements.modalFooter.children[2].onclick();
  assert.equal(h.commits.length,1);
  assert.equal(h.commits[0].taskId,1);
  assert.equal(h.commits[0].minutesToAdd,2);
  assert.equal(Object.isFrozen(h.commits[0].snapshot),true);
  assert.equal(h.task.actual,null,'the UI dialog must not mutate task.actual outside the transaction engine');
  assert.equal(h.counts().switchCalls,1);
});

test('transition failure does not invoke the next-session callback', () => {
  const h=transitionDialogHarness({commitResult:false,switchResult:true});
  h.elements.modalFooter.children[2].onclick();
  assert.equal(h.commits.length,1);
  assert.equal(h.counts().switchCalls,0);
  assert.equal(h.task.actual,null);
});

test('transition dialog is not opened when the initial frozen checkpoint fails', () => {
  const h=transitionDialogHarness({checkpointResult:false});
  assert.equal(h.elements.modalFooter,undefined);
  assert.equal(h.alerts.length,1);
  assert.equal(h.counts().freezeCalls,1);
});

test('cancel transition from an originally paused timer keeps it paused', () => {
  const h=transitionDialogHarness({initiallyRunning:false});
  assert.equal(h.timer.running,false);
  h.elements.modalFooter.children[0].onclick();
  assert.equal(h.timer.running,false);
  assert.equal(h.timer.baseElapsed,120);
  assert.equal(h.counts().switchCalls,0);
});

test('failed timer-transition checkpoint pauses safely and suppresses the success notification', () => {
  const state = {
    running: true, mode: 'pomodoro', phase: 'short-break',
    startedAt: 1_000, sessionStartAt: 1_000, baseElapsed: 0,
    cyclePosition: 0, awaitingConfirmation: false, pendingPhaseEndedAt: null
  };
  let savedSessions = 0;
  let timerSaves = 0;
  let notifications = 0;
  let stopped = 0;
  const alerts = [];
  const sandbox = {
    _focusTimer: state,
    _focusElapsedRemainderMs: 0,
    tasks: [],
    _getElapsedSec: () => state.phase === 'short-break' ? 420 : 0,
    _getFocusTimerElapsedParts: () => ({
      seconds: state.phase === 'short-break' ? 420 : 0,
      remainderMs: sandbox._focusElapsedRemainderMs || 0
    }),
    _phaseTargetSec: () => 300,
    _logSession: () => { savedSessions++; return true; },
    _saveFocusTimer: () => { timerSaves++; return timerSaves > 1; },
    _stopDisplayTick: () => { stopped++; },
    _anchorFocusTimerClock: () => {},
    _renderFocusTimer: () => {},
    renderFocusSessionsCard: () => {},
    _notifyPhaseTransition: () => { notifications++; },
    showAlertModal: (...args) => alerts.push(args)
  };
  vm.runInNewContext(extractFunction('_catchUp'), sandbox);
  sandbox._catchUp(false);

  assert.equal(savedSessions, 1);
  assert.equal(state.phase, 'work');
  assert.equal(state.running, false);
  assert.equal(state.startedAt, null);
  assert.equal(state.baseElapsed, 0);
  assert.equal(timerSaves, 2);
  assert.equal(stopped, 1);
  assert.equal(notifications, 0);
  assert.equal(alerts.length, 1);
});


function migrationHarness(mainRaw, archiveRaw = null, markerRaw = null, faults = {}) {
  const values = new Map([['main', mainRaw]]);
  if (archiveRaw !== null) values.set('migration-archive', archiveRaw);
  if (markerRaw !== null) values.set('migration-in-progress', markerRaw);
  const writes = [];
  const sandbox = {
    STORAGE_KEY: 'main',
    BACKUP_KEY: 'migration-archive',
    MIGRATION_ARCHIVE_KEY: 'migration-archive',
    MIGRATION_IN_PROGRESS_KEY: 'migration-in-progress',
    CURRENT_SCHEMA_VERSION: 2,
    APP_VERSION: 'test',
    _stopwatchTransactionLockDepth: 1,
    Date,
    console,
    localStorage: {
      getItem(key) {
        if (faults.throwOnGetKey === key) throw new Error('simulated read failure');
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        writes.push([key, String(value)]);
        if (faults.throwOnSetKey === key) throw new Error('simulated write failure');
        values.set(key, String(value));
      },
      removeItem(key) {
        if (faults.throwOnRemoveKey === key) throw new Error('simulated remove failure');
        values.delete(key);
      }
    },
    isValidTaskObject(task) { return !!task && typeof task === 'object' && !Array.isArray(task); },
    validateV2(data) {
      return !!data
        && data.schemaVersion === 2
        && Array.isArray(data.tasks)
        && Array.isArray(data.dailyLogs)
        && data.tasks.every((task) => task
          && task.status !== 'partial'
          && typeof task.plannedDate === 'string'
          && /^\d{4}-\d{2}-\d{2}$/.test(task.plannedDate)
          && typeof task.plannedTime === 'string'
          && (task.plannedTime === '' || /^\d{2}:\d{2}$/.test(task.plannedTime)));
    },
    migrateTaskV1toV2(rawTask, existingIds) {
      const id = Number.isInteger(rawTask.id) && rawTask.id > 0 && !existingIds.has(rawTask.id)
        ? rawTask.id : 1;
      existingIds.add(id);
      return {
        task: {
          id, name: typeof rawTask.name === 'string' && rawTask.name ? rawTask.name : 'مهمة',
          type: 'معرفية', status: 'pending', expected: 10, actual: null,
          plannedDate: '2026-11-21', plannedTime: '', completedAt: null, createdAt: 1000
        },
        repairs: []
      };
    },
    todayStr: () => '2026-11-21',
    buildEmptyV2: () => ({
      schemaVersion: 2, createdByVersion: 'test',
      settings: {}, tasks: [], dailyLogs: []
    })
  };
  vm.runInNewContext(
    extractFunction('_healTaskArray') + '\n' + extractFunction('migrateV1ToV2'),
    sandbox
  );
  return { values, writes, sandbox, run: () => sandbox.migrateV1ToV2() };
}

test('V2 migration never writes partially healed tasks when a planned date or time is invalid', () => {
  for (const invalidField of ['plannedDate', 'plannedTime']) {
    const task = {
      id: 7, name: 'مهمة قديمة', status: 'partial', priority: 'unknown',
      plannedDate: '2026-11-21', plannedTime: '09:30',
      completedAt: null, createdAt: 1000
    };
    task[invalidField] = 'invalid-value';
    const original = JSON.stringify({
      schemaVersion: 2, createdByVersion: 'old', settings: {},
      tasks: [task], dailyLogs: []
    });
    const harness = migrationHarness(original);
    const report = harness.run();

    assert.equal(report.success, false, invalidField);
    assert.equal(harness.values.get('main'), original, 'original V2 bytes remain untouched');
    assert.deepEqual(harness.writes, [], 'no partial healing write is allowed');
  }
});

test('corrupt current storage does not silently fall back to an old migration archive', () => {
  const oldArchive = JSON.stringify({
    tasks: [{ id: 7, name: 'بيانات قديمة' }],
    dailyLogs: []
  });
  const harness = migrationHarness('{broken-json', oldArchive, null);
  const report = harness.run();

  assert.equal(report.success, false);
  assert.equal(harness.values.get('main'), '{broken-json');
  assert.deepEqual(harness.writes, [], 'a completed migration archive is not a rolling backup');
  assert.equal(harness.values.get('migration-archive'), oldArchive);
});

test('an explicit pending migration marker allows archive recovery and is cleared after verified V2 write', () => {
  const oldArchive = JSON.stringify({
    tasks: [{ id: 7, name: 'مهمة الترحيل' }],
    dailyLogs: []
  });
  const harness = migrationHarness('{interrupted-write', oldArchive, '1');
  const report = harness.run();

  assert.equal(report.success, true);
  assert.equal(report.recoveredFromBackup, true);
  assert.equal(JSON.parse(harness.values.get('main')).schemaVersion, 2);
  assert.equal(harness.values.get('migration-archive'), oldArchive);
  assert.equal(harness.values.get('migration-in-progress') ?? null, null);
});

test('migration archive write failure leaves the original V1 record unchanged and marked for retry', () => {
  const original = JSON.stringify({ tasks: [{ id: 7, name: 'مهمة' }], dailyLogs: [] });
  const harness = migrationHarness(original, null, null, { throwOnSetKey: 'migration-archive' });
  const report = harness.run();

  assert.equal(report.success, false);
  assert.equal(harness.values.get('main'), original);
  assert.equal(harness.values.get('migration-in-progress'), '1');
  assert.equal(harness.values.get('migration-archive') ?? null, null);
});

function resetAllHarness(faults = {}) {
  const keys = {
    main: 'main', preImport: 'pre-import', importInProgress: 'import-in-progress',
    migrationInProgress: 'migration-in-progress', resetInProgress: 'reset-in-progress',
    rollingBackupA: 'rolling-backup-a', rollingBackupB: 'rolling-backup-b',
    rollingRestoreInProgress: 'rolling-restore-in-progress',
    rollingBackupGeneration: 'rolling-backup-generation',
    testFlag: 'test-flag', migrationArchive: 'migration-archive', testBackup: 'test-backup',
    thoughts: 'thoughts', projects: 'projects', focusTimer: 'focus-timer',
    focusSessions: 'focus-sessions', mentalInbox: 'mental-inbox',
    focusSettings: 'focus-settings', notifications: 'notifications'
  };
  const values = new Map(Object.entries(keys)
    .filter(([name]) => !['resetInProgress', 'rollingRestoreInProgress', 'rollingBackupGeneration'].includes(name))
    .map(([, key]) => [key, 'old-value']));
  const removeCalls = [];
  const alerts = [];
  const toasts = [];
  const confirmations = [];
  const sandbox = {
    STORAGE_KEY: keys.main,
    PRE_IMPORT_KEY: keys.preImport,
    IMPORT_IN_PROGRESS_KEY: keys.importInProgress,
    _stopwatchTransactionLockDepth: 1,
    MIGRATION_IN_PROGRESS_KEY: keys.migrationInProgress,
    RESET_IN_PROGRESS_KEY: keys.resetInProgress,
    ROLLING_BACKUP_A_KEY: keys.rollingBackupA,
    ROLLING_BACKUP_B_KEY: keys.rollingBackupB,
    ROLLING_RESTORE_IN_PROGRESS_KEY: keys.rollingRestoreInProgress,
    ROLLING_BACKUP_GENERATION_KEY: keys.rollingBackupGeneration,
    MIGRATION_ARCHIVE_KEY: keys.migrationArchive,
    BACKUP_KEY: keys.migrationArchive,
    TEST_FLAG_KEY: keys.testFlag,
    TEST_BACKUP_KEY: keys.testBackup,
    THOUGHTS_KEY: keys.thoughts,
    PROJECTS_KEY: keys.projects,
    FOCUS_TIMER_KEY: keys.focusTimer,
    FOCUS_SESSIONS_KEY: keys.focusSessions,
    MENTAL_INBOX_KEY: keys.mentalInbox,
    FOCUS_SETTINGS_KEY: keys.focusSettings,
    NOTIFICATIONS_KEY: keys.notifications,
    APP_VERSION: 'test',
    appSettings: { darkMode: false, themeMode: 'light' },
    tasks: [{ id: 99 }],
    createdByVersion: 'old',
    storageRecoveryRequired: false,
    _sessionsCache: [],
    _focusTimer: {
      mode: 'stopwatch', phase: 'work', running: true, baseElapsed: 75,
      startedAt: 1, cyclePosition: 2, taskId: 99, sessionStartAt: 1,
      awaitingConfirmation: true, pendingPhaseEndedAt: 2,
      clockAdjusted: true, pendingStopwatchTransaction: { id: 'pending' }
    },
    _focusElapsedRemainderMs: 500,
    _focusTimerColdStartWasRunning: true,
    _focusTimerSavedAtAtLoad: 1,
    _focusTimerCheckpointAt: 1,
    _awaySessionPromptOpen: true,
    _secondaryStorageKeys: [
      keys.projects, keys.thoughts, keys.mentalInbox, keys.focusSessions,
      keys.focusTimer, keys.focusSettings, keys.notifications
    ],
    _secondaryStorageBaselines: Object.create(null),
    _secondaryStorageConflicts: Object.create(null),
    _mainStorageExternalChangeObserved: true,
    _focusTimerExternalConflict: true,
    _focusTimerConflictNoticeShown: true,
    _rollingRecoveryBackupEpoch: 0,
    _rollingRecoveryBackupPending: null,
    _rollingRecoveryBackupStale: false,
    _rollingRecoveryBackupLastFailure: null,
    _resetInFlight: false,
    _startupResetRecoveryInFlight: false,
    _resetAllPendingPromise: null,
    buildEmptyV2: () => ({
      schemaVersion: 2, createdByVersion: 'test',
      settings: {}, tasks: [], dailyLogs: []
    }),
    validateV2: () => true,
    todayStr: () => '2026-11-21',
    localStorage: {
      get length() { return values.size; },
      key(index) { return Array.from(values.keys())[index] ?? null; },
      getItem(key) {
        if (faults.throwOnGetKey === key) throw new Error('simulated read failure');
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        if (faults.throwOnSetKey === key) throw new Error('simulated write failure');
        values.set(key, String(value));
      },
      removeItem(key) {
        removeCalls.push(key);
        if (faults.throwOnRemoveKey === key) throw new Error('simulated remove failure');
        values.delete(key);
      }
    },
    _setMainStorageBaseline: () => {},
    _captureMainStorageBaseline: () => true,
    _withStopwatchTransactionLock(callback) {
      const sandbox = this;
      sandbox._stopwatchTransactionLockDepth = (sandbox._stopwatchTransactionLockDepth || 0) + 1;
      return Promise.resolve().then(callback).finally(() => {
        sandbox._stopwatchTransactionLockDepth = Math.max(0, sandbox._stopwatchTransactionLockDepth - 1);
      });
    },
    loadData: () => true,
    _loadFocusTimer: () => {},
    _loadFocusSettings: () => {},
    showConfirmModal(title, body, accept) { confirmations.push({ title, body }); accept(); },
    showAlertModal: (...args) => alerts.push(args),
    showToast: (message) => toasts.push(message),
    _invalidateProjectsCache: () => {},
    _stopDisplayTick: () => {},
    _clearFocusTimerClock: () => {},
    _applyThemePreference: () => {},
    _queueAllTaskReminderSync: () => {},
    cancelEdit: () => {},
    cancelProjectEdit: () => {},
    renderAll: () => {}
  };
  vm.runInNewContext(
    extractFunction('_readPersistedRollingBackupGeneration') + '\n'
      + extractFunction('_setPersistedRollingBackupGeneration') + '\n'
      + extractFunction('_invalidateRollingRecoveryBackupRequests') + '\n'
      + extractFunction('_withResetTransactionLock') + '\n'
      + extractFunction('_resetStorageRemovalKeys') + '\n'
      + extractFunction('_resetSecondaryStorageTrackingAfterReset') + '\n'
      + extractFunction('_recoverInterruptedReset') + '\n'
      + extractFunction('_executeResetAllTransaction') + '\n'
      + extractFunction('resetAll'),
    sandbox
  );
  return {
    keys, values, removeCalls, alerts, toasts, confirmations, sandbox,
    seedResetMarker() {
      const main = JSON.stringify(sandbox.buildEmptyV2());
      values.set(keys.resetInProgress, JSON.stringify({ version: 1, main, generation: 1 }));
    },
    recover: () => sandbox._recoverInterruptedReset(),
    run: () => {
      sandbox.resetAll();
      return sandbox._resetAllPendingPromise;
    }
  };
}
test('interrupted Reset recovery attempts every deletion and retains its marker when one key cannot be removed', () => {
  const harness = resetAllHarness({ throwOnRemoveKey: 'projects' });
  harness.seedResetMarker();
  assert.equal(harness.recover(), false);

  assert.ok(harness.removeCalls.includes('focus-timer'));
  assert.ok(harness.removeCalls.includes('focus-sessions'));
  assert.ok(harness.removeCalls.includes('mental-inbox'));
  assert.equal(harness.values.get('projects'), 'old-value');
  assert.equal(harness.sandbox.storageRecoveryRequired, true);
  assert.notEqual(harness.values.get(harness.keys.resetInProgress), undefined,
    'the durable reset marker must remain available for retry after a failed deletion');
  assert.equal(harness.values.get(harness.keys.rollingBackupGeneration), '1');
});


function rollingRecoveryHarness(initial = {}, faults = {}) {
  const keys = {
    main: 'main',
    focusSessions: 'focus-sessions',
    focusTimer: 'focus-timer',
    mentalInbox: 'mental-inbox',
    thoughts: 'thoughts',
    projects: 'projects',
    focusSettings: 'focus-settings',
    notifications: 'notifications',
    backupA: 'rolling-backup-a',
    backupB: 'rolling-backup-b',
    restoreMarker: 'rolling-restore-in-progress',
    generation: 'rolling-backup-generation'
  };
  const values = new Map(Object.entries(initial));
  const writes = [];
  const reads = [];
  const sandbox = {
    STORAGE_KEY: keys.main,
    FOCUS_SESSIONS_KEY: keys.focusSessions,
    FOCUS_TIMER_KEY: keys.focusTimer,
    MENTAL_INBOX_KEY: keys.mentalInbox,
    THOUGHTS_KEY: keys.thoughts,
    PROJECTS_KEY: keys.projects,
    FOCUS_SETTINGS_KEY: keys.focusSettings,
    NOTIFICATIONS_KEY: keys.notifications,
    ROLLING_BACKUP_A_KEY: keys.backupA,
    ROLLING_BACKUP_B_KEY: keys.backupB,
    ROLLING_RESTORE_IN_PROGRESS_KEY: keys.restoreMarker,
    ROLLING_BACKUP_GENERATION_KEY: keys.generation,
    Date,
    console,
    storageRecoveryRequired: false,
    _stopwatchTransactionLockDepth: 1,
    _rollingRecoveryBackupEpoch: 0,
    _rollingRecoveryBackupPending: null,
    _rollingRecoveryCheckpointHold: 0,
    _rollingRecoveryBackupStale: false,
    _rollingRecoveryBackupLastFailure: null,
    _rollingRecoveryBackupLastSuccessAt: null,
    _isOptionalRollingRecoveryBackupFailure: () => false,
    validateV2(data) {
      return !!data && data.schemaVersion === 2
        && Array.isArray(data.tasks) && Array.isArray(data.dailyLogs);
    },
    _restoreStorageSnapshot(snapshot) {
      if (faults.restoreFails) return false;
      const mapping = [
        ['main', keys.main], ['focusSessions', keys.focusSessions],
        ['focusTimer', keys.focusTimer], ['mentalInbox', keys.mentalInbox],
        ['thoughts', keys.thoughts], ['projects', keys.projects],
        ['focusSettings', keys.focusSettings], ['notifications', keys.notifications]
      ];
      for (const [property, key] of mapping) {
        if (snapshot[property] === null) values.delete(key);
        else values.set(key, snapshot[property]);
      }
      return true;
    },
    _setMainStorageBaseline: () => {},
    localStorage: {
      getItem(key) {
        reads.push(key);
        if (faults.throwOnGetKey === key) throw new Error('simulated read failure');
        const value = values.has(key) ? values.get(key) : null;
        if (typeof faults.onGet === 'function') faults.onGet(key, values, reads.length);
        return value;
      },
      setItem(key, value) {
        writes.push([key, String(value)]);
        if (faults.throwOnSetKey === key) throw new Error('simulated write failure');
        values.set(key, String(value));
      },
      removeItem(key) {
        if (faults.throwOnRemoveKey === key) throw new Error('simulated remove failure');
        values.delete(key);
      }
    }
  };
  vm.runInNewContext(
    extractFunction('_readPersistedRollingBackupGeneration') + '\n'
      + extractFunction('_parseRollingRecoveryBackup') + '\n'
      + extractFunction('_getLatestRollingRecoveryBackup') + '\n'
      + extractFunction('_storeRollingRecoveryBackupLocked') + '\n'
      + extractFunction('_storeRollingRecoveryBackup') + '\n'
      + extractFunction('_recoverInterruptedRollingRestore'),
    sandbox
  );
  return { keys, values, writes, reads, sandbox };
}

function rollingState(prefix) {
  return {
    main: JSON.stringify({ schemaVersion: 2, settings: {}, tasks: [], dailyLogs: [], marker: prefix }),
    'focus-sessions': JSON.stringify([{ id: 1, marker: prefix }]),
    'focus-timer': JSON.stringify({ mode: 'stopwatch', baseElapsed: 10, marker: prefix }),
    'mental-inbox': JSON.stringify([{ id: 2, text: prefix, createdAt: '2026-11-21' }]),
    thoughts: JSON.stringify([{ id: 3, text: prefix, createdAt: '2026-11-21' }]),
    projects: JSON.stringify([{ id: 4, name: prefix }]),
    'focus-settings': JSON.stringify({ workMin: 25, shortMin: 5, longMin: 15 }),
    notifications: JSON.stringify({ enabled: true })
  };
}

test('rolling recovery checkpoints contain every raw storage group and rotate two verified generations', () => {
  const harness = rollingRecoveryHarness(rollingState('first'));
  assert.equal(harness.sandbox._storeRollingRecoveryBackup('main-save'), true);
  const firstRaw = harness.values.get(harness.keys.backupA);
  assert.ok(firstRaw);
  const first = JSON.parse(firstRaw);
  assert.equal(first.sequence, 1);
  assert.deepEqual(Object.keys(first.data).sort(), [
    'main', 'focusSessions', 'focusTimer', 'mentalInbox',
    'thoughts', 'projects', 'focusSettings', 'notifications'
  ].sort());
  assert.equal(first.data.main, rollingState('first').main);
  assert.equal(first.data.projects, rollingState('first').projects);

  for (const [key, value] of Object.entries(rollingState('second'))) {
    harness.values.set(key, value);
  }
  assert.equal(harness.sandbox._storeRollingRecoveryBackup('main-save'), true);
  const latest = harness.sandbox._getLatestRollingRecoveryBackup();
  assert.equal(latest.slot, 'b');
  assert.equal(latest.record.sequence, 2);
  assert.equal(latest.record.data.main, rollingState('second').main);
  assert.ok(harness.values.get(harness.keys.backupA), 'older valid checkpoint remains available');
});

test('rolling recovery refuses an unverified new checkpoint without overwriting the last good slot', () => {
  const harness = rollingRecoveryHarness(rollingState('first'));
  assert.equal(harness.sandbox._storeRollingRecoveryBackup('main-save'), true);
  const knownGood = harness.values.get(harness.keys.backupA);
  for (const [key, value] of Object.entries(rollingState('second'))) {
    harness.values.set(key, value);
  }
  harness.sandbox.localStorage.setItem = (key, value) => {
    if (key === harness.keys.backupB) throw new Error('quota exceeded');
    harness.values.set(key, String(value));
  };
  assert.equal(harness.sandbox._storeRollingRecoveryBackup('main-save'), false);
  assert.equal(harness.values.get(harness.keys.backupA), knownGood);
  assert.equal(harness.sandbox._getLatestRollingRecoveryBackup().record.sequence, 1);
});

test('rolling recovery reader ignores a corrupt newest slot and selects the older verified snapshot', () => {
  const harness = rollingRecoveryHarness(rollingState('first'));
  assert.equal(harness.sandbox._storeRollingRecoveryBackup('main-save'), true);
  for (const [key, value] of Object.entries(rollingState('second'))) {
    harness.values.set(key, value);
  }
  assert.equal(harness.sandbox._storeRollingRecoveryBackup('main-save'), true);
  harness.values.set(harness.keys.backupB, '{broken');
  const latest = harness.sandbox._getLatestRollingRecoveryBackup();
  assert.equal(latest.slot, 'a');
  assert.equal(latest.record.sequence, 1);
  assert.equal(latest.record.data.main, rollingState('first').main);
});

test('interrupted rolling-backup restoration is replayed from its durable slot marker', () => {
  const harness = rollingRecoveryHarness(rollingState('current'));
  const record = {
    formatVersion: 1,
    sequence: 7,
    createdAtMs: 1795260000000,
    reason: 'main-save',
    data: {
      main: rollingState('saved').main,
      focusSessions: rollingState('saved')['focus-sessions'],
      focusTimer: rollingState('saved')['focus-timer'],
      mentalInbox: rollingState('saved')['mental-inbox'],
      thoughts: rollingState('saved').thoughts,
      projects: rollingState('saved').projects,
      focusSettings: rollingState('saved')['focus-settings'],
      notifications: rollingState('saved').notifications
    }
  };
  harness.values.set(harness.keys.backupA, JSON.stringify(record));
  harness.values.set(harness.keys.restoreMarker, JSON.stringify({ version: 1, slot: 'a', sequence: 7 }));
  harness.sandbox._stopwatchTransactionLockDepth = 1;
  assert.equal(harness.sandbox._recoverInterruptedRollingRestore(), true);
  assert.equal(harness.values.get('main'), rollingState('saved').main);
  assert.equal(harness.values.get('projects'), rollingState('saved').projects);
  assert.equal(harness.values.has(harness.keys.restoreMarker), false);
});

test('failed interrupted rolling-backup restoration preserves its marker and verified source snapshot', () => {
  const harness = rollingRecoveryHarness(rollingState('partial'), { restoreFails: true });
  const record = {
    formatVersion: 1,
    sequence: 3,
    createdAtMs: 1795260000000,
    reason: 'main-save',
    data: {
      main: rollingState('saved').main,
      focusSessions: rollingState('saved')['focus-sessions'],
      focusTimer: rollingState('saved')['focus-timer'],
      mentalInbox: rollingState('saved')['mental-inbox'],
      thoughts: rollingState('saved').thoughts,
      projects: rollingState('saved').projects,
      focusSettings: rollingState('saved')['focus-settings'],
      notifications: rollingState('saved').notifications
    }
  };
  const rawRecord = JSON.stringify(record);
  const rawMarker = JSON.stringify({ version: 1, slot: 'a', sequence: 3 });
  harness.values.set(harness.keys.backupA, rawRecord);
  harness.values.set(harness.keys.restoreMarker, rawMarker);
  harness.sandbox._stopwatchTransactionLockDepth = 1;
  assert.equal(harness.sandbox._recoverInterruptedRollingRestore(), false);
  assert.equal(harness.values.get(harness.keys.backupA), rawRecord);
  assert.equal(harness.values.get(harness.keys.restoreMarker), rawMarker);
});

test('_recoverInterruptedResetWithLock keeps the lock through the post-recovery load callback', async () => {
  const events = [];
  let sandbox;
  sandbox = {
    navigator: { locks: { request() { throw new Error('the helper must delegate to the shared lock wrapper'); } } },
    _stopwatchTransactionLockDepth: 0,
    _withStopwatchTransactionLock(callback) {
      sandbox._stopwatchTransactionLockDepth++;
      let result;
      try { result = callback(); }
      finally { sandbox._stopwatchTransactionLockDepth--; }
      return Promise.resolve(result);
    },
    _recoverInterruptedReset(options) {
      events.push({ stage: 'recover', depth: sandbox._stopwatchTransactionLockDepth,
        keepRecoveryLock: options.keepRecoveryLock });
      return true;
    }
  };
  vm.runInNewContext(extractFunction('_recoverInterruptedResetWithLock'), sandbox);
  const result = await sandbox._recoverInterruptedResetWithLock({ keepRecoveryLock: true }, function(recovered) {
    events.push({ stage: 'afterRecovery', depth: sandbox._stopwatchTransactionLockDepth, recovered });
    assert.equal(sandbox._stopwatchTransactionLockDepth, 1,
      'loadData and reset verification must remain inside the same lock');
    return true;
  });
  assert.equal(result, true);
  assert.deepEqual(events.map(event => event.stage), ['recover', 'afterRecovery']);
  assert.equal(events[0].depth, 1);
  assert.equal(events[0].keepRecoveryLock, true);
  assert.equal(events[1].depth, 1);
  assert.equal(sandbox._stopwatchTransactionLockDepth, 0);
});

test('_recoverInterruptedResetWithLock does not run post-recovery load after a failed replay', async () => {
  let callbackCalls = 0;
  let sandbox;
  sandbox = {
    navigator: { locks: { request() { throw new Error('the helper must delegate to the shared lock wrapper'); } } },
    _stopwatchTransactionLockDepth: 0,
    _withStopwatchTransactionLock(callback) {
      sandbox._stopwatchTransactionLockDepth++;
      try { return Promise.resolve(callback()); }
      finally { sandbox._stopwatchTransactionLockDepth--; }
    },
    _recoverInterruptedReset: () => false
  };
  vm.runInNewContext(extractFunction('_recoverInterruptedResetWithLock'), sandbox);
  const result = await sandbox._recoverInterruptedResetWithLock({}, function() {
    callbackCalls++;
    return true;
  });
  assert.equal(result, false);
  assert.equal(callbackCalls, 0);
});

test('resetAll leaves a persistent marker on partial deletion and startup recovery completes the reset', async () => {
  const faults = { throwOnRemoveKey: 'projects' };
  const harness = resetAllHarness(faults);
  assert.equal(await harness.run(), false);
  const markerRaw = harness.values.get(harness.keys.resetInProgress);
  assert.ok(markerRaw, 'reset intent survives after the first reset attempt');
  const marker = JSON.parse(markerRaw);
  assert.equal(marker.version, 1);
  assert.equal(JSON.parse(marker.main).schemaVersion, 2);
  assert.equal(harness.sandbox.storageRecoveryRequired, true);

  faults.throwOnRemoveKey = null;
  assert.equal(harness.recover(), true);
  assert.equal(harness.values.has('projects'), false);
  assert.equal(harness.values.has(harness.keys.focusTimer), false);
  assert.equal(harness.values.has(harness.keys.resetInProgress), false);
  assert.equal(harness.sandbox.storageRecoveryRequired, false);
  assert.equal(harness.values.get(harness.keys.focusSettings), 'old-value',
    'reset preserves the focus-duration preference');
  assert.equal(harness.values.get(harness.keys.notifications), 'old-value',
    'reset preserves the notification preference');
});

test('resetAll does not change data when its durable marker cannot be written and verified', async () => {
  const harness = resetAllHarness({ throwOnSetKey: 'reset-in-progress' });
  const originalMain = harness.values.get('main');
  assert.equal(await harness.run(), false);
  assert.equal(harness.values.get('main'), originalMain);
  assert.equal(harness.removeCalls.length, 0);
  assert.equal(harness.values.has(harness.keys.resetInProgress), false);
  assert.equal(harness.sandbox.storageRecoveryRequired, true);
});

test('interrupted reset recovery rejects an invalid marker without deleting any stored key', () => {
  const harness = resetAllHarness();
  const original = new Map(harness.values);
  harness.values.set(harness.keys.resetInProgress, '{broken');
  assert.equal(harness.recover(), false);
  assert.equal(harness.values.get(harness.keys.resetInProgress), '{broken');
  assert.equal(harness.values.get('projects'), original.get('projects'));
  assert.equal(harness.values.get('focus-timer'), original.get('focus-timer'));
});


test('rolling recovery uses the timestamp to select the newest equal-sequence slot and rotate the older one', () => {
  const firstState = rollingState('older-collision');
  const latestState = rollingState('newer-collision');
  const makeRecord = (state, createdAtMs) => ({
    formatVersion: 1,
    sequence: 9,
    createdAtMs,
    reason: 'main-save',
    data: {
      main: state.main,
      focusSessions: state['focus-sessions'],
      focusTimer: state['focus-timer'],
      mentalInbox: state['mental-inbox'],
      thoughts: state.thoughts,
      projects: state.projects,
      focusSettings: state['focus-settings'],
      notifications: state.notifications
    }
  });
  const harness = rollingRecoveryHarness({
    'rolling-backup-a': JSON.stringify(makeRecord(firstState, 100)),
    'rolling-backup-b': JSON.stringify(makeRecord(latestState, 200)),
    ...rollingState('current')
  });
  const latest = harness.sandbox._getLatestRollingRecoveryBackup();
  assert.equal(latest.slot, 'b');
  assert.equal(latest.record.data.main, latestState.main);
  assert.equal(harness.sandbox._storeRollingRecoveryBackup('main-save'), true);
  assert.equal(harness.sandbox._getLatestRollingRecoveryBackup().slot, 'a');
  assert.equal(harness.sandbox._getLatestRollingRecoveryBackup().record.sequence, 10);
  assert.equal(harness.values.get('rolling-backup-b'), JSON.stringify(makeRecord(latestState, 200)));

  const equalA = JSON.stringify(makeRecord(firstState, 300));
  const equalB = JSON.stringify(makeRecord(latestState, 300));
  const equalHarness = rollingRecoveryHarness({
    'rolling-backup-a': equalA,
    'rolling-backup-b': equalB,
    ...rollingState('current')
  });
  assert.equal(equalHarness.sandbox._getLatestRollingRecoveryBackup().slot, 'a');
  assert.equal(equalHarness.sandbox._storeRollingRecoveryBackup('main-save'), true);
  assert.equal(equalHarness.values.get('rolling-backup-a'), equalA,
    'the selected latest slot remains intact when sequence and timestamp are tied');
});

test('resetAll keeps its durable marker and original records when writing the empty main record fails', async () => {
  const harness = resetAllHarness({ throwOnSetKey: 'main' });
  assert.equal(await harness.run(), false);
  assert.equal(harness.values.get('main'), 'old-value');
  assert.ok(harness.values.get(harness.keys.resetInProgress));
  assert.equal(harness.values.get('projects'), 'old-value');
  assert.equal(harness.sandbox.storageRecoveryRequired, true);
  assert.equal(harness.toasts.some((message) => /تم حذف كل البيانات/.test(message)), false);
});

test('reset recovery retains its marker when marker cleanup fails and can finish on retry', async () => {
  const faults = { throwOnRemoveKey: 'reset-in-progress' };
  const harness = resetAllHarness(faults);
  assert.equal(await harness.run(), false);
  assert.ok(harness.values.get(harness.keys.resetInProgress));
  assert.equal(harness.values.get('main') !== 'old-value', true);
  assert.equal(harness.values.has('projects'), false);
  assert.equal(harness.sandbox.storageRecoveryRequired, true);

  faults.throwOnRemoveKey = null;
  assert.equal(harness.recover(), true);
  assert.equal(harness.values.has(harness.keys.resetInProgress), false);
  assert.equal(harness.sandbox.storageRecoveryRequired, false);
});


test('daily-log save checkpoints the updated main record into rolling recovery storage', () => {
  const original = JSON.stringify({
    schemaVersion: 2, settings: {}, tasks: [], dailyLogs: []
  });
  const values = new Map([['main', original]]);
  let checkpointRaw = null;
  let checkpointReason = null;
  const sandbox = {
    STORAGE_KEY: 'main',
    IMPORT_IN_PROGRESS_KEY: 'import-in-progress',
    _stopwatchTransactionLockDepth: 1,
    MIGRATION_IN_PROGRESS_KEY: 'migration-in-progress',
    RESET_IN_PROGRESS_KEY: 'reset-in-progress',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore-in-progress',
    storageRecoveryRequired: false,
    _mainStorageBaselineReady: true,
    _mainStorageExternalChangeObserved: false,
    _mainStorageBaselineRaw: original,
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); }
    },
    _setMainStorageBaseline(raw) { sandbox._mainStorageBaselineRaw = raw; },
    validateV2: () => true,
    showToast: () => {},
    console,
    _storeRollingRecoveryBackup(reason) {
      checkpointReason = reason;
      checkpointRaw = values.get('main');
      return true;
    }
  };
  vm.runInNewContext(
    extractFunction('_storageWriteAllowed') + '\n'
      + extractFunction('persistDailyLog') + '\npersistDailyLog',
    sandbox
  );

  const log = {
    date: '2026-11-21', control: 4, execution: 5, wellbeing: 3,
    energy: 'متوسط', distractions: 1, bufferUsed: 0,
    mentalTask: '', mentalNext: '', createdAt: 1, updatedAt: 2
  };
  sandbox.persistDailyLog(log);

  const saved = JSON.parse(values.get('main'));
  assert.equal(saved.dailyLogs.length, 1);
  assert.equal(saved.dailyLogs[0].date, log.date);
  assert.equal(checkpointReason, 'daily-log-save');
  assert.equal(checkpointRaw, values.get('main'),
    'checkpoint must capture the new daily log, not the pre-save main record');
});

test('daily-log save refuses writes during migration, import, reset, and rolling restore', () => {
  const original = JSON.stringify({ schemaVersion: 2, settings: {}, tasks: [], dailyLogs: [] });
  const markerKeys = [
    'import-in-progress', 'migration-in-progress',
    'reset-in-progress', 'rolling-restore-in-progress'
  ];
  for (const markerKey of markerKeys) {
    const values = new Map([['main', original], [markerKey, 'pending']]);
    let checkpointCount = 0;
    const sandbox = {
      STORAGE_KEY: 'main',
      IMPORT_IN_PROGRESS_KEY: 'import-in-progress',
    _stopwatchTransactionLockDepth: 1,
      MIGRATION_IN_PROGRESS_KEY: 'migration-in-progress',
      RESET_IN_PROGRESS_KEY: 'reset-in-progress',
      ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore-in-progress',
      storageRecoveryRequired: false,
      _mainStorageBaselineReady: true,
      _mainStorageExternalChangeObserved: false,
      _mainStorageBaselineRaw: original,
      localStorage: {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); }
      },
      _setMainStorageBaseline(raw) { sandbox._mainStorageBaselineRaw = raw; },
      validateV2: () => true,
      showToast: () => {},
      console,
      _storeRollingRecoveryBackup() { checkpointCount++; return true; }
    };
    vm.runInNewContext(
      extractFunction('_storageWriteAllowed') + '\n'
        + extractFunction('persistDailyLog') + '\npersistDailyLog',
      sandbox
    );
    sandbox.persistDailyLog({
      date: '2026-11-21', control: 4, execution: 5, wellbeing: 3,
      energy: 'متوسط', distractions: 1, bufferUsed: 0,
      mentalTask: '', mentalNext: '', createdAt: 1, updatedAt: 2
    });
    assert.equal(values.get('main'), original, 'must not write while marker is active: ' + markerKey);
    assert.equal(checkpointCount, 0);
  }
});

test('storage-write guard blocks all in-progress operations and fails closed on marker read errors', () => {
  const markerKeys = [
    'import-in-progress', 'migration-in-progress',
    'reset-in-progress', 'rolling-restore-in-progress'
  ];
  for (const markerKey of markerKeys) {
    const sandbox = {
      IMPORT_IN_PROGRESS_KEY: 'import-in-progress',
    _stopwatchTransactionLockDepth: 1,
      MIGRATION_IN_PROGRESS_KEY: 'migration-in-progress',
      RESET_IN_PROGRESS_KEY: 'reset-in-progress',
      ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore-in-progress',
      storageRecoveryRequired: false,
      localStorage: { getItem(key) { return key === markerKey ? 'pending' : null; } }
    };
    vm.runInNewContext(extractFunction('_storageWriteAllowed'), sandbox);
    assert.equal(sandbox._storageWriteAllowed(), false, markerKey);
  }

  const readFailure = {
    IMPORT_IN_PROGRESS_KEY: 'import-in-progress',
    _stopwatchTransactionLockDepth: 1,
    MIGRATION_IN_PROGRESS_KEY: 'migration-in-progress',
    RESET_IN_PROGRESS_KEY: 'reset-in-progress',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore-in-progress',
    storageRecoveryRequired: false,
    localStorage: { getItem() { throw new Error('storage unavailable'); } }
  };
  vm.runInNewContext(extractFunction('_storageWriteAllowed'), readFailure);
  assert.equal(readFailure._storageWriteAllowed(), false);
  assert.equal(readFailure.storageRecoveryRequired, true);

  const staleBaseline = {
    STORAGE_KEY: 'main',
    IMPORT_IN_PROGRESS_KEY: 'import-in-progress',
    _stopwatchTransactionLockDepth: 1,
    MIGRATION_IN_PROGRESS_KEY: 'migration-in-progress',
    RESET_IN_PROGRESS_KEY: 'reset-in-progress',
    ROLLING_RESTORE_IN_PROGRESS_KEY: 'rolling-restore-in-progress',
    storageRecoveryRequired: false,
    _mainStorageBaselineReady: true,
    _mainStorageExternalChangeObserved: false,
    _mainStorageBaselineRaw: 'old-main',
    localStorage: { getItem(key) { return key === 'main' ? 'new-main' : null; } }
  };
  vm.runInNewContext(extractFunction('_storageWriteAllowed'), staleBaseline);
  assert.equal(staleBaseline._storageWriteAllowed(), false,
    'side-collection writes must stop when another tab changed the main record');
});


test('rolling recovery refuses a mixed multi-collection snapshot when another tab changes data during capture', () => {
  let projectReads = 0;
  const harness = rollingRecoveryHarness(rollingState('before'), {
    onGet(key, values) {
      if (key === 'projects') {
        projectReads++;
        if (projectReads === 1) values.set('projects', rollingState('during-capture').projects);
      }
    }
  });
  assert.equal(harness.sandbox._storeRollingRecoveryBackup('main-save'), false);
  assert.equal(harness.values.has(harness.keys.backupA), false);
  assert.equal(harness.values.has(harness.keys.backupB), false);
  assert.equal(projectReads, 2);
});

test('resetAll also removes timestamped corruption snapshots from every auxiliary collection', async () => {
  const harness = resetAllHarness();
  const corruptKeys = [
    'mental-inbox_corrupt_1700000000000',
    'thoughts_corrupt_1700000000001',
    'projects_corrupt_1700000000002'
  ];
  for (const key of corruptKeys) harness.values.set(key, 'preserved-corrupt-bytes');

  assert.equal(await harness.run(), true);

  for (const key of corruptKeys) {
    assert.equal(harness.values.has(key), false, 'reset must remove hidden corrupt snapshot: ' + key);
    assert.ok(harness.removeCalls.includes(key), 'cleanup must attempt corrupt snapshot: ' + key);
  }
  assert.equal(harness.sandbox.storageRecoveryRequired, false);
  assert.ok(harness.toasts.some((message) => /تم حذف كل البيانات/.test(message)));
});

test('failed corruption-snapshot deletion keeps reset marker and startup retry removes the remaining snapshot', async () => {
  const corruptKey = 'projects_corrupt_1700000000002';
  const faults = { throwOnRemoveKey: corruptKey };
  const harness = resetAllHarness(faults);
  harness.values.set(corruptKey, 'preserved-corrupt-bytes');

  assert.equal(await harness.run(), false);

  assert.equal(harness.values.get(corruptKey), 'preserved-corrupt-bytes');
  assert.ok(harness.values.has(harness.keys.resetInProgress),
    'a failed hidden-snapshot deletion must keep the durable reset marker');
  assert.equal(harness.sandbox.storageRecoveryRequired, true);

  faults.throwOnRemoveKey = null;
  assert.equal(harness.recover(), true);
  assert.equal(harness.values.has(corruptKey), false);
  assert.equal(harness.values.has(harness.keys.resetInProgress), false);
  assert.equal(harness.sandbox.storageRecoveryRequired, false);
});


test('mental-item conversion rollback refreshes rolling checkpoint to the restored pre-transaction state', () => {
  const originalMain = JSON.stringify({
    schemaVersion: 2, settings: {}, tasks: [], dailyLogs: []
  });
  const values = new Map([['main', originalMain]]);
  const tasks = [];
  const inbox = [{ id: 7, text: 'فكرة', next: 'خطوة', createdAt: '2026-11-21' }];
  const checkpoints = [];
  const toasts = [];
  const sandbox = {
    MENTAL_INBOX_KEY: 'inbox',
    appSettings: { lastTaskId: 0 },
    _secondaryStorageBaselines: Object.create(null),
    _secondaryStorageConflicts: Object.create(null),
    _acquireRollingRecoveryCheckpointHold(enabled) {
      if (enabled) sandbox._rollingRecoveryCheckpointHold++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (enabled) sandbox._rollingRecoveryCheckpointHold = Math.max(0, sandbox._rollingRecoveryCheckpointHold - 1);
      };
    },
    _restoreStorageValueIfUnchanged(key, expected, previous) {
      try {
        if (values.get(key) !== expected) return false;
        if (previous === null) values.delete(key);
        else {
          if ((typeof failRollback !== 'undefined' && failRollback)
              || (typeof failCompensation !== 'undefined' && failCompensation)) {
            throw new Error('simulated compensation failure');
          }
          values.set(key, previous);
        }
        return true;
      } catch (e) { return false; }
    },
    _completeRollingRecoveryCheckpoint(reason) {
      sandbox._storeRollingRecoveryBackup(reason, 0);
      return true;
    },
    tasks,
    STORAGE_KEY: 'main',
    Date,
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    },
    _loadMentalInbox: () => inbox,
    _rollingRecoveryCheckpointHold: 0,
    saveData() {
      values.set('main', JSON.stringify({
        schemaVersion: 2, settings: {}, tasks: sandbox.tasks, dailyLogs: []
      }));
      if (sandbox._rollingRecoveryCheckpointHold === 0) {
        checkpoints.push({ reason: 'main-save', main: values.get('main') });
      }
      return true;
    },
    _saveMentalInbox: () => false,
    getNextTaskId: () => 1,
    todayStr: () => '2026-11-21',
    _setMainStorageBaseline: () => {},
    _storeRollingRecoveryBackup(reason) {
      checkpoints.push({ reason, main: values.get('main'), inbox: JSON.stringify(inbox) });
      return true;
    },
    renderAll: () => {},
    showToast: (message) => toasts.push(message),
    showAlertModal: () => {},
    console
  };
  vm.runInNewContext(extractFunction('convertMentalItemToTask'), sandbox);
  sandbox.convertMentalItemToTask(7);

  assert.equal(values.get('main'), originalMain, 'failed second collection write must restore the main data');
  assert.deepEqual(sandbox.tasks, []);
  assert.equal(inbox[0].convertedTaskId, undefined);
  assert.equal(checkpoints.at(-1).reason, 'transaction-rollback');
  assert.equal(checkpoints.at(-1).main, originalMain);
  assert.ok(toasts.some((message) => /لم تُحوّل/.test(message)));
});

test('mental-item conversion blocks further writes when its main-data compensation fails', () => {
  const originalMain = JSON.stringify({
    schemaVersion: 2, settings: {}, tasks: [], dailyLogs: []
  });
  const values = new Map([['main', originalMain]]);
  const inbox = [{ id: 8, text: 'فكرة', createdAt: '2026-11-21' }];
  let failRollback = false;
  const checkpoints = [];
  const alerts = [];
  const sandbox = {
    MENTAL_INBOX_KEY: 'inbox',
    appSettings: { lastTaskId: 0 },
    _secondaryStorageBaselines: Object.create(null),
    _secondaryStorageConflicts: Object.create(null),
    _acquireRollingRecoveryCheckpointHold(enabled) {
      if (enabled) sandbox._rollingRecoveryCheckpointHold++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (enabled) sandbox._rollingRecoveryCheckpointHold = Math.max(0, sandbox._rollingRecoveryCheckpointHold - 1);
      };
    },
    _restoreStorageValueIfUnchanged(key, expected, previous) {
      try {
        if (values.get(key) !== expected) return false;
        if (previous === null) values.delete(key);
        else {
          if ((typeof failRollback !== 'undefined' && failRollback)
              || (typeof failCompensation !== 'undefined' && failCompensation)) {
            throw new Error('simulated compensation failure');
          }
          values.set(key, previous);
        }
        return true;
      } catch (e) { return false; }
    },
    _completeRollingRecoveryCheckpoint(reason) {
      sandbox._storeRollingRecoveryBackup(reason, 0);
      return true;
    },
    tasks: [],
    STORAGE_KEY: 'main',
    storageRecoveryRequired: false,
    Date,
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) {
        if ((typeof failRollback !== 'undefined' && failRollback)
              || (typeof failCompensation !== 'undefined' && failCompensation)) {
            throw new Error('simulated compensation failure');
          }
        values.set(key, String(value));
      },
      removeItem(key) { values.delete(key); }
    },
    _loadMentalInbox: () => inbox,
    saveData() {
      values.set('main', JSON.stringify({
        schemaVersion: 2, settings: {}, tasks: sandbox.tasks, dailyLogs: []
      }));
      return true;
    },
    _saveMentalInbox: () => { failRollback = true; return false; },
    getNextTaskId: () => 1,
    todayStr: () => '2026-11-21',
    _setMainStorageBaseline: () => {},
    _storeRollingRecoveryBackup(reason) { checkpoints.push(reason); return true; },
    renderAll: () => {},
    showToast: () => {},
    showAlertModal: (...args) => alerts.push(args),
    console
  };
  vm.runInNewContext(extractFunction('convertMentalItemToTask'), sandbox);
  sandbox.convertMentalItemToTask(8);

  assert.equal(sandbox.storageRecoveryRequired, true);
  assert.equal(checkpoints.includes('transaction-rollback'), false);
  assert.ok(alerts.length > 0);
});

test('project deletion rollback refreshes rolling checkpoint only after both stores are restored', () => {
  const originalMain = JSON.stringify({
    schemaVersion: 2, settings: {}, tasks: [
      { id: 1, name: 'مهمة', projectId: 5 }
    ], dailyLogs: []
  });
  const originalProjects = JSON.stringify([{ id: 5, name: 'مشروع' }]);
  const values = new Map([['main', originalMain], ['projects', originalProjects]]);
  const tasks = [{ id: 1, name: 'مهمة', projectId: 5 }];
  const projects = [{ id: 5, name: 'مشروع' }];
  const checkpoints = [];
  const toasts = [];
  const sandbox = {
    MENTAL_INBOX_KEY: 'inbox',
    appSettings: { lastTaskId: 0 },
    _secondaryStorageBaselines: Object.create(null),
    _secondaryStorageConflicts: Object.create(null),
    _acquireRollingRecoveryCheckpointHold(enabled) {
      if (enabled) sandbox._rollingRecoveryCheckpointHold++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (enabled) sandbox._rollingRecoveryCheckpointHold = Math.max(0, sandbox._rollingRecoveryCheckpointHold - 1);
      };
    },
    _restoreStorageValueIfUnchanged(key, expected, previous) {
      try {
        if (values.get(key) !== expected) return false;
        if (previous === null) values.delete(key);
        else {
          if ((typeof failRollback !== 'undefined' && failRollback)
              || (typeof failCompensation !== 'undefined' && failCompensation)) {
            throw new Error('simulated compensation failure');
          }
          values.set(key, previous);
        }
        return true;
      } catch (e) { return false; }
    },
    _completeRollingRecoveryCheckpoint(reason) {
      sandbox._storeRollingRecoveryBackup(reason, 0);
      return true;
    },
    tasks,
    STORAGE_KEY: 'main',
    PROJECTS_KEY: 'projects',
    VALID_PROJECT_STATUS: ['active', 'completed', 'paused'],
    _editingProjectId: null,
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    },
    _loadProjects: () => projects,
    showConfirmModal(_title, _body, accept) { accept(); },
    _rollingRecoveryCheckpointHold: 0,
    saveData() {
      values.set('main', JSON.stringify({
        schemaVersion: 2, settings: {}, tasks: sandbox.tasks, dailyLogs: []
      }));
      if (sandbox._rollingRecoveryCheckpointHold === 0) {
        checkpoints.push({ reason: 'main-save', main: values.get('main') });
      }
      return true;
    },
    _saveProjects: () => false,
    _setMainStorageBaseline: () => {},
    _invalidateProjectsCache: () => {},
    _storeRollingRecoveryBackup(reason) {
      checkpoints.push({
        reason, main: values.get('main'), projects: values.get('projects')
      });
      return true;
    },
    renderProjects: () => {},
    renderTasks: () => {},
    _renderProjectSelect: () => {},
    cancelProjectEdit: () => {},
    showToast: (message) => toasts.push(message),
    showAlertModal: () => {},
    console
  };
  vm.runInNewContext(extractFunction('deleteProject'), sandbox);
  sandbox.deleteProject(5);

  assert.equal(values.get('main'), originalMain);
  assert.equal(values.get('projects'), originalProjects);
  assert.equal(tasks[0].projectId, 5);
  assert.equal(checkpoints.at(-1).reason, 'transaction-rollback');
  assert.equal(checkpoints.at(-1).main, originalMain);
  assert.equal(checkpoints.at(-1).projects, originalProjects);
});

test('project deletion enters recovery-required state if compensating writes fail', () => {
  const originalMain = JSON.stringify({
    schemaVersion: 2, settings: {}, tasks: [
      { id: 1, name: 'مهمة', projectId: 5 }
    ], dailyLogs: []
  });
  const originalProjects = JSON.stringify([{ id: 5, name: 'مشروع' }]);
  const values = new Map([['main', originalMain], ['projects', originalProjects]]);
  const tasks = [{ id: 1, name: 'مهمة', projectId: 5 }];
  const projects = [{ id: 5, name: 'مشروع' }];
  let failCompensation = false;
  const alerts = [];
  const checkpoints = [];
  const sandbox = {
    MENTAL_INBOX_KEY: 'inbox',
    appSettings: { lastTaskId: 0 },
    _secondaryStorageBaselines: Object.create(null),
    _secondaryStorageConflicts: Object.create(null),
    _acquireRollingRecoveryCheckpointHold(enabled) {
      if (enabled) sandbox._rollingRecoveryCheckpointHold++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (enabled) sandbox._rollingRecoveryCheckpointHold = Math.max(0, sandbox._rollingRecoveryCheckpointHold - 1);
      };
    },
    _restoreStorageValueIfUnchanged(key, expected, previous) {
      try {
        if (values.get(key) !== expected) return false;
        if (previous === null) values.delete(key);
        else {
          if ((typeof failRollback !== 'undefined' && failRollback)
              || (typeof failCompensation !== 'undefined' && failCompensation)) {
            throw new Error('simulated compensation failure');
          }
          values.set(key, previous);
        }
        return true;
      } catch (e) { return false; }
    },
    _completeRollingRecoveryCheckpoint(reason) {
      sandbox._storeRollingRecoveryBackup(reason, 0);
      return true;
    },
    tasks,
    STORAGE_KEY: 'main',
    PROJECTS_KEY: 'projects',
    VALID_PROJECT_STATUS: ['active', 'completed', 'paused'],
    _editingProjectId: null,
    storageRecoveryRequired: false,
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) {
        if (failCompensation) throw new Error('simulated compensation failure');
        values.set(key, String(value));
      },
      removeItem(key) { values.delete(key); }
    },
    _loadProjects: () => projects,
    showConfirmModal(_title, _body, accept) { accept(); },
    saveData() {
      values.set('main', JSON.stringify({
        schemaVersion: 2, settings: {}, tasks: sandbox.tasks, dailyLogs: []
      }));
      return true;
    },
    _saveProjects: () => { failCompensation = true; return false; },
    _setMainStorageBaseline: () => {},
    _invalidateProjectsCache: () => {},
    _storeRollingRecoveryBackup(reason) { checkpoints.push(reason); return true; },
    renderProjects: () => {},
    renderTasks: () => {},
    _renderProjectSelect: () => {},
    cancelProjectEdit: () => {},
    showToast: () => {},
    showAlertModal: (...args) => alerts.push(args),
    console
  };
  vm.runInNewContext(extractFunction('deleteProject'), sandbox);
  sandbox.deleteProject(5);

  assert.equal(sandbox.storageRecoveryRequired, true);
  assert.equal(checkpoints.includes('transaction-rollback'), false);
  assert.ok(alerts.length > 0);
});


test('rolling recovery checkpoint hold skips every intermediate snapshot and resumes after commit', () => {
  const initial = rollingState('before-transaction');
  const harness = rollingRecoveryHarness(initial);
  harness.sandbox._rollingRecoveryCheckpointHold = 1;

  assert.equal(harness.sandbox._storeRollingRecoveryBackup('intermediate-main-write'), true);
  assert.equal(harness.values.has(harness.keys.backupA), false);
  assert.equal(harness.values.has(harness.keys.backupB), false);

  harness.values.set('main', rollingState('committed').main);
  harness.values.set('projects', rollingState('committed').projects);
  harness.sandbox._rollingRecoveryCheckpointHold = 0;
  assert.equal(harness.sandbox._storeRollingRecoveryBackup('transaction-commit'), true);

  const latest = harness.sandbox._getLatestRollingRecoveryBackup();
  assert.equal(latest.record.data.main, rollingState('committed').main);
  assert.equal(latest.record.data.projects, rollingState('committed').projects);
  assert.equal(latest.record.reason, 'transaction-commit');
});


test('loadData blocks migration and normal loading when interrupted import recovery fails', () => {
  let migrationCalls = 0;
  const alerts = [];
  const sandbox = {
    tasks: [{ id: 77, name: 'must not be replaced' }],
    storageRecoveryRequired: false,
    _stopwatchTransactionLockDepth: 1,
    _recoverInterruptedReset: () => true,
    _recoverInterruptedRollingRestore: () => true,
    _recoverInterruptedImport: () => false,
    migrateV1ToV2() {
      migrationCalls++;
      return { success: true, fromVersion: 2, totalOriginal: 0 };
    },
    showAlertModal: (...args) => alerts.push(args),
    console
  };
  vm.runInNewContext(extractFunction('loadData'), sandbox);
  sandbox.loadData();

  assert.equal(migrationCalls, 0, 'migration must not proceed after a failed recovery');
  assert.equal(sandbox.storageRecoveryRequired, true);
  assert.equal(sandbox.tasks[0].id, 77, 'in-memory task state must not be replaced by fallback data');
  assert.equal(alerts.length, 1);
});

test('interrupted import keeps both control keys when recovery-marker deletion fails', () => {
  const markerKey = 'import-in-progress';
  const backupKey = 'pre-import';
  const previous = {
    main: JSON.stringify({ schemaVersion: 2, settings: {}, tasks: [], dailyLogs: [] }),
    focusSessions: null,
    focusTimer: null,
    mentalInbox: null,
    thoughts: null,
    projects: null,
    focusSettings: null,
    notifications: null
  };
  const values = new Map([
    [markerKey, '1'],
    [backupKey, JSON.stringify(previous)]
  ]);
  const sandbox = {
    IMPORT_IN_PROGRESS_KEY: markerKey,
    _stopwatchTransactionLockDepth: 1,
    PRE_IMPORT_KEY: backupKey,
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      removeItem(key) {
        if (key === markerKey) throw new Error('simulated marker cleanup failure');
        values.delete(key);
      }
    },
    validateV2: (data) => data && data.schemaVersion === 2,
    _restoreStorageSnapshot: () => true
  };
  vm.runInNewContext(extractFunction('_recoverInterruptedImport'), sandbox);
  assert.equal(sandbox._recoverInterruptedImport(), false);
  assert.equal(values.get(markerKey), '1');
  assert.equal(values.get(backupKey), JSON.stringify(previous));
});

test('interrupted import treats only PRE_IMPORT cleanup failure as retained cleanup debt', () => {
  const markerKey = 'import-in-progress';
  const backupKey = 'pre-import';
  const previous = {
    main: JSON.stringify({ schemaVersion: 2, settings: {}, tasks: [], dailyLogs: [] }),
    focusSessions: null,
    focusTimer: null,
    mentalInbox: null,
    thoughts: null,
    projects: null,
    focusSettings: null,
    notifications: null
  };
  const values = new Map([
    [markerKey, '1'],
    [backupKey, JSON.stringify(previous)]
  ]);
  const sandbox = {
    IMPORT_IN_PROGRESS_KEY: markerKey,
    _stopwatchTransactionLockDepth: 1,
    PRE_IMPORT_KEY: backupKey,
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      removeItem(key) {
        if (key === backupKey) throw new Error('simulated inert snapshot cleanup failure');
        values.delete(key);
      }
    },
    validateV2: (data) => data && data.schemaVersion === 2,
    _restoreStorageSnapshot: () => true
  };
  vm.runInNewContext(extractFunction('_recoverInterruptedImport'), sandbox);
  assert.equal(sandbox._recoverInterruptedImport(), true,
    'restored data remains successful when only deletion of its inert snapshot fails');
  assert.equal(values.has(markerKey), false, 'recovery marker must be cleared');
  assert.equal(values.get(backupKey), JSON.stringify(previous),
    'the inert snapshot is retained for manual cleanup rather than replayed');
});



test('migration self-test checks createdByVersion without triggering live saveData conflict UI', () => {
  const body = extractFunction('runMigrationTests');
  const start = body.indexOf('test("ترحيل V2 يحافظ على createdByVersion"');
  const end = body.indexOf('test("dailyLog بقيمة control', start);
  assert.ok(start >= 0 && end > start, 'the createdByVersion migration case exists');
  const migrationCase = body.slice(start, end);
  assert.doesNotMatch(migrationCase, /saveData\s*\(/,
    'migration tests must not call the live persistence path against temporary test storage');
  assert.match(migrationCase, /if \(!r\.success\)/,
    'the test must fail when migration itself fails');
});

test('storage record copy ignores own __proto__ without mutating the copy prototype', () => {
  const sandbox = {};
  vm.runInNewContext(extractFunction('_copyStorageRecord'), sandbox);
  const source = JSON.parse('{"id":7,"text":"safe","__proto__":{"polluted":true}}');
  const copied = sandbox._copyStorageRecord(source);
  assert.equal(copied.id, 7);
  assert.equal(copied.text, 'safe');
  assert.equal(copied.polluted, undefined);
  assert.equal(copied.hasOwnProperty('text'), true);
  assert.equal(Object.prototype.polluted, undefined);
  for (const loader of ['_loadAppSettings', '_loadMentalInbox', '_loadThoughts', '_loadProjects']) {
    assert.match(extractFunction(loader), /_copyStorageRecord\(/, loader + ' uses the safe record copier');
  }
});

test('V2 validation rejects malformed lastRecurringDates before normal storage use', () => {
  const sandbox = {
    CURRENT_SCHEMA_VERSION: 2,
    VALID_STATUS: ['pending', 'done', 'cancelled'],
    VALID_TYPES: ['معرفية', 'إدارية', 'إبداعية', 'اجتماعية'],
    isValidCalendarDate(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const [year, month, day] = value.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    },
    isValidLocalTime: () => true,
    isValidLocalDateTime: () => true,
    validateDailyLog: () => true
  };
  vm.runInNewContext(
    extractFunction('_validateLastRecurringDates') + '\n' + extractFunction('validateV2'),
    sandbox
  );
  const makeData = (lastRecurringDates) => ({
    schemaVersion: 2,
    settings: { lastRecurringDates },
    tasks: [],
    dailyLogs: []
  });
  assert.equal(sandbox.validateV2(makeData({ 'series:1': '2026-11-21' })), true);
  assert.equal(sandbox.validateV2(makeData(null)), true, 'legacy null remains accepted');
  assert.equal(sandbox.validateV2(makeData('not-an-object')), false);
  assert.equal(sandbox.validateV2(makeData([])), false);
  assert.equal(sandbox.validateV2(makeData({ 'series:1': '2026-02-31' })), false);
  assert.equal(sandbox.validateV2(makeData(JSON.parse('{"constructor":"2026-11-21"}'))), false);
  assert.equal(sandbox.validateV2(makeData(JSON.parse('{"__proto__":"2026-11-21"}'))), false);
  const tooManyRecurringDates = {};
  for (let i = 0; i < 501; i++) tooManyRecurringDates['series:' + i] = '2026-11-21';
  assert.equal(sandbox.validateV2(makeData(tooManyRecurringDates)), false);
  assert.ok(extractFunction('validateBackup').includes('_validateLastRecurringDates('));
});

test('all reviewed modal openers remove the previous shared keydown handler before registering', () => {
  for (const name of ['openSOSModal', 'openShutdownModal', '_showStopwatchSaveDialog', 'finishTimer', '_showSessionTransitionDialog']) {
    const body = extractFunction(name);
    assert.match(body,
      /if \(_modalKeyHandler\) \{\s*document\.removeEventListener\(['"]keydown['"],\s*_modalKeyHandler\);\s*\}\s*_modalKeyHandler\s*=\s*function/,
      name + ' removes the previously registered handler');
  }
});

test('failed timer pause save restores the exact prior running state', () => {
  const originalStartedAt = Date.now() - 12_000;
  const alerts = [];
  let starts = 0, stops = 0;
  const sandbox = {
    _focusTimerExternalConflict: false,
    _focusElapsedRemainderMs: 0,
    _anchorFocusTimerClock: () => {},
    _focusTimer: {
      running: true, awaitingConfirmation: false, baseElapsed: 90,
      startedAt: originalStartedAt, sessionStartAt: originalStartedAt - 500
    },
    _unlockAudioContext: () => {},
    _getElapsedSec: () => 102,
    _getFocusTimerElapsedParts: () => ({ seconds: 102, remainderMs: 0 }),
    _stopDisplayTick: () => { stops++; },
    _startDisplayTick: () => { starts++; },
    _saveFocusTimer: () => false,
    _renderFocusTimer: () => {},
    showAlertModal: (...args) => alerts.push(args)
  };
  vm.runInNewContext(extractFunction('toggleTimer'), sandbox);
  sandbox.toggleTimer();
  assert.equal(sandbox._focusTimer.running, true);
  assert.equal(sandbox._focusTimer.baseElapsed, 90);
  assert.equal(sandbox._focusTimer.startedAt, originalStartedAt);
  assert.equal(sandbox._focusTimer.sessionStartAt, originalStartedAt - 500);
  assert.equal(stops, 1);
  assert.equal(starts, 1);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][0], /إيقاف المؤقت/);
});

test('failed timer start save restores the exact prior stopped state', () => {
  const alerts = [];
  let starts = 0, stops = 0;
  const sandbox = {
    _focusTimerExternalConflict: false,
    _focusElapsedRemainderMs: 0,
    _anchorFocusTimerClock: () => {},
    _focusTimer: {
      running: false, awaitingConfirmation: false, baseElapsed: 240,
      startedAt: null, sessionStartAt: null
    },
    _unlockAudioContext: () => {},
    _getElapsedSec: () => 240,
    _stopDisplayTick: () => { stops++; },
    _startDisplayTick: () => { starts++; },
    _saveFocusTimer: () => false,
    _renderFocusTimer: () => {},
    showAlertModal: (...args) => alerts.push(args)
  };
  vm.runInNewContext(extractFunction('toggleTimer'), sandbox);
  sandbox.toggleTimer();
  assert.equal(sandbox._focusTimer.running, false);
  assert.equal(sandbox._focusTimer.baseElapsed, 240);
  assert.equal(sandbox._focusTimer.startedAt, null);
  assert.equal(sandbox._focusTimer.sessionStartAt, null);
  assert.equal(stops, 1);
  assert.equal(starts, 0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][0], /تشغيل المؤقت/);
});

test('recurring task refresh is page-lifetime, visible-only, minute-based, and idempotently installed', () => {
  let tick = null, delay = null, intervalCreates = 0, generated = 0, rendered = 0, toasted = 0;
  const sandbox = {
    _recurringTaskRefreshInterval: null,
    storageRecoveryRequired: false,
    document: { visibilityState: 'hidden' },
    setInterval(fn, ms) { tick = fn; delay = ms; intervalCreates++; return 77; },
    _generateAndPersistRecurringTasks() { generated++; return 2; },
    renderAll() { rendered++; },
    showToast(message) { if (message.includes('2')) toasted++; },
    console
  };
  vm.runInNewContext(extractFunction('_setupRecurringTaskRefresh'), sandbox);
  sandbox._setupRecurringTaskRefresh();
  sandbox._setupRecurringTaskRefresh();
  assert.equal(intervalCreates, 1);
  assert.equal(delay, 60_000);
  tick();
  assert.equal(generated, 0, 'hidden tabs do not run the periodic task generator');
  sandbox.document.visibilityState = 'visible';
  tick();
  assert.equal(generated, 1);
  assert.equal(rendered, 1);
  assert.equal(toasted, 1);
  sandbox.storageRecoveryRequired = true;
  tick();
  assert.equal(generated, 1, 'recovery-required mode blocks recurring writes');
});
