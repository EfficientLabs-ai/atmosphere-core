/**
 * safe-env tests (Gap 3, #35). A spawned broker child / MCP sidecar must NOT inherit the agent's secrets.
 * safeChildEnv() returns only OS essentials + non-secret Stratos path vars + the caller's explicit extras.
 */
import assert from 'node:assert';
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
ok(e.PATH === '/usr/bin:/bin' && e.HOME === '/home/neo' && e.LANG === 'en_US.UTF-8' && e.NODE_PATH === '/x', 'PATH/HOME/LANG/NODE_PATH are kept (a child needs these to run)');
ok(e.STRATOS_VAULT_DIR === '/vault' && e.STRATOS_PROFILE_DIR === '/profile', 'non-secret Stratos path vars are kept (vault/profile locations)');

console.log('\n=== every secret-shaped parent var is STRIPPED ===');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'SIGNAL_OWNER_ID', 'DISCORD_BOT_TOKEN', 'STRATOS_VAULT_KEY', 'SOLANA_KEYPAIR', 'AWS_SECRET_ACCESS_KEY', 'SOME_RANDOM_TOKEN']) {
  ok(!(k in e), `${k} is NOT inherited by the child`);
}
ok(!JSON.stringify(e).includes('SECRET'), 'no secret material at all in the child env');

console.log('\n=== explicit extras are applied (connector env + one scoped auth/registry var) ===');
const e2 = safeChildEnv({ STRATOS_BROKER_REGISTRY: '/reg.json', MCP_AUTH_TOKEN: 'scoped-bearer' }, fakeEnv);
ok(e2.STRATOS_BROKER_REGISTRY === '/reg.json' && e2.MCP_AUTH_TOKEN === 'scoped-bearer', 'the caller\'s explicit, scoped additions are present');
ok(!('OPENAI_API_KEY' in e2), '…but still no inherited secrets');

console.log(`\n✅ ALL ${pass} safe-env checks passed.`);
