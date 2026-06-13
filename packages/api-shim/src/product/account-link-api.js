/**
 * account-link-api.js — POST /v1/account/link/proof: the NODE side of the node→account ownership
 * proof (TRANSPORT_IDENTITY_KEYSTONE second link; NODE_ACCOUNT_LINK_SPEC slice 2).
 *
 * Given an account_id + the single-use challenge the account issued, the node signs an ownership
 * proof with its NODE key and returns it. The owner calls this (via the CLI / first-party with the
 * gateway secret) to bind their node to their EL account — the gateway secret is the owner's
 * authority, so the route is behind requireGatewaySecretStrict. NOTE: the read-scoped console token
 * does NOT reach this route (it is wired only to /score + /entitlements) — binding requires the
 * master secret, not a console session.
 *
 * SOVEREIGNTY: the node PRIVATE key is read into memory only to sign and is NEVER returned or logged;
 * the response carries the proof (public key bundle + signature) only — the same posture as the
 * register route, which never reads the private half back into a response.
 *
 * EVIDENCE / FAIL-CLOSED: issuing an ownership proof is a proof-surface act, so it emits an
 * `account-link` receipt (the only persistent effect; a DISTINCT action from `pairing` so it never
 * aliases the owner-pairing onboarding checkmark) and REFUSES if the receipt cannot be minted — an
 * unrecorded ownership proof would be effect-without-evidence. The signed proof self-verifies offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

const PASSTHROUGH = (req, res, next) => next();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const MAX_ACCOUNT_ID = 256;
const MAX_CHALLENGE = 512;

export function createAccountLinkRouter(opts = {}) {
  const router = express.Router();
  const auth = opts.auth || PASSTHROUGH;
  const accountLink = opts.accountLink || null; // { createNodeAccountProof }
  const record = opts.record || null;            // the synchronous receipt recorder (continuity-receipt.js)
  const now = opts.now || (() => Date.now());
  const profileDir = opts.profileDir || process.env.STRATOS_PROFILE_DIR || path.join(process.cwd(), '.stratos-profile');
  const nodeKeysFile = () => process.env.STRATOS_NODE_KEYS || path.join(profileDir, 'node-keys.json');
  const deny = (res, code, message) => res.status(code).json({ error: { message, type: 'account_link' } });

  // ── POST /v1/account/link/proof — mint a node→account ownership proof + an account-link receipt ──
  // Body parsing + raw-size cap are handled by the server's GLOBAL bodyParser.json() (which runs
  // before this router); a route-local express.json() would be a no-op there and falsely imply a cap
  // it doesn't enforce (dual-Codex finding), so we don't add one. The SIGNED content is bounded by the
  // account_id/challenge length checks below; auth is requireGatewaySecretStrict.
  router.post('/v1/account/link/proof', auth, (req, res) => {
    if (!accountLink?.createNodeAccountProof) return deny(res, 503, 'account-link module unavailable');
    const { account_id, challenge } = req.body || {};
    if (typeof account_id !== 'string' || !account_id || account_id.length > MAX_ACCOUNT_ID) {
      return deny(res, 400, `account_id required: non-empty string (<= ${MAX_ACCOUNT_ID} chars)`);
    }
    if (typeof challenge !== 'string' || !challenge || challenge.length > MAX_CHALLENGE) {
      return deny(res, 400, `challenge required: non-empty string (<= ${MAX_CHALLENGE} chars)`);
    }
    if (!record) return deny(res, 503, 'receipt recorder unavailable — an ownership proof is a proof-surface act and refuses without its evidence (fail-closed)');

    // Load the FULL node keypair. The private half stays in memory only to sign; it is never returned
    // or logged. No identity yet ⇒ 409 (register first) — we never mint a key here.
    let nodeKeys;
    try {
      const raw = JSON.parse(fs.readFileSync(nodeKeysFile(), 'utf8'));
      if (!raw.publicKey || !raw.privateKey) return deny(res, 409, 'this node has no identity yet — register first (POST /v1/nodes/register)');
      const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
      nodeKeys = { publicKey: dec(raw.publicKey), privateKey: dec(raw.privateKey) };
    } catch {
      return deny(res, 409, 'node identity unavailable — register first (POST /v1/nodes/register)');
    }

    let proof;
    try {
      proof = accountLink.createNodeAccountProof({ nodeKeys, accountId: account_id, challenge, now });
    } catch (e) {
      return deny(res, 400, 'could not mint ownership proof: ' + e.message);
    }

    // The account-link receipt is the ONLY persistent effect — fail-closed if it cannot be minted.
    // action:'account-link' (NOT 'pairing'): onboarding's PAIRED check counts only owner-pairing
    // ceremony receipts, so this must not alias it (dual-Codex finding).
    const receipt_id = record({
      action: 'account-link',
      ref: `account-link:${account_id}`,
      input_hash: sha256(challenge),
      output_hash: sha256(JSON.stringify(proof)),
    });
    if (!receipt_id) return deny(res, 503, 'evidence receipt failed — refusing to issue an unrecorded ownership proof (fail-closed)');

    res.status(200).json({ proof, receipt_id });
  });

  return router;
}
