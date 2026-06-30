/**
 * Telegram bridge dry-run smoke test for ATM-SEC-001.
 *
 * Verifies the adapter can initialize without a real token, without starting a Telegram polling client,
 * and without touching local vault files. The live bot path remains an operator-verified integration path.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (condition, message) => { assert.ok(condition, message); console.log('  ok ' + message); pass++; };

const originalCwd = process.cwd();
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalExistsSync = fs.existsSync;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-bridge-dry-run-'));
const vaultProbes = [];

fs.existsSync = (targetPath) => {
  if (String(targetPath).includes('.secrets-vault')) vaultProbes.push(String(targetPath));
  return originalExistsSync.call(fs, targetPath);
};

try {
  delete process.env.TELEGRAM_BOT_TOKEN;
  process.chdir(tempDir);

  console.log('=== telegram bridge dry-run startup ===');
  const { TelegramBridge } = await import('./src/telegram-bridge.js');
  const bridge = new TelegramBridge({ dryRun: true, token: '123456:unused-test-token', verbose: false });

  ok(bridge.dryRun === true, 'dryRun mode is recorded on the bridge');
  ok(bridge.token === null, 'dryRun mode ignores provided and ambient Telegram tokens');
  ok(bridge.bot === null, 'no Telegram bot client exists before start()');
  ok(vaultProbes.length === 0, 'dryRun construction does not probe .secrets-vault');

  const started = bridge.start();
  ok(started === false, 'start() returns false without a token');
  ok(bridge.bot === null, 'start() does not create a polling client in dry-run mode');
  ok(vaultProbes.length === 0, 'start() does not probe .secrets-vault');
} finally {
  process.chdir(originalCwd);
  fs.existsSync = originalExistsSync;
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\nALL ${pass} telegram-bridge dry-run checks passed.`);
