#!/usr/bin/env node
/**
 * `stratos` — StratosAgent's user-facing CLI entrypoint.
 * Thin wrapper: delegates the testable commands to run() and handles the two side-effectful ones
 * (interactive `init`, foreground daemon `start`) here. See src/cli/stratos-cli.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline';
import { run, applyInit } from '../src/cli/stratos-cli.js';
import * as config from '../src/core/agent-config.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

async function initWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  console.log('\n🌌 StratosAgent setup — local-first, private by default.\n');
  const name = (await ask('Name your agent (default StratosAgent): ')).trim() || 'StratosAgent';
  console.log('\nModel: run a LOCAL open-weights model (private, no API key) or a cloud model with YOUR key (BYOK).');
  const cloud = /^c/i.test(((await ask('  [L]ocal (default) or [C]loud? ')).trim() || 'L'));
  let localModel;
  if (!cloud) {
    localModel = (await ask('  Local model (default qwen2.5:7b): ')).trim() || 'qwen2.5:7b';
  } else {
    console.log('\n  For a cloud model, add YOUR key to the environment (never pasted into chat or stored by us):');
    console.log('    export OPENAI_API_KEY=…   (or ANTHROPIC_API_KEY / GEMINI_API_KEY)');
    console.log('  then just request models like gpt-4o / claude-3-5-sonnet / gemini-1.5-pro.');
  }
  rl.close();
  applyInit({ agentName: name, localModel }, config);
  console.log(`\n✅ Saved — your agent is "${name}".`);
  console.log('   Next:  stratos doctor   (check readiness),  then  stratos start');
  console.log('   Mesh (The Atmosphere) and any wallet are a separate, optional add-on — never required.\n');
}

async function startDaemon() {
  process.env.PORT = process.env.PORT || '4099';
  process.env.LOCAL_FALLBACK_ENABLED = process.env.LOCAL_FALLBACK_ENABLED || 'true';
  console.log(`🚀 Starting StratosAgent on 127.0.0.1:${process.env.PORT} (Ctrl-C to stop)…`);
  await import('../../api-shim/index.js'); // monorepo path; the publish pipeline rewrites this for the package
}

const res = await run(process.argv.slice(2), { config, version: pkgVersion() });
if (res.action === 'init') { await initWizard(); process.exit(0); }
else if (res.action === 'start') { await startDaemon(); /* daemon holds the event loop open */ }
else { for (const l of res.lines) console.log(l); process.exit(res.code); }
