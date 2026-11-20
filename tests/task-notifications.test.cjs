'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const inlineScripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map((match) => match[1])
  .filter((source) => source.trim());
const appScript = inlineScripts.find((source) => source.includes('APP_VERSION'));
assert.ok(appScript, 'application script is available');

function extractFunction(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('(?:async\\s+)?function\\s+' + escaped + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists in index.html');
  return match[0];
}

function loadFunctions(names, context = {}) {
  const source = names.map(extractFunction).join('\n')
    + '\n({ ' + names.map((name) => name + ': ' + name).join(', ') + ' })';
  return vm.runInNewContext(source, context);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function validTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function makeNotificationHarness({ enabled = true, permission = 'granted', tasks = [], pending = [], failCancelAll = false } = {}) {
  const calls = { cancel: [], schedule: [], checkPermissions: 0, requestPermissions: 0, cancelAll: 0 };
  let currentPending = pending.map((item) => ({ ...item }));
  let enabledState = enabled;
  const LN = {
    async getPending() {
      return { notifications: currentPending.map((item) => ({ ...item })) };
    },
    async cancel(options) {
      const ids = (options.notifications || []).map((item) => item.id);
      calls.cancel.push(ids);
      currentPending = currentPending.filter((item) => !ids.includes(item.id));
    },
    async checkPermissions() {
      calls.checkPermissions++;
      return { display: permission };
    },
    async requestPermissions() {
      calls.requestPermissions++;
      return { display: permission === 'prompt' ? 'granted' : permission };
    },
    async schedule(options) {
      calls.schedule.push(...options.notifications);
      currentPending.push(...options.notifications);
      return { notifications: options.notifications.map(({ id }) => ({ id })) };
    },
    async cancelAll() {
      calls.cancelAll++;
      if (failCancelAll) throw new Error('simulated cancel-all failure');
      currentPending = [];
    }
  };
  const context = {
    console,
    tasks,
    _getNotificationsPref: () => ({ enabled: enabledState }),
    _hasCapacitorLocalNotifications: () => true,
    window: { Capacitor: { Plugins: { LocalNotifications: LN } } },
    isValidCalendarDate: validDate,
    isValidLocalTime: validTime,
    _setNotificationsPref: (value) => { enabledState = !!value; context.preference = enabledState; return true; },
    _queueAllTaskReminderSync: async () => true,
    _taskReminderSyncQueue: Promise.resolve(true),
    storageRecoveryRequired: false,
    preference: enabled
  };
  return { context, calls, pending: () => currentPending };
}

const reminderFunctions = [
  '_taskNotificationId',
  '_taskReminderAt',
  '_cancelTaskNotification',
  '_syncTaskNotification',
  '_syncAllTaskNotifications'
];

test('task reminder IDs are stable and stay separate from the reserved focus notification ID', () => {
  const { _taskNotificationId } = loadFunctions(['_taskNotificationId']);
  const id = _taskNotificationId(123456789);
  assert.equal(id, _taskNotificationId(123456789));
  assert.ok(Number.isInteger(id));
  assert.ok(id >= 1 && id <= 1900000000);
  assert.notEqual(id, 2000000000);
  assert.equal(_taskNotificationId(0), null);
  assert.equal(_taskNotificationId(-1), null);
  assert.equal(_taskNotificationId(Number.MAX_SAFE_INTEGER + 1), null);
});

test('only pending tasks with a valid future local date and time have reminders', () => {
  const { _taskReminderAt } = loadFunctions(
    ['_taskReminderAt'],
    { isValidCalendarDate: validDate, isValidLocalTime: validTime }
  );
  const future = { id: 1, status: 'pending', plannedDate: '2099-12-31', plannedTime: '23:59' };
  assert.ok(_taskReminderAt(future).getTime() > Date.now());
  assert.equal(_taskReminderAt({ ...future, status: 'done' }), null);
  assert.equal(_taskReminderAt({ ...future, plannedTime: '' }), null);
  assert.equal(_taskReminderAt({ ...future, plannedDate: '2099-02-30' }), null);
  assert.equal(_taskReminderAt({ ...future, plannedTime: '25:00' }), null);
  assert.equal(_taskReminderAt({ ...future, plannedDate: '2000-01-01' }), null);
});

test('startup reconciliation schedules pending tasks and removes stale task reminders only', async () => {
  const task = { id: 15, name: 'مراجعة المشروع', status: 'pending', plannedDate: '2099-12-31', plannedTime: '23:59' };
  const harness = makeNotificationHarness({
    tasks: [
      task,
      { id: 16, name: 'مكتملة', status: 'done', plannedDate: '2099-12-31', plannedTime: '23:59' },
      { id: 17, name: 'بلا وقت', status: 'pending', plannedDate: '2099-12-31', plannedTime: '' },
      { id: 18, name: 'قديمة', status: 'pending', plannedDate: '2000-01-01', plannedTime: '09:00' }
    ],
    pending: [
      { id: 999, extra: { kind: 'task-reminder', taskId: 'deleted-task' } },
      { id: 2000000000, extra: { kind: 'focus-transition' } }
    ]
  });
  const fns = loadFunctions(reminderFunctions, harness.context);
  assert.equal(await fns._syncAllTaskNotifications(), true);
  assert.deepEqual(harness.calls.schedule.map((item) => item.id), [fns._taskNotificationId(task.id)]);
  assert.equal(harness.calls.schedule[0].title, 'تذكير بمهمة');
  assert.equal(harness.calls.schedule[0].schedule.allowWhileIdle, undefined);
  const cancelled = harness.calls.cancel.flat();
  assert.ok(cancelled.includes(999));
  assert.ok(cancelled.includes(fns._taskNotificationId(task.id)));
  assert.ok(!cancelled.includes(2000000000));
  assert.equal(harness.calls.schedule.length, 1);
});

test('disabling notifications removes task reminders without cancelling unrelated focus notifications', async () => {
  const harness = makeNotificationHarness({
    enabled: false,
    tasks: [{ id: 3, status: 'pending', plannedDate: '2099-12-31', plannedTime: '23:59' }],
    pending: [
      { id: 123, extra: { kind: 'task-reminder', taskId: '3' } },
      { id: 2000000000, extra: { kind: 'focus-transition' } }
    ]
  });
  const fns = loadFunctions(reminderFunctions, harness.context);
  assert.equal(await fns._syncAllTaskNotifications(), true);
  assert.deepEqual(harness.calls.cancel, [[123]]);
  assert.equal(harness.calls.checkPermissions, 0);
  assert.equal(harness.calls.schedule.length, 0);
  assert.deepEqual(harness.pending().map((item) => item.id), [2000000000]);
});

test('revoked permission cancels task reminders instead of leaving stale alarms queued', async () => {
  const harness = makeNotificationHarness({
    permission: 'denied',
    tasks: [{ id: 4, status: 'pending', plannedDate: '2099-12-31', plannedTime: '23:59' }],
    pending: [
      { id: 321, extra: { kind: 'task-reminder', taskId: '4' } },
      { id: 2000000000, extra: { kind: 'focus-transition' } }
    ]
  });
  const fns = loadFunctions(reminderFunctions, harness.context);
  assert.equal(await fns._syncAllTaskNotifications(), false);
  assert.deepEqual(harness.calls.cancel, [[321]]);
  assert.equal(harness.calls.schedule.length, 0);
  assert.deepEqual(harness.pending().map((item) => item.id), [2000000000]);
});

test('native focus transition does not prompt for permission when a timer phase ends', async () => {
  const calls = { requests: 0, schedules: 0 };
  const context = {
    console,
    _hasCapacitorLocalNotifications: () => true,
    window: { Capacitor: { Plugins: { LocalNotifications: {
      checkPermissions: async () => ({ display: 'denied' }),
      requestPermissions: async () => { calls.requests++; return { display: 'granted' }; },
      schedule: async () => { calls.schedules++; }
    } } } }
  };
  const send = vm.runInNewContext('(' + extractFunction('_sendCapacitorNotification') + ')', context);
  assert.equal(send('انتهت الجلسة', 'حان وقت الراحة'), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.requests, 0);
  assert.equal(calls.schedules, 0);
});

test('first native toggle requests permission instead of silently switching off the default preference', async () => {
  const harness = makeNotificationHarness({ enabled: true, permission: 'prompt' });
  const fns = loadFunctions(['_setCapacitorNotificationsEnabled', '_toggleCapacitorNotifications'], harness.context);
  const result = await fns._toggleCapacitorNotifications();
  assert.equal(result.enabled, true);
  assert.equal(result.ok, true);
  assert.equal(harness.calls.requestPermissions, 1);
  assert.equal(harness.context.preference, true);
});

test('enabling notifications reports a failed reminder reconciliation instead of false success', async () => {
  const harness = makeNotificationHarness({ enabled: false, permission: 'granted' });
  harness.context._queueAllTaskReminderSync = async () => false;
  const { _setCapacitorNotificationsEnabled } = loadFunctions(
    ['_setCapacitorNotificationsEnabled'],
    harness.context
  );

  const result = await _setCapacitorNotificationsEnabled(true);
  assert.equal(result, false);
  assert.equal(harness.context.preference, true);
});

test('saving tasks and app startup both queue reminder reconciliation', () => {
  const saveData = extractFunction('saveData');
  assert.match(saveData, /_queueAllTaskReminderSync\(\)/);
  const init = appScript.slice(appScript.indexOf('loadData();'));
  assert.match(init, /_queueAllTaskReminderSync\(\)/);
});



test('queued task reminder updates and cancellations run sequentially', async () => {
  const task = { id: 31, name: 'مهمة مجدولة', status: 'pending', plannedDate: '2099-12-31', plannedTime: '23:59' };
  const harness = makeNotificationHarness({ tasks: [task], permission: 'granted' });
  const names = [
    '_taskNotificationId',
    '_taskReminderAt',
    '_cancelTaskNotification',
    '_syncTaskNotification',
    '_syncAllTaskNotifications',
    '_queueTaskReminderSync',
    '_queueTaskReminderCancellation'
  ];
  const fns = loadFunctions(names, harness.context);

  const update = fns._queueTaskReminderSync(task);
  const cancel = fns._queueTaskReminderCancellation(task.id);
  await Promise.all([update, cancel]);

  assert.equal(harness.calls.schedule.length, 1);
  assert.equal(harness.calls.schedule[0].extra.taskId, '31');
  assert.equal(harness.calls.cancel.length, 2);
  assert.deepEqual(harness.pending(), []);
});

test('failed native cancel-all restores the prior enabled preference', async () => {
  const harness = makeNotificationHarness({
    enabled: true,
    failCancelAll: true,
    pending: [
      { id: 777, extra: { kind: 'task-reminder', taskId: '42' } },
      { id: 2000000000, extra: { kind: 'focus-transition' } }
    ]
  });
  const { _setCapacitorNotificationsEnabled } = loadFunctions(
    ['_setCapacitorNotificationsEnabled'],
    harness.context
  );

  assert.equal(await _setCapacitorNotificationsEnabled(false), false);
  assert.equal(harness.context.preference, true);
  assert.deepEqual(harness.pending().map((item) => item.id), [777, 2000000000]);
  assert.equal(harness.calls.cancelAll, 1);
});


test('startup reconciliation leaves an unchanged pending reminder untouched', async () => {
  const task = { id: 41, name: 'مهمة ثابتة', status: 'pending', plannedDate: '2099-12-31', plannedTime: '23:59' };
  const { _taskNotificationId, _taskReminderAt } = loadFunctions(
    ['_taskNotificationId', '_taskReminderAt'],
    { isValidCalendarDate: validDate, isValidLocalTime: validTime }
  );
  const id = _taskNotificationId(task.id);
  const at = _taskReminderAt(task);
  const harness = makeNotificationHarness({
    tasks: [task],
    pending: [{
      id,
      title: 'تذكير بمهمة',
      body: task.name,
      schedule: { at },
      extra: { kind: 'task-reminder', taskId: String(task.id) }
    }]
  });
  const fns = loadFunctions(reminderFunctions, harness.context);

  assert.equal(await fns._syncAllTaskNotifications(), true);
  assert.equal(harness.calls.schedule.length, 0);
  assert.equal(harness.calls.cancel.length, 0);
});

test('startup reconciliation replaces a pending reminder when task title or due time changes', async () => {
  const task = { id: 42, name: 'العنوان الجديد', status: 'pending', plannedDate: '2099-12-31', plannedTime: '23:59' };
  const { _taskNotificationId, _taskReminderAt } = loadFunctions(
    ['_taskNotificationId', '_taskReminderAt'],
    { isValidCalendarDate: validDate, isValidLocalTime: validTime }
  );
  const id = _taskNotificationId(task.id);
  const oldAt = new Date(2099, 11, 31, 22, 59, 0, 0);
  const at = _taskReminderAt(task);
  const harness = makeNotificationHarness({
    tasks: [task],
    pending: [{
      id,
      title: 'تذكير بمهمة',
      body: 'العنوان السابق',
      schedule: { at: oldAt },
      extra: { kind: 'task-reminder', taskId: String(task.id) }
    }]
  });
  const fns = loadFunctions(reminderFunctions, harness.context);

  assert.equal(await fns._syncAllTaskNotifications(), true);
  assert.equal(harness.calls.cancel.length, 1);
  assert.equal(harness.calls.cancel[0][0], id);
  assert.equal(harness.calls.schedule.length, 1);
  assert.equal(harness.calls.schedule[0].body, task.name);
  assert.equal(new Date(harness.calls.schedule[0].schedule.at).getTime(), at.getTime());
});


test('native notification UI shows an enabled preference with failed reminder reconciliation', async () => {
  const harness = makeNotificationHarness({ enabled: true, permission: 'granted' });
  const button = { textContent: '', className: '', disabled: false };
  harness.context.document = { getElementById: () => button };
  harness.context._isCapacitor = () => true;
  harness.context._taskReminderSyncStatus = null;
  const fns = loadFunctions(
    ['_recordTaskReminderSyncResult', '_updateNotifToggleUI'],
    harness.context
  );

  assert.equal(fns._recordTaskReminderSyncResult(false), false);
  await Promise.resolve();
  assert.match(button.textContent, /المزامنة متعثرة/);
  assert.equal(button.className, 'btn-ghost');
});
