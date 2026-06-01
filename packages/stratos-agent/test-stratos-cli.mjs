/**
 * stratos CLI tests — command parsing + HONESTY guarantees (no fabricated status/balance/peers),
 * read-only doctor pass/fail, owner-bind gating, local-only init. Isolated temp cwd; injected probes.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-cli-'));
process.chdir(tmp);

const config = await import('./src/core/agent-config.js');
const { run, applyInit, COMMANDS, generateSystemdUnit } = await import('./src/cli/stratos-cli.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const text = (r) => r.lines.join('\n');
// Injected probe doubles (no real network/daemon).
const probes = (over = {}) => ({
  nodeVersion: () => ({ raw: '20.0.0', major: 20, ok: true }),
  probePort: async () => false,
  probeOllama: async () => ({ reachable: true, models: ['qwen2.5:7b'] }),
  ...over,
});

console.log('=== help / version / unknown ===');
let r = await run([], { version: '1.2.3' });
ok(r.code === 0 && /init/.test(text(r)) && /doctor/.test(text(r)), 'no args → help with commands');
r = await run(['version'], { version: '1.2.3' });
ok(r.code === 0 && text(r).includes('1.2.3'), 'version → injected version');
r = await run(['frobnicate'], {});
ok(r.code === 1 && /Unknown command/.test(text(r)), 'unknown command → code 1 + help');
ok(COMMANDS.includes('doctor') && COMMANDS.includes('init'), 'COMMANDS surface is exported');

console.log('\n=== status is HONEST (no fabricated balance/peers/records) ===');
r = await run(['status'], { config, probes: probes(), port: 4099 });
const s = text(r);
ok(r.code === 0 && /StratosAgent/.test(s), 'status shows the agent name');
ok(/Daemon:\s+\x1b\[33mstopped/.test(s) || /stopped/.test(s), 'daemon reported stopped (probePort=false) — measured, not assumed');
ok(/qwen2\.5:7b/.test(s) && /ready/.test(s), 'model readiness from effectiveCapabilities (installed → ready)');
ok(/off/.test(s) && /not joined/.test(s), 'mesh reported off (no fleet.json) — not fabricated');
ok(!/SOL|12\.45|Maximus|EsportsCafe|records|connected/.test(s), 'NO fabricated SOL balance / peer list / record counts');

console.log('\n=== status: model not installed → honest "not pulled", daemon up when port listening ===');
r = await run(['status'], { config, probes: probes({ probeOllama: async () => ({ reachable: false, models: [] }), probePort: async () => true }), port: 4099 });
ok(/not pulled/.test(text(r)), 'local model not installed → "not pulled" (not overstated as ready)');
ok(/running/.test(text(r)), 'daemon "running" when the port is listening');

console.log('\n=== doctor is read-only & reflects real failures ===');
r = await run(['doctor'], { config, probes: probes({ probeOllama: async () => ({ reachable: false, models: [] }) }), port: 4099 });
ok(r.code === 1 && /Ollama/.test(text(r)), 'local model + Ollama unreachable → blocking issue, code 1');
ok(/preflight/.test(text(r)) && !/Maximus|SOL/.test(text(r)), 'doctor is honest preflight, no theater');
r = await run(['doctor'], { config, probes: probes(), port: 4099 });
ok(r.code === 0 && /Ready/.test(text(r)), 'all green (ollama reachable + model installed) → Ready, code 0');

console.log('\n=== bind gating ===');
r = await run(['bind', 'not-a-number'], { config, probes: probes() });
ok(r.code === 1 && /Usage/.test(text(r)), 'bind with non-numeric id → rejected');
r = await run(['bind', '8213853174'], { config, probes: probes() });
ok(r.code === 0 && config.getOwner() === '8213853174', 'bind with valid id → owner persisted');

console.log('\n=== models ===');
r = await run(['models'], { config, probes: probes() });
ok(r.code === 0 && /qwen2\.5:7b/.test(text(r)), 'models lists installed local models');

console.log('\n=== init is LOCAL-ONLY (no wallet/mesh) and validates ===');
applyInit({ agentName: 'Atlas', localModel: 'gemma2:9b' }, config);
ok(config.getAgentName() === 'Atlas' && config.getConfig().model.name === 'gemma2:9b' && config.getConfig().configured === true, 'applyInit sets name + local model + marks configured');
applyInit({ agentName: 'Nova', localModel: 'gpt-4o' }, config);
ok(config.getAgentName() === 'Nova' && config.getConfig().model.name === 'gemma2:9b', 'applyInit IGNORES a cloud model as "local" (gpt-4o not applied) — local-only path');

// Ensure the init helper never enrolled the user in the mesh or wrote a wallet.
const cfg = config.getConfig();
ok(cfg.meshOptIn === false, 'base init leaves mesh opt-in OFF (no mesh enrollment)');
ok(!/wallet|solana/i.test(JSON.stringify(cfg)), 'no wallet/solana field written by base init');

console.log('\n=== service: explicit, no-root, separate from install ===');
r = await run(['service'], { config });
ok(r.code === 0 && /no root/i.test(text(r)) && /service install/.test(text(r)), 'service (no sub) → guidance, never auto-enables');
r = await run(['service', 'install'], { config });
ok(r.action === 'service-install', 'service install → action delegated to bin (writes a user unit)');
const unit = generateSystemdUnit({ execPath: '/usr/bin/node', binPath: '/x/stratos.js', port: 4099 });
ok(/systemd/i.test('[Unit]') === false && unit.includes('[Service]') && unit.includes('ExecStart=/usr/bin/node /x/stratos.js start'), 'systemd unit: ExecStart wired to the bin');
ok(unit.includes('WantedBy=default.target') && unit.includes('Environment=PORT=4099') && !/root|sudo/i.test(unit), 'systemd unit: user target (default.target), PORT env, no root');

// connectors — metadata-only listing (injected stub)
r = await run(['connectors'], { config, connectors: { listConnectors: () => [{ name: 'github', hasCredential: true, command: 'node' }] } });
ok(r.code === 0 && /github/.test(text(r)) && /credentialed/.test(text(r)), 'connectors lists onboarded connectors (metadata)');
r = await run(['connectors'], { config, connectors: { listConnectors: () => [] } });
ok(/stratos connect/.test(text(r)), 'empty connectors → points to onboarding');

// mesh — walkthrough + honest status
r = await run(['mesh'], { config });
ok(r.code === 0 && /Atmosphere/.test(text(r)) && /not joined|opted in/.test(text(r)), 'mesh shows the walkthrough + status');

// connect — interactive, delegated to bin
r = await run(['connect'], { config });
ok(r.action === 'connect', 'connect → action delegated to the interactive bin handler');

ok(['connect', 'connectors', 'mesh'].every((c) => COMMANDS.includes(c)), 'new commands are in the COMMANDS surface');

console.log('\n=== status/doctor/models reflect the wizard config (model sources + channels) ===');
config.enableProvider('anthropic', 'cvault:anthropic:api-key:' + 'a'.repeat(32));
config.setMessagingChannel('telegram', { enabled: true, tokenHandle: 'cvault:telegram:bot-token:' + 'b'.repeat(32) });
r = await run(['status'], { config, probes: probes() });
ok(/anthropic/.test(text(r)) && /telegram/.test(text(r)), 'status shows the configured provider + channel');
r = await run(['models'], { config, probes: probes() });
ok(/anthropic/.test(text(r)) && /✓/.test(text(r)), 'models lists the configured provider with its key set');
r = await run(['doctor'], { config, probes: probes() });
ok(/anthropic key/.test(text(r)) && /telegram/.test(text(r)), 'doctor checks the provider key + channel token');

console.log(`\n✅ ALL ${pass} stratos-cli checks passed.`);
