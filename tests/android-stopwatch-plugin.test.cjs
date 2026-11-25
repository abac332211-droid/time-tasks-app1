'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.join(__dirname, '..', 'scripts', 'configure-android-stopwatch.py');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-native-clock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'android', 'app');
  const src = path.join(app, 'src', 'main');
  const java = path.join(src, 'java', 'com', 'abac332211', 'timetasks');
  fs.mkdirSync(java, { recursive: true });
  fs.writeFileSync(path.join(app, 'build.gradle'), 'android {\n namespace "com.abac332211.timetasks"\n}\n');
  fs.writeFileSync(path.join(src, 'AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n'
    + '<application><activity android:name=".MainActivity" /></application>\n</manifest>\n');
  fs.writeFileSync(path.join(java, 'MainActivity.java'),
    'package com.abac332211.timetasks;\nimport com.getcapacitor.BridgeActivity;\n'
    + 'public class MainActivity extends BridgeActivity {\n}\n');
  return { root, java, src };
}
function run(root) { return spawnSync('python3', [script, '--root', root], { encoding: 'utf8' }); }

test('installs native elapsedRealtime clock plugin and specialUse foreground service', (t) => {
  const f = fixture(t), result = run(f.root);
  assert.equal(result.status, 0, result.stderr);
  const activity = fs.readFileSync(path.join(f.java, 'MainActivity.java'), 'utf8');
  assert.match(activity, /registerPlugin\(StopwatchClockPlugin\.class\)/);
  assert.match(activity, /super\.onCreate\(savedInstanceState\)/);
  const plugin = fs.readFileSync(path.join(f.java, 'StopwatchClockPlugin.java'), 'utf8');
  assert.match(plugin, /SystemClock\.elapsedRealtime\(\)/);
  assert.match(plugin, /Settings\.Global\.BOOT_COUNT/);
  const service = fs.readFileSync(path.join(f.java, 'StopwatchForegroundService.java'), 'utf8');
  assert.match(service, /FOREGROUND_SERVICE_TYPE_SPECIAL_USE/);
  assert.match(service, /إيقاف مؤقت/);
  assert.match(service, /إنهاء الجلسة/);
  const manifest = fs.readFileSync(path.join(f.src, 'AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE/);
  assert.match(manifest, /android:foregroundServiceType="specialUse"/);
  assert.match(manifest, /PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);
  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
});

test('configuration is idempotent', (t) => {
  const f = fixture(t);
  assert.equal(run(f.root).status, 0);
  const activityPath = path.join(f.java, 'MainActivity.java');
  const manifestPath = path.join(f.src, 'AndroidManifest.xml');
  const beforeActivity = fs.readFileSync(activityPath, 'utf8');
  const beforeManifest = fs.readFileSync(manifestPath, 'utf8');
  const second = run(f.root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(activityPath, 'utf8'), beforeActivity);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), beforeManifest);
});

test('rejects ambiguous Android namespace', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'android', 'app', 'build.gradle'), 'android { }\n');
  const result = run(f.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected exactly one Android namespace/);
  assert.equal(fs.existsSync(path.join(f.java, 'StopwatchClockPlugin.java')), false);
});
