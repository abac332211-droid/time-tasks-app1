'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'configure-android-version.py');

function fixture({ packageVersion = '2.9.1', appVersion = packageVersion, cacheVersion = packageVersion } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timetasks-android-version-'));
  fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: packageVersion }));
  fs.writeFileSync(path.join(root, 'index.html'), `const APP_VERSION = "${appVersion}";`);
  fs.writeFileSync(path.join(root, 'sw.js'), `const CACHE_NAME = 'timetasks-cache-v${cacheVersion}';`);
  const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
  fs.writeFileSync(gradlePath, `android {
    defaultConfig {
        versionCode 1
        versionName "1.0"
    }
}
`);
  return { root, gradlePath };
}

function run(root) {
  return spawnSync('python3', [script, '--root', root], { encoding: 'utf8' });
}

test('Android version config follows matching app, package, and service-worker versions', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = run(f.root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /versionName=2\.9\.1 versionCode=2009001/);

  const gradle = fs.readFileSync(f.gradlePath, 'utf8');
  assert.match(gradle, /versionCode 2009001/);
  assert.match(gradle, /versionName "2\.9\.1"/);
});

test('Android version config rejects mismatched source versions without changing Gradle', (t) => {
  const f = fixture({ packageVersion: '2.9.1', appVersion: '2.9.0', cacheVersion: '2.9.1' });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const before = fs.readFileSync(f.gradlePath, 'utf8');

  const result = run(f.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /do not match/);
  assert.equal(fs.readFileSync(f.gradlePath, 'utf8'), before);
});

test('Android versionCode increases for patch, minor, and major releases', () => {
  const code = (v) => {
    const [major, minor, patch] = v.split('.').map(Number);
    return major * 1_000_000 + minor * 1_000 + patch;
  };
  assert.ok(code('2.9.1') > code('2.9.0'));
  assert.ok(code('2.10.0') > code('2.9.999'));
  assert.ok(code('3.0.0') > code('2.999.999'));
});
