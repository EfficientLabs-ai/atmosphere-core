/**
 * chat-history.js unit test — append-only ring, persistence, bound, clear, conversationId.
 * Self-isolating: runs in a temp cwd so it never touches real .stratos-profile/chat-memory.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmem-'));
process.chdir(SANDBOX);
process.env.CHAT_RING_MAX = '10'; // ring size to test bounding (module floors at 8)
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} });

const ch = await import('./' + path.relative(SANDBOX, '/home/neo/atmosphere-core/packages/api-shim/src/chat-history.js'));
let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

console.log('=== chat-history (append-only per-chat memory) ===');
const CHAT = 12345;

ch.appendUser(CHAT, 'my dog is Rufus');
ch.appendAssistant(CHAT, 'Noted — Rufus.');
ch.appendUser(CHAT, 'what is my dog?');
let msgs = ch.getMessages(CHAT);
ok(msgs.length === 3 && msgs[0].content === 'my dog is Rufus', 'records user+assistant turns in order');
ok(msgs.every(m => m.role && m.content && !('seq' in m)), 'getMessages returns clean {role,content} only');

ok(ch.conversationId(CHAT) === 'tg:12345', 'stable conversationId from chatId');

// persistence: a fresh import-less reload reads from disk
const f = path.join(SANDBOX, '.stratos-profile', 'chat-memory', '12345.json');
ok(fs.existsSync(f), 'persisted to disk (survives bridge restart)');
const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
ok(onDisk.seq === 3 && onDisk.messages.every((m, i) => m.seq === i), 'append-only monotonic seq on disk');

// ring bound (CHAT_RING_MAX=10): push to 13 total, seq stays monotonic, only last 10 kept
for (let i = 0; i < 10; i++) ch.appendUser(CHAT, 'spam ' + i);
const st = ch.ringStats(CHAT);
ok(st.turns === 10, `ring bounded to ${st.max} (kept ${st.turns})`);
ok(st.seq === 13, 'seq kept monotonic across trim (never reused) — 3 + 10 = 13');
ok(ch.getMessages(CHAT).every(m => !m.content.startsWith('my dog')), 'oldest turns trimmed out of the ring');

// clear
ch.clear(CHAT);
ok(ch.getMessages(CHAT).length === 0 && !fs.existsSync(f), '/forget wipes memory + file');

console.log(`\n✅ ALL ${pass} chat-memory checks passed.`);
