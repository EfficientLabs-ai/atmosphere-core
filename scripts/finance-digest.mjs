#!/usr/bin/env node
/**
 * finance-digest.mjs — the council's FIRST business-automation piece: the "cheapest proof of the
 * self-running loop." A scheduled one-shot that reads Stripe (read-only) and sends the founder a
 * concise daily finance digest on Telegram. The founder is an OBSERVER, not an operator.
 *
 * SECURITY CONTRACT (mirrors the rest of this repo — Codex-reviewed two-tier model):
 *  - Secrets are read ONLY via the existing vault pattern (.secrets-vault/env_blueprint.md table
 *    rows), exactly like TelegramBridge reads TELEGRAM_BOT_TOKEN. The Stripe key and bot token are
 *    NEVER printed, echoed, logged, or placed in argv. If a key is absent we exit cleanly with a
 *    plain message — no crash, no secret echo, no fabricated number.
 *  - OWNER-ONLY: the digest is sent to the bound owner chat id (getOwner(): STRATOS_OWNER_CHAT_ID
 *    env wins, else runtime-state.json ownerChatId). If the owner isn't bound or the bot token is
 *    missing, we exit cleanly and send NOTHING — never to a wrong/unset chat.
 *  - HONEST DATA ONLY: every figure is real Stripe REST data. If an endpoint errors, that line reads
 *    "unavailable" — we never invent a number.
 *  - FAIL-SAFE everywhere: any network/parse failure degrades to an honest line, never a throw into
 *    a partial/false send.
 *
 * USAGE:
 *   node scripts/finance-digest.mjs            # build digest from Stripe, SEND to owner on Telegram
 *   node scripts/finance-digest.mjs --dry-run  # build digest, PRINT to stdout, send NOTHING (safe test)
 *
 * SCHEDULING (daily): see the block at the bottom of this file + DELIVERABLE notes.
 *
 * No heavy deps: Stripe REST is called directly with global fetch (Node 22). No stripe SDK, no
 * node-telegram-bot-api here (we POST sendMessage over the Bot API directly — a one-shot needs no
 * polling daemon).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const STRIPE_API = 'https://api.stripe.com/v1';
const TELEGRAM_API = 'https://api.telegram.org';

// F4-style escape: stray <, >, & in any dynamic text can't break HTML entity parsing on Telegram.
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Read a secret from the SAME vault mechanism TelegramBridge uses: a markdown table row
 * `| `KEY` | value |` in .secrets-vault/env_blueprint.md. Env var wins (so a daemon/cron can inject
 * it without touching the file). Returns null if absent or still a `PASTE_…` placeholder.
 * NEVER logs the value.
 */
export function readVaultSecret(name, { env = process.env, cwd = process.cwd() } = {}) {
  if (env[name] && !String(env[name]).startsWith('PASTE_')) return env[name];
  try {
    const vaultPath = path.join(cwd, '.secrets-vault', 'env_blueprint.md');
    if (!fs.existsSync(vaultPath)) return null;
    const content = fs.readFileSync(vaultPath, 'utf8');
    // Match a table row: | `NAME` | <value> |  (value is a single token, no spaces/pipes)
    const re = new RegExp('\\|\\s*`' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`\\s*\\|\\s*([^\\s|]+)\\s*\\|');
    const match = content.match(re);
    if (match && match[1] && !match[1].startsWith('PASTE_')) return match[1];
  } catch { /* fail-safe: treat as absent */ }
  return null;
}

const fmtMoney = (cents, currency = 'usd') => {
  const n = (Number(cents) || 0) / 100;
  const sym = currency.toLowerCase() === 'usd' ? '$' : '';
  return `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${sym ? '' : ' ' + currency.toUpperCase()}`;
};

/**
 * Thin Stripe REST GET. Returns { ok:true, data } or { ok:false } — NEVER throws. The Authorization
 * header carries the key but is never logged. `fetchImpl` is injectable for hermetic tests.
 */
async function stripeGet(pathAndQuery, key, fetchImpl) {
  try {
    const res = await fetchImpl(`${STRIPE_API}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res || !res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

/**
 * Pull a small, HONEST digest from Stripe REST. Each section independently degrades to
 * `available:false` on any error, so one broken endpoint never fabricates or blocks the others.
 *
 * @returns a plain object describing real-shaped data (also the unit-test surface).
 */
export async function buildDigest({ key, fetchImpl = fetch, now = Date.now() } = {}) {
  const sinceUnix = Math.floor((now - 24 * 60 * 60 * 1000) / 1000);

  const digest = {
    balance: { available: false, byCurrency: {} },
    charges24h: { available: false, count: 0, gross: 0, fees: 0, net: 0, currency: 'usd' },
    customers24h: { available: false, count: 0 },
    subscriptions: { available: false, active: 0, mrrCents: 0, currency: 'usd' },
  };

  // 1) Account balance (available + pending, by currency)
  {
    const r = await stripeGet('/balance', key, fetchImpl);
    if (r.ok && r.data) {
      const by = {};
      for (const a of r.data.available || []) {
        const c = (a.currency || 'usd').toLowerCase();
        by[c] = by[c] || { available: 0, pending: 0 };
        by[c].available += a.amount || 0;
      }
      for (const p of r.data.pending || []) {
        const c = (p.currency || 'usd').toLowerCase();
        by[c] = by[c] || { available: 0, pending: 0 };
        by[c].pending += p.amount || 0;
      }
      digest.balance = { available: true, byCurrency: by };
    }
  }

  // 2) Charges in the last 24h: count + gross + (net of fees if the balance_transaction expands)
  {
    const r = await stripeGet(
      `/charges?created[gte]=${sinceUnix}&limit=100&expand[]=data.balance_transaction`,
      key, fetchImpl,
    );
    if (r.ok && Array.isArray(r.data?.data)) {
      let count = 0, gross = 0, fees = 0, net = 0, currency = 'usd';
      for (const ch of r.data.data) {
        if (ch.paid && ch.status === 'succeeded') {
          count++;
          gross += ch.amount || 0;
          currency = (ch.currency || currency).toLowerCase();
          const bt = ch.balance_transaction;
          if (bt && typeof bt === 'object') { fees += bt.fee || 0; net += bt.net || 0; }
        }
      }
      // If fees never expanded (older charges/permissions), fall back to gross for net and flag fees=0.
      if (net === 0 && fees === 0 && gross > 0) net = gross;
      digest.charges24h = { available: true, count, gross, fees, net, currency };
    }
  }

  // 3) New customers in the last 24h
  {
    const r = await stripeGet(`/customers?created[gte]=${sinceUnix}&limit=100`, key, fetchImpl);
    if (r.ok && Array.isArray(r.data?.data)) {
      digest.customers24h = { available: true, count: r.data.data.length };
    }
  }

  // 4) Active subscriptions + simple MRR (sum of plan.amount per active sub, normalized to monthly)
  {
    const r = await stripeGet('/subscriptions?status=active&limit=100&expand[]=data.items', key, fetchImpl);
    if (r.ok && Array.isArray(r.data?.data)) {
      let active = 0, mrr = 0, currency = 'usd';
      for (const sub of r.data.data) {
        active++;
        const items = sub.items?.data || [];
        for (const it of items) {
          const price = it.price || it.plan || {};
          const amt = price.unit_amount ?? price.amount ?? 0;
          const qty = it.quantity || 1;
          const interval = price.recurring?.interval || price.interval || 'month';
          const intervalCount = price.recurring?.interval_count || price.interval_count || 1;
          currency = (price.currency || currency).toLowerCase();
          // normalize to a monthly figure
          let monthly = amt * qty;
          if (interval === 'year') monthly = monthly / (12 * intervalCount);
          else if (interval === 'week') monthly = (monthly * 52) / (12 * intervalCount);
          else if (interval === 'day') monthly = (monthly * 365) / (12 * intervalCount);
          else monthly = monthly / intervalCount; // month
          mrr += monthly;
        }
      }
      digest.subscriptions = { available: true, active, mrrCents: Math.round(mrr), currency };
    }
  }

  return digest;
}

/** Format the digest into a tight, honest Telegram HTML message. Pure (no I/O) — unit-tested. */
export function formatDigest(d, { date = new Date() } = {}) {
  const day = date.toISOString().slice(0, 10);
  const lines = [`<b>Efficient Labs · daily finance</b> — ${escapeHtml(day)}`];

  // Balance
  if (d.balance.available) {
    const parts = Object.entries(d.balance.byCurrency).map(
      ([cur, v]) => `${fmtMoney(v.available, cur)} avail / ${fmtMoney(v.pending, cur)} pending`,
    );
    lines.push(`• <b>Balance:</b> ${parts.length ? parts.join(' · ') : '$0.00 avail / $0.00 pending'}`);
  } else {
    lines.push('• <b>Balance:</b> <i>unavailable</i>');
  }

  // 24h charges
  if (d.charges24h.available) {
    const c = d.charges24h;
    let s = `• <b>24h:</b> ${c.count} charge${c.count === 1 ? '' : 's'}, ${fmtMoney(c.gross, c.currency)} gross`;
    if (c.fees > 0) s += ` (${fmtMoney(c.net, c.currency)} net, ${fmtMoney(c.fees, c.currency)} fees)`;
    lines.push(s);
  } else {
    lines.push('• <b>24h charges:</b> <i>unavailable</i>');
  }

  // New customers
  if (d.customers24h.available) {
    lines.push(`• <b>New customers (24h):</b> ${d.customers24h.count}`);
  } else {
    lines.push('• <b>New customers (24h):</b> <i>unavailable</i>');
  }

  // Subscriptions / MRR
  if (d.subscriptions.available) {
    const s = d.subscriptions;
    if (s.active > 0) {
      lines.push(`• <b>Subscriptions:</b> ${s.active} active · ${fmtMoney(s.mrrCents, s.currency)} MRR`);
    } else {
      lines.push('• <b>Subscriptions:</b> none active');
    }
  } else {
    lines.push('• <b>Subscriptions:</b> <i>unavailable</i>');
  }

  lines.push('<i>read-only · you are the observer, not the operator</i>');
  return lines.join('\n');
}

/**
 * Send an HTML message to the OWNER chat via the Telegram Bot API directly (no polling daemon).
 * Returns { sent:true } or { sent:false, reason }. NEVER logs the token. `fetchImpl` injectable.
 */
export async function sendToOwner(text, { token, ownerChatId, fetchImpl = fetch } = {}) {
  if (!token) return { sent: false, reason: 'no-token' };
  if (!ownerChatId) return { sent: false, reason: 'no-owner' };
  try {
    const res = await fetchImpl(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(ownerChatId), text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res || !res.ok) return { sent: false, reason: `telegram-status-${res ? res.status : 'no-response'}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `telegram-error` };
  }
}

/**
 * Orchestrator. Returns a result object (also the integration-test surface). Side effects (stdout,
 * Telegram send) are gated on `dryRun` and on every fail-safe guard. Owner resolution is injected so
 * tests don't depend on a real .stratos-profile.
 */
export async function run({
  dryRun = false,
  env = process.env,
  cwd = ROOT,
  fetchImpl = fetch,
  getOwnerFn,
  now = Date.now(),
  log = console.log,
} = {}) {
  // 1) Stripe key — vault pattern. Absent → clean exit, no send, no secret echo.
  const stripeKey = readVaultSecret('STRIPE_SECRET_KEY', { env, cwd })
    || readVaultSecret('STRIPE_API_KEY', { env, cwd }); // tolerate either canonical name
  if (!stripeKey) {
    log('💤 [finance-digest] STRIPE key not configured (set STRIPE_SECRET_KEY in the vault). Nothing sent.');
    return { ok: false, reason: 'no-stripe-key', sent: false };
  }

  // 2) Build the honest digest from Stripe REST.
  const digest = await buildDigest({ key: stripeKey, fetchImpl, now });
  const message = formatDigest(digest, { date: new Date(now) });

  // 3) --dry-run: print to stdout (NO secrets) and send NOTHING.
  if (dryRun) {
    log('— finance-digest (dry-run, NOT sent) —');
    log(message);
    return { ok: true, dryRun: true, sent: false, digest, message };
  }

  // 4) Resolve owner + bot token from the SAME mechanisms the bridge uses. Either missing → clean exit.
  let ownerChatId = null;
  try {
    if (getOwnerFn) ownerChatId = getOwnerFn(env);
    else {
      const cfg = await import('../packages/stratos-agent/src/core/agent-config.js');
      ownerChatId = cfg.getOwner(env);
    }
  } catch { ownerChatId = env.STRATOS_OWNER_CHAT_ID || null; }

  if (!ownerChatId) {
    log('💤 [finance-digest] No owner bound (set STRATOS_OWNER_CHAT_ID or run `stratos-ctl bind`). Nothing sent.');
    return { ok: false, reason: 'no-owner', sent: false, digest, message };
  }

  const botToken = readVaultSecret('TELEGRAM_BOT_TOKEN', { env, cwd });
  if (!botToken) {
    log('💤 [finance-digest] No TELEGRAM_BOT_TOKEN configured. Nothing sent.');
    return { ok: false, reason: 'no-token', sent: false, digest, message };
  }

  // 5) Send owner-only.
  const send = await sendToOwner(message, { token: botToken, ownerChatId, fetchImpl });
  if (send.sent) {
    log('✅ [finance-digest] Digest sent to owner.');
    return { ok: true, sent: true, digest, message };
  }
  log(`⚠️  [finance-digest] Send failed (${send.reason}). Nothing else done.`);
  return { ok: false, reason: send.reason, sent: false, digest, message };
}

// ---- CLI entrypoint --------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((r) => process.exit(r.ok || r.dryRun ? 0 : (r.reason === 'no-stripe-key' || r.reason === 'no-owner' || r.reason === 'no-token' ? 0 : 1)))
    .catch((e) => { console.error('finance-digest fatal:', e.message); process.exit(1); });
}

/*
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 * SCHEDULING — daily, mirroring the repo's existing cron discipline (gsi-scheduler uses node-cron
 * "0 2 * * *"). This one-shot is intentionally NOT a long-lived node-cron daemon — it runs, sends,
 * and exits, so a system/tmux cron is the cleanest fit and survives a daemon restart.
 *
 * Option A — system crontab (recommended; one line). Sends every day at 08:00 local:
 *   0 8 * * *  cd /home/neo/atmosphere-core && /usr/bin/node scripts/finance-digest.mjs >> /home/neo/atmosphere-core/.secrets-vault/finance-digest.log 2>&1
 *   (the cwd must be the repo root so the vault + .stratos-profile resolve; do NOT pass any secret on
 *    the command line — the script reads them from the vault itself.)
 *
 * Option B — this env already runs a persistent tmux Claude + CronCreate/supervisor-cron. Register a
 * daily job there with the same command; the supervisor keeps it alive across reboots.
 *
 * Before turning it on: dry-run first to confirm formatting with no send —
 *   node scripts/finance-digest.mjs --dry-run
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 */
