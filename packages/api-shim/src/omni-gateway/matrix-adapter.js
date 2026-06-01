import fetch from 'node-fetch';

/**
 * MatrixAdapter — a REAL two-way Matrix channel for StratosAgent (new — Matrix had no adapter).
 *
 * Matrix is decentralized + self-hostable, so this is the most sovereign of the chat channels: point it
 * at YOUR homeserver (matrix.org or your own). It connects with an access token, listens for room
 * messages, gates them (owner-only by default; skips its own + non-text + replayed history), routes the
 * text to the local gateway, and replies.
 *
 * The decision/chunk/routing LOGIC is pure + unit-tested (shouldHandle/chunk/askAgent with injected
 * fetch). The live connection in start() lazy-imports matrix-js-sdk so the module + tests load without it.
 *
 * SCOPE NOTE: this serves UNENCRYPTED rooms. End-to-end-encrypted rooms need the SDK's crypto stack
 * (Olm/rust-crypto) set up — a documented follow-up; the bot simply won't see E2EE message bodies until then.
 */
const MATRIX_LIMIT = 4000;

export class MatrixAdapter {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.baseUrl = options.baseUrl || process.env.MATRIX_HOMESERVER || null; // e.g. https://matrix.org (not secret)
    this.accessToken = options.accessToken || process.env.MATRIX_ACCESS_TOKEN || null;
    this.userId = options.userId || process.env.MATRIX_USER_ID || null;       // the bot's own @bot:server
    this.ownerId = options.ownerId || process.env.MATRIX_OWNER_ID || null;    // only this @user:server may command it
    // Fail CLOSED: no owner ⇒ serve nobody unless an open bot is explicitly opted into (MATRIX_ALLOW_ANYONE=1).
    this.allowAnyone = options.allowAnyone === true || process.env.MATRIX_ALLOW_ANYONE === '1';
    this.port = options.port || process.env.PORT || 4099;
    this.model = options.model || process.env.STRATOS_MODEL || 'local';
    this._fetch = options.fetch || fetch; // injectable for tests
    this.client = null;
    this.botUserId = null;
  }

  /**
   * PURE: decide whether to handle a normalized message + extract the prompt. Deny-by-default: only
   * plain text messages, skip our own, owner-gate.
   */
  shouldHandle(msg, botUserId) {
    if (!msg) return { handle: false, reason: 'no message' };
    if (msg.type !== 'm.room.message' || msg.msgtype !== 'm.text') return { handle: false, reason: 'not a text message' };
    if (botUserId && msg.sender === botUserId) return { handle: false, reason: 'own message' };
    if (!this.ownerId) { if (!this.allowAnyone) return { handle: false, reason: 'no owner configured (set MATRIX_OWNER_ID, or MATRIX_ALLOW_ANYONE=1 for an open bot)' }; }
    else if (msg.sender !== this.ownerId) return { handle: false, reason: 'not the owner' };
    const text = String(msg.body || '').trim();
    if (!text) return { handle: false, reason: 'empty' };
    return { handle: true, text };
  }

  /** Route a prompt to the local gateway and return the reply text. */
  async askAgent(text) {
    const res = await this._fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: text }] }),
    });
    const data = await res.json().catch(() => ({}));
    return data?.choices?.[0]?.message?.content || '(no response from the agent)';
  }

  /** Split a reply into Matrix-sized chunks, preferring newline breaks. */
  static chunk(text, max = MATRIX_LIMIT) {
    const out = [];
    let s = String(text ?? '');
    while (s.length > max) {
      let cut = s.lastIndexOf('\n', max);
      if (cut < max * 0.5) cut = max;
      out.push(s.slice(0, cut));
      s = s.slice(cut).replace(/^\n/, '');
    }
    if (s.length) out.push(s);
    return out.length ? out : [''];
  }

  /** Connect to the homeserver and serve. Lazy-imports matrix-js-sdk so the module loads without it. */
  async start() {
    if (!this.accessToken || !this.baseUrl) {
      if (this.verbose) console.warn('⚠️  [Matrix] Needs MATRIX_HOMESERVER + MATRIX_ACCESS_TOKEN — adapter disabled (dry-run).');
      return false;
    }
    let sdk;
    try { sdk = await import('matrix-js-sdk'); }
    catch { console.warn('⚠️  [Matrix] matrix-js-sdk not installed — run `npm i matrix-js-sdk` to enable.'); return false; }
    this.client = sdk.createClient({ baseUrl: this.baseUrl, accessToken: this.accessToken, userId: this.userId || undefined });
    try { const who = await this.client.whoami(); this.botUserId = who.user_id; } catch { this.botUserId = this.userId; }
    const botUserId = this.botUserId;
    // Self-reply-loop guard: without knowing our own @user:server we cannot reliably skip our OWN messages,
    // so an open bot (allowAnyone) would answer itself forever. Refuse to serve until the id is resolved.
    if (!botUserId) {
      console.warn('⚠️  [Matrix] Could not resolve the bot user id (whoami failed + no MATRIX_USER_ID) — refusing to serve to avoid a self-reply loop. Set MATRIX_USER_ID.');
      try { await this.client.stopClient?.(); } catch { /* */ }
      return false;
    }
    let live = false; // ignore the historical backfill delivered during the initial sync
    this.client.once('sync', (state) => { if (state === 'PREPARED') live = true; });
    this.client.on('Room.timeline', async (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline || !live) return;
      try {
        const content = event.getContent ? event.getContent() : {};
        const norm = { type: event.getType?.(), msgtype: content.msgtype, sender: event.getSender?.(), body: content.body, roomId: room?.roomId };
        const decision = this.shouldHandle(norm, botUserId);
        if (!decision.handle) return;
        const reply = await this.askAgent(decision.text);
        for (const part of MatrixAdapter.chunk(reply)) await this.client.sendTextMessage(norm.roomId, part);
      } catch (e) { if (this.verbose) console.error('❌ [Matrix] handler error:', e.message); }
    });
    await this.client.startClient({ initialSyncLimit: 1 });
    if (this.verbose) console.log(`💬 [Matrix] Connected to ${this.baseUrl} as ${botUserId || '?'}`);
    return true;
  }

  async stop() { try { this.client?.stopClient(); } catch { /* */ } }
}
