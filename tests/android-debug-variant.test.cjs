'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'configure-android-debug.py');

function fixture(gradle = `android {
    defaultConfig {
        applicationId "com.abac332211.timetasks"
        versionName "2.9.0"
    }
    buildTypes {
        release {
            minifyEnabled false
        }
    }
}
`) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timetasks-android-debug-'));
  const appDir = path.join(root, 'android', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const gradlePath = path.join(appDir, 'build.gradle');
  fs.writeFileSync(gradlePath, gradle);
  return { root, gradlePath };
}

function run(root) {
  return spawnSync('python3', [script, '--root', root], { encoding: 'utf8' });
}

test('Debug APK gets a distinct package ID while Release keeps the production ID', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = run(f.root);
  assert.equal(result.status, 0, result.stderr);

  const gradle = fs.readFileSync(f.gradlePath, 'utf8');
  assert.match(gradle, /debug\s*\{[\s\S]*applicationIdSuffix "\.debug"/);
  assert.match(gradle, /versionNameSuffix "-debug"/);
  assert.match(gradle, /release\s*\{\s*minifyEnabled false\s*\}/);
  assert.match(gradle, /applicationId "com\.abac332211\.timetasks"/);
});

test('Debug package suffix configuration is idempotent', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  assert.equal(run(f.root).status, 0);
  const once = fs.readFileSync(f.gradlePath, 'utf8');
  const result = run(f.root);
  const twice = fs.readFileSync(f.gradlePath, 'utf8');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already configured/);
  assert.equal(twice, once);
  assert.equal((twice.match(/applicationIdSuffix "\.debug"/g) || []).length, 1);
});

test('Debug package suffix script refuses ambiguous Gradle buildTypes without modifying file', (t) => {
  const f = fixture('android { defaultConfig { versionName "2.9.0" } }\n');
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const before = fs.readFileSync(f.gradlePath, 'utf8');

  const result = run(f.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected exactly one buildTypes/);
  assert.equal(fs.readFileSync(f.gradlePath, 'utf8'), before);
});
