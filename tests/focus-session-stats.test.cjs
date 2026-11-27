'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const inlineScripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map(match => match[1])
  .filter(source => source.trim());
const appScript = inlineScripts.find(source => source.includes('APP_VERSION'));
assert.ok(appScript, 'application script exists');

function extractFunction(name) {
  const pattern = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

const mixedSessions = [
  { mode: 'pomodoro', phase: 'work', durationSec: 1_500 },
  { mode: 'pomodoro', phase: 'short-break', durationSec: 300 },
  { mode: 'pomodoro', phase: 'long-break', durationSec: 900 },
  { mode: 'stopwatch', phase: 'work', durationSec: 1_800 },
  { recordVersion: 2, mode: 'pomodoro', phase: 'work', durationSec: 999, clockTrust: 'untrusted' },
  { recordVersion: 2, mode: 'pomodoro', phase: 'work', durationSec: 720, clockTrust: 'partial' },
  { mode: 'pomodoro', phase: 'short-break', durationSec: 0 }
];

function loadStats(sourceOverrides = {}) {
  const sandbox = {
    _sessionsForDay: () => mixedSessions,
    todayStr: () => '2026-11-26',
    getLast7OperationalDays: () => ['2026-11-26', '2026-11-25'],
    _loadSessions: () => mixedSessions.map(session => ({
      startedAt: session.phase === 'work' ? '2026-11-26' : '2026-11-25',
      ...session
    })),
    _operationalDateFromIso: value => value,
    ...sourceOverrides
  };
  const source = [
    extractFunction('_focusSessionStatsForList'),
    extractFunction('_todaySessionsStats'),
    extractFunction('_weeklySessionsStats')
  ].join('\n');
  vm.runInNewContext(source, sandbox);
  return sandbox;
}

test('focus session summary excludes short and long breaks from productive work totals', () => {
  const sandbox = loadStats();
  const stats = sandbox._focusSessionStatsForList(mixedSessions);
  assert.deepEqual(
    JSON.parse(JSON.stringify(stats)),
    {
      count: 3,
      totalSec: 4_020,
      breakCount: 2,
      breakSec: 1_200
    }
  );
});

test('untrusted V2 time is excluded while partially trusted active time remains measurable', () => {
  const sandbox = loadStats();
  const stats = sandbox._focusSessionStatsForList(mixedSessions);
  assert.equal(stats.totalSec, 1_500 + 1_800 + 720);
  assert.equal(stats.count, 3);
});

test('today and weekly statistics use the same work/break separation', () => {
  const sandbox = loadStats();
  const today = sandbox._todaySessionsStats();
  const week = sandbox._weeklySessionsStats();
  assert.deepEqual(JSON.parse(JSON.stringify(today)), {
    count: 3, totalSec: 4_020, breakCount: 2, breakSec: 1_200
  });
  assert.deepEqual(JSON.parse(JSON.stringify(week)), {
    count: 3, totalSec: 4_020, breakCount: 2, breakSec: 1_200
  });
});

test('break-only history never appears as productive focus time', () => {
  const sandbox = loadStats();
  const stats = sandbox._focusSessionStatsForList([
    { mode: 'pomodoro', phase: 'short-break', durationSec: 300 },
    { mode: 'pomodoro', phase: 'long-break', durationSec: 900 }
  ]);
  assert.equal(stats.count, 0);
  assert.equal(stats.totalSec, 0);
  assert.equal(stats.breakCount, 2);
  assert.equal(stats.breakSec, 1_200);
});
