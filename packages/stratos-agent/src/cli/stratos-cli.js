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
import { realProbes } from './probes.js';

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
    `  ${C.g}channels${C.x}        Connect a messaging channel to talk to your agent (Telegram live)`,
    `  ${C.g}connect${C.x}         Onboard a connector/MCP server (credential → vault, sidecar pinned)`,
    `  ${C.g}connectors${C.x}      List onboarded connectors (metadata only; secrets stay in the vault)`,
    `  ${C.g}mesh${C.x}            The Atmosphere mesh — status + how to join (optional)`,
    `  ${C.g}version${C.x}         Print the version`,
    `  ${C.g}help${C.x}            This message`,
    '',
    `${C.d}Mesh (The Atmosphere) is an optional add-on — never required to use your agent.${C.x}`,
  ];
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

export const COMMANDS = ['init', 'start', 'status', 'doctor', 'models', 'bind', 'channels', 'connect', 'connectors', 'mesh', 'service', 'version', 'help'];

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
    case 'connect': return { code: 0, lines: [], action: 'connect' }; // interactive — handled by bin
    case 'channels': return { code: 0, lines: [], action: 'channels' }; // interactive — handled by bin
    case 'service': return cmdService(rest);
    case 'init': return { code: 0, lines: [], action: 'init' };   // interactive — handled by bin
    case 'start': return { code: 0, lines: [], action: 'start' }; // daemon — handled by bin
    default: return { code: 1, lines: [`${C.r}Unknown command: ${cmd}${C.x}`, '', ...helpText()] };
  }
}
