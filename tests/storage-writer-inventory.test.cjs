'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  .map(match => match[1]).filter(source => source.trim());
const appScript = scripts.find(source => source.includes('APP_VERSION'));
assert.ok(appScript, 'application script exists');

function extractFunction(name) {
  const pattern = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const match = appScript.match(pattern);
  assert.ok(match, 'function ' + name + ' exists');
  return match[0];
}

function productionScript() {
  const testStart = appScript.indexOf('function runMigrationTests()');
  assert.ok(testStart > 0, 'isolated migration-test harness exists');
  return appScript.slice(0, testStart);
}

function collectDirectStorageWriters(source) {
  const lines = source.split('\n');
  const declarations = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(?:async\s+)?function\s+([\$\w]+)\s*\(/);
    if (match) declarations.push({ name: match[1], line: index + 1 });
  });

  const counts = Object.create(null);
  const sites = [];
  lines.forEach((line, index) => {
    const matcher = /(?:window\s*\.\s*)?localStorage\s*\.\s*(setItem|removeItem|clear)\s*\(/g;
    let match;
    while ((match = matcher.exec(line))) {
      const lineNumber = index + 1;
      const owner = declarations.filter(item => item.line <= lineNumber).slice(-1)[0];
      const name = owner ? owner.name : '(top-level)';
      counts[name] = (counts[name] || 0) + 1;
      sites.push({ line: lineNumber, operation: match[1], owner: name });
    }
  });
  return { counts, sites };
}

test('every production localStorage mutation is inventoried under a reviewed owner', () => {
  const source = productionScript();
  const { counts, sites } = collectDirectStorageWriters(source);
  const expected = {
    _writeSecondaryStorageVerified: 1,
    _writeTaskFocusLinkJournal: 1,
    writeAndVerify: 3,
    clearMigrationMarker: 2,
    rollbackRejectedPublication: 2,
    readSnapshot: 1,
    _restoreStorageValueIfUnchanged: 2,
    _recoverInterruptedRollingRestore: 1,
    _restoreLatestRollingRecoveryBackup: 1,
    _setPersistedRollingBackupGeneration: 1,
    _recoverInterruptedReset: 5,
    saveData: 1,
    _executeResetAllTransaction: 1,
    persistDailyLog: 1,
    removePendingItem: 2,
    _recoverInterruptedImport: 2,
    _restoreImportControlStateAfterRollback: 14,
    undoLastImport: 4,
    _writeMainStorageRecordVerified: 1,
    _writeTestMetadataVerified: 2,
    _rollbackTestDataTransaction: 1
  };

  assert.equal(sites.length, 49, 'unexpected production localStorage writer count; audit new or removed sites');
  assert.deepEqual({ ...counts }, expected,
    'direct storage mutations must remain assigned to reviewed writer owners');
  assert.doesNotMatch(source,
    /(?:window\s*\.\s*)?localStorage\s*\[\s*["'](?:setItem|removeItem|clear)["']\s*\]/,
    'computed Storage mutation calls require explicit audit');
  assert.doesNotMatch(source,
    /(?:window\s*\.\s*)?localStorage\s*\.\s*clear\s*\(/,
    'clearing all application storage is not an approved write path');
});

test('each direct writer family has an in-function lock or a verified locked parent', () => {
  const checks = [
    ['_writeSecondaryStorageVerified', /_isTaskStorageLockHeld\s*\(/],
    ['migrateV1ToV2', /_stopwatchTransactionLockDepth\s*>\s*0/],
    ['_storeRollingRecoveryBackupLocked', /_stopwatchTransactionLockDepth\s*>\s*0/],
    ['_restoreStorageValueIfUnchanged', /_isTaskStorageLockHeld\s*\(/],
    ['_recoverInterruptedRollingRestore', /_stopwatchTransactionLockDepth\s*>\s*0/],
    ['_restoreLatestRollingRecoveryBackup', /_stopwatchTransactionLockDepth\s*>\s*0/],
    ['_setPersistedRollingBackupGeneration', /_isTaskStorageLockHeld\s*\(/],
    ['_recoverInterruptedReset', /_stopwatchTransactionLockDepth\s*>\s*0/],
    ['saveData', /_isTaskStorageLockHeld\s*\(/],
    ['_executeResetAllTransaction', /_withResetTransactionLock\s*\(/],
    ['persistDailyLog', /_isTaskStorageLockHeld\s*\(/],
    ['_preserveCorruptStorageSnapshot', /_stopwatchTransactionLockDepth\s*>\s*0/],
    ['_restoreStorageSnapshot', /_stopwatchTransactionLockDepth\s*>\s*0/],
    ['_recoverInterruptedImport', /_stopwatchTransactionLockDepth\s*>\s*0/],
    ['undoLastImport', /_withStopwatchTransactionLock\s*\(/],
    ['_writeMainStorageRecordVerified', /_isTaskStorageLockHeld\s*\(/],
    ['_writeTestMetadataVerified', /_isTaskStorageLockHeld\s*\(/],
    ['_rollbackTestDataTransaction', /_isTaskStorageLockHeld\s*\(/]
  ];
  for (const [name, pattern] of checks) {
    assert.match(extractFunction(name), pattern, name + ' must enforce or delegate lock ownership');
  }

  assert.match(extractFunction('_withResetTransactionLock'),
    /_withStopwatchTransactionLock\s*\(callback\)/,
    'reset transactions must use the same shared cross-window lock');

  const importFunction = extractFunction('showImportPreview');
  const lockStart = importFunction.indexOf('_withStopwatchTransactionLock(function()');
  const importRollback = importFunction.indexOf('function _restoreImportControlStateAfterRollback()');
  assert.ok(lockStart >= 0 && importRollback > lockStart,
    'all import rollback writers must remain nested inside the shared-lock callback');

  const recoveryBackup = extractFunction('_storeRollingRecoveryBackupLocked');
  assert.ok(recoveryBackup.indexOf('function rollbackRejectedPublication()') >= 0
    && recoveryBackup.indexOf('function readSnapshot()') >= 0,
    'backup publication/rollback writers must remain inside the guarded backup transaction');

  const restore = extractFunction('_restoreStorageSnapshot');
  assert.ok(restore.indexOf('function writeAndVerify(') >= 0,
    'snapshot restoration helper must remain inside the lock-guarded restore operation');

  const forensic = extractFunction('_preserveCorruptStorageSnapshot');
  assert.ok(forensic.indexOf('function removePendingItem()') >= 0,
    'forensic-snapshot cleanup must remain inside its lock-guarded preservation operation');
});

test('normal data load derives lastTaskId in memory without bypassing the storage write gate', () => {
  const load = extractFunction('loadData');
  assert.match(load, /appSettings\.lastTaskId\s*=\s*_maxExistingId/);
  assert.doesNotMatch(load, /localStorage\s*\.\s*(?:setItem|removeItem|clear)\s*\(/,
    'loadData must not perform an opportunistic main-record write during recovery');
  assert.match(extractFunction('saveData'), /localStorage\.setItem\(STORAGE_KEY, serializedV2\)/,
    'the normal persistence path remains responsible for saving settings under its write gate');
});

test('migration self-tests mutate only a temporary Storage object and restore the original descriptor', () => {
  const harness = extractFunction('runMigrationTests');
  assert.match(harness, /const testStorageMap = new Map\(\)/);
  assert.match(harness, /Object\.defineProperty\(window, "localStorage"/);
  assert.match(harness, /Object\.defineProperty\(window, "localStorage", originalStorageDescriptor\)/);
});
