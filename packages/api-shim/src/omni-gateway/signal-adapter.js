import { spawn } from 'node:child_process';
import fetch from 'node-fetch';

/**
 * SignalAdapter — a REAL two-way Signal channel for StratosAgent (new). The MOST sovereign chat channel:
 * Signal is end-to-end encrypted and this connects OUTWARD via signal-cli (no webhook, no inbound port).
 *
 * Prerequisite (documented, like Ollama for local models): `signal-cli` installed + your number registered
 * (`signal-cli -a +NUMBER register` then verify). There is no bot token — auth is the registered account's
 * local keystore that signal-cli manages. So config holds the bot NUMBER (not a secret) + the owner number.
 *
 * The adapter runs signal-cli in JSON-RPC mode over stdio: incoming messages arrive as `receive`
 * notifications; replies go out as `send` requests. The decision/chunk/routing LOGIC is pure + unit-tested;
 * the live connection lazy-spawns signal-cli, so the module + tests load without it.
 */
const SIGNAL_LIMIT = 2000;

export class SignalAdapter {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.number = options.number || process.env.SIGNAL_NUMBER || null;     // the agent's Signal number (+E.164)
    this.ownerId = options.ownerId || process.env.SIGNAL_OWNER_ID || null; // only this number may command it
    // Fail CLOSED: no owner ⇒ serve nobody unless an open bot is explicitly opted into (SIGNAL_ALLOW_ANYONE=1).
    this.allowAnyone = options.allowAnyone === true || process.env.SIGNAL_ALLOW_ANYONE === '1';
    this.cliPath = options.cliPath || process.env.SIGNAL_CLI_PATH || 'signal-cli';
    this.port = options.port || process.env.PORT || 4099;
    this.model = options.model || process.env.STRATOS_MODEL || 'local';
    this._fetch = options.fetch || fetch; // injectable for tests
    this.proc = null;
    this._id = 0;
  }

  /** PURE: decide whether to handle a normalized envelope + extract the prompt. Deny-by-default. */
  shouldHandle(env) {
    const dm = env?.dataMessage;
    if (!dm || dm.message == null) return { handle: false, reason: 'not a text message' };
    const sender = env.sourceNumber || env.source;
    if (this.number && sender === this.number) return { handle: false, reason: 'own message' };
    if (!this.ownerId) { if (!this.allowAnyone) return { handle: false, reason: 'no owner configured (set SIGNAL_OWNER_ID, or SIGNAL_ALLOW_ANYONE=1 for an open bot)' }; }
    else if (sender !== this.ownerId) return { handle: false, reason: 'not the owner' };
    const text = String(dm.message).trim();
    if (!text) return { handle: false, reason: 'empty' };
    return { handle: true, text, sender };
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

  static chunk(text, max = SIGNAL_LIMIT) {
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

  /** Send a reply via signal-cli JSON-RPC. */
  send(recipient, message) {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++this._id, method: 'send', params: { recipient: [recipient], message } }) + '\n');
  }

  /** Spawn signal-cli in JSON-RPC mode and serve. No-op (safe) if the number/binary is missing. */
  async start() {
    if (!this.number) {
      if (this.verbose) console.warn('⚠️  [Signal] No SIGNAL_NUMBER configured — adapter disabled (dry-run).');
      return false;
    }
    try {
      this.proc = spawn(this.cliPath, ['-a', this.number, 'jsonRpc'], { stdio: ['pipe', 'pipe', 'inherit'] });
    } catch (e) {
      if (this.verbose) console.warn('⚠️  [Signal] could not spawn signal-cli:', e.message);
      return false;
    }
    this.proc.on('error', (e) => { if (this.verbose) console.warn('⚠️  [Signal] signal-cli not available (install it + register your number):', e.message); });
    let buf = '';
    this.proc.stdout.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method !== 'receive' || !msg.params?.envelope) continue;
        try {
          const decision = this.shouldHandle(msg.params.envelope);
          if (!decision.handle) continue;
          const reply = await this.askAgent(decision.text);
          for (const part of SignalAdapter.chunk(reply)) this.send(decision.sender, part);
        } catch (e) { if (this.verbose) console.error('❌ [Signal] handler error:', e.message); }
      }
    });
    if (this.verbose) console.log(`💬 [Signal] Connected via signal-cli as ${this.number}`);
    return true;
  }

  async stop() { try { this.proc?.kill(); } catch { /* */ } }
}
