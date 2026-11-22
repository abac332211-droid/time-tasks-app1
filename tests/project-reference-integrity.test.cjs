'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
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

function runFunctions(names, sandbox) {
  vm.runInNewContext(names.map(extractFunction).join('\n'), sandbox);
  return sandbox;
}

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

const STORAGE_KEY = 'timeTasksApp_v1';
const PROJECTS_KEY = 'timeTasksApp_projects_v1';
const FOCUS_SESSIONS_KEY = 'timeTasksApp_focusSessions';
const FOCUS_TIMER_KEY = 'timeTasksApp_focusTimer';
const MENTAL_INBOX_KEY = 'timeTasksApp_mentalInbox';
const THOUGHTS_KEY = 'timeTasksApp_thoughts_v1';
const FOCUS_SETTINGS_KEY = 'timeTasksApp_focusSettings';
const NOTIFICATIONS_KEY = 'timeTasksApp_notifications';
const IMPORT_IN_PROGRESS_KEY = 'timeTasksApp_importInProgress';
const PRE_IMPORT_KEY = 'timeTasksApp_preImportBackup';

const validMain = (tasks = []) => JSON.stringify({
  schemaVersion: 2,
  settings: {},
  tasks,
  dailyLogs: []
});

function project(id, name = 'مشروع') {
  return { id, name, status: 'active', createdAt: '2026-11-22T00:00:00.000Z' };
}

function task(id, projectId, status = 'pending') {
  return {
    id, name: 'مهمة ' + id, status, type: 'معرفية', expected: 30,
    actual: status === 'done' ? 30 : null,
    plannedDate: '2026-11-22', plannedTime: '',
    completedAt: status === 'done' ? '2026-11-22T10:00:00' : null,
    createdAt: 1795300000000 + id,
    projectId
  };
}

test('pure project-reference validator accepts null and existing references, and rejects missing, orphaned, unsafe and duplicate IDs', () => {
  const sandbox = runFunctions(['validateTaskProjectReferences'], {});
  const validate = sandbox.validateTaskProjectReferences;

  assert.equal(validate([task(1, null)], []).valid, true);
  assert.equal(validate([task(2, 7)], [project(7)]).valid, true);
  assert.equal(validate([{ ...task(3, null), projectId: undefined }], []).valid, false);
  assert.equal(validate([task(4, 8)], [project(7)]).valid, false);
  assert.equal(validate([task(5, Number.MAX_SAFE_INTEGER + 1)], []).valid, false);
  assert.equal(validate([task(6, -2)], []).valid, false);
  assert.equal(validate([], [project(7), project(7, 'مكرر')]).valid, false);
});

test('legacy normalizer converts only absent projectId fields to null without mutating source records', () => {
  const sandbox = runFunctions(['normalizeLegacyTaskProjectReferences'], {});
  const legacy = [
    { ...task(1, null) , projectId: undefined, extra: 'preserve' },
    task(2, null),
    task(3, 9)
  ];
  const original = JSON.stringify(legacy);
  const normalized = sandbox.normalizeLegacyTaskProjectReferences(legacy);

  assert.equal(normalized.valid, true);
  assert.equal(normalized.changed, true);
  assert.equal(normalized.tasks[0].projectId, null);
  assert.equal(normalized.tasks[0].extra, 'preserve');
  assert.equal(normalized.tasks[1].projectId, null);
  assert.equal(normalized.tasks[2].projectId, 9);
  assert.equal(JSON.stringify(legacy), original, 'normalization must not mutate legacy source records');
  assert.equal(sandbox.normalizeLegacyTaskProjectReferences(normalized.tasks).changed, false);
});

test('persisted relationship check reads both raw stores rather than a stale projects cache', () => {
  const storage = memoryStorage({
    [STORAGE_KEY]: validMain([task(1, 44)]),
    [PROJECTS_KEY]: JSON.stringify([])
  });
  const sandbox = runFunctions([
    'validateTaskProjectReferences',
    '_readStoredProjectsForTaskReferenceValidation',
    '_readStoredTasksForProjectReferenceValidation',
    '_verifyStoredTaskProjectReferences'
  ], {
    localStorage: storage,
    STORAGE_KEY,
    PROJECTS_KEY,
    CURRENT_SCHEMA_VERSION: 2,
    validateV2: () => true,
    _trackSecondaryStorageRead: () => {},
    _projectsCache: [project(44)]
  });

  assert.equal(sandbox._verifyStoredTaskProjectReferences().valid, false,
    'a stale in-memory cache must not make a persisted orphan appear valid');
  storage.setItem(PROJECTS_KEY, JSON.stringify([project(44)]));
  assert.equal(sandbox._verifyStoredTaskProjectReferences().valid, true);
});

test('_saveProjects refuses to remove a referenced project before writing the project store', () => {
  const originalProjects = JSON.stringify([project(55)]);
  const storage = memoryStorage({
    [STORAGE_KEY]: validMain([task(1, 55)]),
    [PROJECTS_KEY]: originalProjects
  });
  let writes = 0;
  const sandbox = runFunctions([
    'validateTaskProjectReferences',
    '_readStoredTasksForProjectReferenceValidation',
    '_saveProjects'
  ], {
    localStorage: storage,
    STORAGE_KEY,
    PROJECTS_KEY,
    CURRENT_SCHEMA_VERSION: 2,
    validateV2: () => true,
    storageRecoveryRequired: false,
    _trackSecondaryStorageRead: () => {},
    _storageWriteAllowed: () => true,
    _writeSecondaryStorageVerified: (key, value) => {
      writes++;
      storage.setItem(key, value);
      return true;
    },
    _invalidateProjectsCache: () => {},
    _storeRollingRecoveryBackup: () => true
  });

  assert.equal(sandbox._saveProjects([]), false);
  assert.equal(writes, 0);
  assert.equal(storage.getItem(PROJECTS_KEY), originalProjects);
  assert.equal(sandbox.storageRecoveryRequired, true);
});

function projectDeleteHarness({ rows, failProjectWrite = false, failMainWrite = false }) {
  const originalMain = validMain(rows);
  const originalProjects = JSON.stringify([project(70)]);
  const storage = memoryStorage({
    [STORAGE_KEY]: originalMain,
    [PROJECTS_KEY]: originalProjects
  });
  const tasks = rows.map((row) => ({ ...row }));
  const alerts = [];
  const toasts = [];
  let saveCalls = 0;
  const sandbox = {
    localStorage: storage,
    STORAGE_KEY,
    PROJECTS_KEY,
    CURRENT_SCHEMA_VERSION: 2,
    VALID_PROJECT_STATUS: ['active', 'completed', 'paused'],
    tasks,
    storageRecoveryRequired: false,
    _secondaryStorageBaselines: Object.create(null),
    _secondaryStorageConflicts: Object.create(null),
    _projectsCache: null,
    _editingProjectId: null,
    _trackSecondaryStorageRead: () => {},
    _isValidProjectId: (id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
    validateV2: () => true,
    _storageWriteAllowed: () => true,
    _loadProjects: () => JSON.parse(storage.getItem(PROJECTS_KEY)),
    _acquireRollingRecoveryCheckpointHold: () => () => {},
    _restoreStorageValueIfUnchanged(key, expected, previous) {
      if (storage.getItem(key) !== expected) return false;
      if (previous === null) storage.removeItem(key);
      else storage.setItem(key, previous);
      return storage.getItem(key) === previous;
    },
    _setMainStorageBaseline: () => {},
    _invalidateProjectsCache: () => { sandbox._projectsCache = null; },
    _writeSecondaryStorageVerified(key, value) {
      if (failProjectWrite && key === PROJECTS_KEY) return false;
      storage.setItem(key, value);
      return storage.getItem(key) === value;
    },
    _storeRollingRecoveryBackup: () => true,
    _completeRollingRecoveryCheckpoint: () => true,
    saveData() {
      saveCalls++;
      if (failMainWrite) return false;
      const current = JSON.parse(storage.getItem(STORAGE_KEY));
      current.tasks = sandbox.tasks;
      storage.setItem(STORAGE_KEY, JSON.stringify(current));
      return true;
    },
    showConfirmModal: (_title, _message, accept) => accept(),
    showAlertModal: (...args) => alerts.push(args),
    showToast: (message) => toasts.push(message),
    renderProjects: () => {},
    renderTasks: () => {},
    _renderProjectSelect: () => {},
    cancelProjectEdit: () => {},
    console
  };
  runFunctions([
    'validateTaskProjectReferences',
    '_readStoredProjectsForTaskReferenceValidation',
    '_readStoredTasksForProjectReferenceValidation',
    '_verifyStoredTaskProjectReferences',
    '_saveProjects',
    'deleteProject'
  ], sandbox);
  return { sandbox, storage, tasks, alerts, toasts, get saveCalls() { return saveCalls; }, originalMain, originalProjects };
}

test('successful project deletion preserves pending, completed and cancelled tasks and detaches every reference', () => {
  const harness = projectDeleteHarness({
    rows: [task(1, 70, 'pending'), task(2, 70, 'done'), task(3, 70, 'cancelled')]
  });

  harness.sandbox.deleteProject(70);

  const persistedMain = JSON.parse(harness.storage.getItem(STORAGE_KEY));
  const persistedProjects = JSON.parse(harness.storage.getItem(PROJECTS_KEY));
  assert.deepEqual(persistedMain.tasks.map((item) => item.id), [1, 2, 3]);
  assert.deepEqual(persistedMain.tasks.map((item) => item.status), ['pending', 'done', 'cancelled']);
  assert.deepEqual(persistedMain.tasks.map((item) => item.projectId), [null, null, null]);
  assert.deepEqual(persistedProjects, []);
  assert.equal(harness.saveCalls, 1);
  assert.equal(harness.sandbox._verifyStoredTaskProjectReferences().valid, true);
  assert.equal(harness.sandbox.storageRecoveryRequired, false);
});

test('successful deletion of a project with no linked tasks leaves main tasks untouched', () => {
  const harness = projectDeleteHarness({ rows: [task(1, null)] });

  harness.sandbox.deleteProject(70);

  assert.equal(harness.saveCalls, 0, 'no main-data transaction is needed without linked tasks');
  assert.equal(JSON.parse(harness.storage.getItem(STORAGE_KEY)).tasks[0].projectId, null);
  assert.deepEqual(JSON.parse(harness.storage.getItem(PROJECTS_KEY)), []);
  assert.equal(harness.sandbox._verifyStoredTaskProjectReferences().valid, true);
});

test('project deletion rolls the main store and in-memory references back if project-store write fails', () => {
  const harness = projectDeleteHarness({
    rows: [task(1, 70, 'pending'), task(2, 70, 'done')],
    failProjectWrite: true
  });

  harness.sandbox.deleteProject(70);

  assert.equal(harness.storage.getItem(STORAGE_KEY), harness.originalMain);
  assert.equal(harness.storage.getItem(PROJECTS_KEY), harness.originalProjects);
  assert.deepEqual(harness.tasks.map((item) => item.projectId), [70, 70]);
  assert.equal(harness.sandbox.storageRecoveryRequired, false);
  assert.ok(harness.toasts.some((message) => /أُعيدت الحالة السابقة/.test(message)));
});

function fullRelationshipStorageHarness(seed = {}) {
  const storage = memoryStorage(seed);
  const sandbox = {
    localStorage: storage,
    STORAGE_KEY,
    PROJECTS_KEY,
    FOCUS_SESSIONS_KEY,
    FOCUS_TIMER_KEY,
    MENTAL_INBOX_KEY,
    THOUGHTS_KEY,
    FOCUS_SETTINGS_KEY,
    NOTIFICATIONS_KEY,
    CURRENT_SCHEMA_VERSION: 2,
    storageRecoveryRequired: false,
    _trackSecondaryStorageRead: () => {},
    _setMainStorageBaseline: () => {},
    _invalidateProjectsCache: () => {},
    validateV2: () => true
  };
  runFunctions([
    'validateTaskProjectReferences',
    'normalizeLegacyTaskProjectReferences',
    '_readStoredProjectsForTaskReferenceValidation',
    '_readStoredTasksForProjectReferenceValidation',
    '_verifyStoredTaskProjectReferences',
    '_restoreStorageSnapshot'
  ], sandbox);
  return { sandbox, storage };
}

function restoreSnapshot(main, projects) {
  return {
    main,
    focusSessions: null,
    focusTimer: null,
    mentalInbox: null,
    thoughts: null,
    projects,
    focusSettings: null,
    notifications: null
  };
}

test('snapshot restore normalizes a missing legacy reference and verifies the actual stored pair before success', () => {
  const legacyMain = validMain([{ ...task(1, null), projectId: undefined }]);
  const projects = JSON.stringify([]);
  const harness = fullRelationshipStorageHarness({
    [STORAGE_KEY]: validMain([]),
    [PROJECTS_KEY]: '[]'
  });

  assert.equal(harness.sandbox._restoreStorageSnapshot(restoreSnapshot(legacyMain, projects)), true);
  const persisted = JSON.parse(harness.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.tasks[0].projectId, null);
  assert.equal(harness.sandbox._verifyStoredTaskProjectReferences().valid, true);
});

test('snapshot restore refuses an orphan reference before writing any collection', () => {
  const originalMain = validMain([]);
  const originalProjects = JSON.stringify([]);
  const harness = fullRelationshipStorageHarness({
    [STORAGE_KEY]: originalMain,
    [PROJECTS_KEY]: originalProjects
  });
  const snapshot = restoreSnapshot(validMain([task(1, 999)]), originalProjects);

  assert.equal(harness.sandbox._restoreStorageSnapshot(snapshot), false);
  assert.equal(harness.storage.getItem(STORAGE_KEY), originalMain);
  assert.equal(harness.storage.getItem(PROJECTS_KEY), originalProjects);
  assert.equal(harness.sandbox.storageRecoveryRequired, true);
});

function importHarness(backup, existingProjects = []) {
  const storage = memoryStorage({
    [STORAGE_KEY]: validMain([]),
    [PROJECTS_KEY]: JSON.stringify(existingProjects),
    [FOCUS_SESSIONS_KEY]: null,
    [FOCUS_TIMER_KEY]: 'previous-timer',
    [MENTAL_INBOX_KEY]: null,
    [THOUGHTS_KEY]: null,
    [FOCUS_SETTINGS_KEY]: null,
    [NOTIFICATIONS_KEY]: null
  });
  const alerts = [];
  let reloads = 0;
  const sandbox = {
    localStorage: storage,
    sessionStorage: { setItem: () => {} },
    STORAGE_KEY,
    PROJECTS_KEY,
    FOCUS_SESSIONS_KEY,
    FOCUS_TIMER_KEY,
    MENTAL_INBOX_KEY,
    THOUGHTS_KEY,
    FOCUS_SETTINGS_KEY,
    NOTIFICATIONS_KEY,
    IMPORT_IN_PROGRESS_KEY,
    PRE_IMPORT_KEY,
    CURRENT_SCHEMA_VERSION: 2,
    APP_VERSION: '2.9.0',
    storageRecoveryRequired: false,
    _trackSecondaryStorageRead: () => {},
    _invalidateProjectsCache: () => {},
    _storeRollingRecoveryBackup: () => true,
    _reloadAfterVerifiedOperation: () => { reloads++; },
    _restoreFocusTimerSnapshot: (data, targetStorage, key) => {
      if (data.focusTimer !== undefined && data.focusTimer !== null) {
        targetStorage.setItem(key, JSON.stringify(data.focusTimer));
      }
    },
    _rollbackRestore: () => false,
    validateV2: () => true,
    _healTaskArray: () => false,
    todayStr: () => '2026-11-22',
    isValidCalendarDate: () => true,
    showConfirmModal: (_title, _body, accept) => accept(),
    showPromptModal: (_title, _body, _initial, _placeholder, submit) => submit('استبدال'),
    showAlertModal: (...args) => alerts.push(args),
    showToast: () => {},
    escapeHTML: (value) => String(value)
  };
  runFunctions([
    'validateTaskProjectReferences',
    'normalizeLegacyTaskProjectReferences',
    '_readStoredProjectsForTaskReferenceValidation',
    '_readStoredTasksForProjectReferenceValidation',
    '_verifyStoredTaskProjectReferences',
    'showImportPreview'
  ], sandbox);
  sandbox.showImportPreview(backup);
  return { sandbox, storage, alerts, reloads: () => reloads };
}

test('backup import normalizes a task with a missing projectId to null before committing', () => {
  const backup = {
    backupFormatVersion: 2,
    schemaVersion: 2,
    data: {
      tasks: [{ ...task(1, null), projectId: undefined }],
      dailyLogs: [],
      projects: [project(81)]
    }
  };
  const harness = importHarness(backup);

  const persisted = JSON.parse(harness.storage.getItem(STORAGE_KEY));
  assert.equal(persisted.tasks[0].projectId, null);
  assert.deepEqual(JSON.parse(harness.storage.getItem(PROJECTS_KEY)), [project(81)]);
  assert.equal(harness.storage.getItem(IMPORT_IN_PROGRESS_KEY), null);
  assert.equal(harness.reloads(), 1);
  assert.equal(harness.sandbox._verifyStoredTaskProjectReferences().valid, true);
});

test('backup import rejects an explicit orphan reference without changing existing storage', () => {
  const originalMain = validMain([]);
  const originalProjects = JSON.stringify([]);
  const backup = {
    backupFormatVersion: 2,
    schemaVersion: 2,
    data: {
      tasks: [task(1, 91)],
      dailyLogs: [],
      projects: []
    }
  };
  const harness = importHarness(backup);

  assert.equal(harness.storage.getItem(STORAGE_KEY), originalMain);
  assert.equal(harness.storage.getItem(PROJECTS_KEY), originalProjects);
  assert.equal(harness.storage.getItem(IMPORT_IN_PROGRESS_KEY), null);
  assert.equal(harness.reloads(), 0);
  assert.ok(harness.alerts.some((args) => /نسخة غير متسقة/.test(String(args[0]))));
});

test('legacy import without a projects collection detaches references instead of matching local project IDs', () => {
  const localProjects = [project(5, 'مشروع الجهاز')];
  const backup = {
    backupFormatVersion: 1,
    schemaVersion: 2,
    data: {
      tasks: [task(1, 5)],
      dailyLogs: []
    }
  };
  const harness = importHarness(backup, localProjects);
  const persisted = JSON.parse(harness.storage.getItem(STORAGE_KEY));

  assert.equal(persisted.tasks[0].projectId, null);
  assert.deepEqual(JSON.parse(harness.storage.getItem(PROJECTS_KEY)), localProjects);
  assert.equal(harness.sandbox._verifyStoredTaskProjectReferences().valid, true);
  assert.equal(harness.reloads(), 1);
});

test('project deletion does not remove the project when the task-store save fails', () => {
  const harness = projectDeleteHarness({
    rows: [task(1, 70, 'pending')],
    failMainWrite: true
  });

  harness.sandbox.deleteProject(70);

  assert.equal(harness.storage.getItem(STORAGE_KEY), harness.originalMain);
  assert.equal(harness.storage.getItem(PROJECTS_KEY), harness.originalProjects);
  assert.equal(harness.tasks[0].projectId, 70);
  assert.equal(harness.sandbox.storageRecoveryRequired, false);
  assert.equal(harness.sandbox._verifyStoredTaskProjectReferences().valid, true);
});

test('backup export refuses to serialize a persisted orphan project reference', () => {
  const storage = memoryStorage({
    [STORAGE_KEY]: validMain([task(1, 777)]),
    [PROJECTS_KEY]: JSON.stringify([])
  });
  const sandbox = runFunctions([
    'validateTaskProjectReferences',
    '_readStoredProjectsForTaskReferenceValidation',
    '_readStoredTasksForProjectReferenceValidation',
    '_verifyStoredTaskProjectReferences',
    'buildBackupObject'
  ], {
    localStorage: storage,
    STORAGE_KEY,
    PROJECTS_KEY,
    CURRENT_SCHEMA_VERSION: 2,
    validateV2: () => true,
    _trackSecondaryStorageRead: () => {}
  });

  assert.throws(() => sandbox.buildBackupObject(), /تعذر تصدير النسخة/);
});

test('addTaskToProject persists repaired legacy project IDs before writing the linked task', () => {
  let projectWrites = 0;
  let taskWrites = 0;
  const tasks = [];
  let projects = [project(101), { ...project(105), _healed: true }];
  const sandbox = {
    tasks,
    _loadProjects: () => projects.map((item) => ({ ...item })),
    _saveProjects(candidate) {
      projectWrites++;
      projects = candidate.map((item) => ({ ...item }));
      return true;
    },
    showPromptModal: (_title, _body, _initial, _placeholder, accept) => accept('مهمة مرتبطة'),
    getNextTaskId: () => 9,
    todayStr: () => '2026-11-22',
    saveData() { taskWrites++; return true; },
    renderProjects: () => {},
    renderTasks: () => {},
    showToast: () => {}
  };
  runFunctions(['addTaskToProject'], sandbox);

  sandbox.addTaskToProject(101);

  assert.equal(projectWrites, 1, 'the repaired project collection is persisted first');
  assert.equal(taskWrites, 1, 'the new linked task is saved after project repair');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].projectId, 101);
  assert.equal(projects.find((item) => item.id === 105)._healed, true,
    'healing metadata is retained according to the existing loader contract');
});
