'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'configure-android-stopwatch.py');
const namespace = 'com.abac332211.timetasks';

function fixture(namespaceLine) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timetasks-stopwatch-namespace-'));
  const app = path.join(root, 'android', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'build.gradle'), `android {
    ${namespaceLine}
    defaultConfig { applicationId "${namespace}" }
}
`);
  const mainDir = path.join(app, 'src', 'main');
  const javaDir = path.join(mainDir, 'java', ...namespace.split('.'));
  fs.mkdirSync(javaDir, { recursive: true });
  fs.writeFileSync(path.join(javaDir, 'MainActivity.java'),
    `package ${namespace};

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
}
`);
  fs.writeFileSync(path.join(mainDir, 'AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application></application></manifest>\n');
  return { root, app, javaDir, mainDir };
}

function run(root) {
  return spawnSync('python3', [script, '--root', root], { encoding: 'utf8' });
}

for (const [label, namespaceLine] of [
  ['assignment syntax', 'namespace = "com.abac332211.timetasks"'],
  ['legacy Groovy syntax', 'namespace "com.abac332211.timetasks"']
]) {
  test(`Android stopwatch configurator accepts ${label}`, (t) => {
    const f = fixture(namespaceLine);
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

    const result = run(f.root);
    assert.equal(result.status, 0, result.stderr);

    for (const name of [
      'StopwatchClockPlugin.java',
      'StopwatchForegroundService.java',
      'StopwatchNotificationActionReceiver.java'
    ]) {
      assert.ok(fs.existsSync(path.join(f.javaDir, name)), name);
    }

    const activity = fs.readFileSync(path.join(f.javaDir, 'MainActivity.java'), 'utf8');
    assert.match(activity, /registerPlugin\(StopwatchClockPlugin\.class\);/);
    assert.match(activity, /onNewIntent\(Intent intent\)/);

    const manifest = fs.readFileSync(path.join(f.mainDir, 'AndroidManifest.xml'), 'utf8');
    assert.match(manifest, /FOREGROUND_SERVICE_SPECIAL_USE/);
    assert.match(manifest, /foregroundServiceType="specialUse"/);
    assert.match(manifest, /PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);

    const once = manifest;
    assert.equal(run(f.root).status, 0);
    const twice = fs.readFileSync(path.join(f.mainDir, 'AndroidManifest.xml'), 'utf8');
    assert.equal(twice, once, 'configuration remains idempotent');
    assert.equal((twice.match(/StopwatchForegroundService/g) || []).length, 1);
  });
}

test('Android stopwatch configurator rejects multiple namespace declarations without writing', (t) => {
  const f = fixture('namespace = "com.abac332211.timetasks"');
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const gradlePath = path.join(f.app, 'build.gradle');
  const before = fs.readFileSync(gradlePath, 'utf8');
  fs.writeFileSync(gradlePath, before.replace('defaultConfig {', 'namespace = "com.example.other"\n    defaultConfig {'));

  const result = run(f.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected exactly one Android namespace/);
  assert.equal(fs.readFileSync(gradlePath, 'utf8'), before.replace('defaultConfig {', 'namespace = "com.example.other"\n    defaultConfig {'));
  assert.equal(fs.existsSync(path.join(f.javaDir, 'StopwatchClockPlugin.java')), false);
});
