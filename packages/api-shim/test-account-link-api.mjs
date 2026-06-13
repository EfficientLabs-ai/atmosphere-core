/**
 * test-account-link-api.mjs — POST /v1/account/link/proof.
 * Asserts: a valid request returns a proof that VERIFIES against the issued account+challenge and a
 * receipt id; no node identity → 409; bad inputs → 400; the receipt is fail-closed (recorder absent
 * or a failed mint → 503, no proof issued); the private key never appears in the response.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import fetch from 'node-fetch';
import { generateHybridKeyPair } from '../stratos-agent/src/security/quantum-crypto.js';
import { createNodeAccountProof, verifyNodeAccountProof } from '../stratos-agent/src/identity/account-link.js';
import { createAccountLinkRouter } from './src/product/account-link-api.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

const b64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));

// Spin a server with a temp profile. `withKeys` writes node-keys.json; `record` is the injected recorder.
function serve({ withKeys = true, record } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acctlink-api-'));
  let nodePublic = null;
  if (withKeys) {
    const kp = generateHybridKeyPair();
    nodePublic = kp.publicKey;
    fs.writeFileSync(path.join(dir, 'node-keys.json'), JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }), { mode: 0o600 });
  }
  const app = express();
  app.use(express.json()); // mirror the daemon's GLOBAL bodyParser.json() (server.js) — the route relies on it
  app.use(createAccountLinkRouter({ accountLink: { createNodeAccountProof }, record, profileDir: dir, now: Date.now }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1/account/link/proof`,
      dir, nodePublic, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    }));
  });
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const ACCT = 'acct_xyz';
const CHALLENGE = 'c'.repeat(64);
let idCounter = 0;
const goodRecord = () => `receipt_${++idCounter}`;     // recorder that succeeds
const failRecord = () => null;                          // recorder whose mint fails

console.log('account-link-api — POST /v1/account/link/proof\n');

// 1. HAPPY PATH — 200, proof verifies, receipt id present, NO private key leaked.
{
  let captured = null;
  const rec = (fields) => { captured = fields; return goodRecord(); };
  const s = await serve({ record: rec });
  const res = await post(s.url, { account_id: ACCT, challenge: CHALLENGE });
  const body = await res.json();
  ok(res.status === 200, `valid request → 200 (got ${res.status})`);
  ok(body.receipt_id && typeof body.receipt_id === 'string', 'receipt_id returned');
  const v = verifyNodeAccountProof(body.proof, { expectedAccountId: ACCT, expectedChallenge: CHALLENGE });
  ok(v.ok === true, `returned proof verifies against the issued account+challenge (${v.reason || 'ok'})`);
  ok(captured && captured.action === 'account-link' && captured.ref === `account-link:${ACCT}`, "an 'account-link' receipt (NOT 'pairing') was recorded with the account-link ref");
  const blob = JSON.stringify(body);
  ok(!blob.includes('privateKey') && !body.proof.privateKey, 'response carries no private key material');
  s.close();
}

// 2. NO IDENTITY — node-keys.json absent → 409 (register first), no proof.
{
  const s = await serve({ withKeys: false, record: goodRecord });
  const res = await post(s.url, { account_id: ACCT, challenge: CHALLENGE });
  ok(res.status === 409, `no node identity → 409 (got ${res.status})`);
  s.close();
}

// 3. BAD INPUTS → 400.
{
  const s = await serve({ record: goodRecord });
  ok((await post(s.url, { challenge: CHALLENGE })).status === 400, 'missing account_id → 400');
  ok((await post(s.url, { account_id: ACCT })).status === 400, 'missing challenge → 400');
  ok((await post(s.url, { account_id: '', challenge: CHALLENGE })).status === 400, 'empty account_id → 400');
  ok((await post(s.url, { account_id: 'x'.repeat(300), challenge: CHALLENGE })).status === 400, 'oversized account_id → 400');
  s.close();
}

// 4. FAIL-CLOSED RECEIPT — a failed mint → 503, no proof issued.
{
  const s = await serve({ record: failRecord });
  const res = await post(s.url, { account_id: ACCT, challenge: CHALLENGE });
  const body = await res.json();
  ok(res.status === 503 && !body.proof, 'receipt mint fails → 503, no proof issued (fail-closed)');
  s.close();
}

// 5. NO RECORDER → 503 (proof-surface act refuses without evidence).
{
  const s = await serve({ record: undefined });
  ok((await post(s.url, { account_id: ACCT, challenge: CHALLENGE })).status === 503, 'no recorder configured → 503');
  s.close();
}

console.log(`\n${fail ? '✖' : '✓'} account-link-api: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
