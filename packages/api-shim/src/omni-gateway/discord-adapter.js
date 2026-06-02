import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { scanForSecrets, SECRET_REFUSAL } from '../secret-guard.js';
import { parseApprovalResponse, dispatchAgentTurn, convKey } from './approval-flow.js';

/**
 * DiscordAdapter — a REAL two-way Discord channel for StratosAgent (was a stub with a mock token).
 *
 * It connects to Discord with discord.js, listens for messages, gates them (owner-only by default; in
 * servers only when @mentioned, DMs always), routes the text to the local gateway (/v1/chat/completions),
 * and replies — chunked to Discord's 2000-char limit. Mirrors the proven telegram-bridge flow.
 *
 * The decision/format/routing LOGIC is pure + unit-tested (shouldHandle, chunk, askAgent with injected
 * fetch). The live connection is in start(), which LAZY-imports discord.js so this module + its tests load
 * without the SDK installed; start() is exercised live by the operator with a real bot token.
 */
const DISCORD_LIMIT = 1900; // hard limit is 2000; leave headroom for reply formatting

export class DiscordAdapter {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.token = options.token || process.env.DISCORD_BOT_TOKEN || null;
    this.ownerId = options.ownerId || process.env.DISCORD_OWNER_ID || null; // only this user may command it
    // Fail CLOSED: with no owner configured, serve NOBODY unless an open bot is explicitly opted into
    // (DISCORD_ALLOW_ANYONE=1). Stops the "anyone who finds the bot can command it" footgun.
    this.allowAnyone = options.allowAnyone === true || process.env.DISCORD_ALLOW_ANYONE === '1';
    this.port = options.port || process.env.PORT || 4099;
    this.model = options.model || process.env.STRATOS_MODEL || 'local';
    this._fetch = options.fetch || fetch; // injectable for tests
    this.client = null;
    this.pending = new Map(); // sender → { text, token } : a cost-approval awaiting the user's reply
  }

  /**
   * PURE: decide whether to handle a normalized message and extract the prompt. Deny-by-default:
   * skip our own + other bots, enforce owner-gating when an owner is set, and in guild channels only
   * respond when @mentioned (DMs always). Returns { handle, text? , reason? }.
   */
  shouldHandle(msg, botUserId) {
    if (!msg) return { handle: false, reason: 'no message' };
    if (botUserId && String(msg.authorId) === String(botUserId)) return { handle: false, reason: 'own message' };
    if (msg.authorBot) return { handle: false, reason: 'other bot' };
    if (!this.ownerId) { if (!this.allowAnyone) return { handle: false, reason: 'no owner configured (set DISCORD_OWNER_ID, or DISCORD_ALLOW_ANYONE=1 for an open bot)' }; }
    else if (String(msg.authorId) !== String(this.ownerId)) return { handle: false, reason: 'not the owner' };
    if (!msg.isDM && !msg.mentionedBot) return { handle: false, reason: 'not @mentioned in a server' };
    const text = String(msg.content || '').replace(/<@!?\d+>/g, '').trim(); // strip the mention token
    if (!text) return { handle: false, reason: 'empty' };
    // Secret-guard (parity with Telegram): never forward a pasted API key/token to the model, logs, or
    // telemetry — refuse at the channel boundary.
    if (scanForSecrets(text)) return { handle: false, refuse: true, reply: SECRET_REFUSAL, reason: 'secret in message' };
    return { handle: true, text };
  }

  /**
   * Route a prompt to the local gateway. Returns the reply string, OR { approval } when the gateway
   * answers a 402 cost-approval gate (so dispatch can run the human-in-the-loop handshake). `extraHeaders`
   * carries the replay headers (x-stratos-route / x-stratos-approval) when the user has approved.
   */
  async askAgent(text, extraHeaders = {}) {
    const res = await this._fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: text }] }),
    });
    const data = await res.json().catch(() => ({}));
    const approval = parseApprovalResponse(res.status, data);
    if (approval.approvalRequired) return { approval };
    return data?.choices?.[0]?.message?.content || '(no response from the agent)';
  }

  /** Split a reply into Discord-sized chunks, preferring to break on newlines. */
  static chunk(text, max = DISCORD_LIMIT) {
    const out = [];
    let s = String(text ?? '');
    while (s.length > max) {
      let cut = s.lastIndexOf('\n', max);
      if (cut < max * 0.5) cut = max; // no good newline → hard cut
      out.push(s.slice(0, cut));
      s = s.slice(cut).replace(/^\n/, '');
    }
    if (s.length) out.push(s);
    return out.length ? out : [''];
  }

  /**
   * Run ONE normalized message: gate it, refuse on a secret (SECRET_REFUSAL, stopping BEFORE askAgent),
   * else route to the agent and reply. Replies go through the injected `send(text)` so this whole branch
   * is unit-testable without the discord.js SDK. Returns the decision.
   */
  async dispatch(norm, botUserId, send, { typing } = {}) {
    const decision = this.shouldHandle(norm, botUserId);
    if (!decision.handle) { if (decision.refuse) await send(decision.reply); return decision; }
    await dispatchAgentTurn({
      // scope the pending approval to THIS conversation (user@channel), not just the user
      pending: this.pending, key: convKey(norm.authorId, norm.channelId, norm.isDM), text: decision.text,
      askAgent: (t, h) => this.askAgent(t, h), send, chunk: DiscordAdapter.chunk, typing,
    });
    return decision;
  }

  /** Connect to Discord and serve. Lazy-imports discord.js so the module loads without the SDK. */
  async start() {
    if (!this.token) {
      if (this.verbose) console.warn('⚠️  [Discord] No DISCORD_BOT_TOKEN configured — adapter disabled (dry-run).');
      return false;
    }
    let discord;
    try { discord = await import('discord.js'); }
    catch { console.warn('⚠️  [Discord] discord.js not installed — run `npm i discord.js` to enable.'); return false; }
    const { Client, GatewayIntentBits, Partials } = discord;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel], // required to receive DMs
    });
    this.client.once('ready', (c) => { if (this.verbose) console.log(`💬 [Discord] Connected as ${c.user.tag}`); });
    this.client.on('messageCreate', async (m) => {
      try {
        const norm = {
          authorId: m.author.id, authorBot: m.author.bot, content: m.content, channelId: m.channel?.id,
          isDM: !m.guild, mentionedBot: this.client.user ? m.mentions.has(this.client.user.id) : false,
        };
        await this.dispatch(norm, this.client.user?.id,
          (t) => m.reply(t).catch(() => m.channel.send(t).catch(() => {})),
          { typing: () => m.channel.sendTyping().catch(() => {}) });
      } catch (e) { if (this.verbose) console.error('❌ [Discord] handler error:', e.message); }
    });
    await this.client.login(this.token);
    return true;
  }

  async stop() { try { await this.client?.destroy(); } catch { /* */ } }

  /** Normalize a raw discord.js message into a Stratos envelope (kept for context tagging). */
  normalizeRequest(discordMessage) {
    const { author, content, channel, guild } = discordMessage;
    const isolatedContextTag = guild
      ? `discord-context-guild_${guild.id}-channel_${channel.id}`
      : `discord-context-direct-user_${author.id}`;
    return {
      protocol: 'omni-acp-v1', channel: 'discord', sender: author.username || author.id, text: content,
      timestamp: Date.now(), messageId: discordMessage.id || crypto.randomBytes(16).toString('hex'),
      sessionMeta: { isolatedContextTag, platformMeta: { guildId: guild ? guild.id : null, channelId: channel.id, authorId: author.id } },
    };
  }
}
