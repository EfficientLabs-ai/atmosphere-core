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
import { realProbes } from './probes.js';

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' };
const LOCAL_MODEL_RE = /^(qwen|gemma|llama|mistral|phi|deepseek)[a-z0-9.:_-]*$/i;

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
    `${C.b}stratos${C.x} — your sovereign, local-first AI agent (Efficient Labs)`,
    '',
    'Usage: stratos <command> [args]',
    '',
    `  ${C.g}init${C.x}            Set up your agent (name + local/BYOK model). Local-only, no wallet.`,
    `  ${C.g}start${C.x}           Run the local agent on 127.0.0.1 (foreground; Ctrl-C to stop)`,
    `  ${C.g}status${C.x}          Honest snapshot: agent, model readiness, daemon, mesh`,
    `  ${C.g}doctor${C.x}          Read-only preflight — tells you exactly what's missing`,
    `  ${C.g}models${C.x}          List locally-installed models + the configured route`,
    `  ${C.g}bind${C.x} <chat-id>  Bind your Telegram chat id as owner (enables chat config)`,
    `  ${C.g}version${C.x}         Print the version`,
    `  ${C.g}help${C.x}            This message`,
    '',
    `${C.d}Mesh (The Atmosphere) is an optional add-on; mesh commands appear once it's installed.${C.x}`,
  ];
}

async function cmdStatus(deps) {
  const { config, probes, port } = deps;
  const { models } = await probes.probeOllama();
  const eff = config.effectiveCapabilities({ installedModels: models });
  const up = await probes.probePort(port);
  const owner = config.getOwner();
  const fleet = readFleet();
  const meshLine = fleet ? `${fleet.nodes} node(s), ${fleet.cores} cores ${C.d}(self-reported)${C.x}` : `off ${C.d}(not joined)${C.x}`;
  return {
    code: 0,
    lines: [
      `${C.b}${eff.agentName}${C.x} — status`,
      `  Model:    ${eff.model.name} ${eff.model.state === 'ready' ? C.g + '(ready)' : C.y + '(' + eff.model.state + ')'}${C.x}`,
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

  const oll = await probes.probeOllama();
  const isLocal = eff && eff.model.provider === 'local';
  if (isLocal) {
    checks.push({ ok: oll.reachable, label: 'Ollama', detail: oll.reachable ? `reachable, ${oll.models.length} model(s)` : `unreachable at ${ollamaHost} (needed for the local model)` });
    const installed = eff && oll.models.some((m) => m.split(':')[0] === eff.model.name.split(':')[0]);
    checks.push({ ok: !!installed, label: 'Local model', detail: installed ? `${eff.model.name} installed` : `${eff?.model.name} NOT pulled — run: ollama pull ${eff?.model.name}`, warn: !installed });
  } else if (eff) {
    const keyVar = `${eff.model.provider.toUpperCase()}_API_KEY`;
    const present = !!process.env[keyVar];
    checks.push({ ok: present, label: 'Cloud key', detail: present ? `${keyVar} present` : `${keyVar} not set (BYOK cloud model needs it)`, warn: !present });
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
  const cfg = config.getConfig();
  const lines = [`${C.b}Models${C.x}`, `  Configured: ${cfg.model.provider}:${cfg.model.name}`];
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

export const COMMANDS = ['init', 'start', 'status', 'doctor', 'models', 'bind', 'service', 'version', 'help'];

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
    case 'service': return cmdService(rest);
    case 'init': return { code: 0, lines: [], action: 'init' };   // interactive — handled by bin
    case 'start': return { code: 0, lines: [], action: 'start' }; // daemon — handled by bin
    default: return { code: 1, lines: [`${C.r}Unknown command: ${cmd}${C.x}`, '', ...helpText()] };
  }
}
