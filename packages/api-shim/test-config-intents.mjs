/**
 * config-intents unit tests — the security boundary: owner+DM gating, no privileged grants / cloud
 * switches via chat, negation/quote guards, and safe reads. Isolated temp cwd.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-intent-'));
process.chdir(tmp);

const cfg = await import('../stratos-agent/src/core/agent-config.js');
const { handleConfigIntent } = await import('./src/config-intents.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

const OWNER = '555';
cfg.bindOwner(OWNER);
const asOwner = (text, extra = {}) => handleConfigIntent({ text, chatId: OWNER, isDM: true, installedModels: ['qwen2.5:7b', 'gemma2:9b'], ...extra });

console.log('=== owner + DM gating ===');
let r = handleConfigIntent({ text: 'call yourself Atlas', chatId: '999', isDM: true });
ok(r.handled && /owner/i.test(r.reply), 'non-owner rename → refused (owner-only message)');
ok(cfg.getAgentName() === 'StratosAgent', 'non-owner attempt did NOT mutate the name');
r = handleConfigIntent({ text: 'call yourself Atlas', chatId: OWNER, isDM: false });
ok(r.handled && /direct message/i.test(r.reply), 'owner in a GROUP (not DM) → refused');
ok(cfg.getAgentName() === 'StratosAgent', 'group attempt did NOT mutate the name');

console.log('\n=== owner in DM: safe mutations ===');
r = asOwner('call yourself Atlas');
ok(r.handled && /Atlas/.test(r.reply), 'owner DM rename → applied');
ok(cfg.getAgentName() === 'Atlas', 'name persisted to config');
r = asOwner('use gemma2:9b');
ok(r.handled && /gemma2:9b/.test(r.reply), 'owner DM local-model switch → applied');
ok(cfg.getConfig().model.name === 'gemma2:9b' && cfg.getConfig().model.provider === 'local', 'local model persisted');

console.log('\n=== privileged / cloud → EXPLAIN, never grant ===');
const revBefore = cfg.getConfig().rev;
r = asOwner('use claude');
ok(r.handled && /API key/i.test(r.reply) && /won'?t take it in chat/i.test(r.reply), 'cloud provider switch → explained (key via env), not applied');
r = asOwner('switch to gpt-4o');
ok(r.handled && /env|vault/i.test(r.reply), 'cloud switch via "switch to gpt" → explained');
r = asOwner('enable shell access');
ok(r.handled && /stratos-ctl|CLI/i.test(r.reply), 'shell grant → explained as CLI-only, not granted');
r = asOwner('allow network');
ok(r.handled && /CLI|stratos-ctl/i.test(r.reply), 'network grant → explained as CLI-only');
ok(cfg.getConfig().rev === revBefore, 'NONE of the explain-only intents mutated config (rev unchanged)');
ok(cfg.getConfig().permissions.shell === 'disabled' && cfg.getConfig().permissions.network === 'disabled', 'permissions remain disabled');
ok(cfg.getConfig().model.provider === 'local', 'provider still local — no chat-driven cloud switch');

console.log('\n=== negation / quote / hypothetical guards (must NOT mutate) ===');
r = asOwner("don't call yourself Bob");
ok(!r.handled || cfg.getAgentName() === 'Atlas', 'negated rename → no mutation');
ok(cfg.getAgentName() === 'Atlas', 'name still Atlas after negated request');
r = asOwner('change your name to "Bob"');
ok(cfg.getAgentName() === 'Atlas', 'quoted name → not applied (quote guard)');
r = asOwner('should I enable shell?');
ok(cfg.getConfig().permissions.shell === 'disabled', 'hypothetical "should I enable shell?" → no grant');
r = asOwner('if you use qwen2.5:7b, what happens?');
ok(cfg.getConfig().model.name === 'gemma2:9b', 'hypothetical "if you use qwen…, what happens?" → no model switch (Codex LOW finding)');
r = asOwner('use qwen2.5:7b?');
ok(cfg.getConfig().model.name === 'gemma2:9b', 'trailing-? question form → no mutation');

console.log('\n=== safe reads + fall-through ===');
r = asOwner('what can you do');
ok(r.handled && /Atlas/.test(r.reply) && /files=disabled/.test(r.reply), 'capabilities read → honest config view');
r = asOwner('use gemma2:9b');  // ensure model ready-state reflected
r = asOwner("what's your config");
ok(r.handled && /gemma2:9b \(ready\)/.test(r.reply), 'installed local model reported as (ready), not overstated');
r = handleConfigIntent({ text: 'what is the weather in Tokyo?', chatId: OWNER, isDM: true });
ok(r.handled === false, 'non-config message → falls through to normal chat (handled:false)');
r = handleConfigIntent({ text: 'tell me a joke', chatId: OWNER, isDM: true });
ok(r.handled === false, 'ordinary chat → not intercepted');

console.log(`\n✅ ALL ${pass} config-intents checks passed.`);
