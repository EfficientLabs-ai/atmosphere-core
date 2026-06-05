/**
 * mesh-signal.js — an HONEST, file-backed mesh-availability signal for the sovereign router.
 *
 * The router can route heavy work to "the mesh" (your other machines) instead of the cloud — but
 * ONLY if the mesh is actually there. This reads the SAME self-reported fleet.json the CLI surfaces
 * (`stratos mesh`), so the router's mesh decision and the status command can never disagree.
 *
 * Deny-by-default + never invent peers (the honesty thesis): no fleet file, a corrupt file, zero
 * nodes, or zero cores ⇒ NOT available. As of this writing no device has ever actually connected,
 * so this returns false — correctly — until a real fleet.json is written by a live mesh node.
 *
 * LIVENESS (review finding #3, now implemented): a fleet.json left over from a past mesh run must NOT
 * read as a live mesh. The file's own updatedAtMs is the origin's clock (not guaranteed wall-clock),
 * so freshness is gated on the file MTIME — a live origin rewrites fleet.json on a heartbeat, so a
 * fresh file ⇒ a live fleet. Default window 10 min (STRATOS_FLEET_MAX_AGE_MS; 0 disables). This still
 * isn't a per-node reachability probe — that's deeper follow-up — but it rejects stale snapshots.
 *
 *   STRATOS_FLEET            override the fleet.json path
 *   STRATOS_MESH_AVAILABLE   hard override ('true'/'false') — for tests + explicit opt-out
 */
import fs from 'node:fs';
import path from 'node:path';

// Liveness window: a live origin rewrites fleet.json on a heartbeat, so a FRESH file = a live fleet.
// Default 10 min (a live origin updates far more often); 0 disables the freshness gate.
function fleetMaxAgeMs() {
  const v = Number(process.env.STRATOS_FLEET_MAX_AGE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 600_000;
}

/** Read the self-reported fleet state from disk, or null if absent/unreadable. Never throws. */
export function readFleetState(opts = {}) {
  const envPath = process.env.STRATOS_FLEET || opts.path;
  const bases = opts.bases || [process.cwd(), path.join(process.cwd(), '.stratos-profile')];
  const candidates = envPath ? [envPath] : bases.map((b) => path.join(b, 'fleet.json'));
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const f = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Canonical schema (matches the CLI's readFleet): counts live under `totals`; `nodes` is the
      // node ARRAY. Fall back to top-level for a flat/legacy file. (Reading top-level `nodes` on the
      // canonical file gave Number(array)=NaN→0, so a real fleet was never detected — fixed here.)
      const t = (f && typeof f.totals === 'object' && f.totals) ? f.totals : f;
      return { nodes: Number(t.nodes) || 0, cores: Number(t.cores) || 0, path: p, mtimeMs: fs.statSync(p).mtimeMs };
    } catch { /* corrupt/unreadable fleet file → treat as no mesh */ }
  }
  return null;
}

/**
 * Whether the mesh is available to absorb work right now. True only if a real fleet reports ≥1 node
 * with ≥1 core, the file is FRESH (liveness), and opt-in isn't explicitly false. Deny-by-default else.
 * @param {object} [opts] { optIn?, fleet?, path?, bases?, maxAgeMs? }
 */
export function meshAvailable(opts = {}) {
  const hard = process.env.STRATOS_MESH_AVAILABLE;
  if (hard === 'true') return true;
  if (hard === 'false') return false;
  if (opts.optIn === false) return false;                 // explicitly not joined
  const fleet = opts.fleet !== undefined ? opts.fleet : readFleetState(opts);
  if (!(fleet && fleet.nodes > 0 && fleet.cores > 0)) return false;
  // LIVENESS gate: the file's own updatedAtMs is the origin's clock (not guaranteed wall-clock), so
  // use the file MTIME — a reliable wall-clock signal — to reject STALE snapshots from past mesh runs
  // (e.g. a fleet.json left over from a test days ago must NOT read as a live mesh).
  const maxAge = opts.maxAgeMs ?? fleetMaxAgeMs();
  if (maxAge > 0 && fleet.mtimeMs != null && (Date.now() - fleet.mtimeMs) > maxAge) return false;
  return true;
}
