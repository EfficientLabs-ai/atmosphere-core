// test-trifecta-live.mjs — capability gate + attribution ledger + identity broker, wired together
// through the SkillExecutor: verified run → recorded; credentialed step → brokered token (never raw).
import assert from 'node:assert';
import { GsiCompiler } from './gsi-compiler.js';
import { SkillExecutor } from './src/evolution/skill-executor.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { AttributionLedger } from './src/ledger/attribution-ledger.js';
import { IdentityBroker } from './src/identity/identity-broker.js';

let pass = 0;
const ok = (name, c) => { assert.ok(c, name); console.log(`  ✓ ${name}`); pass++; };
const now = () => 1_000_000;
const NODE = 'did:atmos:node1';
const kp = generateHybridKeyPair();
const compiler = new GsiCompiler({ verbose: false });

console.log('trifecta live — gate + ledger + broker through the executor\n');

// --- 1. computational run is verified, enforced, AND recorded to the ledger ---
const ledger = new AttributionLedger({ now });
const wasm = await compiler.compile({ id: 'double.v1', kind: 'computational', computation: { type: 'affine', a: 2, b: 0 } }, kp.privateKey);
const exec = new SkillExecutor({ publicKeyBundle: kp.publicKey, enforceCapabilities: true, verbose: false, ledger, contributorId: NODE });
const r1 = await exec.run(wasm, 5);
ok('verified computational skill ran (2*5 = 10)', r1.verified === true && r1.result === 10);
ok('the run was recorded to the attribution ledger', ledger.length === 1 && ledger.entries()[0].kind === 'skill-executed');
ok('the entry is attributed to this node + names the skill', ledger.entries()[0].contributor === NODE && ledger.entries()[0].subject === 'double.v1');
ok('the ledger verifies (tamper-evident)', ledger.verify().ok === true);

// --- 2. a credentialed automation step gets a BROKERED token, never a raw credential ---
const broker = new IdentityBroker({ secret: 'broker-secret', now });
broker.grant({ subject: NODE, audience: 'api.github.com', scopes: ['issues.read'] });
let dispatched = null;
const actionExecutor = async (step) => { dispatched = step; return 'ok'; };
const autoWasm = await compiler.compile(
  { id: 'gh.v1', kind: 'automation', steps: [{ action: 'fetch', host: 'api.github.com', scope: 'issues.read' }] },
  kp.privateKey,
);
const exec2 = new SkillExecutor({ publicKeyBundle: kp.publicKey, enforceCapabilities: true, verbose: false, ledger, broker, contributorId: NODE, actionExecutor });
await exec2.run(autoWasm);
ok('the step received a brokered token, not a raw credential', !!dispatched.brokeredToken && !('credential' in dispatched) && !('apiKey' in dispatched));
ok('the brokered token verifies for that audience + scope', broker.verify(dispatched.brokeredToken, { audience: 'api.github.com', scope: 'issues.read' }).ok === true);
ok('the automation run was also recorded', ledger.length === 2 && ledger.entries()[1].subject === 'gh.v1');

// --- 3. deny-by-default: no grant ⇒ the broker refuses ⇒ the run is refused (nothing dispatched) ---
const broker2 = new IdentityBroker({ secret: 'broker-secret', now }); // no grant registered
let dispatched2 = false;
const exec3 = new SkillExecutor({ publicKeyBundle: kp.publicKey, enforceCapabilities: true, verbose: false, ledger, broker: broker2, contributorId: NODE, actionExecutor: async () => { dispatched2 = true; return 'ok'; } });
await assert.rejects(() => exec3.run(autoWasm), /IDENTITY BROKER/);
ok('un-granted credentialed step refused — nothing dispatched, no extra ledger entry', dispatched2 === false && ledger.length === 2);

// --- 4. the attribution view ---
const sum = ledger.summarize();
ok('summarize attributes both runs to the node (measurement, no payout)', sum[0].contributor === NODE && sum[0].total === 2 && !('value' in sum[0]));

console.log(`\n✅ ${pass}/${pass} — trifecta LIVE: enforced + recorded + brokered, deny-by-default throughout.`);
