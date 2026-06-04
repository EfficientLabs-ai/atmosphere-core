/**
 * mesh-signal.js — an HONEST, file-backed mesh-availability signal for the sovereign router.
 *
 * The router can route heavy work to "the mesh" (your other machines) instead of the cloud — but
 * ONLY if the mesh is actually there. This reads the SAME self-reported fleet.json the CLI surfaces
 * (`stratos mesh`), so the router's mesh decision and the status command can never disagree.
 *
 * Deny-by-default + never invent peers (the honesty thesis): no fleet file, a corrupt file, zero
 * nodes, or zero cores ⇒ NOT available. As of this writing no device has ever actually connected,
 * so this returns false — correctly — until a real fleet.json is written by a live ghost-node.
 *
 *   STRATOS_FLEET            override the fleet.json path
 *   STRATOS_MESH_AVAILABLE   hard override ('true'/'false') — for tests + explicit opt-out
 */
import fs from 'node:fs';
import path from 'node:path';

/** Read the self-reported fleet state from disk, or null if absent/unreadable. Never throws. */
export function readFleetState(opts = {}) {
  const envPath = process.env.STRATOS_FLEET || opts.path;
  const bases = opts.bases || [process.cwd(), path.join(process.cwd(), '.stratos-profile')];
  const candidates = envPath ? [envPath] : bases.map((b) => path.join(b, 'fleet.json'));
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const f = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { nodes: Number(f.nodes) || 0, cores: Number(f.cores) || 0, path: p };
      }
    } catch { /* corrupt fleet file → treat as no mesh */ }
  }
  return null;
}

/**
 * Whether the mesh is available to absorb work right now. True only if a real fleet reports at least
 * one node with at least one core (and opt-in isn't explicitly false). Deny-by-default everywhere else.
 * @param {object} [opts] { optIn?, fleet?, path?, bases? }
 */
export function meshAvailable(opts = {}) {
  const hard = process.env.STRATOS_MESH_AVAILABLE;
  if (hard === 'true') return true;
  if (hard === 'false') return false;
  if (opts.optIn === false) return false;                 // explicitly not joined
  const fleet = opts.fleet !== undefined ? opts.fleet : readFleetState(opts);
  return !!(fleet && fleet.nodes > 0 && fleet.cores > 0);
}
