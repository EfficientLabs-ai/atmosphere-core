// test-stratos-demo.mjs — the `stratos demo` CLI: the "$0 bill" vertical-slice proof command.
// Hermetic: injects a mock gateway fetch + a deterministic keypair via run() deps, so it needs NO live
// daemon, NO Ollama, NO on-disk keys. Proves the terminal proof sequence, --json bundle, --prompt
// override, honest degrade (no fabricated response), the capability gate (deny-by-default), and help.
import assert from 'node:assert';
import { run } from './src/cli/stratos-cli.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { parseCapabilities } from './src/security/capability-gate.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const text = (r) => r.lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

console.log('stratos demo — the "$0 bill" wedge proof\n');

const ANSWER = 'Local inference keeps your data on your own machine.';
const USAGE = { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 };
const okFetch = async (url, opts) => {
  assert.ok(url.includes('/v1/chat/completions'), 'hits the local OpenAI-compatible gateway');
  return { ok: true, status: 200, json: async () => ({ model: 'gemma2:2b', choices: [{ message: { role: 'assistant', content: ANSWER } }], usage: USAGE }) };
};
const KP = generateHybridKeyPair();               // deterministic-per-run injected node identity
const deps = { version: '0.0.0-test', demoFetch: okFetch, demoKeyPair: KP };

// --- terminal proof sequence (the recordable output) ---
let r = await run(['demo'], deps);
ok(r.code === 0, 'demo exits 0 on a healthy slice');
const t = text(r);
ok(/OpenAI-compatible request/.test(t) && /127\.0\.0\.1:.*\/v1\/chat\/completions/.test(t), 'step 1 shows the OpenAI-compatible local call');
ok(t.includes(ANSWER.slice(0, 30)), 'step 1 prints the REAL local response (not fabricated)');
ok(/Sovereign routing decision/.test(t) && /LOCAL/.test(t), 'step 2 shows the sovereign LOCAL decision');
ok(/cloud\s+NOT used/.test(t), 'step 2 makes it obvious cloud was NOT used');
ok(/Signed capability receipt/.test(t) && /verifiable proof/.test(t), 'step 3 emits + verifies the signed receipt (public key only)');
ok(/in\/out HASHED/.test(t) && /measured units/.test(t), 'step 3 is honest: hashes not content, measured units not price');
ok(/\$0/.test(t) && /local marginal cost/.test(t), 'step 4 shows the $0 local marginal cost');
ok(/illustrative estimate, NOT billed/.test(t) && /gpt-4o/.test(t), 'step 4 cloud column is explicitly illustrative (gpt-4o list price)');
ok(/PROVEN: local · sovereign · signed-and-verifiable · \$0/.test(t), 'closes with the one-line proof verdict');

// --- --json: machine-readable proof bundle ---
r = await run(['demo', '--json'], deps);
ok(r.code === 0, '--json exits 0 on success');
const j = JSON.parse(r.lines.join('\n'));
ok(j.ok === true && j.response.content === ANSWER, '--json carries the real response');
ok(j.decision.cloud === false && /local/.test(j.decision.tier), '--json decision is local, cloud false');
ok(j.receipt.verification.ok === true && j.receipt.cost_units === 36, '--json receipt verifies + carries measured cost');
ok(j.bill.localMarginalUsd === 0 && /illustrative/i.test(j.bill.illustrativeCloud.label), '--json bill: $0 local, illustrative cloud');
ok(!r.lines.join('\n').includes('privateKey'), '--json leaks NO private key');

// --- --prompt override flows through to the request + receipt ---
r = await run(['demo', '--json', '--prompt', 'custom sovereign prompt'], deps);
ok(JSON.parse(r.lines.join('\n')).prompt === 'custom sovereign prompt', '--prompt overrides the default thesis prompt');

// --- HONEST DEGRADE: daemon down → clear message + non-zero exit, NO fabricated response ---
const downFetch = async () => { throw new Error('ECONNREFUSED'); };
r = await run(['demo'], { ...deps, demoFetch: downFetch });
ok(r.code === 1, 'degrade exits non-zero');
const dt = text(r);
ok(/isn't answering/.test(dt) && /stratos start/.test(dt), 'degrade tells the operator to start the daemon');
ok(!dt.includes(ANSWER) && /nothing was run or faked/.test(dt), 'degrade fabricates NO response (honest)');
ok(/LOCAL/.test(dt), 'degrade still shows the (pure) local sovereign decision');
// degrade as JSON is still well-formed
r = await run(['demo', '--json'], { ...deps, demoFetch: downFetch });
ok(r.code === 1 && JSON.parse(r.lines.join('\n')).degraded === true, '--json degrade is well-formed JSON with degraded:true');

// --- capability gate: deny-by-default ---
const deniedCaps = parseCapabilities({ capabilities: { actions: [] } });
r = await run(['demo'], { ...deps, demoCaps: deniedCaps });
ok(r.code === 1 && /DENIED/.test(text(r)), 'demo is capability-gated: denied caps refuse (deny-by-default)');

// --- help is ungated + describes the proof ---
r = await run(['demo', 'help'], deps);
ok(r.code === 0 && /\$0 bill/.test(text(r)) && /illustrative/.test(text(r)), 'demo help describes the proof + the honest illustrative caveat');

// --- demo is a registered command (help lists it; COMMANDS includes it) ---
const { COMMANDS } = await import('./src/cli/stratos-cli.js');
ok(COMMANDS.includes('demo'), 'demo is in COMMANDS');
r = await run(['help'], deps);
ok(/demo/.test(text(r)) && /\$0 bill/.test(text(r)), 'top-level help advertises stratos demo');

console.log(`\n✅ ${pass}/${pass} stratos-demo CLI tests passed — wired, honest, verifiable, gated, degrades cleanly.`);
