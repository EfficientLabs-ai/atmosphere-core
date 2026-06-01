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
import { validateModelChoice, applyWizard, privacyPosture } from '../src/cli/wizard.js';
import { realProbes } from '../src/cli/probes.js';
import * as config from '../src/core/agent-config.js';

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

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

async function pickCloud(ask) {
  const a = (await ask(`  ${C.b}→${C.x} Which cloud? ${C.d}[O]penAI / [A]nthropic / [G]emini (default OpenAI)${C.x}: `)).trim().toLowerCase();
  return a.startsWith('a') ? 'anthropic' : a.startsWith('g') ? 'gemini' : 'openai';
}

async function initWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.once('close', () => { closed = true; });
  // resolve to '' (→ the step's default) if the input stream ends mid-question, so the wizard never
  // strands on EOF/Ctrl-D (a real TTY never closes; piped/non-interactive input safely takes defaults).
  const ask = (q) => new Promise((res) => {
    if (closed) return res('');
    const onClose = () => res('');
    rl.once('close', onClose);
    rl.question(q, (a) => { rl.removeListener('close', onClose); res(a); });
  });
  console.log(banner());
  console.log(box([`${C.bold}Set up your sovereign agent${C.x}`, `${C.d}4 quick steps · local-first · private by default${C.x}`]));

  // Step 1 — name
  console.log(stepHdr(1, 4, 'Name'));
  const agentName = (await ask(`  ${C.b}→${C.x} Name your agent ${C.d}(default StratosAgent)${C.x}: `)).trim() || 'StratosAgent';

  // Step 2 — brain (with LIVE validation + honest privacy posture)
  console.log(stepHdr(2, 4, 'Brain — the model that thinks'));
  console.log(`    ${C.g}[L]${C.x} Local open-weights  ${C.d}— private, no API key, $0${C.x}`);
  console.log(`    ${C.y}[C]${C.x} Cloud (BYOK)        ${C.d}— your key, your spend, their terms${C.x}`);
  const cloud = /^c/i.test(((await ask(`  ${C.b}→${C.x} [L]ocal (default) or [C]loud? `)).trim() || 'L'));
  const provider = cloud ? await pickCloud(ask) : 'local';
  let localModel;
  if (!cloud) {
    localModel = (await ask(`  ${C.b}→${C.x} Local model ${C.d}(default qwen2.5:7b)${C.x}: `)).trim() || 'qwen2.5:7b';
  } else {
    console.log(`    ${C.d}Add YOUR key to the environment (never pasted into chat or stored by us):${C.x}`);
    console.log(`      ${C.b}export ${provider.toUpperCase()}_API_KEY=…${C.x}`);
  }
  const v = await validateModelChoice({ provider, model: localModel }, { probes: realProbes });
  console.log('    ' + (v.ok ? okMark(v.detail) : noMark(v.detail, v.fix)));
  const pp = privacyPosture(provider);
  console.log(`    ${pp.private ? C.g + '🔒' : C.y + '☁ '}${C.d}${pp.note}${C.x}`);

  // Step 3 — routing & cost (the cost/ToS-approval mode the router will honor)
  console.log(stepHdr(3, 4, 'Routing & cost'));
  const saveApiSpend = !/^n/i.test(((await ask(`  ${C.b}→${C.x} Route simple tasks to your local model to save API spend? ${C.d}[Y/n]${C.x} `)).trim() || 'Y'));
  console.log(`    ${C.d}When a task WOULD incur cloud API spend, Stratos should:${C.x}`);
  console.log(`      ${C.g}[1]${C.x} Ask me first ${C.d}(notify + approve each spend — human on the loop)${C.x}`);
  console.log(`      ${C.b}[2]${C.x} Auto-use a capable local model when one can do it`);
  console.log(`      ${C.y}[3]${C.x} Always proceed and spend`);
  const cm = ((await ask(`  ${C.b}→${C.x} Choice ${C.d}(default 1)${C.x}: `)).trim() || '1');
  const costApproval = cm === '2' ? 'auto-local' : cm === '3' ? 'always-spend' : 'ask';

  // Step 4 — mesh (optional, clearly separate)
  console.log(stepHdr(4, 4, 'The Atmosphere mesh (optional)'));
  console.log(`    ${C.d}A P2P compute mesh. Always optional — never required to use your agent.${C.x}`);
  const meshEnroll = /^y/i.test(((await ask(`  ${C.b}→${C.x} Join the mesh now? ${C.d}[y/N]${C.x} `)).trim() || 'N'));
  rl.close();

  applyWizard({ agentName, provider, localModel, saveApiSpend, costApproval, meshEnroll }, config);

  const modeLabel = { ask: 'ask before cloud spend', 'auto-local': 'prefer local; spend only if needed', 'always-spend': 'always proceed' }[costApproval];
  console.log('\n' + box([
    `${C.g}${C.bold}✓ Saved — "${agentName}" is configured${C.x}`,
    `${C.d}Brain:${C.x}   ${provider}${localModel ? ' · ' + localModel : ''}  ${v.ok ? C.g + '(ready)' : C.y + '(' + v.state + ')'}${C.x}`,
    `${C.d}Routing:${C.x} save-spend ${saveApiSpend ? C.g + 'on' + C.x : 'off'} · ${modeLabel}`,
    `${C.d}Mesh:${C.x}    ${meshEnroll ? 'joining' : 'off (optional)'}`,
  ]));
  console.log(`\n  Next:  ${C.b}stratos doctor${C.x} ${C.d}(check readiness)${C.x}  →  ${C.b}stratos start${C.x}`);
  if (!v.ok && v.fix) console.log(`  ${C.y}First, fix the brain:${C.x} ${v.fix}`);
  console.log(`  ${C.d}Tip: let Stratos self-configure from chat later — ${pp.private ? 'fully private with your local brain.' : 'note your cloud brain will see those prompts.'}${C.x}\n`);
}

async function startDaemon() {
  process.env.PORT = process.env.PORT || '4099';
  process.env.LOCAL_FALLBACK_ENABLED = process.env.LOCAL_FALLBACK_ENABLED || 'true';
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
else if (res.action === 'start') { await startDaemon(); /* daemon holds the event loop open */ }
else if (res.action === 'service-install') { installService(); process.exit(0); }
else { for (const l of res.lines) console.log(l); process.exit(res.code); }
