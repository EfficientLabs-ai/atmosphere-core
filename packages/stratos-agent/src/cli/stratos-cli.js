/**
 * stratos-cli.js — the honest `stratos` CLI core (StratosAgent's front door).
 *
 * Design: docs/designs/distribution-and-cli.md (Codex BUILD WITH CHANGES). Principles enforced here:
 *  - HONEST: no command prints data it didn't measure. There is NO fabricated status / balance / peer
 *    list / record count (the old `stratos-ctl` did all of that — a launch blocker).
 *  - `doctor` is READ-ONLY and never phones home.
 *  - `init` is LOCAL-ONLY: name + local/BYOK model. Wallet + mesh enrollment live behind the optional
 *    Atmosphere add-on, never in base onboarding.
 *  - mesh-optional: mesh data comes from a real `fleet.json` or is reported "off" — never invented.
 *
 * `run(argv, deps)` returns { code, lines, action? } and performs NO side effects for the testable
 * commands (help/version/status/doctor/bind/models), so it is unit-tested with injected probes/config.
 * Interactive `init` and the `start` daemon are handled by bin/stratos.js via the exported helpers.
 */
import fs from 'node:fs';
import nodeCrypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import * as realConfig from '../core/agent-config.js';
import * as realConnectors from '../connectors/connector-registry.js';
import { languageName } from '../core/languages.js';
import { realProbes } from './probes.js';
import { scaffoldWorkspace, validateWorkspace, ICM_LAYERS } from '../context/icm-workspace.js';
import { AttributionLedger } from '../ledger/attribution-ledger.js';
import { ReceiptLog, makeReceiptVerifier, verifyBundle } from '../ledger/capability-receipt.js';
import { originId } from '../memory/skill-seal.js';
import { route as routeDecision, difficulty, autoEscalateEnabled } from '../routing/model-router.js';
import { runDemo, DEFAULT_PROMPT } from './demo-harness.js';
import { meshAvailable } from '../routing/mesh-signal.js';
import * as ownerIdentity from '../identity/owner-identity.js';
import * as nodeAuthz from '../identity/node-authz.js';
import { makeAuditHook, recordDenial } from '../security/denial-audit.js';
import { parseCapabilities, assertStepAllowed } from '../security/capability-gate.js';
import { EgressPolicy, checkEgress, connectorHostsToRules } from '../security/egress-policy.js';
import * as fts from '../memory/fts-memory.js';
import * as userModelMem from '../memory/user-model.js';
import * as voiceEngine from '../sensory/voice-engine.js';
import { parseSkillMd, importSkillMd, exportSkillMd } from '../skills/skill-md.js';
import { SkillStore } from '../skills/skill-store.js';
import { generateBatch, resolveModelConfig, PLATFORMS, TONES } from '../content/content-engine.js';
import * as composioToolkits from '../integrations/composio-toolkits.js';
import { runToolAction } from '../integrations/composio-exec.js';
import * as workspaceTree from '../workspace/workspace-tree.js';
import { capture as captureEvent, classify as classifyEvent } from '../context/context-capture.js';
import { startTrace, recordStep, endTrace, readTrace } from '../trace/trace-engine.js';
import { evaluate as evaluateTrace } from '../eval/eval-engine.js';
import { improve as improveTask } from '../self-improve/improvement-engine.js';
import { readEval as readEvalRecord } from '../eval/eval-engine.js';
import { generateHybridKeyPair } from '../security/quantum-crypto.js';
import { makeReceiptSigner } from '../ledger/capability-receipt.js';

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m', B: '\x1b[1m' };
const LOCAL_MODEL_RE = /^(qwen|gemma|llama|mistral|phi|deepseek)[a-z0-9.:_-]*$/i;

// Branded wordmark for first-run / help (like the polished onboarding of OpenCode/Hermes).
const _F = {
  S: ['█████', '█    ', '█████', '    █', '█████'],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  A: ['█████', '█   █', '█████', '█   █', '█   █'],
  O: ['█████', '█   █', '█   █', '█   █', '█████'],
};
const _WORDMARK = [0, 1, 2, 3, 4]
  .map((r) => '  ' + 'STRATOS'.split('').map((c) => _F[c][r]).join(' '))
  .join('\n');

/** The branded banner shown on `stratos init` and `stratos help`. */
export function banner() {
  return [
    '',
    C.b + C.B + _WORDMARK + C.x,
    '  ' + C.b + C.B + 'A G E N T' + C.x + C.d + '   ·   sovereign, local-first AI   ·   Efficient Labs' + C.x,
    '  ' + C.d + 'The cloud is a ceiling. ' + C.x + C.b + 'The Atmosphere is limitless.' + C.x,
    '',
  ].join('\n');
}

function readFleet() {
  for (const base of [process.cwd(), path.join(process.cwd(), '.stratos-profile')]) {
    try {
      const f = JSON.parse(fs.readFileSync(path.join(base, 'fleet.json'), 'utf8'));
      if (f?.totals?.nodes != null) return f.totals;
    } catch { /* none */ }
  }
  return null;
}

function helpText() {
  return [
    banner(),
    'Usage: stratos <command> [args]',
    '',
    `  ${C.g}init${C.x}            Set up your agent (name + local/BYOK model). Local-only, no wallet.`,
    `  ${C.g}start${C.x}           Run the local agent on 127.0.0.1 (foreground; Ctrl-C to stop)`,
    `  ${C.g}status${C.x}          Honest snapshot: agent, model readiness, daemon, mesh`,
    `  ${C.g}doctor${C.x}          Read-only preflight — tells you exactly what's missing`,
    `  ${C.g}models${C.x}          List locally-installed models + the configured route`,
    `  ${C.g}bind${C.x} <chat-id>  Bind your Telegram chat id as owner (enables chat config)`,
    `  ${C.g}owner${C.x}           Cryptographic owner identity (Gate 2): did + pairing fingerprint`,
    `  ${C.g}pair${C.x}            Pair a second node to the same owner: request · approve · accept · list`,
    `  ${C.g}channels${C.x}        Connect a messaging channel to talk to your agent (Telegram · Discord · Slack · Matrix · Signal — all live)`,
    `  ${C.g}connect${C.x}         Onboard a connector/MCP server (credential → vault, sidecar pinned)`,
    `  ${C.g}connectors${C.x}      List onboarded connectors (metadata only; secrets stay in the vault)`,
    `  ${C.g}mesh${C.x}            The Atmosphere mesh — status + how to join (optional)`,
    `  ${C.g}icm${C.x}             Context workspace contract (folders over agents): init · validate`,
    `  ${C.g}workspace${C.x}       Files-first operational unit (Workspace > Project > Workflow > Task): create · tree`,
    `  ${C.g}task${C.x}            Scaffold a task (instructions.md · tools.json · data/ · memory/ · outputs/ · traces/ · evals/ · skills/): create`,
    `  ${C.g}capture${C.x}         Capture an event into the operational map (Capture → Classify → Store; deterministic)`,
    `  ${C.g}trace${C.x}           Trace an execution → traces/{task-id}.json + a signed capability-receipt spine`,
    `  ${C.g}eval${C.x}            Score a trace → evals/{task-id}.md + .json (deterministic rubric · verify-as-a-criterion · candidate lessons)`,
    `  ${C.g}improve${C.x}         Compress an eval → lesson + updated instruction (idempotent) + reusable skill on PASS (the closing loop)`,
    `  ${C.g}ledger${C.x}          Attribution: who contributed what — summary · verify · list (measured, not priced)`,
    `  ${C.g}receipt${C.x}         Signed capability receipts — the cross-machine proof rail: export · verify · summary`,
    `  ${C.g}id${C.x}              This node's self-sovereign identity (did:atmos): whoami · inspect`,
    `  ${C.g}route${C.x} <prompt>   Preview the sovereign router: local by default, cloud only on opt-in`,
    `  ${C.g}demo${C.x}            The "$0 bill" proof: one local call · sovereign-routed · signed receipt · $0 vs cloud`,
    `  ${C.g}memory${C.x}          Full-text recall over past conversations (local FTS5): search · recall`,
    `  ${C.g}user${C.x}            The dialectic theory of you — grows across sessions, personalizes: show · forget`,
    `  ${C.g}voice${C.x}           Native local talk/hear/see (Piper TTS · gemma audio/vision): say · hear · see · status`,
    `  ${C.g}skill${C.x}           SKILL.md portability (agentskills.io-compatible): import · export · list`,
    `  ${C.g}egress${C.x}          Policy-as-code egress firewall (default-DENY, anti-exfiltration): show · check`,
    `  ${C.g}content${C.x}         Reusable content engine — private profile in, dated batch out (sovereign-default): generate`,
    `  ${C.g}tool${C.x}            Sovereign Composio toolkits (1000+ apps, keys stay in OUR vault): list · run`,
    `  ${C.g}version${C.x}         Print the version`,
    `  ${C.g}help${C.x}            This message`,
    '',
    `${C.d}Mesh (The Atmosphere) is an optional add-on — never required to use your agent.${C.x}`,
  ];
}

function cmdIcm(rest) {
  const sub = (rest[0] || 'help').toLowerCase();
  const dir = path.resolve(rest[1] || process.cwd());
  if (sub === 'init') {
    let r;
    try { r = scaffoldWorkspace(dir); } catch (e) { return { code: 1, lines: [`${C.r}icm init failed: ${e.message}${C.x}`] }; }
    const lines = [
      `${C.B}ICM workspace${C.x} ${C.d}${dir}${C.x}  ${C.d}— folders over agents${C.x}`,
      ...ICM_LAYERS.map((l) => `  ${C.b}${l.layer}${C.x} ${l.dir.padEnd(11)} ${C.d}${l.purpose}${l.live ? '' : C.y + ' (new)' + C.x}${C.x}`),
      '',
      r.created.length ? `${C.g}✓ created${C.x} ${r.created.join(', ')}` : `${C.d}nothing to create${C.x}`,
      r.existed.length ? `${C.d}• kept   ${r.existed.join(', ')}${C.x}` : '',
      '',
      `${C.d}The folders are the contract — edit files, not the agent.${C.x}`,
    ].filter(Boolean);
    return { code: 0, lines };
  }
  if (sub === 'validate' || sub === 'check') {
    const v = validateWorkspace(dir);
    if (v.ok) return { code: 0, lines: [`${C.g}✓ valid ICM workspace${C.x} ${C.d}${dir}${C.x}`] };
    return { code: 1, lines: [`${C.r}✗ incomplete ICM workspace${C.x} ${C.d}${dir}${C.x}`, ...v.missing.map((m) => `  ${C.y}missing${C.x} ${m}`), '', `${C.d}scaffold it with ${C.x}${C.g}stratos icm init${C.x}`] };
  }
  return { code: 0, lines: [
    `${C.B}stratos icm${C.x} ${C.d}— the folders-over-agents context contract${C.x}`,
    `  ${C.g}init${C.x} [dir]      Scaffold a 5-layer ICM workspace (idempotent; never overwrites)`,
    `  ${C.g}validate${C.x} [dir]  Check a workspace is complete`,
  ] };
}

// ---- ledger + id: observe the trust substrate (attribution + sovereign identity) -----------
// Both default their paths the SAME way the daemon's self-evolution runtime does, so the CLI reads
// the live node's identity + ledger when run from the repo root (env vars override).
const _ROOT = path.resolve(process.cwd());
const shortHash = (h) => (h ? String(h).slice(0, 12) : '—');
const didShort = (d) => { const s = String(d || '—'); return s.length > 30 ? s.slice(0, 22) + '…' + s.slice(-6) : s; };

function ledgerPath(arg) {
  if (arg && !/^\d+$/.test(arg)) return path.resolve(arg);
  if (process.env.STRATOS_LEDGER) return process.env.STRATOS_LEDGER;
  const cands = [
    process.env.STRATOS_SKILLS_DIR && path.join(process.env.STRATOS_SKILLS_DIR, 'attribution.jsonl'),
    path.join(_ROOT, 'packages', 'stratos-agent', 'dist', 'skills', 'attribution.jsonl'),
    path.join(_ROOT, 'dist', 'skills', 'attribution.jsonl'),
    path.join(_ROOT, 'attribution.jsonl'),
  ].filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || cands[0];
}
function nodeKeysPath(arg) {
  if (arg) return path.resolve(arg);
  if (process.env.STRATOS_NODE_KEYS) return process.env.STRATOS_NODE_KEYS;
  const cands = [path.join(_ROOT, '.stratos-profile', 'node-keys.json'), path.join(_ROOT, 'node-keys.json')];
  return cands.find((p) => fs.existsSync(p)) || cands[0];
}

// Capability receipts default to <skills>/receipts.jsonl, mirroring the daemon runtime's
// DIST_SKILLS_DIR convention (env STRATOS_RECEIPTS / STRATOS_SKILLS_DIR override).
function receiptsPath(arg) {
  if (arg && !/^\d+$/.test(arg)) return path.resolve(arg);
  if (process.env.STRATOS_RECEIPTS) return process.env.STRATOS_RECEIPTS;
  const cands = [
    process.env.STRATOS_SKILLS_DIR && path.join(process.env.STRATOS_SKILLS_DIR, 'receipts.jsonl'),
    path.join(_ROOT, 'packages', 'stratos-agent', 'dist', 'skills', 'receipts.jsonl'),
    path.join(_ROOT, 'dist', 'skills', 'receipts.jsonl'),
    path.join(_ROOT, 'receipts.jsonl'),
  ].filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || cands[0];
}

// Reading/exporting/verifying the capability-receipt proof rail is a capability — declared minimally
// and gated deny-by-default through the SAME capability-gate the skill runtime uses. `receipt.read`
// is all this surface needs: it touches no network, no secrets, only the local receipts.jsonl.
const RECEIPT_CAPS = parseCapabilities({ capabilities: { actions: ['receipt.read'] } });

// Load the node's PUBLIC key bundle (no private half) so `receipt export` can embed it for
// third-party verification and `receipt verify` can check the live log. Public-only by design.
function loadNodePublicBundle(kf) {
  if (!kf || !fs.existsSync(kf)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(kf, 'utf8'));
    return Object.fromEntries(Object.entries(raw.publicKey).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  } catch { return null; }
}

/**
 * `stratos receipt export|verify|summary` — the SIGNED CAPABILITY RECEIPT proof rail.
 *   export [--since <iso>]  emit a self-contained, third-party-verifiable JSON bundle to stdout
 *   verify <bundle-file>    check every PQC signature + the full hash chain (OK/BROKEN + where)
 *   summary                 measured cost/count per actor + per node (measurement, never a price)
 * Capability-gated (deny-by-default). HONEST: hashes not content; measurement not price; fail-closed
 * verification. `export` embeds ONLY the node's PUBLIC key, so anyone can verify the bundle with no
 * private key and no access to this node.
 */
function cmdReceipt(rest, d = {}) {
  const sub = (rest[0] || 'summary').toLowerCase();
  const caps = d.receiptCaps || RECEIPT_CAPS;

  if (sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: 0, lines: [
      `${C.B}stratos receipt${C.x} ${C.d}— the signed capability-receipt proof rail (cross-machine, PQC, hash-chained)${C.x}`,
      `  ${C.g}export${C.x} [--since <iso>]   Emit a signed, third-party-verifiable JSON bundle to stdout`,
      `  ${C.g}verify${C.x} <bundle-file>     Check every signature + the full hash chain (fail-closed)`,
      `  ${C.g}summary${C.x}                  Measured cost/count per actor + per node (NOT a payout)`,
      '',
      `  ${C.d}Proves WHO ran WHAT, on WHOSE node, over which input/output (hashed), at what measured cost.`,
      `  A verifier holding ONLY the node's public key can confirm it — and detect any altered or`,
      `  removed/reordered receipt. Content is never stored; cost is measured, never priced.${C.x}`,
    ] };
  }

  // Capability gate: deny-by-default. Tests/callers can inject denied caps to prove enforcement.
  try { assertStepAllowed(caps, { action: 'receipt.read' }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  // VERIFY a bundle file — third-party path: needs only the bundle (public key is embedded).
  if (sub === 'verify') {
    const file = rest[1];
    if (!file) return { code: 1, lines: [`${C.r}usage: stratos receipt verify <bundle-file>${C.x}`] };
    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
    catch (e) { return { code: 1, lines: [`${C.r}cannot read bundle ${file}: ${e.message}${C.x}`] }; }
    const v = verifyBundle(bundle);
    if (v.ok) return { code: 0, lines: [
      `${C.g}✓ receipt bundle OK${C.x} ${C.d}${v.count} receipt(s)${v.node_id ? ` · node ${didShort(v.node_id)}` : ''}${C.x}`,
      `${C.d}every hybrid-PQC signature verified + the hash chain is intact — third-party-verifiable with the public key only.${C.x}`,
    ] };
    return { code: 1, lines: [
      `${C.r}✗ receipt bundle BROKEN${v.brokenAt != null ? ` at receipt ${v.brokenAt}` : ''}: ${v.reason}${C.x}`,
      `${C.d}a receipt was altered, removed, or reordered — the proof no longer validates (fail-closed).${C.x}`,
    ] };
  }

  // export + summary read the FULL receipt history: archived rotation segments (oldest first) +
  // the active file — rotation never silently shrinks what this surface reports (segment-aware
  // since the rotation feature landed; control lines are lineage, not receipts, and are skipped).
  const pArg = rest.find((a, i) => i > 0 && a !== '--since' && !/^\d+$/.test(a) && rest[i - 1] !== '--since');
  const p = receiptsPath(sub === 'export' ? undefined : pArg);
  const kf = nodeKeysPath();
  const pub = loadNodePublicBundle(kf);
  const verifier = pub ? makeReceiptVerifier(pub) : null;

  let log;
  try {
    log = new ReceiptLog({ verifier });
    log.chain = ReceiptLog.loadChainEntries(p); // genesis-rooted full history across segments
  } catch (e) { return { code: 1, lines: [`${C.r}could not read receipts: ${e.message}${C.x}`] }; }

  if (sub === 'export') {
    if (!log.length) {
      // Honest: nothing to export yet. Still emit a well-formed (empty) bundle so pipelines don't break.
      const empty = log.exportBundle({ publicKeyBundle: pub || undefined });
      return { code: 0, lines: JSON.stringify(empty, null, 2).split('\n') };
    }
    if (!pub) {
      return { code: 1, lines: [
        `${C.r}no node public key found${C.x} ${C.d}(${kf})${C.x}`,
        `${C.d}export embeds the node's PUBLIC key so a third party can verify — without it the bundle isn't verifiable.${C.x}`,
      ] };
    }
    const si = rest.indexOf('--since');
    const since = si >= 0 ? rest[si + 1] || null : null;
    const bundle = log.exportBundle({ since, publicKeyBundle: pub });
    // Emit raw JSON to stdout so it can be piped/redirected to a file — portable + verifiable by design.
    return { code: 0, lines: JSON.stringify(bundle, null, 2).split('\n') };
  }

  // default: summary — measured cost/count per actor + per node (NOT a payout).
  if (!log.length) {
    return { code: 0, lines: [
      `${C.B}stratos receipt${C.x} ${C.d}— the capability-receipt proof rail${C.x}`,
      `${C.y}no receipts yet${C.x} ${C.d}at ${p}${C.x}`,
      `${C.d}The daemon emits a signed receipt per inference + verified skill-run once evolution is enabled.${C.x}`,
    ] };
  }
  const v = verifier ? log.verify() : { ok: null };
  const sum = log.summarize();
  const lines = [
    `${C.B}Capability receipts${C.x} ${C.d}— measured cost/count per actor + node (NOT a payout)${C.x}`,
    v.ok === true ? `${C.g}✓ chain + signatures intact${C.x} ${C.d}${log.length} receipt(s)${C.x}`
      : v.ok === false ? `${C.r}✗ chain broken at ${v.brokenAt}: ${v.reason}${C.x}`
      : `${C.y}chain present${C.x} ${C.d}${log.length} receipt(s) (no node key to check signatures)${C.x}`,
    '',
    `${C.B}By actor${C.x}`,
  ];
  for (const a of sum.byActor) {
    const acts = Object.entries(a.byAction).map(([k, u]) => `${k}:${u}`).join(' ');
    lines.push(`  ${C.b}${didShort(a.actor_id)}${C.x}  ${C.g}${String(a.cost_units).padStart(7)}u${C.x} ${C.d}${String(a.count)}rcpt · ${acts}${C.x}`);
  }
  lines.push('', `${C.B}By node${C.x}`);
  for (const n of sum.byNode) {
    const acts = Object.entries(n.byAction).map(([k, u]) => `${k}:${u}`).join(' ');
    lines.push(`  ${C.b}${didShort(n.node_id)}${C.x}  ${C.g}${String(n.cost_units).padStart(7)}u${C.x} ${C.d}${String(n.count)}rcpt · ${acts}${C.x}`);
  }
  // By OWNER WALLET — the reward-attribution view: measured cost per Solana owner (NOT a payout, no
  // price). Wallet-less contributions are summed under an explicit (unattributed) bucket.
  if (Array.isArray(sum.byWallet) && sum.byWallet.length) {
    lines.push('', `${C.B}By owner wallet${C.x} ${C.d}(reward-attribution basis — measured cost only)${C.x}`);
    for (const w of sum.byWallet) {
      const acts = Object.entries(w.byAction).map(([k, u]) => `${k}:${u}`).join(' ');
      const label = w.owner_wallet ? `${w.owner_wallet.slice(0, 4)}…${w.owner_wallet.slice(-4)}` : '(unattributed)';
      lines.push(`  ${C.b}${label}${C.x}  ${C.g}${String(w.cost_units).padStart(7)}u${C.x} ${C.d}${String(w.count)}rcpt · ${acts}${C.x}`);
    }
  }
  lines.push('', `${C.d}Measurement before rewards: the cross-machine proof a future reward layer would read.${C.x}`);
  return { code: 0, lines };
}

function cmdLedger(rest) {
  const sub = (rest[0] || 'summary').toLowerCase();
  if (sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: 0, lines: [
      `${C.B}stratos ledger${C.x} ${C.d}— attribution: who contributed what (measured, never priced)${C.x}`,
      `  ${C.g}summary${C.x} [path]   Measured units per contributor, broken out by kind (default)`,
      `  ${C.g}verify${C.x}  [path]   Replay the tamper-evident hash chain end-to-end`,
      `  ${C.g}list${C.x} [n] [path]  Show the last n entries (default 10)`,
    ] };
  }
  const p = ledgerPath(rest.find((a, i) => i > 0 && !/^\d+$/.test(a)));
  if (!fs.existsSync(p)) {
    return { code: 0, lines: [
      `${C.B}stratos ledger${C.x} ${C.d}— attribution (measured, never priced)${C.x}`,
      `${C.y}no ledger yet${C.x} ${C.d}at ${p}${C.x}`,
      `${C.d}The daemon records here once a verified skill runs — capability-gated + attributed to this node.${C.x}`,
    ] };
  }
  let ledger;
  try { ledger = new AttributionLedger({ path: p }); }
  catch (e) { return { code: 1, lines: [`${C.r}could not read ledger: ${e.message}${C.x}`] }; }

  if (sub === 'verify') {
    const v = ledger.verify();
    if (v.ok) return { code: 0, lines: [
      `${C.g}✓ ledger intact${C.x} ${C.d}${ledger.length} entries · head ${shortHash(v.head)}${C.x}`,
      `${C.d}tamper-evident hash chain verified end-to-end.${C.x}`,
    ] };
    return { code: 1, lines: [
      `${C.r}✗ ledger BROKEN at entry ${v.brokenAt}: ${v.reason}${C.x}`,
      `${C.d}an entry was edited or reordered — the chain no longer validates.${C.x}`,
    ] };
  }
  if (sub === 'list' || sub === 'tail') {
    const n = Math.max(1, parseInt(rest.find((a) => /^\d+$/.test(a)), 10) || 10);
    const entries = ledger.entries().slice(-n);
    if (!entries.length) return { code: 0, lines: [`${C.d}ledger is empty${C.x}`] };
    const lines = [`${C.B}last ${entries.length} of ${ledger.length}${C.x} ${C.d}${p}${C.x}`];
    for (const e of entries) {
      lines.push(`  ${C.d}#${String(e.seq).padStart(3)}${C.x} ${C.b}${String(e.kind).padEnd(15)}${C.x} ${C.g}${String(e.units).padStart(4)}u${C.x} ${e.subject || `${C.d}—${C.x}`} ${C.d}${didShort(e.contributor)}${C.x}`);
    }
    return { code: 0, lines };
  }
  // default: summary
  const sum = ledger.summarize();
  const v = ledger.verify();
  if (!sum.length) return { code: 0, lines: [`${C.d}ledger is empty (${ledger.length} entries)${C.x}`] };
  const lines = [
    `${C.B}Attribution summary${C.x} ${C.d}— measured units per contributor (NOT a payout)${C.x}`,
    v.ok ? `${C.g}✓ chain intact${C.x} ${C.d}${ledger.length} entries${C.x}` : `${C.r}✗ chain broken at ${v.brokenAt}${C.x}`,
    '',
  ];
  for (const c of sum) {
    const kinds = Object.entries(c.byKind).map(([k, units]) => `${k}:${units}`).join(' ');
    lines.push(`  ${C.b}${didShort(c.contributor)}${C.x}  ${C.g}${String(c.total).padStart(5)}u${C.x}  ${C.d}${kinds}${C.x}`);
  }
  lines.push('', `${C.d}Measurement before rewards: the attribution a future reward layer would read.${C.x}`);
  return { code: 0, lines };
}

function cmdId(rest) {
  const sub = (rest[0] || 'whoami').toLowerCase();
  if (sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: 0, lines: [
      `${C.B}stratos id${C.x} ${C.d}— this node's self-sovereign identity (did:atmos)${C.x}`,
      `  ${C.g}whoami${C.x} [keyfile]   Show this node's did:atmos (default)`,
      `  ${C.g}inspect${C.x} <token>    Decode a brokered id-jag assertion (claims + expiry)`,
    ] };
  }
  if (sub === 'inspect' || sub === 'decode') {
    const token = rest[1];
    if (!token) return { code: 1, lines: [`${C.r}usage: stratos id inspect <token>${C.x}`] };
    try {
      const [h, pl] = String(token).split('.');
      const dec = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
      const header = dec(h), payload = dec(pl);
      const nowS = Math.floor(Date.now() / 1000);
      const expired = payload.exp != null && nowS >= payload.exp;
      const left = payload.exp != null ? payload.exp - nowS : null;
      return { code: 0, lines: [
        `${C.B}Brokered assertion${C.x} ${C.d}(id-jag) — decoded, ${C.y}NOT signature-verified${C.d} (the CLI holds no broker secret)${C.x}`,
        `  ${C.d}alg     ${C.x}${header.alg || '?'} ${C.d}${header.typ || ''}${C.x}`,
        `  ${C.d}subject ${C.x}${C.b}${didShort(payload.sub)}${C.x}`,
        `  ${C.d}audience${C.x} ${payload.aud || '—'}`,
        `  ${C.d}scope   ${C.x}${(payload.scope || []).join(', ') || '—'}`,
        expired ? `  ${C.r}EXPIRED${C.x}` : `  ${C.g}valid for ${left}s${C.x} ${C.d}(short-lived by design)${C.x}`,
      ] };
    } catch (e) { return { code: 1, lines: [`${C.r}not a brokered token: ${e.message}${C.x}`] }; }
  }
  // default: whoami
  const kf = nodeKeysPath(rest[1]);
  if (!fs.existsSync(kf)) {
    return { code: 0, lines: [
      `${C.B}stratos id${C.x} ${C.d}— this node's sovereign identity${C.x}`,
      `${C.y}no node identity yet${C.x} ${C.d}(${kf})${C.x}`,
      `${C.d}The daemon mints a PQC node key (Ed25519 + ML-DSA) on first run; its did:atmos derives from the public half.${C.x}`,
    ] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(kf, 'utf8'));
    const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, val]) => [k, Buffer.from(val, 'base64')]));
    const did = originId(dec(raw.publicKey));
    return { code: 0, lines: [
      `${C.B}This node${C.x}`,
      `  ${C.b}${C.B}${did}${C.x}`,
      `  ${C.d}self-sovereign · content-addressed · hybrid PQC (Ed25519 + ML-DSA-65)${C.x}`,
      '',
      `${C.d}This id signs your skills and names you in the attribution ledger. The private half never leaves ${kf}.${C.x}`,
    ] };
  } catch (e) { return { code: 1, lines: [`${C.r}could not read node identity: ${e.message}${C.x}`] }; }
}

// `stratos route <prompt>` — preview the sovereign router's decision (the third observability
// surface: id · ledger · route). Mirrors the live classify() path: /force-* + /private directives,
// and a configured BYOK key is the standing opt-in to escalate hard prompts to cloud.
const _FRONTIER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY'];
const _envHasKey = () => _FRONTIER_KEYS.some((k) => !!process.env[k]);

function cmdRoute(rest) {
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const mi = rest.indexOf('--model');
  const model = mi >= 0 ? rest[mi + 1] || null : null;
  const prompt = rest.filter((a, i) => !a.startsWith('--') && !(mi >= 0 && i === mi + 1)).join(' ').trim();

  if (!prompt && !model) {
    return { code: 1, lines: [
      `${C.r}usage: stratos route <prompt> [--private] [--model <m>] [--mesh] [--key] [--auto-escalate]${C.x}`,
      `${C.d}Preview the sovereign router's decision. --key simulates a configured BYOK key; --mesh${C.x}`,
      `${C.d}simulates a live fleet; --auto-escalate simulates STRATOS_CLOUD_AUTO_ESCALATE=true.${C.x}`,
      `${C.d}/force-local · /force-cloud · /private work inline.${C.x}`,
    ] };
  }

  const q = prompt.toLowerCase();
  const priv = flags.has('--private') || q.includes('/private');
  const keyed = flags.has('--key') || _envHasKey();
  const autoEsc = flags.has('--auto-escalate') || autoEscalateEnabled();  // deploy-time opt-in
  const escalate = keyed && autoEsc;                // both needed for difficulty-based escalation
  const meshReal = meshAvailable();                 // the real, file-backed fleet signal
  const mesh = flags.has('--mesh') || meshReal;     // --mesh forces a preview even with no fleet

  let d;
  if (q.includes('/force-local') || q.includes('/local')) {
    d = { tier: 'local-strong', cloud: false, difficulty: difficulty(prompt), reason: 'explicit /force-local directive' };
  } else if (q.includes('/force-cloud') || q.includes('/cloud')) {
    d = { tier: 'frontier', cloud: true, difficulty: difficulty(prompt), reason: 'explicit /force-cloud directive (opt-in)' };
  } else {
    d = routeDecision({ prompt, model, private: priv, escalate }, { hasFrontierKey: keyed, meshAvailable: mesh });
  }

  const tierLabel = d.cloud
    ? `${C.y}☁  CLOUD${C.x} ${C.d}(frontier, opt-in)${C.x}`
    : d.tier === 'mesh'
      ? `${C.b}⬡  MESH${C.x} ${C.d}(your hardware)${C.x}`
      : `${C.g}🛡  LOCAL${C.x} ${C.d}(${d.tier})${C.x}`;
  const shown = prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt;
  const lines = [
    `${C.B}stratos route${C.x} ${C.d}— what the one sovereign router would do (preview)${C.x}`,
    `  ${C.d}prompt    ${C.x}"${shown}" ${C.d}(${prompt.length} chars)${C.x}`,
    model ? `  ${C.d}model     ${C.x}${model}` : '',
    `  ${C.d}difficulty${C.x} ${d.difficulty}/5`,
    `  ${C.d}decision  ${C.x}${tierLabel}`,
    `  ${C.d}reason    ${C.x}${d.reason}`,
    `  ${C.d}context   ${C.x}key:${keyed ? `${C.g}set${C.x}` : `${C.d}none${C.x}`}  auto-escalate:${autoEsc ? `${C.y}on${C.x}` : `${C.g}off${C.x}`}  mesh:${mesh ? (meshReal ? `${C.b}live${C.x}` : `${C.y}simulated${C.x}`) : 'off'}  private:${priv ? `${C.b}on${C.x}` : 'off'}`,
    '',
    d.cloud
      ? `${C.d}Cloud only because a key is configured (standing opt-in). ${C.x}/force-local${C.d} or ${C.x}--private${C.d} pins it local.${C.x}`
      : `${C.d}Stays on your hardware — the sovereign default. Cloud needs a configured key AND a hard prompt, never silently.${C.x}`,
  ].filter(Boolean);
  return { code: 0, lines };
}

// `stratos demo` — the WIRED VERTICAL-SLICE "$0 bill" proof. Runs ONE OpenAI-compatible request against
// the LOCAL gateway, shows the sovereign routing decision, emits + verifies a signed capability receipt,
// and prints the honest $0-vs-illustrative-cloud bill. The slice logic lives in demo-harness.js (reuses
// the router + receipt + gateway; invents nothing). Capability-gated deny-by-default like `receipt`: this
// surface reads local receipts + makes a loopback call, so `receipt.read` is the action it declares.
const DEMO_CAPS = parseCapabilities({ capabilities: { actions: ['receipt.read'] } });

const usd = (n) => '$' + Number(n).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');

async function cmdDemo(rest, d = {}) {
  if (rest[0] === 'help' || rest[0] === '-h' || rest[0] === '--help') {
    return { code: 0, lines: [
      `${C.B}stratos demo${C.x} ${C.d}— the "$0 bill" vertical-slice proof (local · sovereign · signed · verifiable)${C.x}`,
      `  ${C.g}stratos demo${C.x}                  Run the end-to-end proof against your local daemon`,
      `  ${C.g}stratos demo --prompt "<text>"${C.x}  Use your own prompt (default: the sovereignty thesis)`,
      `  ${C.g}stratos demo --json${C.x}            Emit the machine-readable proof bundle (for pipelines/CI)`,
      '',
      `  ${C.d}Proves: one OpenAI-shaped request runs on THIS machine, sovereign-routed (cloud NOT used),`,
      `  with a third-party-verifiable signed receipt, at $0 marginal cost — data never leaves the box.`,
      `  Honest: real local numbers; the cloud column is an explicitly illustrative list-price estimate.${C.x}`,
    ] };
  }

  // Capability gate: deny-by-default (a test/caller can inject denied caps to prove enforcement).
  const caps = d.demoCaps || DEMO_CAPS;
  try { assertStepAllowed(caps, { action: 'receipt.read' }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const json = flags.has('--json');
  const pi = rest.indexOf('--prompt');
  const prompt = (pi >= 0 ? rest.slice(pi + 1).filter((a) => !a.startsWith('--')).join(' ').trim() : '') || DEFAULT_PROMPT;

  const port = d.port || process.env.PORT || 4099;
  const result = await runDemo({
    prompt,
    port,
    model: d.demoModel || process.env.LOCAL_MODEL_DEFAULT || 'gemma2:2b',
    fetchImpl: d.demoFetch,        // injected in tests; production uses global fetch
    keyPair: d.demoKeyPair,        // injected in tests; production mints an ephemeral node identity
    gatewaySecret: process.env.ATMOS_GATEWAY_SECRET || null,
  });

  // --json: emit the proof bundle verbatim (degrade is still well-formed JSON for pipelines).
  if (json) return { code: result.ok ? 0 : 1, lines: JSON.stringify(result, null, 2).split('\n') };

  // Honest degrade: NO response was fabricated. Show the (pure/local) decision + how to start the daemon.
  if (!result.ok) {
    const g = result.gateway || {};
    return { code: 1, lines: [
      `${C.B}stratos demo${C.x} ${C.d}— the "$0 bill" proof${C.x}`,
      `${C.r}✗ no local response — the daemon isn't answering.${C.x}`,
      `  ${C.d}reason ${C.x}${g.reason || 'gateway unreachable'}`,
      `  ${C.y}→ ${g.fix || 'start the daemon:  stratos start'}${C.x}`,
      '',
      `${C.d}The sovereign router still decided ${C.x}${C.g}LOCAL${C.x}${C.d} for this prompt — but nothing was run or faked.${C.x}`,
    ] };
  }

  const r = result;
  const tier = `${C.g}🛡  LOCAL${C.x} ${C.d}(${r.decision.tier})${C.x}`;
  const verOk = r.receipt.verification?.ok === true;
  const u = r.response.usage || {};
  const ill = r.bill.illustrativeCloud;
  const snippet = r.response.content.trim().replace(/\s+/g, ' ').slice(0, 220);

  const lines = [
    `${C.B}━━ stratos demo · the "$0 bill" proof ━━${C.x}`,
    '',
    `${C.B}1 · OpenAI-compatible request → your machine${C.x}`,
    `  ${C.d}POST ${C.x}127.0.0.1:${port}/v1/chat/completions ${C.d}(same shape any OpenAI client sends)${C.x}`,
    `  ${C.d}prompt   ${C.x}"${prompt.length > 64 ? prompt.slice(0, 61) + '…' : prompt}"`,
    `  ${C.g}✓ real local response${C.x} ${C.d}from ${r.response.model} · ${u.total_tokens ?? '?'} tokens${C.x}`,
    `  ${C.d}↳ ${snippet}${r.response.content.trim().length > 220 ? '…' : ''}${C.x}`,
    '',
    `${C.B}2 · Sovereign routing decision${C.x}`,
    `  ${C.d}decision ${C.x}${tier}`,
    `  ${C.d}reason   ${C.x}${r.decision.reason}`,
    `  ${C.d}cloud    ${C.x}${r.decision.cloud ? C.r + 'USED' + C.x : C.g + 'NOT used — data stays on this machine' + C.x}`,
    '',
    `${C.B}3 · Signed capability receipt${C.x}`,
    `  ${C.d}id       ${C.x}${r.receipt.receipt_id}`,
    `  ${C.d}hash     ${C.x}${shortHash(r.receipt.hash)} ${C.d}· node ${didShort(r.receipt.node_id)}${C.x}`,
    `  ${C.d}attests  ${C.x}${r.receipt.action} of ${r.receipt.ref} · in/out HASHED · ${r.receipt.cost_units} measured units`,
    verOk
      ? `  ${C.g}✓ verifiable proof${C.x} ${C.d}— signature + chain verified with the PUBLIC key only${C.x}`
      : `  ${C.r}✗ verification failed: ${r.receipt.verification?.reason || 'unknown'}${C.x}`,
    '',
    `${C.B}4 · The $0 bill${C.x}`,
    `  ${C.g}local marginal cost   ${usd(r.bill.localMarginalUsd)}${C.x} ${C.d}(${r.bill.localBasis})${C.x}`,
    `  ${C.d}data locality         ${C.x}${r.bill.dataLocality}`,
    `  ${C.y}same call on cloud   ~${usd(ill.usd)}${C.x} ${C.d}(${ill.label}: ${ill.model}, ${ill.prompt_tokens}+${ill.completion_tokens} tok × list price)${C.x}`,
    `  ${C.d}basis                 ${C.x}${C.d}${ill.basis}${C.x}`,
    '',
    verOk
      ? `${C.g}${C.B}✓ PROVEN: local · sovereign · signed-and-verifiable · $0 marginal cost.${C.x}`
      : `${C.y}slice ran locally at $0, but the receipt did not verify — see step 3.${C.x}`,
    `${C.d}Reproduce: stratos demo --json  ·  the cloud figure is illustrative, never a measured bill.${C.x}`,
  ];
  return { code: verOk ? 0 : 1, lines };
}

// `stratos tool` is capability-gated deny-by-default through the SAME gate the skill runtime uses.
// `tool.read` lists toolkits/actions; `tool.run` executes a sovereign Composio action.
const TOOL_CAPS = parseCapabilities({ capabilities: { actions: ['tool.read', 'tool.run'] } });

/**
 * cmdTool — sovereign Composio toolkit surface.
 *   stratos tool list [toolkit]                      — discover toolkits, or actions in one
 *   stratos tool run <toolkit> <action> [--entity id] [--json '{...}']
 * HONEST: execution hits the APP's API only (never composio.dev), pulls the per-entity credential from
 * OUR vault via the broker, and prints a brokered result — never the raw token.
 */
async function cmdTool(rest, d = {}) {
  const sub = (rest[0] || 'list').toLowerCase();
  const caps = d.toolCaps || TOOL_CAPS;
  const tk = d.composioToolkits || composioToolkits;

  if (sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: 0, lines: [
      `${C.B}stratos tool${C.x} ${C.d}— sovereign Composio toolkits (1000+ apps; your keys never leave OUR vault)${C.x}`,
      `  ${C.g}list${C.x} [toolkit]                 List toolkits (or actions in a toolkit). ★ = executable now`,
      `  ${C.g}run${C.x} <toolkit> <action> [opts]  Execute an action via the sovereign executor`,
      `    ${C.d}--entity <id>     per-user identity whose vaulted credential is used (default: "default")${C.x}`,
      `    ${C.d}--json '<params>' action params as JSON${C.x}`,
      '',
      `  ${C.d}Zero composio.dev calls. Credential resolved broker-side, audience-bound + scoped, never returned.${C.x}`,
    ] };
  }

  if (sub === 'list') {
    try { assertStepAllowed(caps, { action: 'tool.read' }); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    const toolkitArg = rest[1];
    if (toolkitArg) {
      let actions;
      try { actions = tk.listActions(toolkitArg); } catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
      if (!actions.length) return { code: 1, lines: [`${C.r}unknown toolkit "${toolkitArg}"${C.x}`] };
      const exec = actions.filter((a) => a.executable);
      const lines = [`${C.b}${toolkitArg}${C.x} ${C.d}— ${actions.length} actions in the MIT catalog, ${exec.length} executable sovereignly${C.x}`];
      for (const a of exec) lines.push(`  ${C.g}★ ${a.slug}${C.x} ${C.d}${a.name}${C.x}`);
      if (!exec.length) lines.push(`  ${C.d}none wired yet — add a sovereign spec in composio-toolkits.js ACTION_SPECS${C.x}`);
      lines.push(`  ${C.d}(+${actions.length - exec.length} catalog-only actions; add specs to run them)${C.x}`);
      return { code: 0, lines };
    }
    let toolkits;
    try { toolkits = tk.listToolkits(); } catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    const exec = toolkits.filter((t) => t.executable);
    const lines = [`${C.b}Sovereign Composio toolkits${C.x} ${C.d}(${toolkits.length} in MIT catalog; ${exec.length} executable now)${C.x}`];
    for (const t of exec) lines.push(`  ${C.g}★ ${t.slug.padEnd(14)}${C.x} ${C.d}${t.name} · ${t.authSchemes.join(',')} · ${t.toolCount} actions${C.x}`);
    lines.push(`  ${C.d}…and ${toolkits.length - exec.length} more catalog toolkits. ${C.x}${C.g}stratos tool list <toolkit>${C.x}${C.d} for actions.${C.x}`);
    return { code: 0, lines };
  }

  if (sub === 'run') {
    try { assertStepAllowed(caps, { action: 'tool.run' }); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    const toolkit = rest[1], action = rest[2];
    if (!toolkit || !action) return { code: 1, lines: [`${C.r}usage: stratos tool run <toolkit> <action> [--entity id] [--json '{...}']${C.x}`] };
    let entity = 'default', params = {};
    for (let i = 3; i < rest.length; i++) {
      if (rest[i] === '--entity') entity = rest[++i];
      else if (rest[i] === '--json') {
        try { params = JSON.parse(rest[++i] || '{}'); } catch { return { code: 1, lines: [`${C.r}--json must be valid JSON${C.x}`] }; }
      }
    }
    const runner = d.runToolAction || runToolAction;
    let result;
    try { result = await runner({ entity, toolkit, action, params }, d.composioDeps || {}); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    return { code: result.ok ? 0 : 1, lines: [
      `${result.ok ? C.g + '✓' : C.r + '✗'} ${toolkit}/${action}${C.x} ${C.d}HTTP ${result.status} · brokered scope=${(result.brokered.scope || []).join(',')} aud=${result.brokered.aud}${C.x}`,
      ...JSON.stringify(result.data, null, 2).split('\n').slice(0, 40),
    ] };
  }

  return { code: 1, lines: [`${C.r}Unknown tool subcommand: ${sub}${C.x}`, `${C.d}Try: list · run · help${C.x}`] };
}

function cmdConnectors(deps) {
  let list;
  try { list = deps.connectors.listConnectors(); } catch (e) { return { code: 1, lines: [`${C.r}connector registry error: ${e.message}${C.x}`] }; }
  const lines = [`${C.b}Connectors${C.x} ${C.d}(credentials live encrypted in the vault — only opaque handles are stored here)${C.x}`];
  if (!list.length) lines.push(`  ${C.d}none yet — onboard one with: ${C.x}${C.g}stratos connect${C.x}`);
  else for (const c of list) lines.push(`  - ${c.name.padEnd(16)} ${c.hasCredential ? C.g + '🔑 credentialed' : C.y + 'no credential'}${C.x} ${C.d}(${c.command})${C.x}`);
  return { code: 0, lines };
}

function cmdMesh(deps) {
  const optIn = deps.config.getConfig().meshOptIn;
  const fleet = readFleet();
  return {
    code: 0,
    lines: [
      `${C.b}The Atmosphere${C.x} — P2P compute mesh ${C.d}(optional, never required)${C.x}`,
      `  Status:  ${optIn ? C.g + 'opted in' + C.x : C.y + 'not joined' + C.x}`,
      `  Fleet:   ${fleet ? `${fleet.nodes} node(s), ${fleet.cores} cores ${C.d}(self-reported)${C.x}` : `off ${C.d}(no fleet.json yet)${C.x}`}`,
      '',
      `  ${C.d}What it is: a public-DHT, hole-punched (no inbound ports), post-quantum zero-trust mesh that lets`,
      `  your agent borrow/lend spare compute. Your data stays end-to-end encrypted; nodes are PQC-verified.${C.x}`,
      '',
      `  ${C.d}To join: run a node bundle (built per platform) — it hole-punches outward, opening no ports.${C.x}`,
      optIn
        ? `  ${C.g}✓ You've opted in.${C.x} ${C.d}Build/run your node bundle to bring this device online.${C.x}`
        : `  ${C.d}Opt in:${C.x} ${C.g}stratos init${C.x} ${C.d}(mesh step) — or set ATMOSPHERE_P2P_OPT_IN=true.${C.x}`,
    ],
  };
}

// render the enabled model sources (local + providers) with honest readiness
function modelsSummary(eff, installedModels, env = process.env) {
  const ms = eff.modelSources || { local: {}, providers: {} };
  const parts = [];
  if (ms.local?.enabled) {
    const installed = installedModels.some((i) => String(i).split(':')[0] === String(ms.local.name).split(':')[0]);
    parts.push(`local:${ms.local.name} ${installed ? C.g + '(ready)' : C.y + '(not pulled)'}${C.x}`);
  }
  for (const [p, cfg] of Object.entries(ms.providers || {})) {
    const ready = !!cfg.keyHandle || !!env[`${p.toUpperCase()}_API_KEY`];
    parts.push(`${p} ${ready ? C.g + '(key set)' : C.y + '(no key)'}${C.x}`);
  }
  return parts.length ? parts.join(' · ') : C.y + 'none configured' + C.x;
}

async function cmdStatus(deps) {
  const { config, probes, port } = deps;
  const { models } = await probes.probeOllama();
  const eff = config.effectiveCapabilities({ installedModels: models });
  const up = await probes.probePort(port);
  const owner = config.getOwner();
  const fleet = readFleet();
  const meshLine = fleet ? `${fleet.nodes} node(s), ${fleet.cores} cores ${C.d}(self-reported)${C.x}` : `off ${C.d}(not joined)${C.x}`;
  const chans = Object.entries(eff.messaging || {}).filter(([, m]) => m.enabled).map(([c]) => c);
  return {
    code: 0,
    lines: [
      `${C.b}${eff.agentName}${C.x} — status`,
      `  Language: ${languageName(config.getLanguage()) || 'English'}`,
      `  Models:   ${modelsSummary(eff, models)}`,
      `  Routing:  save-spend ${eff.routing.saveApiSpend ? C.g + 'on' + C.x : 'off'} ${C.d}·${C.x} ${eff.routing.costApproval}`,
      `  Talk:     ${chans.length ? chans.join(' · ') + ` ${C.d}(configured)${C.x}` : C.y + 'no channel' + C.x + C.d + ' (stratos channels)' + C.x}`,
      `  Daemon:   ${up ? C.g + 'running' : C.y + 'stopped'}${C.x} ${C.d}(127.0.0.1:${port})${C.x}`,
      `  Owner:    ${owner ? C.g + 'bound' : C.y + 'not bound'}${C.x}${owner ? '' : C.d + ' (run: stratos bind <chat-id>)' + C.x}`,
      `  Mesh:     ${meshLine}`,
    ],
  };
}

async function cmdDoctor(deps) {
  const { config, probes, port, ollamaHost } = deps;
  const checks = [];
  const nv = probes.nodeVersion();
  checks.push({ ok: nv.ok, label: 'Node.js', detail: nv.ok ? `${nv.raw}` : `${nv.raw} — need >= ${18}` });

  let cfgOk = true, cfgDetail = 'agent-config.json';
  let eff;
  try { eff = config.effectiveCapabilities({ installedModels: [] }); cfgDetail = `agent "${eff.agentName}"`; }
  catch (e) { cfgOk = false; cfgDetail = `unreadable: ${e.message}`; }
  checks.push({ ok: cfgOk, label: 'Config', detail: cfgDetail });

  const ms = eff?.modelSources || { local: {}, providers: {} };
  // local model source
  if (ms.local?.enabled) {
    const oll = await probes.probeOllama();
    checks.push({ ok: oll.reachable, label: 'Ollama', detail: oll.reachable ? `reachable, ${oll.models.length} model(s)` : `unreachable at ${ollamaHost} (needed for local models)` });
    const installed = oll.models.some((m) => m.split(':')[0] === String(ms.local.name).split(':')[0]);
    checks.push({ ok: installed, label: 'Local model', detail: installed ? `${ms.local.name} installed` : `${ms.local.name} NOT pulled — run: ollama pull ${ms.local.name}`, warn: !installed });
  }
  // provider keys (configured in the vault, or present in env)
  for (const [p, cfg] of Object.entries(ms.providers || {})) {
    const ready = !!cfg.keyHandle || !!process.env[`${p.toUpperCase()}_API_KEY`];
    checks.push({ ok: ready, label: `${p} key`, detail: ready ? 'configured (vault)' : `no key — re-run stratos init and add ${p}`, warn: !ready });
  }
  // messaging channels
  for (const [ch, m] of Object.entries(eff?.messaging || {})) {
    if (!m.enabled) continue;
    const ready = !!m.tokenHandle;
    checks.push({ ok: ready, label: `${ch}`, detail: ready ? 'token configured (vault)' : `no token — run: stratos channels`, warn: !ready });
  }
  if (!ms.local?.enabled && !Object.keys(ms.providers || {}).length) {
    checks.push({ ok: false, label: 'Models', detail: 'no model source configured — run: stratos init', warn: true });
  }

  const up = await probes.probePort(port);
  checks.push({ ok: true, label: 'Daemon port', detail: up ? `127.0.0.1:${port} in use (agent running)` : `127.0.0.1:${port} free (agent not started)` });

  const lines = [`${C.b}stratos doctor${C.x} — read-only preflight`];
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? `${C.g}✓${C.x}` : (c.warn ? `${C.y}!${C.x}` : `${C.r}✗${C.x}`);
    if (!c.ok && !c.warn) failed++;
    lines.push(`  ${mark} ${c.label.padEnd(13)} ${C.d}${c.detail}${C.x}`);
  }
  lines.push('', failed === 0 ? `${C.g}Ready.${C.x}` : `${C.r}${failed} blocking issue(s).${C.x} Fix the ✗ items above.`);
  return { code: failed === 0 ? 0 : 1, lines };
}

async function cmdModels(deps) {
  const { config, probes } = deps;
  const { reachable, models } = await probes.probeOllama();
  const ms = config.getModelSources ? config.getModelSources() : { local: {}, providers: {} };
  const lines = [`${C.b}Models${C.x} ${C.d}— your configured sources${C.x}`];
  lines.push(`  Local:     ${ms.local?.enabled ? C.g + ms.local.name + C.x : C.d + 'off' + C.x}`);
  const provs = Object.keys(ms.providers || {});
  lines.push(`  Providers: ${provs.length ? provs.map((p) => `${p}${ms.providers[p].keyHandle ? C.g + ' ✓' + C.x : C.y + ' (no key)' + C.x}`).join(', ') : C.d + 'none' + C.x}`);
  lines.push('');
  if (!reachable) lines.push(`  ${C.y}Ollama not reachable — no local models to list.${C.x}`);
  else if (!models.length) lines.push(`  ${C.d}(no local models installed — run: ollama pull gemma2:2b)${C.x}`);
  else { lines.push('  Installed locally:'); for (const m of models) lines.push(`    - ${m}`); }
  return { code: 0, lines };
}

function cmdBind(argv, deps) {
  const id = (argv[0] || '').trim();
  if (!/^-?\d{3,}$/.test(id)) {
    return { code: 1, lines: [`${C.r}Usage: stratos bind <telegram-chat-id>${C.x} (digits). Current owner: ${deps.config.getOwner() || 'none'}.`] };
  }
  const bound = deps.config.bindOwner(id);
  return { code: 0, lines: [`${C.g}✓ Owner bound to ${bound}.${C.x} Only this id (in a DM) can reconfigure the agent from chat.`] };
}

/**
 * `stratos owner` — GATE 2: the cryptographic OWNER identity (hybrid PQC, separate from node keys —
 * the chat-id bind above is UI auth; THIS is the authority a pairing grant is signed with).
 *   show (default)   owner did:atmos + the HUMAN fingerprint (what you compare during pairing)
 *   init             create the owner keypair if absent (0600), record the public half in runtime
 * The private half never prints and never enters runtime state.
 */
function cmdOwner(rest, deps) {
  const sub = (rest[0] || 'show').toLowerCase();
  if (sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: 0, lines: [
      `${C.B}stratos owner${C.x} ${C.d}— the cryptographic owner identity (Gate 2)${C.x}`,
      `  ${C.g}show${C.x}   Owner did:atmos + fingerprint (creates the keypair on first use)`,
      `  ${C.g}init${C.x}   Same as show (explicit first-run form)`,
    ] };
  }
  if (sub !== 'show' && sub !== 'init') return { code: 1, lines: [`${C.r}unknown owner subcommand: ${sub}${C.x} — see 'stratos owner help'`] };
  try {
    const ok = ownerIdentity.loadOrCreateOwnerKeys();
    const fp = ownerIdentity.fingerprint(ok.publicKey);
    // Record the PUBLIC identity in runtime state so channels/daemon can reference it.
    const pubB64 = Object.fromEntries(Object.entries(ok.publicKey).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
    try { deps.config.setOwnerIdentity?.(ok.ownerDid, pubB64); } catch { /* runtime store optional in minimal deps */ }
    return { code: 0, lines: [
      `${C.B}Owner identity${C.x} ${C.d}(hybrid Ed25519 + ML-DSA-65 — same suite as the node)${C.x}`,
      `  ${C.d}did        ${C.x}${C.b}${ok.ownerDid}${C.x}`,
      `  ${C.d}fingerprint${C.x} ${C.g}${fp}${C.x}  ${C.d}← compare THIS, human-to-human, when pairing${C.x}`,
      `  ${C.d}keys       ${C.x}${ok.path} ${C.d}(0600; private half never leaves this file)${C.x}`,
    ] };
  } catch (e) { return { code: 1, lines: [`${C.r}owner identity failed: ${e.message}${C.x}`] }; }
}

/**
 * `stratos pair` — GATE 2: the explicit node-pairing ceremony (no blind TOFU; the human-compared
 * fingerprint IS the trust step). Artifacts are plain JSON files the human moves between devices —
 * the signatures carry the trust, not the transport.
 *   request                                    (on the NEW node) signed pairing-request → stdout
 *   approve <request.json> --fingerprint <fp>  (on the OWNER node) verify + approve → grant → stdout
 *   accept  <grant.json>                       (on the NEW node) verify the grant, PIN the owner key
 *   list                                       paired nodes recorded on this device
 */
function cmdPair(rest, deps) {
  const sub = (rest[0] || 'help').toLowerCase();
  if (sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: 0, lines: [
      `${C.B}stratos pair${C.x} ${C.d}— pair a second node to the same owner (Gate 2 ceremony)${C.x}`,
      `  ${C.g}request${C.x}                                    On the NEW node: signed pairing-request → stdout`,
      `  ${C.g}approve${C.x} <request.json> --fingerprint <fp>  On the OWNER node: verify + sign the grant.`,
      `      ${C.y}Refuses without --fingerprint${C.x} ${C.d}— pass the value the human read off the new device;`,
      `      the comparison IS the ceremony (no blind trust-on-first-use).${C.x}`,
      `  ${C.g}accept${C.x}  <grant.json> --owner-fingerprint <fp>`,
      `      On the NEW node: verify the grant is for THIS node, compare the OWNER's fingerprint`,
      `      (read off the owner device — ${C.y}required on first accept${C.x}${C.d}), then PIN the owner key.`,
      `      Once pinned, later grants verify against the pin and need no fingerprint.${C.x}`,
      `  ${C.g}list${C.x}                                       Nodes paired on this device (active/REVOKED)`,
      `  ${C.g}revoke${C.x}  <node-did>                           Owner: withdraw a node's authority (signed revocation)`,
      `  ${C.g}apply-revocation${C.x} <revocation.json>          Peer: verify + record a revocation`,
      `  ${C.g}authz${C.x}   <envelope.json>                      Diagnostic: verify a mesh command vs this device's trust set`,
      '',
      `  ${C.d}Honest scope: identity + ceremony + pinning + ENFORCEMENT + revocation are live (Gate 2b). Wiring the`,
      `  enforcement into the live mesh ingress is the daemon-integration step.${C.x}`,
    ] };
  }
  const readJson = (f) => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
  const loadNodeKeypair = () => {
    const kf = nodeKeysPath();
    if (!fs.existsSync(kf)) throw new Error(`no node identity yet (${kf}) — run the daemon once or 'stratos init'`);
    const raw = JSON.parse(fs.readFileSync(kf, 'utf8'));
    const dec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
    return { publicKey: dec(raw.publicKey), privateKey: dec(raw.privateKey) };
  };
  try {
    if (sub === 'request') {
      const nodeKeys = loadNodeKeypair();
      const req = ownerIdentity.createPairingRequest({ nodeKeys });
      const fp = ownerIdentity.fingerprint(nodeKeys.publicKey);
      console.error(`# this node's fingerprint — the owner must hear/see THIS value: ${fp}`);
      return { code: 0, lines: JSON.stringify(req, null, 2).split('\n') };
    }
    if (sub === 'approve') {
      const file = rest[1];
      const fpIdx = rest.indexOf('--fingerprint');
      const fp = fpIdx >= 0 ? rest[fpIdx + 1] : null;
      if (!file) return { code: 1, lines: [`${C.r}usage: stratos pair approve <request.json> --fingerprint <fp>${C.x}`] };
      const ownerKeys = ownerIdentity.loadOrCreateOwnerKeys();
      const grant = ownerIdentity.approvePairing({ ownerKeys, request: readJson(file), expectedFingerprint: fp });
      try { deps.config.addPairedNode?.({ node_did: grant.node_did, node_public_key: grant.node_public_key, granted_at: grant.granted_at }); } catch { /* runtime store optional in minimal deps */ }
      console.error(`# paired ${didShort(grant.node_did)} — give the grant below to the new node ('stratos pair accept')`);
      return { code: 0, lines: JSON.stringify(grant, null, 2).split('\n') };
    }
    if (sub === 'accept') {
      const file = rest[1];
      const ofpIdx = rest.indexOf('--owner-fingerprint');
      const ownerFp = ofpIdx >= 0 ? rest[ofpIdx + 1] : null;
      if (!file) return { code: 1, lines: [`${C.r}usage: stratos pair accept <grant.json> [--owner-fingerprint <fp>]${C.x}`] };
      const grant = readJson(file);
      // Bind acceptance to THIS device's node identity — a grant minted for another node is
      // refused here (replay protection). The accepting device must hold its node keys.
      const myDid = originId(loadNodeKeypair().publicKey);
      // The PIN lives in its own slot (pairedOwner) — a LOCAL owner identity created by
      // 'stratos owner' on this device can never clobber it.
      const pinned = deps.config.getPairedOwner?.();
      const v = ownerIdentity.verifyPairingGrant(grant, {
        pinnedOwnerPublicKey: pinned ? pinned.owner_public_key : null,
        expectedOwnerFingerprint: ownerFp, // REQUIRED on first accept — the verifier refuses without it
        expectedNodeDid: myDid,
      });
      if (!v.ok) {
        recordDenial({ gate: 'pairing', reason: v.reason, action: 'pair accept', actor: grant?.node_did });
        const hint = /no pinned owner and no owner fingerprint/.test(v.reason)
          ? [`${C.d}First pairing: run ${C.x}stratos owner${C.d} on the OWNER device, read its fingerprint aloud, then re-run with --owner-fingerprint <fp> — the human comparison is the ceremony, in BOTH directions.${C.x}`]
          : [];
        return { code: 1, lines: [`${C.r}✗ grant REFUSED: ${v.reason}${C.x}`, ...hint] };
      }
      try { deps.config.setPairedOwner?.(v.ownerDid, grant.owner_public_key); } catch { /* runtime store optional in minimal deps */ }
      // Pairing-success receipt (ATMOS_ONBOARDING_BACKEND §1 step 3): the checklist's step-3
      // checkmark needs an evidence artifact on the chain, not just runtime state. Fail-visible,
      // never lifecycle-blocking — a receipt failure must not undo a valid pairing.
      let receiptLine = null;
      try {
        const nodeKeys = loadNodeKeypair();
        const rlog = new ReceiptLog({
          path: receiptsPath(), signer: makeReceiptSigner(nodeKeys.privateKey),
          nodeId: myDid, rotateMaxBytes: 5 * 1024 * 1024,
        });
        // BIND the receipt to the ceremony (dual-Codex: an unbound pairing receipt is
        // self-asserted — any key holder could mint one out of band). input_hash = the
        // owner-SIGNED grant verbatim; output_hash = the accepted ceremony facts (owner DID +
        // pinned owner fingerprint + this node's DID). A verifier can now demand the grant
        // that hashes to input_hash and check its owner signature independently.
        const h = (x) => nodeCrypto.createHash('sha256').update(String(x)).digest('hex');
        const r = rlog.append({
          actor_id: myDid, action: 'pairing', ref: `accept:${v.ownerDid}`, cost_units: 0,
          input_hash: h(JSON.stringify(grant)),
          output_hash: h(JSON.stringify({ owner_did: v.ownerDid, owner_fingerprint: v.ownerFingerprint, node_did: myDid })),
        });
        receiptLine = `${C.d}pairing receipt ${C.x}${shortHash(r.hash)}${C.d} appended to the chain (step-3 evidence artifact).${C.x}`;
      } catch (e) {
        receiptLine = `${C.y}⚠ pairing receipt not minted (${e.message}) — the pairing itself succeeded.${C.x}`;
      }
      return { code: 0, lines: [
        `${C.g}✓ paired to owner ${didShort(v.ownerDid)}${C.x} ${C.d}(owner fingerprint ${v.ownerFingerprint})${C.x}`,
        `${C.d}owner key ${pinned ? 'matched the existing pin' : 'PINNED on this device'}; future grants must verify against it.${C.x}`,
        receiptLine,
      ] };
    }
    if (sub === 'list') {
      const nodes = deps.config.getPairedNodes?.() || [];
      const revoked = new Set(deps.config.getRevokedNodes?.() || []);
      if (!nodes.length) return { code: 0, lines: [`${C.d}no paired nodes recorded on this device${C.x}`] };
      return { code: 0, lines: nodes.map((n) => `  ${C.b}${didShort(n.node_did)}${C.x} ${revoked.has(n.node_did) ? C.r + 'REVOKED' + C.x : C.g + 'active' + C.x} ${C.d}paired ${n.paired_at || n.granted_at || '?'}${C.x}`) };
    }
    // GATE 2b: the OWNER revokes a paired node's authority. Signs a verifiable revocation and records
    // the did in this device's revocation set so mesh authorization (node-authz) denies it.
    if (sub === 'revoke') {
      const nodeDid = rest[1];
      if (!nodeDid) return { code: 1, lines: [`${C.r}usage: stratos pair revoke <node-did>${C.x}`] };
      const ownerKeys = ownerIdentity.loadOrCreateOwnerKeys();
      const rev = ownerIdentity.createRevocation({ ownerKeys, nodeDid });
      try { deps.config.addRevokedNode?.(nodeDid); } catch { /* runtime store optional in minimal deps */ }
      console.error(`# revoked ${didShort(nodeDid)} — distribute the signed revocation below to peers ('stratos pair apply-revocation')`);
      return { code: 0, lines: JSON.stringify(rev, null, 2).split('\n') };
    }
    // A peer applies a revocation it received: verifies against its pinned owner, then records it.
    if (sub === 'apply-revocation') {
      const file = rest[1];
      const ofpIdx = rest.indexOf('--owner-fingerprint');
      const ownerFp = ofpIdx >= 0 ? rest[ofpIdx + 1] : null;
      if (!file) return { code: 1, lines: [`${C.r}usage: stratos pair apply-revocation <revocation.json> [--owner-fingerprint <fp>]${C.x}`] };
      const pinned = deps.config.getPairedOwner?.();
      const v = ownerIdentity.verifyRevocation(readJson(file), { pinnedOwnerPublicKey: pinned ? pinned.owner_public_key : null, expectedOwnerFingerprint: ownerFp });
      if (!v.ok) {
        recordDenial({ gate: 'pairing', reason: v.reason, action: 'pair apply-revocation' });
        return { code: 1, lines: [`${C.r}✗ revocation REFUSED: ${v.reason}${C.x}`] };
      }
      try { deps.config.addRevokedNode?.(v.nodeDid); } catch { /* runtime store optional in minimal deps */ }
      return { code: 0, lines: [`${C.g}✓ applied revocation of ${didShort(v.nodeDid)}${C.x} ${C.d}(signed by owner ${didShort(v.ownerDid)})${C.x}`] };
    }
    // Verify-as-a-criterion: authorize a mesh command envelope against THIS device's trust set.
    if (sub === 'authz') {
      const file = rest[1];
      if (!file) return { code: 1, lines: [`${C.r}usage: stratos pair authz <envelope.json>${C.x}`] };
      const trust = nodeAuthz.buildTrustSet({
        pairedOwner: deps.config.getPairedOwner?.() || null,
        pairedNodes: deps.config.getPairedNodes?.() || [],
        revokedNodes: deps.config.getRevokedNodes?.() || [],
      });
      // DIAGNOSTIC verifier: checks an envelope against trust + signature + freshness for a human
      // testing pairing. Durable cross-message REPLAY state is the DAEMON mesh-ingress's job (a
      // locked, persistent nonce store) — NOT a CLI file (an unlocked CLI read-modify-write would be
      // race-prone and fail-open; Codex finding). So authz passes a fresh ephemeral store and
      // declares its replay check is single-invocation only.
      const verdict = nodeAuthz.authorizeMeshCommand(readJson(file), trust, { seenNonces: new Set(), audit: makeAuditHook('node-authz') });
      return verdict.ok
        ? { code: 0, lines: [`${C.g}✓ authorized${C.x} ${C.d}(sender role: ${verdict.role}; diagnostic — durable replay state lives in the daemon ingress)${C.x}`] }
        : { code: 1, lines: [`${C.r}✗ DENIED: ${verdict.reason}${C.x}`] };
    }
    return { code: 1, lines: [`${C.r}unknown pair subcommand: ${sub}${C.x} — see 'stratos pair help'`] };
  } catch (e) {
    // Pairing-attempt telemetry (red-team gap): a refused approve/accept/apply-revocation previously
    // reached only the human's terminal. Best-effort persist; the refusal itself is unchanged.
    recordDenial({ gate: 'pairing', reason: e.message, action: `pair ${sub}` });
    return { code: 1, lines: [`${C.r}pair ${sub} failed: ${e.message}${C.x}`] };
  }
}

/** Pure systemd --user unit generator (no root). Tested directly. */
export function generateSystemdUnit({ execPath = process.execPath, binPath = 'stratos', port = 4099 } = {}) {
  return [
    '[Unit]',
    'Description=StratosAgent (local sovereign AI agent)',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=PORT=${port}`,
    'Environment=LOCAL_FALLBACK_ENABLED=true',
    `ExecStart=${execPath} ${binPath} start`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Pure config application for `init` — tested directly. Local-only; no wallet/mesh. */
export function applyInit({ agentName, localModel } = {}, config = realConfig) {
  if (agentName && agentName.trim()) config.setAgentName(agentName.trim());
  if (localModel && LOCAL_MODEL_RE.test(localModel.trim())) config.setLocalModel(localModel.trim());
  config.markConfigured();
  return config.getConfig();
}

export const COMMANDS = ['init', 'start', 'status', 'doctor', 'models', 'bind', 'owner', 'pair', 'channels', 'connect', 'connectors', 'mesh', 'icm', 'workspace', 'task', 'capture', 'trace', 'eval', 'improve', 'ledger', 'receipt', 'id', 'route', 'demo', 'memory', 'user', 'voice', 'skill', 'egress', 'service', 'version', 'help'];

// Reading local cross-session memory is itself a capability — declared minimally and gated
// deny-by-default through the SAME capability-gate the skill runtime uses. `memory.read` is the
// only action this surface needs; it touches no network, no extra fs, no secrets.
const MEMORY_CAPS = parseCapabilities({ capabilities: { actions: ['memory.read'] } });

/**
 * `stratos memory search|recall "<query>"` — sovereign full-text recall over past conversations.
 * Capability-gated (deny-by-default): refuses unless the `memory.read` action is permitted. Honest:
 * if FTS5 isn't available in the SQLite build it says so plainly instead of inventing results.
 */
async function cmdMemory(rest, d = {}) {
  const sub = rest[0];
  const query = rest.slice(1).join(' ').trim();
  if (sub !== 'search' && sub !== 'recall') {
    return { code: query || sub ? 1 : 0, lines: [
      `${C.B}stratos memory${C.x} — full-text recall over past conversations (local, sovereign)`,
      `  ${C.g}stratos memory search "<query>"${C.x}   ranked keyword hits (FTS5 bm25 + snippets)`,
      `  ${C.g}stratos memory recall "<query>"${C.x}   search + local-model summary ("what did we decide about X?")`,
      `  ${C.d}Keyword/exact recall — complementary to the semantic vector store. 100% local.${C.x}`,
    ] };
  }
  if (!query) return { code: 1, lines: [`${C.r}Usage: stratos memory ${sub} "<query>"${C.x}`] };

  // Capability gate: deny-by-default. A test/caller can inject denied caps to prove enforcement.
  const caps = d.memoryCaps || MEMORY_CAPS;
  try { assertStepAllowed(caps, { action: 'memory.read' }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  // Injectable memory backend (tests pass a stub; production uses the real FTS5 module).
  const mem = d.memory || fts;
  await mem.initFtsMemory?.();
  if (mem.available && !mem.available()) {
    return { code: 0, lines: [
      `${C.y}Full-text memory unavailable:${C.x} ${mem.unavailableReason?.() || 'FTS5 not compiled in this SQLite build'}`,
      `${C.d}(Honest degrade — no results fabricated. Vector recall is unaffected.)${C.x}`,
    ] };
  }

  if (sub === 'search') {
    const hits = mem.search(query, { limit: 8 });
    if (!hits.length) return { code: 0, lines: [`${C.d}No matches for "${query}".${C.x}`] };
    const lines = [`${C.B}${hits.length} match(es) for "${query}":${C.x}`];
    for (const h of hits) {
      const when = h.ts ? new Date(h.ts).toISOString().slice(0, 16).replace('T', ' ') : '?';
      lines.push(`  ${C.b}${h.role}${C.x} ${C.d}${when} · ${h.conversationId}${C.x}`);
      lines.push(`    ${h.snippet || h.content}`);
    }
    return { code: 0, lines };
  }

  // recall: search + summarize via the local gateway (sovereign — never cloud).
  const summarize = d.summarize || mem.localGatewaySummarizer?.({ port: d.port });
  const out = await mem.recall(query, { limit: 6, summarize });
  if (!out.hits.length) return { code: 0, lines: [`${C.d}No matches for "${query}".${C.x}`] };
  const lines = [];
  if (out.answer) lines.push(`${C.B}Recall:${C.x} ${out.answer}`, '');
  else lines.push(`${C.y}(No summary — showing raw hits)${C.x}`);
  lines.push(`${C.d}Based on ${out.hits.length} excerpt(s):${C.x}`);
  for (const h of out.hits) lines.push(`  ${C.b}${h.role}${C.x} ${h.snippet || h.content}`);
  return { code: 0, lines };
}

// Reading/forgetting the synthesized theory of the user is a capability — declared minimally and gated
// deny-by-default through the SAME capability-gate the skill runtime uses. `user.read` shows the model;
// `user.forget` wipes it. Neither touches network, extra fs, or secrets.
const USER_CAPS = parseCapabilities({ capabilities: { actions: ['user.read', 'user.forget'] } });

/**
 * `stratos user show|forget [conversationId]` — inspect / erase the DIALECTIC theory of the user.
 *   show   [cid]  print the current synthesized user-model (a revisable theory, not asserted fact)
 *   forget [cid]  clear that conversation's observations + synthesized model (fully forgettable)
 * Capability-gated (deny-by-default). 100% local. Strictly per-conversation (keyed by id — no bleed).
 * The store is injectable (d.userModel) so the CLI is unit-tested with no SQLite / no live model.
 */
async function cmdUser(rest, d = {}) {
  const sub = (rest[0] || '').toLowerCase();
  if (sub !== 'show' && sub !== 'forget') {
    return { code: sub ? 1 : 0, lines: [
      `${C.B}stratos user${C.x} — the dialectic theory of you (local, revisable, forgettable)`,
      `  ${C.g}stratos user show [conversationId]${C.x}     print the current synthesized user-model`,
      `  ${C.g}stratos user forget [conversationId]${C.x}   wipe observations + model for a conversation`,
      `  ${C.d}A theory the agent grows of who you are (preferences · goals · style · topics) to personalize.${C.x}`,
      `  ${C.d}Synthesized locally, never asserted as fact, strictly per-conversation, 100% on-device.${C.x}`,
    ] };
  }
  const conversationId = rest.slice(1).join(' ').trim() || (sub === 'show' ? 'tg:default' : '');

  // Capability gate: deny-by-default. A test/caller can inject denied caps to prove enforcement.
  const caps = d.userCaps || USER_CAPS;
  const action = sub === 'show' ? 'user.read' : 'user.forget';
  try { assertStepAllowed(caps, { action }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  if (sub === 'forget' && !conversationId) {
    return { code: 1, lines: [`${C.r}Usage: stratos user forget <conversationId>${C.x}`] };
  }

  const um = d.userModel || userModelMem;
  await um.initUserModel?.();
  if (um.available && !um.available()) {
    return { code: 0, lines: [
      `${C.y}User-model store unavailable:${C.x} ${um.unavailableReason?.() || 'better-sqlite3 not available'}`,
      `${C.d}(Honest degrade — no profile fabricated.)${C.x}`,
    ] };
  }

  if (sub === 'forget') {
    const okWiped = um.forget(conversationId);
    return { code: 0, lines: [
      okWiped
        ? `${C.g}✓ forgot the theory of the user for ${conversationId}${C.x} ${C.d}(observations + model wiped)${C.x}`
        : `${C.y}nothing to forget for ${conversationId}${C.x}`,
    ] };
  }

  // show
  const info = um.modelInfo ? um.modelInfo(conversationId) : { exists: false, observations: 0 };
  if (!info.exists) {
    return { code: 0, lines: [
      `${C.B}user-model · ${conversationId}${C.x}`,
      `${C.d}No synthesized theory yet${C.x} ${C.d}(${info.observations || 0} observation(s) accrued; synthesis runs after enough turns).${C.x}`,
    ] };
  }
  const when = info.synthesizedAt ? new Date(info.synthesizedAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
  return { code: 0, lines: [
    `${C.B}user-model · ${conversationId}${C.x} ${C.d}synthesized ${when} · ${info.observations} obs${C.x}`,
    `${C.d}A revisable theory (not asserted fact) — local, per-conversation, forgettable:${C.x}`,
    '',
    info.summary,
  ] };
}

// The `voice` surface is local-only (Piper on disk + localhost Ollama) — no network egress beyond
// 127.0.0.1, no secrets, no filesystem writes outside the user-named output path. We declare the
// minimal sensory actions and gate deny-by-default through the SAME capability-gate skills use.
const VOICE_CAPS = parseCapabilities({ capabilities: { actions: ['voice.say', 'voice.hear', 'voice.see', 'voice.status'] } });

/**
 * `stratos voice say|hear|see|status` — the turnkey, open-source, local, zero-cost sensory surface.
 *   say "<text>"     → Piper TTS, prints the wav path it produced
 *   hear <audiofile> → local STT (gemma audio via Ollama, whisper.cpp fallback), prints transcript
 *   see <imagefile>  → gemma vision via Ollama, prints the description
 *   status           → HONEST report of which engines are available on this box
 * Every sub honestly degrades (clear reason, non-zero exit) — never fabricates output.
 * Engine surface is injectable (d.voice) so it's unit-tested without real binaries / a live Ollama.
 */
async function cmdVoice(rest, d = {}) {
  const sub = (rest[0] || '').toLowerCase();
  const ve = d.voice || voiceEngine;

  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: sub ? 0 : 0, lines: [
      `${C.B}stratos voice${C.x} — native local talk / hear / see (open-source, 100% local, zero-cost)`,
      `  ${C.g}stratos voice say "<text>"${C.x}      Piper TTS → a .wav you can play`,
      `  ${C.g}stratos voice hear <audiofile>${C.x}  local speech-to-text → transcript`,
      `  ${C.g}stratos voice see <imagefile>${C.x}   local vision → image description`,
      `  ${C.g}stratos voice status${C.x}            which engines are available (honest ✓/✗)`,
      `  ${C.d}No cloud, no API keys, no cost. Cloud phone voice is a separate optional add-on.${C.x}`,
    ] };
  }

  const actionFor = { say: 'voice.say', hear: 'voice.hear', see: 'voice.see', status: 'voice.status' }[sub];
  if (!actionFor) return { code: 1, lines: [`${C.r}Unknown voice subcommand: ${sub}${C.x}`, `${C.d}Try: say · hear · see · status${C.x}`] };

  // Capability gate: deny-by-default. A test/caller can inject denied caps to prove enforcement.
  const caps = d.voiceCaps || VOICE_CAPS;
  try { assertStepAllowed(caps, { action: actionFor }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  if (sub === 'status') {
    const st = await ve.voiceStatus({ ollamaHost: typeof d.ollamaHost === 'string' ? d.ollamaHost : undefined });
    const mark = (ok) => (ok ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`);
    const why = (o) => (o.ok ? '' : `  ${C.d}${o.reason}${C.x}`);
    return { code: 0, lines: [
      `${C.B}stratos voice — engine status${C.x} ${C.d}(local-only, honest)${C.x}`,
      `  ${mark(st.piper.ok)} ${C.B}Piper TTS${C.x} (talk)${why(st.piper)}`,
      `  ${mark(st.gemmaAudio.ok)} ${C.B}${st.model} audio${C.x} (hear)${why(st.gemmaAudio)}`,
      `  ${mark(st.gemmaVision.ok)} ${C.B}${st.model} vision${C.x} (see)${why(st.gemmaVision)}`,
      `  ${mark(st.whisper.ok)} ${C.B}whisper.cpp${C.x} (hear, fallback)${why(st.whisper)}`,
      '',
      `  ${C.d}Effective:${C.x} talk ${mark(st.canTalk)}  ·  hear ${mark(st.canHear)}  ·  see ${mark(st.canSee)}`,
    ] };
  }

  const arg = rest.slice(1).join(' ').trim();
  if (!arg) return { code: 1, lines: [`${C.r}Usage: stratos voice ${sub} ${sub === 'say' ? '"<text>"' : '<file>'}${C.x}`] };

  if (sub === 'say') {
    const out = d.sayOutPath || path.join(process.cwd(), `stratos-voice-${Date.now()}.wav`);
    const res = await ve.say(arg, out, { verbose: false, silent: true });
    if (!res.ok) return { code: 1, lines: [`${C.y}TTS unavailable:${C.x} ${res.reason}`, `${C.d}(Honest degrade — no audio fabricated.)${C.x}`] };
    return { code: 0, lines: [`${C.g}🔊 Spoke ${arg.length} chars → ${C.x}${res.path}`] };
  }

  // Generous timeout for the one-shot CLI: a cold multimodal load (audio/vision) can take a while.
  const CLI_TIMEOUT_MS = 240_000;

  if (sub === 'hear') {
    const res = await ve.hear(arg, { verbose: false, silent: true, timeoutMs: CLI_TIMEOUT_MS, ollamaHost: typeof d.ollamaHost === 'string' ? d.ollamaHost : undefined });
    if (!res.ok) return { code: 1, lines: [`${C.y}STT unavailable:${C.x} ${res.reason}`, `${C.d}(Honest degrade — no transcript fabricated.)${C.x}`] };
    return { code: 0, lines: [`${C.b}📝 (${res.engine})${C.x} ${res.text}`] };
  }

  // see
  const res = await ve.see(arg, null, { verbose: false, silent: true, timeoutMs: CLI_TIMEOUT_MS, ollamaHost: typeof d.ollamaHost === 'string' ? d.ollamaHost : undefined });
  if (!res.ok) return { code: 1, lines: [`${C.y}Vision unavailable:${C.x} ${res.reason}`, `${C.d}(Honest degrade — no description fabricated.)${C.x}`] };
  return { code: 0, lines: [`${C.b}👁️${C.x} ${res.text}`] };
}

// `stratos skill import|export|list` — SKILL.md portability (agentskills.io / clawhub compatible).
// IMPORT is untrusted-by-default + deny-by-default capability-gated; EXPORT emits provenance. Network-effect
// MOAT: interoperate with the open skill ecosystem WITHOUT shedding the sovereign PQC seal.
//
// Capability-gated through the SAME gate the skill runtime uses: importing a foreign skill is the
// `skill.import` action; reading/exporting ours is `skill.read`. Deny-by-default.
const SKILL_CAPS = parseCapabilities({ capabilities: { actions: ['skill.import', 'skill.read'] } });

function skillsDir() {
  if (process.env.STRATOS_SKILLS_DIR) return path.resolve(process.env.STRATOS_SKILLS_DIR);
  const cands = [
    path.join(_ROOT, 'packages', 'stratos-agent', 'dist', 'skills'),
    path.join(_ROOT, 'dist', 'skills'),
  ];
  return cands.find((p) => fs.existsSync(p)) || cands[0];
}

async function cmdSkill(rest, d = {}) {
  const sub = (rest[0] || 'help').toLowerCase();
  const caps = d.skillCaps || SKILL_CAPS;
  const store = d.skillStore || new SkillStore(skillsDir());

  if (sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: rest[0] ? 0 : 0, lines: [
      `${C.B}stratos skill${C.x} ${C.d}— SKILL.md portability (agentskills.io / clawhub compatible)${C.x}`,
      `  ${C.g}import${C.x} <file.md>   Ingest a foreign SKILL.md ${C.d}(UNTRUSTED by default · deny-by-default caps)${C.x}`,
      `  ${C.g}export${C.x} <id>        Emit one of your skills as portable SKILL.md ${C.d}(+ did:atmos provenance)${C.x}`,
      `  ${C.g}list${C.x}              List imported skills + their honest trust label`,
      '',
      `  ${C.d}Imported skills are prose/instruction by default: stored + capability-gated, never auto-run.`,
      `  Net/fs/secrets/compute are NEVER granted to a foreign .md — that requires local re-sealing.${C.x}`,
    ] };
  }

  if (sub === 'list') {
    try { assertStepAllowed(caps, { action: 'skill.read' }); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    let items;
    try { items = store.list(); } catch (e) { return { code: 1, lines: [`${C.r}store error: ${e.message}${C.x}`] }; }
    if (!items.length) {
      return { code: 0, lines: [
        `${C.B}Imported skills${C.x} ${C.d}— none yet${C.x}`,
        `${C.d}Import one with: ${C.x}${C.g}stratos skill import <file.md>${C.x}`,
      ] };
    }
    const lines = [`${C.B}Imported skills${C.x} ${C.d}(${items.length})${C.x}`];
    for (const it of items) {
      const trust = it.sealed ? `${C.g}sealed-locally${C.x}` : `${C.y}untrusted${C.x}`;
      lines.push(`  ${C.b}${it.id}${C.x}  ${trust} ${C.d}· ${it.kind}${C.x}`);
      if (it.description) lines.push(`    ${C.d}${String(it.description).slice(0, 80)}${C.x}`);
    }
    return { code: 0, lines };
  }

  if (sub === 'import') {
    try { assertStepAllowed(caps, { action: 'skill.import' }); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    const file = rest[1];
    if (!file) return { code: 1, lines: [`${C.r}usage: stratos skill import <file.md>${C.x}`] };
    let text;
    try { text = fs.readFileSync(path.resolve(file), 'utf8'); }
    catch (e) { return { code: 1, lines: [`${C.r}cannot read ${file}: ${e.message}${C.x}`] }; }
    let rec;
    try { rec = await importSkillMd(text, { store, source: d.skillSource || `file:${path.basename(file)}` }); }
    catch (e) { return { code: 1, lines: [`${C.r}import rejected: ${e.message}${C.x}`] }; }
    const lines = [
      `${C.g}✓ imported${C.x} ${C.b}${rec.name}${C.x}  ${C.d}→ ${rec.id}${C.x}`,
      `  ${C.d}trust    ${C.x}${rec.sealed ? C.g + 'sealed-locally' + C.x : C.y + 'UNTRUSTED' + C.x} ${C.d}(${rec.kind})${C.x}`,
      `  ${C.d}granted  ${C.x}${rec.grantedCapabilities.length ? rec.grantedCapabilities.join(', ') : C.d + 'none — inert instruction skill' + C.x}`,
    ];
    if (rec.refusedCapabilities.length) {
      lines.push(`  ${C.y}refused  ${C.x}${rec.refusedCapabilities.join(', ')} ${C.d}(deny-by-default: a foreign .md can't grant these)${C.x}`);
    }
    if (rec.provenance?.claimedAuthor) {
      lines.push(`  ${C.d}author   ${C.x}${rec.provenance.claimedAuthor} ${C.y}(claimed, unverified)${C.x}`);
    }
    return { code: 0, lines };
  }

  if (sub === 'export') {
    try { assertStepAllowed(caps, { action: 'skill.read' }); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    const id = rest[1];
    if (!id) return { code: 1, lines: [`${C.r}usage: stratos skill export <id>${C.x}`] };
    let md;
    try { md = exportSkillMd(id, { store, originDid: d.originDid }); }
    catch (e) { return { code: 1, lines: [`${C.r}export failed: ${e.message}${C.x}`] }; }
    // Emit the raw SKILL.md to stdout so it can be piped/redirected to a file — portable by design.
    return { code: 0, lines: md.split('\n') };
  }

  return { code: 1, lines: [`${C.r}Unknown skill subcommand: ${sub}${C.x}`, `${C.d}Try: import · export · list${C.x}`] };
}

// `stratos egress` — the POLICY-AS-CODE EGRESS FIREWALL surface (anti-exfiltration made auditable).
//   stratos egress                      print the active policy + effective posture (default-deny)
//   stratos egress check <host> [m] [p] test a request → ALLOW/DENY + why (composes with skill caps)
// Reading/checking the egress policy is itself a capability — declared minimally and gated deny-by-
// default through the SAME capability-gate the skill runtime uses. `egress.read` is all it needs:
// it touches the local policy file only — no network, no secrets, no extra fs.
const EGRESS_CAPS = parseCapabilities({ capabilities: { actions: ['egress.read'] } });

function egressPolicyPath(arg) {
  if (arg) return path.resolve(arg);
  if (process.env.STRATOS_EGRESS_POLICY) return process.env.STRATOS_EGRESS_POLICY;
  const base = process.env.STRATOS_PROFILE_DIR || path.join(_ROOT, '.stratos-profile');
  const cands = [path.join(base, 'egress-policy.json'), path.join(_ROOT, 'config', 'egress-policy.json')];
  return cands.find((p) => fs.existsSync(p)) || cands[0];
}

function cmdEgress(rest, d = {}) {
  const sub = (rest[0] || '').toLowerCase();

  if (sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: 0, lines: [
      `${C.B}stratos egress${C.x} ${C.d}— the policy-as-code egress firewall (default-DENY, fail-closed)${C.x}`,
      `  ${C.g}stratos egress${C.x}                       Print the active policy + effective posture`,
      `  ${C.g}stratos egress check <host> [m] [path]${C.x}  Test a request → ALLOW / DENY + why`,
      '',
      `  ${C.d}Effective allow = (this host policy) ∩ (a skill's sealed net caps). A skill reaches a host`,
      `  only if it is in BOTH. Nothing leaves the box unless an allow-rule permits it. Hot-reloaded.${C.x}`,
    ] };
  }

  // Capability gate: deny-by-default (a test/caller can inject denied caps to prove enforcement).
  const caps = d.egressCaps || EGRESS_CAPS;
  try { assertStepAllowed(caps, { action: 'egress.read' }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  const policyPath = d.egressPolicyPath || egressPolicyPath();
  const ep = d.egressPolicy || new EgressPolicy({ path: policyPath });
  const policy = ep.current();

  if (sub === 'check') {
    const host = rest[1];
    if (!host) return { code: 1, lines: [`${C.r}usage: stratos egress check <host> [method] [path]${C.x}`] };
    const method = rest[2] && !rest[2].startsWith('/') ? rest[2] : null;
    const pth = rest.find((a, i) => i >= 2 && a.startsWith('/')) || null;
    // Compose with skill caps if the caller supplies a --caps host list (else policy-only check).
    const ci = rest.indexOf('--caps');
    const capNet = ci >= 0 ? rest.slice(ci + 1).filter((a) => !a.startsWith('-')) : null;
    const res = checkEgress({ host, method, path: pth }, policy, capNet ? { caps: { net: capNet } } : {});
    const verdict = res.allowed ? `${C.g}✓ ALLOW${C.x}` : `${C.r}✗ DENY${C.x}`;
    return { code: res.allowed ? 0 : 1, lines: [
      `${C.B}stratos egress check${C.x} ${C.d}${host}${method ? ' ' + method : ''}${pth || ''}${C.x}`,
      `  ${verdict}  ${res.allowed ? `${C.d}matched an allow-rule${res.rule?.suffix ? ` (suffix .${res.rule.host})` : ''}${C.x}`
        : `${C.d}${res.reason}${res.layer ? ` [${res.layer}]` : ''}${C.x}`}`,
      capNet ? `  ${C.d}composed with caps.net = [${capNet.join(', ')}] (intersection)${C.x}` : `  ${C.d}policy-only (pass --caps <hosts…> to compose with skill caps)${C.x}`,
    ] };
  }

  // default: print the active policy + posture.
  const lines = [
    `${C.B}stratos egress${C.x} ${C.d}— policy-as-code egress firewall (anti-exfiltration)${C.x}`,
    `  ${C.d}policy   ${C.x}${policyPath}`,
    `  ${C.d}default  ${C.x}${C.r}DENY${C.x} ${C.d}(fail-closed)${C.x}`,
  ];
  if (ep.lastError) {
    lines.push(`  ${C.y}! load issue: ${ep.lastError} — DENYING ALL (fail-closed)${C.x}`);
  }
  if (policy._malformed) {
    lines.push(`  ${C.y}! ${policy._malformed} malformed rule(s) dropped (not trusted)${C.x}`);
  }
  lines.push('', `${C.B}Allow-rules${C.x} ${C.d}(${policy.allow.length})${C.x}`);
  if (!policy.allow.length) {
    lines.push(`  ${C.y}none — total egress lockdown${C.x} ${C.d}(nothing leaves the box)${C.x}`);
  } else {
    for (const r of policy.allow) {
      const h = r.suffix ? `.${r.host} ${C.d}(suffix)${C.x}` : r.host;
      const m = r.methods ? ` ${C.d}methods=[${r.methods.join(',')}]${C.x}` : '';
      const p = r.paths ? ` ${C.d}paths=[${r.paths.join(',')}]${C.x}` : '';
      lines.push(`  ${C.g}allow${C.x} ${C.b}${h}${C.x}${m}${p}`);
    }
  }
  lines.push('', `${C.d}Effective allow for a skill = these rules ∩ the skill's sealed net caps (host must be in BOTH).${C.x}`);
  return { code: 0, lines };
}

function cmdService(rest) {
  if ((rest[0] || 'status') === 'install') return { code: 0, lines: [], action: 'service-install' };
  return {
    code: 0,
    lines: [
      `${C.b}stratos service${C.x} — optional background service (no root)`,
      `  ${C.g}stratos service install${C.x}   write a user service unit + print the enable command`,
      `  ${C.d}Linux: a systemd --user unit at ~/.config/systemd/user/stratos.service${C.x}`,
      `  ${C.d}macOS/other: guidance printed; we never enable or start it for you.${C.x}`,
    ],
  };
}

// `stratos content generate` — the GENERIC content engine. It reads a creator PROFILE + ANGLE BANK from a
// PRIVATE content dir OUTSIDE the repo (CONTENT_DIR, default ~/founder-content), generates structured pieces
// via the sovereign-default local gateway (configurable CONTENT_MODEL/CONTENT_ENDPOINT for a stronger model),
// self-grows by mining the live build log (git commit subjects), marks angles used, and writes a dated batch.
// Capability-gated deny-by-default like demo/receipt: it reads local files + makes a loopback model call, so
// `content.generate` is the single action it declares. HONEST: no fabricated numbers; a down model degrades.
const CONTENT_CAPS = parseCapabilities({ capabilities: { actions: ['content.generate'] } });

function defaultContentDir() {
  return process.env.CONTENT_DIR || path.join(os.homedir(), 'founder-content');
}

// Default build-log provider: recent commit subjects from the repo, so "everything we build is content".
// Injected in tests; failures are non-fatal (the engine just gets no fresh angles this run).
function defaultBuildLog() {
  try {
    const out = execFileSync('git', ['log', '-n', '25', '--pretty=%s'], { cwd: _ROOT, encoding: 'utf8', timeout: 5000 });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

async function cmdContent(rest, d = {}) {
  const sub = rest[0];
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: sub ? 0 : 1, lines: [
      `${C.B}stratos content${C.x} ${C.d}— the reusable content engine (private profile in, dated batch out)${C.x}`,
      `  ${C.g}stratos content generate${C.x} ${C.d}[--lane personal|labs|both] [--platform x|linkedin|short-video|carousel|all]${C.x}`,
      `                           ${C.d}[--tone raw|cinematic|hybrid|all] [--n N]${C.x}`,
      '',
      `  ${C.d}Reads your PRIVATE profile + angle bank from ${C.x}${defaultContentDir()}${C.d} (CONTENT_DIR to change).${C.x}`,
      `  ${C.d}Generates via your LOCAL sovereign gateway by default; set ${C.x}CONTENT_MODEL${C.d}/${C.x}CONTENT_ENDPOINT${C.d} for a`,
      `  ${C.d}stronger model. Picks UNUSED angles, marks them used (re-run → fresh), and self-grows from the build log.${C.x}`,
      `  ${C.d}Honest: output tracks the model; never ships fabricated metrics; a down model degrades, never fakes.${C.x}`,
    ] };
  }
  if (sub !== 'generate') return { code: 1, lines: [`${C.r}usage: stratos content generate [--lane …] [--platform …] [--tone …] [--n N]${C.x}`] };

  // Capability gate: deny-by-default (a test/caller can inject denied caps to prove enforcement).
  const caps = d.contentCaps || CONTENT_CAPS;
  try { assertStepAllowed(caps, { action: 'content.generate' }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  const flagVal = (name, def) => { const i = rest.indexOf(name); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : def; };
  const lane = flagVal('--lane', 'both');
  const platArg = flagVal('--platform', 'x');
  const toneArg = flagVal('--tone', 'raw');
  const n = Math.max(1, parseInt(flagVal('--n', '3'), 10) || 3);
  const platforms = platArg === 'all' ? [...PLATFORMS] : [platArg];
  const tones = toneArg === 'all' ? [...TONES] : [toneArg];

  const contentDir = d.contentDir || defaultContentDir();
  if (!fs.existsSync(path.join(contentDir, 'profile.md'))) {
    return { code: 1, lines: [
      `${C.B}stratos content${C.x}`,
      `${C.r}✗ no profile at ${path.join(contentDir, 'profile.md')}${C.x}`,
      `  ${C.d}Create your private profile + angles.json there first (or set CONTENT_DIR). Nothing is committed.${C.x}`,
    ] };
  }

  const modelConfig = d.contentModelConfig || resolveModelConfig();
  const commitSubjects = d.buildLog ? d.buildLog() : defaultBuildLog();
  let res;
  try {
    res = await generateBatch({ contentDir, modelConfig, lane, platforms, tones, n, fetchImpl: d.contentFetch, commitSubjects, now: d.contentNow });
  } catch (e) { return { code: 1, lines: [`${C.r}content engine error: ${e.message}${C.x}`] }; }

  if (res.degraded) {
    // Honest about WHY: an unreachable model vs a reachable model that returned unusable output are
    // different failures with different fixes. Either way nothing was fabricated and no angle was consumed.
    const unreachable = res.skipped.some((s) => /cannot reach|timed out|no fetch/.test(s.reason));
    const badOutput = res.skipped.some((s) => /not valid JSON|no content|not JSON/.test(s.reason));
    const why = unreachable
      ? 'the content model is unreachable.'
      : badOutput ? 'the model replied but produced no usable, schema-valid copy.' : 'no pieces produced.';
    const fix = unreachable
      ? 'start your local daemon (stratos start) or point CONTENT_ENDPOINT at a model.'
      : 'this local model is too weak for clean structured copy — point CONTENT_MODEL/CONTENT_ENDPOINT at a stronger model for finished output.';
    return { code: 1, lines: [
      `${C.B}stratos content generate${C.x} ${C.d}— ${lane} · ${platforms.join(',')} · ${tones.join(',')}${C.x}`,
      `${C.r}✗ no pieces produced — ${why}${C.x}`,
      ...res.skipped.slice(0, 3).map((s) => `  ${C.d}${s.angle} ${s.platform}/${s.tone}: ${s.reason}${C.x}`),
      `  ${C.y}→ ${fix}${C.x}`,
      `  ${C.d}Nothing was fabricated. Angles were NOT consumed — re-run to retry.${C.x}`,
    ] };
  }

  return { code: 0, lines: [
    `${C.B}━━ stratos content generate ━━${C.x}`,
    `  ${C.d}lane ${C.x}${lane}  ${C.d}platforms ${C.x}${platforms.join(', ')}  ${C.d}tones ${C.x}${tones.join(', ')}`,
    `  ${C.d}model ${C.x}${res.model} ${C.d}@ ${res.endpoint}${C.x}`,
    `  ${C.g}✓ ${res.produced} piece(s)${C.x} ${C.d}from ${res.angleIds.length} angle(s) [${res.angleIds.join(', ')}]${C.x}`,
    res.freshAngles ? `  ${C.b}+${res.freshAngles} fresh angle(s) mined from the build log${C.x}` : `  ${C.d}no new build-log angles this run${C.x}`,
    res.skipped.length ? `  ${C.y}${res.skipped.length} skipped (honest, not faked)${C.x}` : '',
    `  ${C.g}→ ${res.batchPath}${C.x}`,
    `  ${C.d}Private — under your content dir, never committed. Re-run for fresh pieces (no repeats).${C.x}`,
  ].filter(Boolean) };
}

// ---- operating core (Increment 1): workspace · task · capture · trace -------------------------
// The files-first operational unit + capture + trace. Reading/writing the local operational map is a
// capability — declared minimally and gated deny-by-default through the SAME capability-gate the skill
// runtime uses. workspace/task scaffolding is `workspace.write`; capture is `context.capture`; the
// trace exerciser is `trace.write`. All touch only the local stratos state dir — no network, no secrets.
const WORKSPACE_CAPS = parseCapabilities({ capabilities: { actions: ['workspace.write', 'context.capture', 'trace.write', 'eval.write', 'improve.write'] } });

function fmtTree(node, prefix = '', isLast = true, lines = []) {
  const branch = prefix ? (isLast ? '└─ ' : '├─ ') : '';
  const tag = node.type === 'task' ? `${C.g} [task]${C.x}` : node.type === 'workspace' ? `${C.d} [workspace]${C.x}` : '';
  lines.push(`${C.d}${prefix}${C.x}${branch}${C.b}${node.name}${C.x}${tag}`);
  const next = prefix + (isLast ? '   ' : `${C.d}│${C.x}  `);
  node.children.forEach((c, i) => fmtTree(c, next, i === node.children.length - 1, lines));
  return lines;
}

/**
 * `stratos workspace create <name> | tree <name>` — the files-first operational unit. Capability-gated
 * deny-by-default. Creates a Workspace (with its session log) or prints the Workspace>…>Task tree.
 */
function cmdWorkspace(rest, d = {}) {
  const sub = (rest[0] || 'help').toLowerCase();
  const wt = d.workspaceTree || workspaceTree;
  const root = d.workspacesRoot; // undefined in normal use → module default

  if (sub === 'help' || sub === '-h' || sub === '--help') {
    return { code: 0, lines: [
      `${C.B}stratos workspace${C.x} ${C.d}— the files-first operational unit (Workspace > Project > Workflow > Task > Subtask)${C.x}`,
      `  ${C.g}create${C.x} <name>   Create (or resolve) a workspace`,
      `  ${C.g}tree${C.x} <name>     Print the workspace tree (tasks scaffold instructions.md · tools.json · data/ · memory/ · outputs/ · traces/ · evals/ · skills/)`,
      '',
      `  ${C.d}The durable asset is your living operational map — files on disk, framework-agnostic.${C.x}`,
    ] };
  }

  const caps = d.workspaceCaps || WORKSPACE_CAPS;

  if (sub === 'create') {
    try { assertStepAllowed(caps, { action: 'workspace.write' }); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    const name = rest[1];
    if (!name) return { code: 1, lines: [`${C.r}usage: stratos workspace create <name>${C.x}`] };
    let r;
    try { r = wt.createWorkspace(name, root ? { root } : {}); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    return { code: 0, lines: [
      `${r.created ? C.g + '✓ created workspace' : C.d + '• workspace exists'}${C.x} ${C.b}${r.workspace}${C.x}`,
      `  ${C.d}${r.path}${C.x}`,
    ] };
  }

  if (sub === 'tree') {
    try { assertStepAllowed(caps, { action: 'workspace.write' }); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    const name = rest[1];
    if (!name) {
      // No name → list workspaces.
      let list;
      try { list = wt.listWorkspaces(root ? { root } : {}); }
      catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
      if (!list.length) return { code: 0, lines: [`${C.y}no workspaces yet${C.x} ${C.d}— create one: stratos workspace create <name>${C.x}`] };
      return { code: 0, lines: [`${C.B}Workspaces${C.x} ${C.d}(${list.length})${C.x}`, ...list.map((w) => `  ${C.b}${w}${C.x}`)] };
    }
    let tree;
    try { tree = wt.listTree(name, root ? { root } : {}); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    if (!tree) return { code: 1, lines: [`${C.r}no workspace "${name}"${C.x} ${C.d}— create it: stratos workspace create ${name}${C.x}`] };
    return { code: 0, lines: [`${C.B}stratos workspace tree${C.x}`, ...fmtTree(tree)] };
  }

  return { code: 1, lines: [`${C.r}Unknown workspace subcommand: ${sub}${C.x}`, `${C.d}Try: create · tree · help${C.x}`] };
}

/**
 * `stratos task create <ws/proj/wf/task>` — scaffold a Task (the eight canonical entries) anywhere in
 * the tree, creating any missing parents. Capability-gated deny-by-default.
 */
function cmdTask(rest, d = {}) {
  const sub = (rest[0] || 'help').toLowerCase();
  const wt = d.workspaceTree || workspaceTree;
  const root = d.workspacesRoot;

  if (sub === 'help' || sub === '-h' || sub === '--help' || !sub) {
    return { code: 0, lines: [
      `${C.B}stratos task${C.x} ${C.d}— the unit of work (scaffolds the 8 canonical entries)${C.x}`,
      `  ${C.g}create${C.x} <ws/proj/wf/task>   Create a task (and any missing parents)`,
      '',
      `  ${C.d}A task folder holds: instructions.md · tools.json · data/ · memory/ · outputs/ · traces/ · evals/ · skills/${C.x}`,
    ] };
  }

  if (sub === 'create') {
    const caps = d.workspaceCaps || WORKSPACE_CAPS;
    try { assertStepAllowed(caps, { action: 'workspace.write' }); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    const p = rest[1];
    if (!p) return { code: 1, lines: [`${C.r}usage: stratos task create <workspace/project/workflow/task>${C.x}`] };
    const parts = p.split('/').map((s) => s.trim()).filter(Boolean);
    if (parts.length !== 4) return { code: 1, lines: [`${C.r}task path must be "workspace/project/workflow/task" (4 segments)${C.x}`] };
    let r;
    try { r = wt.createTask(parts[0], parts[1], parts[2], parts[3], root ? { root } : {}); }
    catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }
    return { code: 0, lines: [
      `${r.created ? C.g + '✓ created task' : C.d + '• task exists'}${C.x} ${C.b}${parts.join(' / ')}${C.x}`,
      `  ${C.d}${r.path}${C.x}`,
      `  ${C.g}scaffolded${C.x} ${C.d}${r.scaffolded.join(' · ')}${C.x}`,
    ] };
  }

  return { code: 1, lines: [`${C.r}Unknown task subcommand: ${sub}${C.x}`, `${C.d}Try: create · help${C.x}`] };
}

/**
 * `stratos capture <ws/proj/wf/task> "<text>"` — minimal CAPTURE exerciser: classify + persist a
 * context record into the task's data/+memory/ and append the workspace session log. Deterministic
 * (no LLM/network). Capability-gated deny-by-default.
 */
function cmdCapture(rest, d = {}) {
  const cap = d.captureFn || captureEvent;
  const root = d.workspacesRoot;
  if (!rest.length || rest[0] === 'help' || rest[0] === '-h' || rest[0] === '--help') {
    return { code: rest.length ? 0 : 1, lines: [
      `${C.B}stratos capture${C.x} ${C.d}— capture an event into the operational map (Capture → Classify → Store)${C.x}`,
      `  ${C.g}stratos capture <ws/proj/wf/task> "<text>"${C.x} ${C.d}[--source chat|file|repo|terminal|browser|api|mcp] [--intent "<intent>"]${C.x}`,
      '',
      `  ${C.d}Deterministic: rule-based classify, no LLM/network. Raw → data/, record → memory/, line → session.log.${C.x}`,
    ] };
  }
  const caps = d.workspaceCaps || WORKSPACE_CAPS;
  try { assertStepAllowed(caps, { action: 'context.capture' }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  const taskPath = rest[0];
  const si = rest.indexOf('--source');
  const ii = rest.indexOf('--intent');
  const source = si >= 0 ? rest[si + 1] : 'terminal';
  const userIntent = ii >= 0 ? rest[ii + 1] : '';
  const text = rest.slice(1).filter((a, i) => {
    const idx = i + 1;
    if (a.startsWith('--')) return false;
    if (si >= 0 && idx === si + 1) return false;
    if (ii >= 0 && idx === ii + 1) return false;
    return true;
  }).join(' ').trim();
  if (!text) return { code: 1, lines: [`${C.r}usage: stratos capture <ws/proj/wf/task> "<text>"${C.x}`] };

  let rec;
  try { rec = cap({ task: taskPath, source, raw: text, user_intent: userIntent }, root ? { root } : {}); }
  catch (e) { return { code: 1, lines: [`${C.r}capture failed: ${e.message}${C.x}`] }; }
  return { code: 0, lines: [
    `${C.g}✓ captured${C.x} ${C.b}${rec.id}${C.x} ${C.d}· ${rec.source}/${rec.classification.intent}${C.x}`,
    `  ${C.d}raw    ${C.x}${rec._paths.raw}`,
    `  ${C.d}record ${C.x}${rec._paths.record}`,
    `  ${C.d}log    ${C.x}${rec._paths.sessionLog}`,
  ] };
}

/**
 * `stratos trace <ws/proj/wf/task>` — minimal TRACE exerciser: start → a couple of steps → end,
 * minting a signed capability-receipt as the tamper-evident spine and verifying it with the public
 * key. Uses an EPHEMERAL node identity (deterministic in tests via injected keyPair). Capability-gated.
 */
function cmdTrace(rest, d = {}) {
  const root = d.workspacesRoot;
  if (!rest.length || rest[0] === 'help' || rest[0] === '-h' || rest[0] === '--help') {
    return { code: rest.length ? 0 : 1, lines: [
      `${C.B}stratos trace${C.x} ${C.d}— exercise the trace engine (start → steps → end, with a signed receipt spine)${C.x}`,
      `  ${C.g}stratos trace <ws/proj/wf/task>${C.x}`,
      '',
      `  ${C.d}Writes traces/{task-id}.json + a PQC-signed, hash-chained capability-receipt (the tamper-evident spine).${C.x}`,
    ] };
  }
  const caps = d.workspaceCaps || WORKSPACE_CAPS;
  try { assertStepAllowed(caps, { action: 'trace.write' }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  const taskPath = rest[0];
  const start = d.startTrace || startTrace;
  const step = d.recordStep || recordStep;
  const end = d.endTrace || endTrace;
  const keyPair = d.traceKeyPair || generateHybridKeyPair();
  const nodeId = originId(keyPair.publicKey);

  let h, res;
  try {
    h = start({ task: taskPath, model_used: d.traceModel || 'gemma2:2b', model_class: 'openweight', root, now: d.traceNow });
    step(h, { kind: 'plan', summary: 'plan the task', who: nodeId, model: 'gemma2:2b', permission: 'plan' });
    step(h, { kind: 'io', summary: 'write an output', who: nodeId, model: 'gemma2:2b', permission: 'fs.write', input: taskPath, output: 'done', cost_units: 1 });
    const log = d.traceReceiptLog || new (d.ReceiptLog || ReceiptLog)({
      signer: makeReceiptSigner(keyPair.privateKey),
      verifier: makeReceiptVerifier(keyPair.publicKey),
      nodeId, now: d.traceNow,
    });
    res = end(h, { result: 'ok', outputs: ['done'], receiptLog: log, actor_id: nodeId, now: d.traceNow });
    const v = res.receipt ? log.verify({ requireSig: true }) : { ok: null };
    return { code: 0, lines: [
      `${C.g}✓ trace written${C.x} ${C.d}${res.file}${C.x}`,
      `  ${C.d}steps   ${C.x}${res.trace.steps.length} · result ${res.trace.result}`,
      `  ${C.d}node    ${C.x}${didShort(nodeId)}`,
      res.receipt
        ? `  ${C.d}receipt ${C.x}${shortHash(res.receipt.hash)} ${v.ok === true ? C.g + '✓ verified (public key only)' + C.x : C.r + '✗ verify failed' + C.x}`
        : `  ${C.y}no receipt minted${C.x}`,
    ] };
  } catch (e) { return { code: 1, lines: [`${C.r}trace failed: ${e.message}${C.x}`] }; }
}

/**
 * `stratos eval <ws/proj/wf/task>` — score the task's trace with the deterministic default rubric and
 * write evals/{task-id}.md + .json, linking the eval back into the trace. The trace-integrity criterion
 * re-runs the receipt verify path (verify-as-a-criterion). Capability-gated deny-by-default. Reads the
 * trace from traces/{task-id}.json by default; a receipt verifier is loaded from the node public key if
 * present (else the integrity criterion honestly reports "unverified"). DETERMINISTIC — no LLM/network.
 */
function cmdEval(rest, d = {}) {
  const root = d.workspacesRoot;
  if (!rest.length || rest[0] === 'help' || rest[0] === '-h' || rest[0] === '--help') {
    return { code: rest.length ? 0 : 1, lines: [
      `${C.B}stratos eval${C.x} ${C.d}— score a trace against the deterministic rubric (the trace→eval→lesson loop)${C.x}`,
      `  ${C.g}stratos eval <ws/proj/wf/task>${C.x} ${C.d}[--budget <units>]${C.x}`,
      '',
      `  ${C.d}Writes evals/{task-id}.md + .json, links eval_path back into the trace. Default rubric:${C.x}`,
      `  ${C.d}result-ok · no-error-steps · outputs-present · cost-within-budget · trace-integrity (verify-as-a-criterion).${C.x}`,
      `  ${C.d}Each failed criterion emits a candidate lesson — the seam into self-improvement.${C.x}`,
    ] };
  }
  const caps = d.workspaceCaps || WORKSPACE_CAPS;
  try { assertStepAllowed(caps, { action: 'eval.write' }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  const taskPath = rest[0];
  const bi = rest.indexOf('--budget');
  const budget = bi >= 0 && /^\d+(\.\d+)?$/.test(rest[bi + 1] || '') ? Number(rest[bi + 1]) : undefined;

  const evalFn = d.evaluate || evaluateTrace;
  const read = d.readTrace || readTrace;

  // Resolve the trace file for this task and read it (deny-by-default: a missing trace is an honest error).
  let wt = d.workspaceTree || workspaceTree;
  let t, trace;
  try {
    t = wt.resolveTask(taskPath, root ? { root } : {});
    const taskId = t.subtask || t.task;
    const traceFile = path.join(t.dirs.traces, `${taskId}.json`);
    if (!fs.existsSync(traceFile)) {
      return { code: 1, lines: [
        `${C.r}no trace at ${traceFile}${C.x}`,
        `${C.d}run ${C.x}${C.g}stratos trace ${taskPath}${C.x}${C.d} first — eval scores a finished trace.${C.x}`,
      ] };
    }
    trace = read(traceFile);
  } catch (e) { return { code: 1, lines: [`${C.r}eval failed: ${e.message}${C.x}`] }; }

  // Load the node's PUBLIC key bundle to verify the receipt chain (verify-as-a-criterion). If absent,
  // the trace-integrity criterion honestly reports "unverified" rather than fabricating a pass.
  const pub = d.evalPublicKeyBundle || loadNodePublicBundle(nodeKeysPath());
  const verifier = pub ? makeReceiptVerifier(pub) : undefined;
  // If the trace's receipt lives in a JSONL log on disk, hand the FULL history (rotation segments +
  // active file, genesis-rooted) so the REAL chain is replayed — a receipt that rotation has moved
  // into a *.segment is still found and verified. receipt_path records the log BASE path; segments
  // derive from it.
  let receiptLog;
  const rp = trace.receipt_path;
  if (verifier && rp && !String(rp).startsWith('(in-memory)')) {
    try {
      const entries = ReceiptLog.loadChainEntries(String(rp));
      if (entries.length) { receiptLog = new ReceiptLog({ verifier }); receiptLog.chain = entries; }
    } catch { receiptLog = undefined; }
  }

  let out;
  try {
    out = evalFn({ taskPath, trace, root, budget, verifier, receiptLog, now: d.evalNow });
  } catch (e) { return { code: 1, lines: [`${C.r}eval failed: ${e.message}${C.x}`] }; }

  const r = out.record;
  const lines = [
    `${r.passed ? C.g + '✓ eval PASS' : C.y + '✗ eval FAIL'}${C.x} ${C.b}${r.task_id}${C.x} ${C.d}· ${r.score}/${r.max_score} (${Math.round(r.normalized * 100)}%)${C.x}`,
    `  ${C.d}scorecard ${C.x}${out.mdFile}`,
    `  ${C.d}record    ${C.x}${out.jsonFile}`,
  ];
  for (const c of r.criteria) {
    lines.push(`  ${c.pass ? C.g + '✓' : C.r + '✗'}${C.x} ${String(c.id).padEnd(20)} ${C.d}${c.detail}${C.x}`);
  }
  if (r.lessons.length) {
    lines.push('', `${C.B}Candidate lessons${C.x} ${C.d}(seam into self-improvement)${C.x}`);
    for (const l of r.lessons) lines.push(`  ${C.y}• ${l.criterion}${C.x} ${C.d}(${l.severity}) — ${l.suggested_instruction}${C.x}`);
  }
  return { code: 0, lines };
}

/**
 * `stratos improve <ws/proj/wf/task>` — the COMPRESSION step closing the loop: read the task's trace +
 * eval and produce a lesson + an idempotent instruction update, plus a reusable SKILL scaffold when the
 * eval PASSED. Capability-gated deny-by-default (improve.write). Reads traces/{id}.json + evals/{id}.json
 * from the task folder by default. DETERMINISTIC — no LLM/network (the distiller hook is OFF by default).
 */
function cmdImprove(rest, d = {}) {
  const root = d.workspacesRoot;
  if (!rest.length || rest[0] === 'help' || rest[0] === '-h' || rest[0] === '--help') {
    return { code: rest.length ? 0 : 1, lines: [
      `${C.B}stratos improve${C.x} ${C.d}— compress an eval into reusable improvement (trace → eval → lesson → instruction → skill)${C.x}`,
      `  ${C.g}stratos improve <ws/proj/wf/task>${C.x}`,
      '',
      `  ${C.d}On a FAILED eval: writes a lesson + appends its suggested instruction to instructions.md (idempotent).${C.x}`,
      `  ${C.d}On a PASSED eval: also scaffolds a reusable skill (skill.md + examples/ + tools.json) in the SKILL.md format.${C.x}`,
      `  ${C.d}Deterministic + rule-based; the LLM distiller is an off-by-default hook. Does NOT generate executable code.${C.x}`,
    ] };
  }
  const caps = d.workspaceCaps || WORKSPACE_CAPS;
  try { assertStepAllowed(caps, { action: 'improve.write' }); }
  catch (e) { return { code: 1, lines: [`${C.r}${e.message}${C.x}`] }; }

  const taskPath = rest[0];
  const improveFn = d.improve || improveTask;
  const read = d.readTrace || readTrace;
  const readEv = d.readEval || readEvalRecord;
  const wt = d.workspaceTree || workspaceTree;

  let trace, evalRecord;
  try {
    const t = wt.resolveTask(taskPath, root ? { root } : {});
    const taskId = t.subtask || t.task;
    const traceFile = path.join(t.dirs.traces, `${taskId}.json`);
    const evalFile = path.join(t.dirs.evals, `${taskId}.json`);
    if (!fs.existsSync(traceFile)) {
      return { code: 1, lines: [`${C.r}no trace at ${traceFile}${C.x}`, `${C.d}run ${C.x}${C.g}stratos trace ${taskPath}${C.x}${C.d} then ${C.x}${C.g}stratos eval ${taskPath}${C.x}${C.d} first.${C.x}`] };
    }
    if (!fs.existsSync(evalFile)) {
      return { code: 1, lines: [`${C.r}no eval at ${evalFile}${C.x}`, `${C.d}run ${C.x}${C.g}stratos eval ${taskPath}${C.x}${C.d} first — improve compresses a scored trace.${C.x}`] };
    }
    trace = read(traceFile);
    evalRecord = readEv(evalFile);
  } catch (e) { return { code: 1, lines: [`${C.r}improve failed: ${e.message}${C.x}`] }; }

  let out;
  try {
    out = improveFn({ taskPath, trace, evalRecord, root, now: d.improveNow });
  } catch (e) { return { code: 1, lines: [`${C.r}improve failed: ${e.message}${C.x}`] }; }

  const lines = [
    `${out.passed ? C.g + '✓ improve (PASS)' : C.y + '✓ improve (FAIL)'}${C.x} ${C.b}${taskPath}${C.x}`,
  ];
  if (out.lesson) {
    lines.push(`  ${C.d}lesson    ${C.x}${out.lesson.file} ${C.d}(${out.lesson.record.severity})${C.x}`);
  } else {
    lines.push(`  ${C.d}lesson    ${C.x}${C.d}none — the eval passed with no failed criteria${C.x}`);
  }
  if (out.instruction) {
    lines.push(out.instruction.applied
      ? `  ${C.g}✓ instruction applied${C.x} ${C.d}${out.instruction.instructionsFile}${C.x}`
      : `  ${C.d}instruction already applied (idempotent — no duplicate)${C.x}`);
  }
  if (out.skill) {
    lines.push(`  ${C.g}✓ reusable skill scaffolded${C.x} ${C.d}${out.skill.skillMdFile}${C.x}`);
    lines.push(`  ${C.d}skill id  ${C.x}${out.skill.id} ${C.d}(loads via SkillStore)${C.x}`);
  } else {
    lines.push(`  ${C.d}skill     ${C.x}${C.d}not scaffolded — only a passing run is promoted to a skill${C.x}`);
  }
  return { code: 0, lines };
}

export async function run(argv = [], deps = {}) {
  const d = {
    config: deps.config || realConfig,
    connectors: deps.connectors || realConnectors,
    probes: deps.probes || realProbes,
    port: deps.port || process.env.PORT || 4099,
    ollamaHost: deps.ollamaHost || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    version: deps.version || '0.0.0',
    // Injectable memory surface (tests pass stubs; production falls back to the real FTS5 module +
    // declared MEMORY_CAPS inside cmdMemory). Pass-through only — undefined in normal use.
    memory: deps.memory,
    memoryCaps: deps.memoryCaps,
    summarize: deps.summarize,
    // Injectable dialectic user-model surface (tests pass a stub store + caps; production uses the real
    // user-model module + declared USER_CAPS inside cmdUser). Pass-through only — undefined in normal use.
    userModel: deps.userModel,
    userCaps: deps.userCaps,
    // Injectable sensory surface (tests pass a stub; production uses the real voice-engine).
    voice: deps.voice,
    voiceCaps: deps.voiceCaps,
    ollamaHost: deps.ollamaHost,
    sayOutPath: deps.sayOutPath,
    // Injectable SKILL.md portability surface (tests pass a stub store + caps; production uses the
    // file-backed SkillStore + declared SKILL_CAPS inside cmdSkill).
    skillStore: deps.skillStore,
    skillCaps: deps.skillCaps,
    skillSource: deps.skillSource,
    originDid: deps.originDid,
    // Injectable capability-receipt gate (tests inject denied caps to prove deny-by-default).
    receiptCaps: deps.receiptCaps,
    // Injectable egress-firewall surface (tests inject a policy/path + denied caps to prove the gate +
    // the default-deny posture; production uses the on-disk .stratos-profile/egress-policy.json).
    egressPolicy: deps.egressPolicy,
    egressPolicyPath: deps.egressPolicyPath,
    egressCaps: deps.egressCaps,
    // Injectable "$0 bill" demo surface (tests inject a mock gateway fetch + deterministic keypair +
    // denied caps; production uses global fetch, an ephemeral node identity, and DEMO_CAPS).
    demoFetch: deps.demoFetch,
    demoKeyPair: deps.demoKeyPair,
    demoCaps: deps.demoCaps,
    demoModel: deps.demoModel,
    // Injectable content-engine surface (tests inject a mock model fetch + build-log + clock + content dir +
    // denied caps; production uses global fetch, `git log`, the real clock, CONTENT_DIR, and CONTENT_CAPS).
    contentFetch: deps.contentFetch,
    contentDir: deps.contentDir,
    contentModelConfig: deps.contentModelConfig,
    contentCaps: deps.contentCaps,
    buildLog: deps.buildLog,
    contentNow: deps.contentNow,
    // Injectable sovereign-Composio surface (tests inject a stub toolkit loader + runner + denied caps;
    // production uses the MIT catalog loader + the real broker/vault/gate executor and TOOL_CAPS).
    composioToolkits: deps.composioToolkits,
    runToolAction: deps.runToolAction,
    composioDeps: deps.composioDeps,
    toolCaps: deps.toolCaps,
    // Injectable operating-core surface (Increment 1). Tests inject an isolated workspaces root +
    // denied caps + a deterministic keypair/clock; production uses the on-disk .stratos-profile state
    // dir, WORKSPACE_CAPS, and an ephemeral node identity. Pass-through only — undefined in normal use.
    workspaceTree: deps.workspaceTree,
    workspacesRoot: deps.workspacesRoot,
    workspaceCaps: deps.workspaceCaps,
    captureFn: deps.captureFn,
    startTrace: deps.startTrace,
    recordStep: deps.recordStep,
    endTrace: deps.endTrace,
    traceKeyPair: deps.traceKeyPair,
    traceReceiptLog: deps.traceReceiptLog,
    traceModel: deps.traceModel,
    traceNow: deps.traceNow,
    ReceiptLog: deps.ReceiptLog,
    // Injectable eval-engine surface (Increment 2). Tests inject the isolated root + denied caps + a
    // deterministic clock + (optionally) a public-key bundle / stub evaluate; production uses the
    // on-disk trace, the node public key for verify-as-a-criterion, WORKSPACE_CAPS, and the real engine.
    evaluate: deps.evaluate,
    readTrace: deps.readTrace,
    evalPublicKeyBundle: deps.evalPublicKeyBundle,
    evalNow: deps.evalNow,
    // Injectable self-improvement surface (Increment 3). Tests inject the isolated root + denied caps +
    // a deterministic clock + (optionally) a stub improve/readEval; production reads the on-disk trace +
    // eval, uses WORKSPACE_CAPS (improve.write), and the real engine. Pass-through only.
    improve: deps.improve,
    readEval: deps.readEval,
    improveNow: deps.improveNow,
  };
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'version': case '--version': case '-v': return { code: 0, lines: [d.version] };
    case 'help': case '--help': case '-h': case undefined: return { code: 0, lines: helpText() };
    case 'status': return cmdStatus(d);
    case 'doctor': return cmdDoctor(d);
    case 'models': return cmdModels(d);
    case 'bind': return cmdBind(rest, d);
    case 'owner': return cmdOwner(rest, d);
    case 'pair': return cmdPair(rest, d);
    case 'connectors': return cmdConnectors(d);
    case 'mesh': return cmdMesh(d);
    case 'icm': return cmdIcm(rest);
    case 'ledger': return cmdLedger(rest);
    case 'receipt': return cmdReceipt(rest, d);
    case 'id': return cmdId(rest);
    case 'route': return cmdRoute(rest);
    case 'demo': return cmdDemo(rest, d);
    case 'memory': return cmdMemory(rest, d);
    case 'user': return cmdUser(rest, d);
    case 'voice': return cmdVoice(rest, d);
    case 'skill': return cmdSkill(rest, d);
    case 'egress': return cmdEgress(rest, d);
    case 'content': return cmdContent(rest, d);
    case 'tool': return cmdTool(rest, d);
    case 'workspace': case 'ws': return cmdWorkspace(rest, d);
    case 'task': return cmdTask(rest, d);
    case 'capture': return cmdCapture(rest, d);
    case 'trace': return cmdTrace(rest, d);
    case 'eval': return cmdEval(rest, d);
    case 'improve': return cmdImprove(rest, d);
    case 'connect': return { code: 0, lines: [], action: 'connect' }; // interactive — handled by bin
    case 'channels': return { code: 0, lines: [], action: 'channels' }; // interactive — handled by bin
    case 'service': return cmdService(rest);
    case 'init': return { code: 0, lines: [], action: 'init' };   // interactive — handled by bin
    case 'start': return { code: 0, lines: [], action: 'start' }; // daemon — handled by bin
    default: return { code: 1, lines: [`${C.r}Unknown command: ${cmd}${C.x}`, '', ...helpText()] };
  }
}
