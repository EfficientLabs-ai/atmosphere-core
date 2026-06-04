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
import path from 'node:path';
import * as realConfig from '../core/agent-config.js';
import * as realConnectors from '../connectors/connector-registry.js';
import { languageName } from '../core/languages.js';
import { realProbes } from './probes.js';
import { scaffoldWorkspace, validateWorkspace, ICM_LAYERS } from '../context/icm-workspace.js';
import { AttributionLedger } from '../ledger/attribution-ledger.js';
import { originId } from '../memory/skill-seal.js';
import { route as routeDecision, difficulty } from '../routing/model-router.js';
import { meshAvailable } from '../routing/mesh-signal.js';

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
    `  ${C.g}channels${C.x}        Connect a messaging channel to talk to your agent (Telegram · Discord · Slack · Matrix · Signal — all live)`,
    `  ${C.g}connect${C.x}         Onboard a connector/MCP server (credential → vault, sidecar pinned)`,
    `  ${C.g}connectors${C.x}      List onboarded connectors (metadata only; secrets stay in the vault)`,
    `  ${C.g}mesh${C.x}            The Atmosphere mesh — status + how to join (optional)`,
    `  ${C.g}icm${C.x}             Context workspace contract (folders over agents): init · validate`,
    `  ${C.g}ledger${C.x}          Attribution: who contributed what — summary · verify · list (measured, not priced)`,
    `  ${C.g}id${C.x}              This node's self-sovereign identity (did:atmos): whoami · inspect`,
    `  ${C.g}route${C.x} <prompt>   Preview the sovereign router: local by default, cloud only on opt-in`,
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
      `${C.r}usage: stratos route <prompt> [--private] [--model <m>] [--mesh] [--key]${C.x}`,
      `${C.d}Preview the sovereign router's decision. --key simulates a configured BYOK key;${C.x}`,
      `${C.d}--mesh simulates the mesh being available. /force-local · /force-cloud · /private work inline.${C.x}`,
    ] };
  }

  const q = prompt.toLowerCase();
  const priv = flags.has('--private') || q.includes('/private');
  const keyed = flags.has('--key') || _envHasKey();
  const meshReal = meshAvailable();                 // the real, file-backed fleet signal
  const mesh = flags.has('--mesh') || meshReal;     // --mesh forces a preview even with no fleet

  let d;
  if (q.includes('/force-local') || q.includes('/local')) {
    d = { tier: 'local-strong', cloud: false, difficulty: difficulty(prompt), reason: 'explicit /force-local directive' };
  } else if (q.includes('/force-cloud') || q.includes('/cloud')) {
    d = { tier: 'frontier', cloud: true, difficulty: difficulty(prompt), reason: 'explicit /force-cloud directive (opt-in)' };
  } else {
    d = routeDecision({ prompt, model, private: priv, escalate: keyed }, { hasFrontierKey: keyed, meshAvailable: mesh });
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
    `  ${C.d}context   ${C.x}key:${keyed ? `${C.g}set${C.x}` : `${C.d}none${C.x}`}  mesh:${mesh ? (meshReal ? `${C.b}live${C.x}` : `${C.y}simulated${C.x}`) : 'off'}  private:${priv ? `${C.b}on${C.x}` : 'off'}`,
    '',
    d.cloud
      ? `${C.d}Cloud only because a key is configured (standing opt-in). ${C.x}/force-local${C.d} or ${C.x}--private${C.d} pins it local.${C.x}`
      : `${C.d}Stays on your hardware — the sovereign default. Cloud needs a configured key AND a hard prompt, never silently.${C.x}`,
  ].filter(Boolean);
  return { code: 0, lines };
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
      `  ${C.d}To join: run a ghost-node bundle (built per platform) — it hole-punches outward, opening no ports.${C.x}`,
      optIn
        ? `  ${C.g}✓ You've opted in.${C.x} ${C.d}Build/run your ghost-node bundle to bring this device online.${C.x}`
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
  else if (!models.length) lines.push(`  ${C.d}(no local models installed — run: ollama pull qwen2.5:7b)${C.x}`);
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

export const COMMANDS = ['init', 'start', 'status', 'doctor', 'models', 'bind', 'channels', 'connect', 'connectors', 'mesh', 'icm', 'ledger', 'id', 'route', 'service', 'version', 'help'];

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

export async function run(argv = [], deps = {}) {
  const d = {
    config: deps.config || realConfig,
    connectors: deps.connectors || realConnectors,
    probes: deps.probes || realProbes,
    port: deps.port || process.env.PORT || 4099,
    ollamaHost: deps.ollamaHost || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    version: deps.version || '0.0.0',
  };
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'version': case '--version': case '-v': return { code: 0, lines: [d.version] };
    case 'help': case '--help': case '-h': case undefined: return { code: 0, lines: helpText() };
    case 'status': return cmdStatus(d);
    case 'doctor': return cmdDoctor(d);
    case 'models': return cmdModels(d);
    case 'bind': return cmdBind(rest, d);
    case 'connectors': return cmdConnectors(d);
    case 'mesh': return cmdMesh(d);
    case 'icm': return cmdIcm(rest);
    case 'ledger': return cmdLedger(rest);
    case 'id': return cmdId(rest);
    case 'route': return cmdRoute(rest);
    case 'connect': return { code: 0, lines: [], action: 'connect' }; // interactive — handled by bin
    case 'channels': return { code: 0, lines: [], action: 'channels' }; // interactive — handled by bin
    case 'service': return cmdService(rest);
    case 'init': return { code: 0, lines: [], action: 'init' };   // interactive — handled by bin
    case 'start': return { code: 0, lines: [], action: 'start' }; // daemon — handled by bin
    default: return { code: 1, lines: [`${C.r}Unknown command: ${cmd}${C.x}`, '', ...helpText()] };
  }
}
