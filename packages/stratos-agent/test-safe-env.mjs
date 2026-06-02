/**
 * safe-env tests (Gap 3, #35). A spawned broker child / MCP sidecar must NOT inherit the agent's secrets.
 * safeChildEnv() returns only OS essentials + non-secret Stratos path vars + the caller's explicit extras.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeChildEnv } from './src/connectors/safe-env.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

const fakeEnv = {
  PATH: '/usr/bin:/bin', HOME: '/home/neo', LANG: 'en_US.UTF-8', NODE_PATH: '/x',
  STRATOS_VAULT_DIR: '/vault', STRATOS_PROFILE_DIR: '/profile',
  // secrets the daemon decrypted into ITS env — must NEVER reach a child:
  OPENAI_API_KEY: 'sk-openai-SECRET', ANTHROPIC_API_KEY: 'sk-ant-SECRET', OPENROUTER_API_KEY: 'or-SECRET',
  SIGNAL_OWNER_ID: '+1555', DISCORD_BOT_TOKEN: 'MTk4-SECRET', STRATOS_VAULT_KEY: 'master-SECRET',
  SOLANA_KEYPAIR: '[1,2,3]', AWS_SECRET_ACCESS_KEY: 'aws-SECRET', SOME_RANDOM_TOKEN: 'tok-SECRET',
};

console.log('=== OS essentials + non-secret Stratos paths pass through ===');
const e = safeChildEnv({}, fakeEnv);
ok(e.PATH === '/usr/bin:/bin' && e.HOME === '/home/neo' && e.LANG === 'en_US.UTF-8', 'PATH/HOME/LANG are kept (a child needs these to run)');
ok(!('NODE_PATH' in e), 'NODE_PATH is STRIPPED (a module-resolution / code-loading vector — pass it per-connector if truly needed)');
ok(e.STRATOS_VAULT_DIR === '/vault' && e.STRATOS_PROFILE_DIR === '/profile', 'non-secret Stratos path vars are kept (vault/profile locations)');

console.log('\n=== every secret-shaped parent var is STRIPPED ===');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'SIGNAL_OWNER_ID', 'DISCORD_BOT_TOKEN', 'STRATOS_VAULT_KEY', 'SOLANA_KEYPAIR', 'AWS_SECRET_ACCESS_KEY', 'SOME_RANDOM_TOKEN']) {
  ok(!(k in e), `${k} is NOT inherited by the child`);
}
ok(!JSON.stringify(e).includes('SECRET'), 'no secret material at all in the child env');
ok(!('NODE_OPTIONS' in safeChildEnv({}, { ...fakeEnv, NODE_OPTIONS: '--require /tmp/evil.js' })), 'NODE_OPTIONS is STRIPPED (a --require/--import code-exec + secret-repopulation vector)');

console.log('\n=== explicit extras are applied (connector env + one scoped auth/registry var) ===');
const e2 = safeChildEnv({ STRATOS_BROKER_REGISTRY: '/reg.json', MCP_AUTH_TOKEN: 'scoped-bearer' }, fakeEnv);
ok(e2.STRATOS_BROKER_REGISTRY === '/reg.json' && e2.MCP_AUTH_TOKEN === 'scoped-bearer', 'the caller\'s explicit, scoped additions are present');
ok(!('OPENAI_API_KEY' in e2), '…but still no inherited secrets');

console.log('\n=== networking/TLS + cross-platform home vars pass through (real broker/sidecar needs them) ===');
const e3 = safeChildEnv({}, { ...fakeEnv, HTTPS_PROXY: 'http://proxy:8080', NODE_EXTRA_CA_CERTS: '/ca.pem', USERPROFILE: 'C:\\\\Users\\\\neo' });
ok(e3.HTTPS_PROXY === 'http://proxy:8080' && e3.NODE_EXTRA_CA_CERTS === '/ca.pem', 'proxy + custom CA bundle are kept (non-secret runtime config)');
ok(e3.USERPROFILE === 'C:\\\\Users\\\\neo', 'Windows USERPROFILE is kept (so os.homedir() / the default vault path still resolves)');

console.log('\n=== REAL spawn boundary: a child spawned via createStdioTransport CANNOT see the secret ===');
{
  const { createStdioTransport } = await import('./src/connectors/mcp-stdio-transport.js');
  const out = path.join(os.tmpdir(), `safeenv-probe-${process.pid}.json`);
  try { fs.unlinkSync(out); } catch {}
  // POISON the parent env with a secret, then spawn a child sidecar that dumps its OWN env to a file.
  process.env.OPENAI_API_KEY = 'sk-PARENT-SECRET-must-not-leak';
  const t = createStdioTransport({
    command: process.execPath,
    args: ['-e', 'require("fs").writeFileSync(process.env.ENV_PROBE_OUT, JSON.stringify(process.env)); setInterval(()=>{}, 1e9)'],
    env: { ENV_PROBE_OUT: out },                          // a connector-declared (non-secret) var
    auth: { value: 'scoped-bearer-xyz', envVar: 'MCP_AUTH_TOKEN' },
  });
  // poll for the child's env dump (it writes synchronously on startup)
  let childEnv = null;
  for (let i = 0; i < 50 && !childEnv; i++) {
    try { childEnv = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 40)); }
  }
  t.close();
  try { fs.unlinkSync(out); } catch {}
  delete process.env.OPENAI_API_KEY;
  ok(childEnv && !('OPENAI_API_KEY' in childEnv), 'the spawned sidecar does NOT inherit the parent\'s OPENAI_API_KEY');
  ok(childEnv && !JSON.stringify(childEnv).includes('PARENT-SECRET'), 'no parent-secret material anywhere in the child env');
  ok(childEnv && childEnv.ENV_PROBE_OUT === out, 'the connector-declared env var DID reach the child');
  ok(childEnv && childEnv.MCP_AUTH_TOKEN === 'scoped-bearer-xyz', 'the injected scoped auth DID reach the child');
  ok(childEnv && !!childEnv.PATH, 'PATH (an OS essential) reached the child so it can run');
}

console.log(`\n✅ ALL ${pass} safe-env checks passed.`);
