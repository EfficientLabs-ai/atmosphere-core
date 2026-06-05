/**
 * test-telegram-streamer.mjs — hermetic tests for the ALIVE Telegram chat path.
 *
 * Mocks the Telegram bot (sendChatAction / sendMessage / editMessageText) and the Ollama stream — no
 * live Telegram API, no live Ollama, no network. Covers:
 *   • persistentTyping re-fires the action on an interval during generation, and stop() clears it
 *     with no leaked interval (clearInterval called for the handle).
 *   • streamed chunks produce THROTTLED editMessageText calls (not one-per-token).
 *   • a stream that exceeds 4096 chars SPLITS into a new message (sendMessage called again).
 *   • an edit-failure final flush falls back to a full sendMessage — the reply is NEVER lost.
 *   • 429 on an edit triggers a backoff (sleepFn) rather than spamming.
 */
import assert from 'node:assert';
import {
  persistentTyping,
  streamToTelegram,
  streamOllamaChat,
  TG_MAX_CHARS,
} from './src/telegram-streamer.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

// ── a fake bot recording every call ────────────────────────────────────────────────────────────
function makeBot(overrides = {}) {
  const calls = { chatAction: [], sendMessage: [], editMessageText: [] };
  let msgId = 100;
  const bot = {
    sendChatAction: async (chatId, action) => { calls.chatAction.push({ chatId, action }); },
    sendMessage: async (chatId, text, opts) => {
      calls.sendMessage.push({ chatId, text, opts });
      return { message_id: ++msgId };
    },
    editMessageText: async (text, form) => { calls.editMessageText.push({ text, form }); },
    ...overrides,
  };
  return { bot, calls };
}

// an async stream of deltas
async function* deltas(arr, sink) { for (const d of arr) { if (sink) sink.push(d); yield d; } }

// ── 1. persistent typing: re-fires on interval + clears cleanly ──────────────────────────────────
console.log('=== persistent typing indicator ===');
{
  const { bot, calls } = makeBot();
  const cleared = [];
  let tick = null;
  const fakeSet = (fn) => { tick = fn; return 'H1'; };
  const fakeClear = (h) => { cleared.push(h); tick = null; };

  const stop = persistentTyping(bot, 42, { setIntervalFn: fakeSet, clearIntervalFn: fakeClear, intervalMs: 4000 });
  ok(calls.chatAction.length === 1, 'fires sendChatAction immediately (typing… in first frame)');
  ok(calls.chatAction[0].action === 'typing', "action is 'typing'");
  // simulate 3 interval ticks during a long generation
  tick(); tick(); tick();
  await Promise.resolve();
  ok(calls.chatAction.length === 4, 're-sends the typing action on each interval tick (4 total)');
  stop();
  ok(cleared.length === 1 && cleared[0] === 'H1', 'stop() clears the interval handle (no leak)');
  stop(); // idempotent
  ok(cleared.length === 1, 'stop() is idempotent (no double-clear)');
}

// ── 2. throttled edits ───────────────────────────────────────────────────────────────────────────
console.log('\n=== throttled typewriter edits ===');
{
  const { bot, calls } = makeBot();
  // 20 small deltas of 10 chars each = 200 chars. With min 40 chars/edit and a fake clock advancing
  // 1600ms each delta, throttle should batch — far fewer than 20 edits.
  let t = 0;
  const arr = Array.from({ length: 20 }, () => 'xxxxxxxxxx'); // 10 chars each
  const res = await streamToTelegram({
    bot, chatId: 7, tokenStream: deltas(arr),
    formatFinal: (s) => `<b>${s}</b>`, parseModeOpts: { parse_mode: 'HTML' },
    timing: { nowFn: () => (t += 1600), editMinIntervalMs: 1500, editMinChars: 40, sleepFn: async () => {} },
  });
  ok(calls.sendMessage.length === 1, 'one placeholder message sent');
  ok(calls.editMessageText.length > 0, 'at least one streaming edit happened');
  ok(calls.editMessageText.length < arr.length, `edits throttled (${calls.editMessageText.length} < ${arr.length} tokens)`);
  const last = calls.editMessageText[calls.editMessageText.length - 1];
  ok(last.text === '<b>' + 'xxxxxxxxxx'.repeat(20) + '</b>', 'FINAL edit is the complete formatted text');
  ok(last.form.parse_mode === 'HTML', 'final edit carries parse_mode HTML');
  ok(res.text === 'xxxxxxxxxx'.repeat(20) && !res.fellBack, 'returns full text, did not fall back');
}

// ── 3. >4096 split into a new message ─────────────────────────────────────────────────────────────
console.log('\n=== 4096-char split ===');
{
  const { bot, calls } = makeBot();
  // 6000 chars total in 60 deltas of 100 → crosses the soft cap, must open a 2nd message.
  const arr = Array.from({ length: 60 }, () => 'y'.repeat(100));
  let t = 0;
  const res = await streamToTelegram({
    bot, chatId: 9, tokenStream: deltas(arr),
    formatFinal: (s) => s,
    timing: { nowFn: () => (t += 2000), editMinIntervalMs: 1500, editMinChars: 40, sleepFn: async () => {} },
  });
  ok(arr.join('').length > TG_MAX_CHARS, 'precondition: total text exceeds 4096');
  ok(calls.sendMessage.length >= 2, `split into >=2 messages (${calls.sendMessage.length} placeholders)`);
  ok(res.messages >= 2, 'result reports >=2 messages');
  ok(res.text.length === 6000, 'full text preserved across the split');
}

// ── 4. edit-failure → full sendMessage fallback (reply never lost) ────────────────────────────────
console.log('\n=== fail-safe: edit failure → full send ===');
{
  // editMessageText ALWAYS throws (non-429) → final flush must fall back to sendMessage with full text.
  const { bot, calls } = makeBot({
    editMessageText: async () => { throw new Error('Bad Request: message to edit not found'); },
  });
  let t = 0;
  const arr = ['Hello ', 'world, ', 'this is ', 'the answer.'];
  const res = await streamToTelegram({
    bot, chatId: 11, tokenStream: deltas(arr),
    formatFinal: (s) => `<i>${s}</i>`, parseModeOpts: { parse_mode: 'HTML' },
    timing: { nowFn: () => (t += 2000), editMinIntervalMs: 1500, editMinChars: 1, sleepFn: async () => {} },
  });
  ok(res.fellBack === true, 'reports it fell back');
  const full = arr.join('');
  const delivered = calls.sendMessage.some((c) => String(c.text).includes(full) || String(c.text).includes('<i>' + full + '</i>'));
  ok(delivered, 'full reply delivered via sendMessage despite every edit failing (never lost)');
}

// ── 5. 429 backoff ───────────────────────────────────────────────────────────────────────────────
console.log('\n=== 429 backoff ===');
{
  let editCount = 0;
  const { bot } = makeBot({
    editMessageText: async () => {
      editCount += 1;
      if (editCount <= 2) { const e = new Error('429 Too Many Requests'); e.code = 429; throw e; }
      // succeed afterward
    },
  });
  const slept = [];
  let t = 0;
  const arr = Array.from({ length: 8 }, () => 'zzzzzzzzzz'); // enough to trigger several edits
  const res = await streamToTelegram({
    bot, chatId: 13, tokenStream: deltas(arr),
    formatFinal: (s) => s,
    timing: { nowFn: () => (t += 2000), editMinIntervalMs: 1500, editMinChars: 1, sleepFn: async (ms) => { slept.push(ms); } },
  });
  ok(slept.length >= 1, `backed off on 429 (slept ${slept.length} time(s))`);
  ok(slept.every((ms) => ms > 0), 'backoff delay is positive');
  ok(res.text === 'zzzzzzzzzz'.repeat(8), 'full text still produced after 429 backoff');
}

// ── 6. streamOllamaChat parses NDJSON deltas + throws on non-OK ──────────────────────────────────
console.log('\n=== streamOllamaChat NDJSON parsing ===');
{
  // Fake a node-fetch-style async-iterable body of NDJSON lines.
  const ndjson = [
    JSON.stringify({ message: { content: 'Hel' } }) + '\n',
    JSON.stringify({ message: { content: 'lo' } }) + '\n',
    JSON.stringify({ message: { content: '!' }, done: true }) + '\n',
  ];
  async function* body() { for (const l of ndjson) yield Buffer.from(l); }
  const fetchImpl = async () => ({ ok: true, status: 200, body: body() });
  let out = '';
  for await (const d of streamOllamaChat({ fetchImpl, ollamaHost: 'http://x', model: 'gemma4:e4b', messages: [] })) out += d;
  ok(out === 'Hello!', 'concatenates streamed deltas into the full text');

  // non-OK → throws so the caller can fall back
  let threw = false;
  try {
    const bad = streamOllamaChat({ fetchImpl: async () => ({ ok: false, status: 500, body: null }), ollamaHost: 'x', model: 'm', messages: [] });
    for await (const _ of bad) { void _; }
  } catch { threw = true; }
  ok(threw, 'throws on a non-OK Ollama response (enables fail-safe)');
}

console.log(`\n✅ telegram-streamer: ${pass} assertions passed.`);
