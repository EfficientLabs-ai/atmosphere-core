// test-demo-harness.mjs — the "$0 bill" vertical-slice harness, hermetic.
// Mocks the gateway fetch + uses a deterministic injected keypair, so it needs NO live daemon, NO
// Ollama, NO on-disk keys. Proves: a real local response is required (never fabricated), the sovereign
// decision is local (cloud NOT used), the signed receipt verifies third-party-style (public key only),
// the $0 bill is honest (local=$0, cloud column explicitly illustrative), and a down daemon degrades
// with a clear "start the daemon" message instead of inventing a response.
import assert from 'node:assert';
import {
  buildChatRequest, illustrativeCloudCost, callLocalGateway, sovereignDecision,
  proveWithReceipt, buildBill, runDemo, DEFAULT_PROMPT, ILLUSTRATIVE_CLOUD,
} from './src/cli/demo-harness.js';
import { generateHybridKeyPair } from './src/security/quantum-crypto.js';
import { verifyBundle } from './src/ledger/capability-receipt.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

console.log('demo-harness — the wired "$0 bill" vertical slice\n');

// A real OpenAI-shaped gateway response (gemma2:2b, with usage), as the live daemon returns.
const PROMPT = 'why local?';
const ANSWER = 'Because your data never leaves the machine.';
const USAGE = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
const okFetch = async (url, opts) => {
  assert.ok(url.endsWith('/v1/chat/completions'), 'calls the OpenAI-compatible gateway path');
  const body = JSON.parse(opts.body);
  assert.strictEqual(body.messages[0].content, PROMPT, 'forwards the prompt as an OpenAI message');
  return { ok: true, status: 200, json: async () => ({ model: 'gemma2:2b', choices: [{ message: { role: 'assistant', content: ANSWER } }], usage: USAGE }) };
};

// --- request shape: identical to an OpenAI client ---
const req = buildChatRequest(PROMPT);
ok(req.messages[0].role === 'user' && req.messages[0].content === PROMPT && req.stream === false, 'buildChatRequest is an OpenAI-compatible body');

// --- step 1: a REAL local response is returned (never fabricated) ---
let call = await callLocalGateway({ prompt: PROMPT, fetchImpl: okFetch });
ok(call.ok && call.content === ANSWER && call.usage.total_tokens === 30, 'callLocalGateway returns the real local response + usage');

// --- step 2: sovereign decision is LOCAL — cloud NOT used ---
const dec = sovereignDecision(PROMPT, { model: 'gemma2:2b' });
ok(dec.cloud === false && /local/.test(dec.tier) && dec.dataStaysOnMachine === true, 'decision is local: cloud not used, data stays on machine');

// --- step 3: signed receipt verifies with the PUBLIC key only ---
const kp = generateHybridKeyPair();
const proof = proveWithReceipt({ prompt: PROMPT, content: ANSWER, usage: USAGE, model: 'gemma2:2b', keyPair: kp });
ok(proof.verification.ok === true && proof.verification.count === 1, 'receipt bundle verifies third-party-style (public key only)');
ok(proof.receipt.input_hash !== PROMPT && proof.receipt.output_hash !== ANSWER, 'receipt stores HASHES, never the content');
ok(proof.receipt.cost_units === 30, 'receipt cost_units is the MEASURED token count (not a price)');
ok(!JSON.stringify(proof.bundle).includes('privateKey') && !!proof.bundle.public_key, 'exported bundle carries the public key, leaks NO private key');
// independent re-verification of the exact bundle (a true third party)
ok(verifyBundle(proof.bundle).ok === true, 'an independent verifyBundle() accepts the bundle');
// tamper → fail-closed
const tampered = JSON.parse(JSON.stringify(proof.bundle));
tampered.receipts[0].cost_units = 999999;
ok(verifyBundle(tampered).ok === false, 'a tampered receipt fails verification (fail-closed)');

// --- step 4: the $0 bill is honest ---
const cloud = illustrativeCloudCost(USAGE);
ok(Math.abs(cloud.usd - ((10 / 1e6) * ILLUSTRATIVE_CLOUD.inputPerM + (20 / 1e6) * ILLUSTRATIVE_CLOUD.outputPerM)) < 1e-12, 'cloud estimate = tokens × published list price');
const bill = buildBill({ usage: USAGE, decision: dec });
ok(bill.localMarginalUsd === 0, 'local marginal cost is exactly $0');
ok(/illustrative/i.test(bill.illustrativeCloud.label) && /NOT billed/i.test(bill.illustrativeCloud.label), 'cloud column is explicitly labelled illustrative, NOT billed');
ok(bill.dataLocality.includes('on-device'), 'bill records data locality = on-device');

// --- full slice (happy path) ---
const full = await runDemo({ prompt: PROMPT, fetchImpl: okFetch, keyPair: kp });
ok(full.ok && full.response.content === ANSWER && full.decision.cloud === false && full.receipt.verification.ok === true && full.bill.localMarginalUsd === 0, 'runDemo end-to-end: real response · local · verified receipt · $0');

// --- HONEST DEGRADE: daemon down → clear message, NO fabricated response ---
const downFetch = async () => { const e = new Error('ECONNREFUSED'); throw e; };
call = await callLocalGateway({ prompt: PROMPT, fetchImpl: downFetch });
ok(!call.ok && call.degraded && /start the/i.test(call.fix), 'daemon down: honest degrade with a start-the-daemon fix');
const degraded = await runDemo({ prompt: PROMPT, fetchImpl: downFetch });
ok(!degraded.ok && degraded.degraded && !degraded.response, 'runDemo degrade carries NO response (nothing fabricated)');
ok(degraded.decision && degraded.decision.cloud === false, 'even when degraded, the sovereign decision is shown and is local');

// --- 200 with empty content is NOT treated as a real answer (no emptiness shown) ---
const emptyFetch = async () => ({ ok: true, status: 200, json: async () => ({ model: 'gemma2:2b', choices: [{ message: { content: '   ' } }], usage: {} }) });
call = await callLocalGateway({ prompt: PROMPT, fetchImpl: emptyFetch });
ok(!call.ok && call.degraded, '200 with empty content degrades honestly (not a real local answer)');

// --- 502 (fallback disabled) → actionable fix ---
const badFetch = async () => ({ ok: false, status: 502, json: async () => ({ error: { message: 'no fallback' } }) });
call = await callLocalGateway({ prompt: PROMPT, fetchImpl: badFetch });
ok(!call.ok && call.status === 502 && /LOCAL_FALLBACK_ENABLED/.test(call.fix), '502 degrade tells you to enable local fallback');

// --- default prompt is the sovereign thesis ---
ok(/sovereign/i.test(DEFAULT_PROMPT), 'the default prompt states the sovereignty thesis');

console.log(`\n✅ ${pass}/${pass} demo-harness tests passed — wired, honest, verifiable, degrades cleanly.`);
