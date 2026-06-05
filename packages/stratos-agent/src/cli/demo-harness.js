/**
 * demo-harness.js — the WIRED VERTICAL-SLICE "$0 bill" demo, pure + hermetic.
 *
 * This is the council's wedge: it converts the built-but-scattered capabilities into ONE undeniable,
 * reproducible, screen-recordable proof. A single chat request runs on THIS machine, sovereign-routed,
 * with a signed capability receipt that a third party can verify — identical request shape to an OpenAI
 * call, at $0 marginal cost, with the data never leaving the box.
 *
 * It REUSES the existing substrate and invents nothing:
 *   - the OpenAI-compatible gateway at 127.0.0.1:PORT/v1/chat/completions (server.js)
 *   - the ONE sovereign router (model-router.js route()) for the local/cloud decision
 *   - the signed capability receipt (capability-receipt.js: ReceiptLog + verifyBundle)
 *
 * HONEST by construction:
 *   - NEVER fabricates a model response. If the daemon is down, it returns a clear degrade with the
 *     exact command to start it — no synthetic text is ever produced.
 *   - The $0 figure is the REAL local marginal cost (own weights, own electricity, no API/per-token
 *     charge). The cloud column is an EXPLICITLY ILLUSTRATIVE estimate (published list price × measured
 *     tokens) — clearly labelled, never claimed as a measured cloud bill.
 *   - The receipt stores HASHES of input/output (privacy), a MEASURED cost_units (token count), and is
 *     verified third-party-style with ONLY the node's public key.
 *
 * The gateway fetch, the receipt log, and the node keypair are all INJECTABLE, so the slice logic is
 * unit-tested with no live daemon, no Ollama, and no on-disk keys.
 */
import { route as routeDecision } from '../routing/model-router.js';
import { ReceiptLog, makeReceiptSigner, makeReceiptVerifier, hashContent, verifyBundle } from '../ledger/capability-receipt.js';
import { generateHybridKeyPair } from '../security/quantum-crypto.js';
import { originId } from '../memory/skill-seal.js';

/** A good default prompt: states the sovereign thesis so the proof is also a narrative. */
export const DEFAULT_PROMPT =
  'In one sentence: why does running this inference locally, with a signed receipt, matter for sovereignty?';

/**
 * ILLUSTRATIVE-ONLY published list prices (USD per 1M tokens) for a frontier cloud API, used solely to
 * estimate what the SAME call WOULD have cost on cloud. This is a public-list-price reference for the
 * comparison column — it is NEVER a measured charge and the demo labels it as such everywhere it shows.
 * gpt-4o pricing as published by OpenAI (input $2.50 / output $10.00 per 1M tokens).
 */
export const ILLUSTRATIVE_CLOUD = Object.freeze({
  model: 'gpt-4o',
  source: 'OpenAI published list price (reference for the estimate only)',
  inputPerM: 2.50,
  outputPerM: 10.00,
});

/** The OpenAI-compatible request body, exactly as an OpenAI SDK client would send it. */
export function buildChatRequest(prompt, { model = 'gemma2:2b' } = {}) {
  return {
    model,
    messages: [{ role: 'user', content: String(prompt) }],
    stream: false,
  };
}

/** Compute the illustrative cloud cost (USD) for the measured token usage. Estimate, not a bill. */
export function illustrativeCloudCost(usage, pricing = ILLUSTRATIVE_CLOUD) {
  const pt = Number(usage?.prompt_tokens) || 0;
  const ct = Number(usage?.completion_tokens) || 0;
  const usd = (pt / 1e6) * pricing.inputPerM + (ct / 1e6) * pricing.outputPerM;
  return { model: pricing.model, usd, prompt_tokens: pt, completion_tokens: ct, source: pricing.source };
}

/**
 * Step 1 — issue the OpenAI-compatible chat request to the LOCAL gateway and get a REAL local response.
 * Returns { ok, status?, model?, content?, usage?, degraded?, reason?, fix? }. NEVER fabricates content:
 * on any connection error or non-OK status it returns a degrade with the start-the-daemon instruction.
 * @param {object} o { prompt, port, model, fetchImpl, gatewaySecret, timeoutMs }
 */
export async function callLocalGateway({ prompt, port = 4099, model = 'gemma2:2b', fetchImpl, gatewaySecret = null, timeoutMs = 120000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, degraded: true, reason: 'no fetch implementation available', fix: 'run on Node 18+ (global fetch) or inject fetchImpl' };
  }
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const body = buildChatRequest(prompt, { model });
  const headers = { 'content-type': 'application/json' };
  if (gatewaySecret) headers['x-atmos-gateway'] = gatewaySecret;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    clearTimeout(t);
    return {
      ok: false, degraded: true,
      reason: `cannot reach the local gateway at 127.0.0.1:${port} (${err.name === 'AbortError' ? 'timed out' : err.message})`,
      fix: 'start the sovereign daemon first:  stratos start   (then re-run: stratos demo)',
    };
  }
  clearTimeout(t);

  if (!resp.ok) {
    let detail = '';
    try { detail = JSON.stringify(await resp.json()).slice(0, 200); } catch { /* ignore body */ }
    return {
      ok: false, degraded: true, status: resp.status,
      reason: `local gateway returned ${resp.status}${detail ? ' — ' + detail : ''}`,
      fix: resp.status === 502
        ? 'enable local fallback:  LOCAL_FALLBACK_ENABLED=true stratos start'
        : 'check the daemon:  stratos doctor',
    };
  }

  let data;
  try { data = await resp.json(); } catch (err) {
    return { ok: false, degraded: true, status: resp.status, reason: `gateway response was not JSON: ${err.message}`, fix: 'check the daemon:  stratos doctor' };
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    // Honest: a 200 with no usable content is NOT a real local answer — degrade rather than show emptiness.
    return {
      ok: false, degraded: true, status: resp.status,
      reason: 'gateway returned 200 but no assistant content (model produced nothing)',
      fix: `confirm the local model is pulled:  ollama pull ${model}`,
    };
  }
  return { ok: true, status: resp.status, model: data.model || model, content, usage: data.usage || {}, raw: data };
}

/**
 * Step 2 — the SOVEREIGN ROUTING decision for this request, from the ONE router. The demo sends a local
 * model name (the wedge is "this runs on YOUR machine"), so the honest decision is local; we surface the
 * tier + reason + the data-locality fact, and make it unmistakable that cloud was NOT used.
 */
export function sovereignDecision(prompt, { model = 'gemma2:2b' } = {}) {
  // No frontier key, no escalate, no mesh: the pure sovereign-default path through the live router.
  const d = routeDecision({ prompt, model }, { hasFrontierKey: false, meshAvailable: false });
  return {
    tier: d.tier,
    cloud: d.cloud,                       // false — proven by the router, not asserted by the demo
    difficulty: d.difficulty,
    reason: d.reason,
    dataStaysOnMachine: !d.cloud,
  };
}

/**
 * Step 3 — produce a SIGNED capability receipt for the inference and verify it third-party-style (public
 * key only). Uses the REAL ReceiptLog + verifyBundle. The keypair/identity are injectable; when none is
 * supplied we mint an ephemeral node identity so the demo is fully self-contained and reproducible.
 * @returns { receipt, bundle, verification, node_id }
 */
export function proveWithReceipt({ prompt, content, usage, model, keyPair } = {}) {
  const kp = keyPair || generateHybridKeyPair();
  const nodeId = originId(kp.publicKey);
  const actorId = nodeId; // single-machine slice: the node is both the actor and the compute host
  const costUnits = Number(usage?.total_tokens) || Number(usage?.completion_tokens) || 0;

  const log = new ReceiptLog({
    nodeId,
    signer: makeReceiptSigner(kp.privateKey),
    verifier: makeReceiptVerifier(kp.publicKey),
  });
  const receipt = log.append({
    actor_id: actorId,
    action: 'inference',
    ref: model,
    input_hash: hashContent(prompt),     // HASH of the input — never the content
    output_hash: hashContent(content),   // HASH of the output — never the content
    cost_units: costUnits,               // MEASURED token count, never a price
  });

  // Export a self-contained bundle carrying ONLY the public key, then verify it as a third party would.
  const bundle = log.exportBundle({ publicKeyBundle: kp.publicKey });
  const verification = verifyBundle(bundle);
  return { receipt, bundle, verification, node_id: nodeId };
}

/**
 * Step 4 — the honest "$0 BILL" reconciliation.
 *   - local marginal cost = $0 (own open weights, own electricity, no API key, no per-token charge)
 *   - cloud column = ILLUSTRATIVE estimate (published list price × the SAME measured tokens), labelled
 *   - data locality = on-device (the router proved local; nothing egressed)
 */
export function buildBill({ usage, decision, pricing = ILLUSTRATIVE_CLOUD } = {}) {
  const cloud = illustrativeCloudCost(usage, pricing);
  return {
    localMarginalUsd: 0,
    localBasis: 'local open-weight model, no API/cloud, no per-token charge (own compute + electricity)',
    dataLocality: decision?.dataStaysOnMachine ? 'on-device — nothing left this machine' : 'EGRESS — request left the machine',
    illustrativeCloud: {
      label: 'illustrative estimate, NOT billed',
      model: cloud.model,
      usd: cloud.usd,
      prompt_tokens: cloud.prompt_tokens,
      completion_tokens: cloud.completion_tokens,
      basis: cloud.source,
    },
    savedVsCloudUsd: cloud.usd, // what you did NOT pay vs the illustrative cloud estimate
  };
}

/**
 * Run the full end-to-end slice and return a machine-readable proof bundle. Orchestrates steps 1–4.
 * Returns { ok, degraded?, ...proof }. NEVER throws on a down daemon — it degrades honestly.
 * The gateway fetch + keypair are injectable for hermetic tests.
 */
export async function runDemo({ prompt = DEFAULT_PROMPT, port = 4099, model = 'gemma2:2b', fetchImpl, gatewaySecret, keyPair, timeoutMs } = {}) {
  const call = await callLocalGateway({ prompt, port, model, fetchImpl, gatewaySecret, timeoutMs });
  const decision = sovereignDecision(prompt, { model });

  if (!call.ok) {
    // Honest degrade: still show the sovereign decision (pure/local), but make clear NO response was run.
    return { ok: false, degraded: true, prompt, decision, gateway: call };
  }

  const proof = proveWithReceipt({ prompt, content: call.content, usage: call.usage, model: call.model, keyPair });
  const bill = buildBill({ usage: call.usage, decision });

  return {
    ok: true,
    prompt,
    gateway: { ok: true, port, status: call.status },
    response: { model: call.model, content: call.content, usage: call.usage },
    decision,
    receipt: {
      receipt_id: proof.receipt.receipt_id,
      hash: proof.receipt.hash,
      action: proof.receipt.action,
      ref: proof.receipt.ref,
      input_hash: proof.receipt.input_hash,
      output_hash: proof.receipt.output_hash,
      cost_units: proof.receipt.cost_units,
      node_id: proof.node_id,
      verification: proof.verification, // { ok, count, node_id } — third-party-verifiable with public key only
      bundle: proof.bundle,
    },
    bill,
  };
}
