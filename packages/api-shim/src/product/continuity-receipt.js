/**
 * continuity-receipt.js — a SYNCHRONOUS signed-receipt recorder for continuity store (F2).
 *
 * Why not reuse the terminal session recorder: that one is async + fire-and-forget (correct for a
 * non-blocking session lifecycle), so it can only return a ref BEFORE the append actually lands —
 * a false pointer on a proof surface (Codex finding). This recorder loads the node keys once, then
 * synchronously mints + appends a skill-run receipt over HASHES ONLY and returns the TRUE
 * receipt_id — or null if the append fails (honest: no id implies no receipt).
 *
 * Lazy key load mirrors the operating-tap pattern: reuse persisted node keys, mint on first use.
 */
import fs from 'node:fs';
import path from 'node:path';

export function makeContinuityRecorder(deps = {}, opts = {}) {
  const { ReceiptLog, makeReceiptSigner, createReceipt, originId } = deps;
  let log = null;       // lazily built signed ReceiptLog
  let actorId = null;
  let warned = false;

  function ensure() {
    if (log) return;
    // RETRY on every call until keys exist (Codex note: a permanent failure cache would never pick
    // up a node identity created after the first continuity write — until a restart). Cheap: a
    // single file read on a low-frequency path; we just don't spam the warning.
    try {
      const profile = opts.profileDir || process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile');
      const keyFile = process.env.STRATOS_NODE_KEYS || path.join(profile, 'node-keys.json');
      const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
      const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8')); // continuity needs an existing node identity
      const keys = { publicKey: dec(raw.publicKey), privateKey: dec(raw.privateKey) };
      actorId = originId(keys.publicKey);
      const logPath = process.env.STRATOS_RECEIPTS || path.join(profile, 'live-receipts.jsonl');
      log = new ReceiptLog({ path: logPath, signer: makeReceiptSigner(keys.privateKey), nodeId: actorId, rotateMaxBytes: 5 * 1024 * 1024 });
    } catch (e) {
      if (!warned) { try { console.warn('⚠️  [continuity] receipt rail unavailable (entries still store; no receipt; will retry):', e.message); } catch { /* never throw */ } warned = true; }
    }
  }

  /** ({ input_hash, output_hash, ref }) => signed receipt_id | null. Throws nothing. */
  return function record({ input_hash, output_hash, ref }) {
    ensure();
    if (!log) return null;
    try {
      const r = log.append(createReceipt({
        actor_id: actorId, action: 'skill-run', ref, cost_units: 0,
        node_id: actorId, input_hash: input_hash ?? null, output_hash: output_hash ?? null,
      }));
      return r?.receipt_id ?? null; // the TRUE signed id, only after a successful append
    } catch (e) {
      try { console.warn('⚠️  [continuity] receipt append failed (entry stored; no receipt):', e.message); } catch { /* never throw */ }
      return null;
    }
  };
}
