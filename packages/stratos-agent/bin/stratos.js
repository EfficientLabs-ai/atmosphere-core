#!/usr/bin/env node
/**
 * `stratos` — StratosAgent's user-facing CLI entrypoint.
 * Thin wrapper: delegates the testable commands to run() and handles the two side-effectful ones
 * (interactive `init`, foreground daemon `start`) here. See src/cli/stratos-cli.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline';
import { run, generateSystemdUnit, banner } from '../src/cli/stratos-cli.js';
import { validateModelChoice, applyWizard, privacyPosture, MODEL_SOURCES, multiSelectReduce, CHANNELS, channelDef, resolveProviderKeysToEnv, resolveChannelTokensToEnv } from '../src/cli/wizard.js';
import { realProbes } from '../src/cli/probes.js';
import * as config from '../src/core/agent-config.js';
import * as connectorRegistry from '../src/connectors/connector-registry.js';
import * as vault from '../src/connectors/vault.js';

// ---- TUI helpers (presentation only; the wizard's logic is tested in src/cli/wizard.js) ----------
const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[36m', m: '\x1b[35m', d: '\x1b[2m', bold: '\x1b[1m', x: '\x1b[0m' };
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
function box(lines, pad = 2) {
  const w = Math.max(...lines.map((l) => strip(l).length)) + pad * 2;
  const body = lines.map((l) => '│' + ' '.repeat(pad) + l + ' '.repeat(w - pad - strip(l).length) + '│');
  return [`╭${'─'.repeat(w)}╮`, ...body, `╰${'─'.repeat(w)}╯`].join('\n');
}
const stepHdr = (n, total, title) => `\n${C.m}${C.bold}  ◆ Step ${n}/${total}${C.x}${C.bold} · ${title}${C.x}`;
const okMark = (s) => `${C.g}✓${C.x} ${s}`;
const noMark = (s, fix) => `${C.y}✗${C.x} ${s}${fix ? `\n       ${C.d}↳ ${fix}${C.x}` : ''}`;

// shared non-TTY line queue: buffer stdin ONCE so every prompt + the multi-select draw from the same
// scripted input (avoids the multiple-reader race when several askers are created across the wizard).
let _ntLines = null, _ntIdx = 0;
function nonTtyReady() {
  if (_ntLines) return Promise.resolve();
  return new Promise((res) => {
    let buf = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { _ntLines = buf.length ? buf.replace(/\n$/, '').split('\n') : []; res(); });
  });
}
const nextNonTtyLine = () => (_ntLines && _ntIdx < _ntLines.length ? _ntLines[_ntIdx++] : '');

/**
 * Unified line/secret prompt that works for BOTH an interactive TTY and piped input.
 *  - TTY: readline.question with secret masking (echoes •) and EOF/Ctrl-D resilience (resolves '').
 *  - non-TTY: serve from the shared buffered queue, masking secrets in the echo.
 * Close it BEFORE running multiSelect() (raw mode), then make a fresh one for subsequent prompts.
 */
function makeAsker() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let closed = false; rl.once('close', () => { closed = true; });
    const base = (q, mask) => new Promise((res) => {
      if (closed) return res('');
      const onC = () => res(''); rl.once('close', onC);
      const orig = rl._writeToOutput;
      if (mask) rl._writeToOutput = (s) => orig.call(rl, s.includes(q) ? s : '•');
      rl.question(q, (a) => { rl.removeListener('close', onC); if (mask) { rl._writeToOutput = orig; process.stdout.write('\n'); } res(a); });
    });
    return { ask: (q) => base(q, false), askSecret: (q) => base(q, true), close: () => rl.close() };
  }
  const serve = async (q, mask) => { await nonTtyReady(); process.stdout.write(q); const v = nextNonTtyLine(); process.stdout.write((mask ? '•'.repeat(v.length) : v) + '\n'); return v; };
  return { ask: (q) => serve(q, false), askSecret: (q) => serve(q, true), close: () => {} };
}

/**
 * Keyboard multi-select: ↑/↓ move, space toggles, enter confirms. Self-contained raw mode (no readline
 * open at the same time). Non-TTY fallback: numbered list + a comma-separated line from the shared queue.
 * `items`: [{ label, hint, value, checked? }]. Returns the selected values (in list order).
 */
async function multiSelect(title, items, { min = 0 } = {}) {
  const preselect = items.map((it, i) => (it.checked ? i : -1)).filter((i) => i >= 0);
  if (!process.stdin.isTTY) {
    await nonTtyReady();
    process.stdout.write(title + '\n');
    items.forEach((it, i) => process.stdout.write(`    ${i + 1}) ${it.label}  ${C.d}${it.hint || ''}${C.x}\n`));
    process.stdout.write(`  ${C.b}→${C.x} Enter numbers ${C.d}(comma-separated, e.g. 1,2)${C.x}: `);
    const raw = nextNonTtyLine(); process.stdout.write(raw + '\n');
    let picks = raw ? raw.split(/[,\s]+/).map((n) => parseInt(n, 10) - 1).filter((n) => n >= 0 && n < items.length) : [];
    if (!picks.length) picks = preselect;
    return picks.map((i) => items[i].value);
  }
  return new Promise((resolve) => {
    let state = { index: 0, selected: new Set(preselect), count: items.length };
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true); process.stdin.resume();
    const draw = (first) => {
      const out = [title];
      items.forEach((it, i) => {
        const cur = i === state.index, on = state.selected.has(i);
        out.push(`  ${cur ? C.b + '›' + C.x : ' '} ${on ? C.g + '◉' + C.x : '◯'} ${cur ? C.b + it.label + C.x : it.label}  ${C.d}${it.hint || ''}${C.x}`);
      });
      out.push(`  ${C.d}↑/↓ move · space select · enter confirm${C.x}`);
      if (!first) process.stdout.write(`\x1b[${out.length}A`);
      process.stdout.write(out.map((l) => '\x1b[2K' + l).join('\n') + '\n');
    };
    draw(true);
    const cleanup = () => { process.stdin.removeListener('keypress', onKey); try { process.stdin.setRawMode(false); } catch { /* */ } process.stdin.pause(); };
    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') { cleanup(); process.stdout.write('\n'); process.exit(130); }
      if (key.name === 'return' || key.name === 'enter') {
        if (state.selected.size < min) return;
        cleanup(); resolve([...state.selected].sort((a, b) => a - b).map((i) => items[i].value)); return;
      }
      const action = key.name === 'space' || str === ' ' ? 'space' : key.name;
      const next = multiSelectReduce(state, action);
      if (next !== state) { state = next; draw(false); }
    };
    process.stdin.on('keypress', onKey);
  });
}

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

async function initWizard() {
  console.log(banner());
  console.log(box([`${C.bold}Set up your sovereign agent${C.x}`, `${C.d}5 quick steps · local-first · private by default${C.x}`]));

  // Step 1 — name
  let asker = makeAsker();
  console.log(stepHdr(1, 5, 'Name'));
  const agentName = (await asker.ask(`  ${C.b}→${C.x} Name your agent ${C.d}(default StratosAgent)${C.x}: `)).trim() || 'StratosAgent';
  asker.close(); // release the line reader before the raw-mode multi-select

  // Step 2 — your models (multi-select; drop in keys for providers)
  console.log(stepHdr(2, 5, 'Your models — pick one or more'));
  console.log(`  ${C.d}Mix and match: run private local models, and/or connect providers with your own API key.${C.x}`);
  const items = MODEL_SOURCES.map((s) => ({ label: s.label, hint: s.hint, value: s.value, checked: s.value === 'local' }));
  const chosen = await multiSelect('', items, { min: 1 });

  asker = makeAsker();
  let localModel = null, localReady = null;
  if (chosen.includes('local')) {
    localModel = (await asker.ask(`  ${C.b}→${C.x} Local model ${C.d}(default qwen2.5:7b)${C.x}: `)).trim() || 'qwen2.5:7b';
    config.setLocalSource({ enabled: true, name: localModel });
    localReady = await validateModelChoice({ provider: 'local', model: localModel }, { probes: realProbes });
    console.log('    ' + (localReady.ok ? okMark(localReady.detail) : noMark(localReady.detail, localReady.fix)));
  } else {
    config.setLocalSource({ enabled: false });
  }

  // for each selected provider: drop in the key → stored ENCRYPTED in the vault, Stratos wires the rest
  const providers = chosen.filter((c) => c !== 'local');
  for (const provider of providers) {
    const key = (await asker.askSecret(`  ${C.b}→${C.x} ${provider} API key ${C.d}(hidden — stored encrypted in your vault)${C.x}: `)).trim();
    if (key) {
      const handle = vault.putSecret({ connector: provider, kind: 'api-key', value: key });
      config.enableProvider(provider, handle);
      console.log('    ' + okMark(`${provider} connected — key encrypted in the vault`));
    } else {
      config.enableProvider(provider, null);
      console.log(`    ${C.y}• ${provider} selected, no key entered — add it later by re-running ${C.x}${C.b}stratos init${C.x}`);
    }
  }
  asker.close();

  const anyProvider = providers.length > 0;
  const pp = privacyPosture(anyProvider ? 'provider' : 'local');
  console.log(`    ${pp.private ? C.g + '🔒' : C.y + '☁ '}${C.d}${pp.note}${C.x}`);

  // Step 3 — routing & cost (transparency description; no jargon, no "beta")
  asker = makeAsker();
  console.log(stepHdr(3, 5, 'Routing & cost'));
  console.log(`  ${C.d}Routing decides WHERE each task runs so you don't overspend: simple work can run on your free${C.x}`);
  console.log(`  ${C.d}local models, and only what truly needs a paid model uses your API key. Nothing is sent to a${C.x}`);
  console.log(`  ${C.d}provider you didn't connect — and you choose how paid calls are handled.${C.x}`);
  const saveApiSpend = !/^n/i.test(((await asker.ask(`  ${C.b}→${C.x} Route simple tasks to your free local models to save spend? ${C.d}[Y/n]${C.x} `)).trim() || 'Y'));
  console.log(`    ${C.d}When a task WOULD use a paid model, Stratos should:${C.x}`);
  console.log(`      ${C.g}[1]${C.x} Ask me first ${C.d}(notify + approve each paid call — you're on the loop)${C.x}`);
  console.log(`      ${C.b}[2]${C.x} Auto-use a capable local model when one can do it ${C.d}(spend only if needed)${C.x}`);
  console.log(`      ${C.y}[3]${C.x} Always proceed with my selected model`);
  const cm = ((await asker.ask(`  ${C.b}→${C.x} Choice ${C.d}(default 1)${C.x}: `)).trim() || '1');
  const costApproval = cm === '2' ? 'auto-local' : cm === '3' ? 'always-spend' : 'ask';

  // Step 4 — mesh walkthrough (optional, clearly separate)
  console.log(stepHdr(4, 5, 'The Atmosphere mesh (optional)'));
  console.log(`    ${C.d}A public-DHT, hole-punched (no inbound ports), post-quantum zero-trust mesh that lets your${C.x}`);
  console.log(`    ${C.d}agent borrow/lend spare compute. Data stays end-to-end encrypted; peers are PQC-verified.${C.x}`);
  console.log(`    ${C.d}Opting in just sets a flag — you bring a device online later by running a ghost-node bundle.${C.x}`);
  const meshEnroll = /^y/i.test(((await asker.ask(`  ${C.b}→${C.x} Opt in to the mesh now? ${C.d}(you can join devices later) [y/N]${C.x} `)).trim() || 'N'));
  if (meshEnroll) console.log(`    ${C.g}✓ Opted in.${C.x} ${C.d}Next: see ${C.x}${C.b}stratos mesh${C.x}${C.d} for how to bring this device online.${C.x}`);
  asker.close(); // release before the raw-mode channel multi-select

  // Step 5 — talk to your agent (messaging channels). Telegram is live; others are roadmap.
  console.log(stepHdr(5, 5, 'Talk to your agent'));
  console.log(`  ${C.d}Pick how you'll message it. Telegram works today; Slack/Discord/Matrix are coming.${C.x}`);
  const channels = await setupChannels();

  // persist name/routing/mesh (+ legacy default model if local). model sources were applied above.
  applyWizard({ agentName, provider: 'local', localModel: localModel || undefined, saveApiSpend, costApproval, meshEnroll }, config);
  if (!chosen.includes('local') && providers.length) {
    try { config.updateConfig((c) => { c.model = { provider: providers[0], name: providers[0] }; }); } catch { /* keep default */ }
  }

  const modeLabel = { ask: 'ask before paid calls', 'auto-local': 'prefer local; spend only if needed', 'always-spend': 'always use my selected model' }[costApproval];
  const sourcesLabel = [chosen.includes('local') ? `local${localModel ? ' (' + localModel + ')' : ''}` : null, ...providers].filter(Boolean).join(' · ');
  const readyChannels = channels.filter((c) => channelDef(c)?.status === 'ready');
  console.log('\n' + box([
    `${C.g}${C.bold}✓ Saved — "${agentName}" is configured${C.x}`,
    `${C.d}Models:${C.x}  ${sourcesLabel || C.y + 'none' + C.x}`,
    `${C.d}Routing:${C.x} save-spend ${saveApiSpend ? C.g + 'on' + C.x : 'off'} · ${modeLabel}`,
    `${C.d}Talk:${C.x}    ${readyChannels.length ? readyChannels.join(' · ') : C.y + 'no channel yet (stratos channels)' + C.x}`,
    `${C.d}Mesh:${C.x}    ${meshEnroll ? 'joining' : 'off (optional)'}`,
  ]));
  console.log(`\n  Next:  ${C.b}stratos doctor${C.x} ${C.d}(check readiness)${C.x}  →  ${C.b}stratos start${C.x}`);
  if (localReady && !localReady.ok && localReady.fix) console.log(`  ${C.y}Local model:${C.x} ${localReady.fix}`);
  console.log(`  ${C.d}Tip: let Stratos self-configure from chat later — ${pp.private ? 'fully private with local-only.' : 'note any connected provider will see those prompts.'}${C.x}\n`);
}

async function connectWizard() {
  const { ask, askSecret, close } = makeAsker();
  console.log(banner());
  console.log(box([`${C.bold}Onboard a connector / MCP server${C.x}`, `${C.d}credential → encrypted vault · only an opaque handle is stored${C.x}`]));
  const name = (await ask(`  ${C.b}→${C.x} Connector name ${C.d}(e.g. github)${C.x}: `)).trim();
  const command = (await ask(`  ${C.b}→${C.x} Pinned MCP sidecar command ${C.d}(e.g. node)${C.x}: `)).trim();
  const argsRaw = (await ask(`  ${C.b}→${C.x} Sidecar args ${C.d}(space-separated, e.g. ./gh-mcp.js — optional)${C.x}: `)).trim();
  const authEnvVar = (await ask(`  ${C.b}→${C.x} Auth env var the sidecar reads ${C.d}[MCP_AUTH_TOKEN]${C.x}: `)).trim() || 'MCP_AUTH_TOKEN';
  const secret = (await askSecret(`  ${C.b}→${C.x} Credential/token ${C.d}(hidden — stored encrypted in the vault; leave blank for none)${C.x}: `)).trim();
  close();

  try {
    const r = connectorRegistry.addConnector({ name, secret: secret || undefined, command, args: argsRaw ? argsRaw.split(/\s+/) : [], authEnvVar });
    console.log('\n' + box([
      `${C.g}${C.bold}✓ Connector "${r.name}" onboarded${C.x}`,
      `${C.d}Credential:${C.x} ${r.hasCredential ? C.g + 'in the vault (encrypted)' + C.x : 'none'}`,
      `${C.d}Sidecar:${C.x}    ${r.command}`,
    ]));
    console.log(`  ${C.d}The broker will use this pinned sidecar; the agent only ever sees results, never the secret.${C.x}`);
    console.log(`  ${C.d}List anytime:${C.x} ${C.b}stratos connectors${C.x}\n`);
  } catch (e) {
    console.log(`\n${C.r}✗ ${e.message}${C.x}\n`);
    process.exitCode = 1;
  }
}

/**
 * Pick messaging channels + set up the ready ones. Self-contained: runs the raw-mode multi-select with
 * NO readline open, then a fresh asker for credentials. HONEST: only 'ready' channels (Telegram today)
 * are actually configured; 'soon' ones are noted, not faked.
 */
async function setupChannels() {
  const items = CHANNELS.map((c) => ({ label: c.label, hint: c.hint, value: c.value, checked: false }));
  const chosen = await multiSelect(`  ${C.d}Which channels do you want to message your agent through? (space to pick, enter to confirm)${C.x}`, items, { min: 0 });
  if (!chosen.length) { console.log(`    ${C.d}No channel selected — you can add one anytime with ${C.x}${C.b}stratos channels${C.x}${C.d}.${C.x}`); return chosen; }
  const asker = makeAsker();
  for (const ch of chosen) {
    const def = channelDef(ch);
    if (!def || def.status !== 'ready') {
      console.log(`    ${C.y}• ${def ? def.label : ch} — coming soon.${C.x} ${C.d}Noted; the adapter ships soon (Telegram works today).${C.x}`);
      continue;
    }
    const token = (await asker.askSecret(`  ${C.b}→${C.x} ${def.label} ${def.credLabel} ${C.d}(hidden — encrypted in your vault)${C.x}: `)).trim();
    if (!token) { console.log(`    ${C.y}• ${def.label} skipped — no ${def.credLabel} entered.${C.x}`); continue; }
    const handle = vault.putSecret({ connector: ch, kind: 'bot-token', value: token });
    config.setMessagingChannel(ch, { enabled: true, tokenHandle: handle });
    const chatId = (await asker.ask(`  ${C.b}→${C.x} Your ${def.label} chat id ${C.d}(only you can command it — optional, digits)${C.x}: `)).trim();
    const bound = /^-?\d{3,}$/.test(chatId);
    if (bound) config.bindOwner(chatId);
    console.log(`    ${okMark(`${def.label} connected — token encrypted; ${bound ? 'owner bound' : 'bind your chat later: stratos bind <id>'}`)}`);
  }
  asker.close();
  return chosen;
}

async function channelsWizard() {
  console.log(banner());
  console.log(box([`${C.bold}Talk to your agent${C.x}`, `${C.d}connect a messaging channel · tokens encrypted in your vault${C.x}`]));
  await setupChannels();
  console.log(`\n  ${C.d}Tokens are decrypted into the agent only at start; restart with ${C.x}${C.b}stratos start${C.x}${C.d} to apply.${C.x}\n`);
}

async function startDaemon() {
  process.env.PORT = process.env.PORT || '4099';
  process.env.LOCAL_FALLBACK_ENABLED = process.env.LOCAL_FALLBACK_ENABLED || 'true';
  // decrypt the keys/tokens you dropped in during setup into this process's env (the gateway + bridge
  // read PROVIDER_API_KEY / TELEGRAM_BOT_TOKEN). They live encrypted at rest and only here at runtime.
  try {
    const keys = resolveProviderKeysToEnv(config, vault);
    const chans = resolveChannelTokensToEnv(config, vault);
    if (keys.length) console.log(`🔑 Loaded API keys from your vault: ${keys.join(', ')}`);
    if (chans.length) console.log(`💬 Loaded messaging channels from your vault: ${chans.join(', ')}`);
  } catch (e) { console.warn(`⚠️  Could not load vault credentials: ${e.message}`); }
  console.log(`🚀 Starting StratosAgent on 127.0.0.1:${process.env.PORT} (Ctrl-C to stop)…`);
  await import('../../api-shim/index.js'); // monorepo path; the publish pipeline rewrites this for the package
}

function installService() {
  const binPath = path.join(HERE, 'stratos.js');
  const port = process.env.PORT || '4099';
  if (process.platform === 'linux') {
    const unit = generateSystemdUnit({ execPath: process.execPath, binPath, port });
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    const unitPath = path.join(dir, 'stratos.service');
    fs.writeFileSync(unitPath, unit);
    console.log(`✅ Wrote ${unitPath} (no root used).`);
    console.log('   Enable + start it yourself:');
    console.log('     systemctl --user daemon-reload');
    console.log('     systemctl --user enable --now stratos');
    console.log('   (Optional: `loginctl enable-linger $USER` to keep it running while logged out.)');
  } else if (process.platform === 'darwin') {
    console.log('macOS: create a LaunchAgent at ~/Library/LaunchAgents/com.efficientlabs.stratos.plist');
    console.log('  with ProgramArguments = [node, ' + binPath + ', start], then: launchctl load <plist>.');
    console.log('  (Guidance only — we never load or start it for you.)');
  } else {
    console.log(`On ${process.platform}, run \`stratos start\` under your process manager of choice (no service template shipped).`);
  }
}

const res = await run(process.argv.slice(2), { config, version: pkgVersion() });
if (res.action === 'init') { await initWizard(); process.exit(0); }
else if (res.action === 'connect') { await connectWizard(); process.exit(process.exitCode || 0); }
else if (res.action === 'channels') { await channelsWizard(); process.exit(process.exitCode || 0); }
else if (res.action === 'start') { await startDaemon(); /* daemon holds the event loop open */ }
else if (res.action === 'service-install') { installService(); process.exit(0); }
else { for (const l of res.lines) console.log(l); process.exit(res.code); }
