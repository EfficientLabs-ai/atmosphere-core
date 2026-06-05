/**
 * telegram-streamer.js — makes the Telegram chat agent feel ALIVE while a slow CPU model thinks.
 *
 * Two independent, fail-safe primitives, both dependency-injected (the `bot` and `fetch` are passed
 * in) so they're trivially hermetically testable with no live Telegram API and no live Ollama:
 *
 *   1. persistentTyping(bot, chatId)  → returns stop(). Re-sends sendChatAction(chatId,'typing')
 *      on an interval (~4s; the action expires server-side after ~5s) so "typing…" shows the WHOLE
 *      time the model generates, not just the first 5 seconds. stop() clears the interval; it is
 *      idempotent and must be called on every exit path (finish AND error) so no interval leaks.
 *
 *   2. streamGenerate(...) → drives Ollama's streaming /api/chat and progressively renders the
 *      accumulating text into Telegram via ONE placeholder message + THROTTLED editMessageText
 *      calls (the typewriter effect). Throttle respects Telegram's edit rate limits; the 4096-char
 *      cap is handled by finalizing the current message and continuing in a new one; and the whole
 *      thing is fail-safe: any stream/edit failure falls back to a single sendMessage with the full
 *      text so a reply is NEVER lost.
 *
 * Nothing here imports node-telegram-bot-api or node-fetch directly — the live bridge injects the
 * real ones; tests inject mocks.
 */

export const TG_MAX_CHARS = 4096;
// Leave headroom under the hard 4096 cap so a final formatted (HTML-tagged) flush can't tip over.
const SOFT_CHARS = 3900;

// Telegram rate-limits edits. Edit at most once per EDIT_MIN_INTERVAL_MS, AND only when at least
// EDIT_MIN_CHARS new characters have accumulated since the last edit — whichever is gentler — so we
// never spam editMessageText on a fast token stream.
const EDIT_MIN_INTERVAL_MS = 1500;
const EDIT_MIN_CHARS = 40;
// Typing action cadence: the action expires ~5s server-side, so refresh a touch sooner.
const TYPING_INTERVAL_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Persistent "typing…" indicator. Fires sendChatAction immediately, then every ~4s until stop().
 * Returns an idempotent stop() that clears the interval. Never throws (sendChatAction failures are
 * swallowed — a dropped typing ping must not break the chat).
 *
 * @param {{sendChatAction:Function}} bot
 * @param {number|string} chatId
 * @param {object} [opts] - { intervalMs, action, setIntervalFn, clearIntervalFn } (injectable for tests)
 * @returns {() => void} stop
 */
export function persistentTyping(bot, chatId, opts = {}) {
  const intervalMs = opts.intervalMs || TYPING_INTERVAL_MS;
  const action = opts.action || 'typing';
  const setI = opts.setIntervalFn || setInterval;
  const clearI = opts.clearIntervalFn || clearInterval;

  const ping = () => { try { Promise.resolve(bot.sendChatAction(chatId, action)).catch(() => {}); } catch { /* never throws */ } };
  ping(); // immediate, so "typing…" appears in the first frame
  let handle = setI(ping, intervalMs);

  return function stop() {
    if (handle != null) { try { clearI(handle); } catch { /* ignore */ } handle = null; }
  };
}

/**
 * Consume Ollama's streaming /api/chat NDJSON and yield text deltas.
 *
 * Yields strings (the incremental `message.content` for /api/chat, or `response` for /api/generate).
 * Works with either a WHATWG ReadableStream body (res.body.getReader) or a Node Readable (async
 * iterator) — node-fetch v3 bodies are async-iterable. Throws on a non-OK response so the caller can
 * fall back. The caller is responsible for the fail-safe; this just surfaces tokens or throws.
 *
 * @param {object} args
 * @param {Function} args.fetchImpl - fetch (global fetch or node-fetch), injected
 * @param {string} args.ollamaHost
 * @param {string} args.model
 * @param {Array}  args.messages - OpenAI-style [{role,content}]
 * @param {object} [args.options] - Ollama options (e.g. { num_ctx })
 * @param {AbortSignal} [args.signal]
 */
export async function* streamOllamaChat({ fetchImpl, ollamaHost, model, messages, options = {}, signal }) {
  const res = await fetchImpl(`${ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options }),
    signal,
  });
  if (!res || !res.ok) {
    throw new Error(`Ollama stream returned non-OK status: ${res ? res.status : 'no-response'}`);
  }

  for await (const chunk of iterateBody(res.body)) {
    // Ollama streams newline-delimited JSON objects.
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }
      const delta = obj?.message?.content ?? obj?.response ?? '';
      if (delta) yield delta;
      if (obj?.done) return;
    }
  }
}

/** Iterate a fetch Response body as decoded UTF-8 text chunks (handles both stream styles). */
async function* iterateBody(body) {
  if (!body) return;
  // WHATWG ReadableStream (global fetch / undici)
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const nl = buf.lastIndexOf('\n');
      if (nl >= 0) { yield buf.slice(0, nl + 1); buf = buf.slice(nl + 1); }
    }
    if (buf) yield buf;
    return;
  }
  // Node Readable (node-fetch v3 body is async-iterable)
  let buf = '';
  for await (const piece of body) {
    buf += typeof piece === 'string' ? piece : Buffer.from(piece).toString('utf8');
    const nl = buf.lastIndexOf('\n');
    if (nl >= 0) { yield buf.slice(0, nl + 1); buf = buf.slice(nl + 1); }
  }
  if (buf) yield buf;
}

/**
 * Render a token stream to Telegram as a throttled typewriter, with 4096 splitting and a fail-safe
 * fallback. NEVER loses a reply: if anything goes wrong mid-stream, it flushes the full accumulated
 * text via plain sendMessage.
 *
 * @param {object} args
 * @param {{sendMessage:Function, editMessageText:Function}} args.bot
 * @param {number|string} args.chatId
 * @param {AsyncIterable<string>} args.tokenStream - yields text deltas
 * @param {(full:string)=>string} [args.formatFinal] - format the COMPLETE text for the final edit
 *        (e.g. dispatcher.formatResponseHTML). The live edits use raw text; the final edit uses this.
 * @param {object} [args.parseModeOpts] - extra opts for the FINAL formatted edit/send (e.g. { parse_mode:'HTML' })
 * @param {object} [args.timing] - { editMinIntervalMs, editMinChars, nowFn, sleepFn } (injectable for tests)
 * @returns {Promise<{ ok:boolean, text:string, fellBack:boolean, messages:number }>}
 */
export async function streamToTelegram({ bot, chatId, tokenStream, formatFinal, parseModeOpts = {}, timing = {} }) {
  const editMinInterval = timing.editMinIntervalMs ?? EDIT_MIN_INTERVAL_MS;
  const editMinChars = timing.editMinChars ?? EDIT_MIN_CHARS;
  const now = timing.nowFn || Date.now;
  const naptime = timing.sleepFn || sleep;
  const fmt = typeof formatFinal === 'function' ? formatFinal : (s) => s;

  let full = '';            // everything generated, across all messages
  let segment = '';         // text in the CURRENT telegram message
  let currentMsgId = null;  // message_id of the current placeholder
  let lastEditAt = 0;
  let lastEditedLen = 0;    // segment length at last successful edit (throttle gate)
  let messages = 0;

  // Fail-safe: flush the whole reply as plain message(s). Used when streaming/editing can't continue.
  const failSafeFullSend = async () => {
    const formatted = fmt(full);
    try {
      await sendChunked(bot, chatId, formatted, parseModeOpts);
    } catch {
      // Last resort: send unformatted, unsplit-aware plaintext so the user still gets SOMETHING.
      try { await sendChunked(bot, chatId, full, {}); } catch { /* nothing more we can do */ }
    }
  };

  try {
    // 1. Placeholder message we'll type into.
    const placeholder = await bot.sendMessage(chatId, '…', {});
    currentMsgId = placeholder?.message_id ?? placeholder?.messageId ?? null;
    messages = 1;
    if (currentMsgId == null) {
      // Couldn't get a message id to edit — degrade to a single full send when done.
      for await (const delta of tokenStream) full += delta;
      await failSafeFullSend();
      return { ok: true, text: full, fellBack: true, messages: 1 };
    }

    let editFailures = 0;
    let editsDisabled = false; // stop *attempting* edits after persistent failures, but KEEP
                               // consuming the stream so we never drop tokens — the final flush delivers all.

    for await (const delta of tokenStream) {
      full += delta;
      segment += delta;

      if (editsDisabled) continue; // keep draining the stream; deliver everything at the end

      // 4096 handling: if this segment would exceed the soft cap, FINALIZE the current message with
      // its complete formatted text, then open a NEW message to continue typing into.
      if (segment.length >= SOFT_CHARS) {
        await safeEdit(bot, currentMsgId, chatId, fmt(segment), parseModeOpts).catch(() => {});
        const next = await bot.sendMessage(chatId, '…', {});
        currentMsgId = next?.message_id ?? next?.messageId ?? null;
        messages += 1;
        segment = '';
        lastEditAt = now();
        lastEditedLen = 0;
        if (currentMsgId == null) { await failSafeFullSend(); return { ok: true, text: full, fellBack: true, messages }; }
        continue;
      }

      // Throttle: edit only if BOTH enough time passed AND enough new chars accrued.
      const dt = now() - lastEditAt;
      const dChars = segment.length - lastEditedLen;
      if (dt >= editMinInterval && dChars >= editMinChars) {
        try {
          await bot.editMessageText(segment, { chat_id: chatId, message_id: currentMsgId });
          lastEditAt = now();
          lastEditedLen = segment.length;
          editFailures = 0;
        } catch (e) {
          // 429 → back off and let the next loop retry; other errors tolerated (final edit will fix it).
          if (is429(e)) await naptime(retryAfterMs(e));
          editFailures += 1;
          // If edits are persistently failing, stop HAMMERING (but keep draining the stream); the
          // final fail-safe flush still delivers the complete text.
          if (editFailures >= 3) editsDisabled = true;
        }
      }
    }

    // If we gave up on live edits mid-stream, the message is undeliverable via edit → full send.
    if (editsDisabled) { await failSafeFullSend(); return { ok: true, text: full, fellBack: true, messages }; }

    // 2. FINAL edit = the complete, formatted text of the current segment.
    const finalFormatted = fmt(segment);
    try {
      await bot.editMessageText(finalFormatted, { chat_id: chatId, message_id: currentMsgId, ...parseModeOpts });
    } catch (e) {
      if (is429(e)) {
        await naptime(retryAfterMs(e));
        try { await bot.editMessageText(finalFormatted, { chat_id: chatId, message_id: currentMsgId, ...parseModeOpts }); }
        catch { /* fall through to plaintext retry */ }
      }
      // HTML/parse failure or repeated edit failure → retry the final edit as PLAINTEXT (always valid).
      try {
        await bot.editMessageText(segment, { chat_id: chatId, message_id: currentMsgId });
      } catch {
        // Even the plaintext edit failed — fail-safe: send the whole thing fresh so it's never lost.
        await failSafeFullSend();
        return { ok: true, text: full, fellBack: true, messages };
      }
    }

    return { ok: true, text: full, fellBack: false, messages };
  } catch (err) {
    // Stream blew up (e.g. Ollama dropped). We already accumulated `full`; deliver it.
    await failSafeFullSend();
    return { ok: false, text: full, fellBack: true, messages: Math.max(messages, 1) };
  }
}

/** Edit helper that tolerates HTML-parse failures by retrying as plaintext. */
async function safeEdit(bot, messageId, chatId, text, parseModeOpts) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...parseModeOpts });
  } catch {
    await bot.editMessageText(stripTags(text), { chat_id: chatId, message_id: messageId });
  }
}

/** Send text that may exceed 4096 chars as multiple messages, splitting on a newline boundary. */
async function sendChunked(bot, chatId, text, opts) {
  const str = String(text ?? '');
  if (str.length <= TG_MAX_CHARS) { await bot.sendMessage(chatId, str, opts); return; }
  let rest = str;
  while (rest.length > 0) {
    let cut = Math.min(TG_MAX_CHARS, rest.length);
    if (cut === TG_MAX_CHARS) {
      const nl = rest.lastIndexOf('\n', TG_MAX_CHARS);
      if (nl > TG_MAX_CHARS * 0.5) cut = nl + 1; // prefer a clean line break if reasonably close
    }
    const piece = rest.slice(0, cut);
    rest = rest.slice(cut);
    // Only the final piece carries the formatting opts (HTML on a split fragment can be unbalanced).
    await bot.sendMessage(chatId, piece, rest.length === 0 ? opts : {});
  }
}

function stripTags(s) { return String(s).replace(/<[^>]+>/g, ''); }

function is429(err) {
  const code = err?.response?.statusCode || err?.code || err?.statusCode;
  return code === 429 || /429|too many requests/i.test(String(err?.message || ''));
}

function retryAfterMs(err) {
  const ra = err?.response?.body?.parameters?.retry_after || err?.parameters?.retry_after;
  const secs = Number(ra);
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, 10_000) : 1500;
}
