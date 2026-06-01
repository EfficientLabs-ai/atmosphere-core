import crypto from 'node:crypto';
import fetch from 'node-fetch';

/**
 * SlackAdapter — a REAL two-way Slack channel for StratosAgent (was a signature-verifier stub).
 *
 * Uses Slack SOCKET MODE (via @slack/bolt): the bot connects OUTWARD over a websocket, so there are NO
 * inbound ports / no public webhook URL — consistent with the Atmosphere's no-open-ports posture. Socket
 * Mode needs TWO tokens: a bot token (xoxb-…) for API calls and an app-level token (xapp-…) for the socket.
 *
 * It gates messages (owner-only by default; in channels only when @mentioned, DMs always), routes the
 * text to the local gateway (/v1/chat/completions), and replies — chunked to Slack's limit. The
 * decision/chunk/routing LOGIC is pure + unit-tested; the live connection in start() lazy-imports
 * @slack/bolt so the module + tests load without the SDK.
 */
const SLACK_LIMIT = 3000; // Slack text fields allow ~40k, but ~3000/message is the safe, readable chunk

export class SlackAdapter {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.botToken = options.botToken || process.env.SLACK_BOT_TOKEN || null;
    this.appToken = options.appToken || process.env.SLACK_APP_TOKEN || null;
    this.ownerId = options.ownerId || process.env.SLACK_OWNER_ID || null; // only this user may command it
    // Fail CLOSED: no owner ⇒ serve nobody unless an open bot is explicitly opted into (SLACK_ALLOW_ANYONE=1).
    this.allowAnyone = options.allowAnyone === true || process.env.SLACK_ALLOW_ANYONE === '1';
    this.port = options.port || process.env.PORT || 4099;
    this.model = options.model || process.env.STRATOS_MODEL || 'local';
    this.signingSecret = options.signingSecret || process.env.SLACK_SIGNING_SECRET || null;
    this._fetch = options.fetch || fetch; // injectable for tests
    this.app = null;
    this.botUserId = null;
  }

  /**
   * PURE: decide whether to handle a normalized message + extract the prompt. Deny-by-default: skip our
   * own + bot/system (subtyped) messages, owner-gate, and in channels respond only when @mentioned.
   */
  shouldHandle(msg, botUserId) {
    if (!msg) return { handle: false, reason: 'no message' };
    if (msg.botId || msg.subtype) return { handle: false, reason: 'bot/system message' };
    if (botUserId && String(msg.userId) === String(botUserId)) return { handle: false, reason: 'own message' };
    if (!this.ownerId) { if (!this.allowAnyone) return { handle: false, reason: 'no owner configured (set SLACK_OWNER_ID, or SLACK_ALLOW_ANYONE=1 for an open bot)' }; }
    else if (String(msg.userId) !== String(this.ownerId)) return { handle: false, reason: 'not the owner' };
    if (!msg.isDM && !msg.mentionedBot) return { handle: false, reason: 'not @mentioned in a channel' };
    const text = String(msg.text || '').replace(/<@[A-Z0-9]+>/g, '').trim(); // strip Slack mention tokens
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

  /** Split a reply into Slack-sized chunks, preferring newline breaks. */
  static chunk(text, max = SLACK_LIMIT) {
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

  /** Connect over Socket Mode and serve. Lazy-imports @slack/bolt so the module loads without the SDK. */
  async start() {
    if (!this.botToken || !this.appToken) {
      if (this.verbose) console.warn('⚠️  [Slack] Needs both SLACK_BOT_TOKEN + SLACK_APP_TOKEN — adapter disabled (dry-run).');
      return false;
    }
    let bolt;
    try { bolt = await import('@slack/bolt'); }
    catch { console.warn('⚠️  [Slack] @slack/bolt not installed — run `npm i @slack/bolt` to enable.'); return false; }
    this.app = new bolt.App({ token: this.botToken, appToken: this.appToken, socketMode: true });
    try { const auth = await this.app.client.auth.test(); this.botUserId = auth.user_id; } catch { /* keep null */ }
    const botUserId = this.botUserId;
    this.app.message(async ({ message, say }) => {
      try {
        const norm = {
          userId: message.user, botId: message.bot_id, subtype: message.subtype, text: message.text,
          isDM: message.channel_type === 'im',
          mentionedBot: botUserId ? String(message.text || '').includes(`<@${botUserId}>`) : false,
        };
        const decision = this.shouldHandle(norm, botUserId);
        if (!decision.handle) return;
        const reply = await this.askAgent(decision.text);
        for (const part of SlackAdapter.chunk(reply)) await say(part);
      } catch (e) { if (this.verbose) console.error('❌ [Slack] handler error:', e.message); }
    });
    await this.app.start();
    if (this.verbose) console.log(`💬 [Slack] Connected (Socket Mode)${botUserId ? ' as ' + botUserId : ''}`);
    return true;
  }

  async stop() { try { await this.app?.stop(); } catch { /* */ } }

  /** HMAC verification for the alternative HTTP/Events-API mode (unused in Socket Mode; kept for completeness). */
  verifyRequestSignature(rawBody, timestamp, signature) {
    if (!rawBody || !timestamp || !signature || !this.signingSecret) return false;
    if (parseInt(timestamp, 10) < Math.floor(Date.now() / 1000) - 300) return false; // replay window
    const hmac = crypto.createHmac('sha256', this.signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
    const expected = `v0=${hmac}`;
    try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
  }

  /** Normalize a raw Slack event (kept for context tagging). */
  normalizeRequest(slackEvent) {
    const { event, team_id, api_app_id } = slackEvent;
    return {
      protocol: 'omni-acp-v1', channel: 'slack', sender: event.user, text: event.text, timestamp: Date.now(),
      messageId: event.client_msg_id || crypto.randomBytes(16).toString('hex'),
      sessionMeta: { isolatedContextTag: `slack-context-team_${team_id}-channel_${event.channel}`, platformMeta: { teamId: team_id, channelId: event.channel, apiAppId: api_app_id } },
    };
  }
}
