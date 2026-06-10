#!/usr/bin/env node
/**
 * check-carve-sync.mjs — the carve-sync drift gate (issues #75 + #76; Unified Audit §4).
 *
 * THE PROBLEM: security-critical files are hand-carved from this private core into the public
 * mirrors (StratosAgent, TheAtmosphere). `quantum-crypto.js` — the PQC primitive every receipt,
 * seal, and identity rests on — exists as THREE byte-identical copies. A silent divergence in any
 * copy breaks cross-repo signature/receipt interop, which is exactly the interop the trust spine
 * guarantees. This gate makes drift loud.
 *
 * MECHANISM (#75's "generate-from-private with checksum" variant — npm extraction stays
 * founder-gated): the file in THIS repo is the declared CANONICAL source (declared here in the
 * manifest, not in-file, so the bytes stay identical across copies). CI fetches each public
 * mirror's copy raw from GitHub and fails if any sha256 differs from the canonical.
 *
 * INTENTIONAL changes: update the canonical and the mirrors in lockstep (one PR per repo); the
 * gate passes again once all copies match. There is no allowlist — identity IS the contract.
 *
 * Offline behavior: mirrors are fetched over the network. In CI (GitHub runners) that always
 * works; locally with no network the gate SKIPS with a warning (exit 0) — it is an
 * integration gate, not a hermetic test. Force-fail-on-offline with CARVE_SYNC_STRICT=1.
 *
 * Hermetic testing: pass a fetcher via runCarveSync({fetcher}) — see test-check-carve-sync.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The carve manifest: canonical (this repo) → public mirrors (raw URLs). Extend as carves grow. */
export const CARVES = [
  {
    name: 'quantum-crypto (the PQC trust-spine primitive)',
    canonical: 'packages/stratos-agent/src/security/quantum-crypto.js',
    mirrors: [
      'https://raw.githubusercontent.com/EfficientLabs-ai/StratosAgent/main/src/security/quantum-crypto.js',
      'https://raw.githubusercontent.com/EfficientLabs-ai/TheAtmosphere/main/node-runner/quantum-crypto.js',
    ],
  },
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function defaultFetcher(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Run the gate. Returns { ok, results } — ok=false means DRIFT (a mirror differs).
 * Fetch failures are reported distinctly: drift fails the gate; unreachable mirrors fail only
 * in strict mode (CI sets CARVE_SYNC_STRICT=1), otherwise skip with a warning.
 */
export async function runCarveSync({ fetcher = defaultFetcher, strict = process.env.CARVE_SYNC_STRICT === '1', carves = CARVES, root = ROOT } = {}) {
  const results = [];
  let drift = false;
  let unreachable = false;

  for (const carve of carves) {
    const canonicalPath = path.join(root, carve.canonical);
    const canonicalHash = sha256(fs.readFileSync(canonicalPath));
    for (const url of carve.mirrors) {
      try {
        const mirrorHash = sha256(await fetcher(url));
        const match = mirrorHash === canonicalHash;
        if (!match) drift = true;
        results.push({ carve: carve.name, url, match, canonicalHash, mirrorHash });
      } catch (e) {
        unreachable = true;
        results.push({ carve: carve.name, url, match: null, error: e.message });
      }
    }
  }

  const ok = !drift && (!unreachable || !strict);
  return { ok, drift, unreachable, results };
}

// CLI entrypoint
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { ok, drift, unreachable, results } = await runCarveSync();
  for (const r of results) {
    if (r.match === true) console.log(`  ✓ in sync   ${r.carve} ← ${r.url}`);
    else if (r.match === false) console.error(`  ✗ DRIFT     ${r.carve}\n      canonical ${r.canonicalHash.slice(0, 16)}… ≠ mirror ${r.mirrorHash.slice(0, 16)}…\n      ${r.url}`);
    else console.warn(`  ⚠ unreachable ${r.url} (${r.error})`);
  }
  if (drift) {
    console.error('\n❌ carve-sync: a public mirror has drifted from the canonical source.');
    console.error('   Fix: update the canonical + every mirror in lockstep (one PR per repo) so all copies are byte-identical again.');
    process.exit(1);
  }
  if (unreachable && process.env.CARVE_SYNC_STRICT === '1') {
    console.error('\n❌ carve-sync (strict): mirror unreachable — cannot verify the trust spine.');
    process.exit(1);
  }
  if (unreachable) console.warn('\n⚠ carve-sync: skipped unreachable mirrors (offline?). CI runs strict.');
  console.log(ok ? '\n✅ carve-sync: all public mirrors byte-identical to the canonical source.' : '');
}
