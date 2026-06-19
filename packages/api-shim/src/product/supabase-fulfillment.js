/**
 * supabase-fulfillment.js — the FULFILLMENT SINK that writes the console's source of truth.
 *
 * STRIPE_PROVISIONING_PLAN.md — fulfillment side. On a VERIFIED paid event the provisioning service
 * recomputes the entitlement (subscription-state.js) and upserts the bridge-local record; THIS sink
 * additionally mirrors that same recompute result into the Supabase `subscriptions` row that the
 * website `/app` console reads (efficientlabs-web: lib/supabase.ts → `subscriptions`). So whichever
 * webhook-of-record the founder picks (bridge OR website), the console reflects the SAME truth.
 *
 * SCOPE LINE (mirrors the rest of the rail): this module holds NO secret at import time and speaks to
 * Supabase ONLY through the injected url + service-role key. It writes the recompute RESULT, never an
 * event delta — so a late/out-of-order webhook can never regress the row (the bridge record is the
 * truth path; this is its mirror).
 *
 * FAIL LOUD, NEVER SILENT (plan + task §3): if Supabase creds are absent, createSupabaseFulfillment
 * returns a sink whose write() THROWS — the caller (provisioning-service mount) turns that into a 5xx
 * so Stripe RETRIES and the founder sees the misconfig in the log. A fulfillment sink that silently
 * no-ops would let a paid user look unpaid in the console; that is exactly the failure this refuses.
 *
 * No SDK: we use the Supabase PostgREST REST surface over the existing node-fetch dep (no new package,
 * no new audit surface). The service-role key is sent ONLY as a header to the configured Supabase URL;
 * it is NEVER logged (errors log status + body only, never the key).
 */

/** The Supabase `subscriptions` row shape the website console reads. Kept minimal + explicit so the
 *  coordination contract with efficientlabs-web is visible in one place. `subject` is the upsert key
 *  (the Stripe customer / account id — the same subject the bridge record uses). */
function rowFromRecord(record, now) {
  return {
    subject: record.subject,
    tier: record.tier || 'free_forever',
    state: record.state || 'canceled',
    grant: record.grant === true,
    price_id: record.price_id || null,
    seats: record.seats ?? null,
    interval: record.interval || null,
    expires_at: record.expires_at ? new Date(record.expires_at).toISOString() : null,
    namespaces: Array.isArray(record.namespaces) ? record.namespaces : [],
    updated_at: new Date(now).toISOString(),
  };
}

/**
 * Create the Supabase fulfillment sink.
 *
 * @param {object} opts
 *   url        : Supabase project URL (e.g. https://xxxx.supabase.co). REQUIRED to go live.
 *   serviceKey : the SERVICE-ROLE key (server-side only; bypasses RLS to upsert). REQUIRED.
 *   table      : table name (default 'subscriptions' — the console's source of truth).
 *   onConflict : upsert conflict column (default 'subject').
 *   fetchImpl  : injected fetch (defaults to global fetch); tests inject a fake.
 *   now        : clock.
 *
 * @returns {{ enabled:boolean, write:(record:object)=>Promise<void> }}
 *   enabled === false  → no creds configured. write() THROWS (fail loud) — the mount turns this into
 *                        5xx so the event is NOT acked and the founder sees it. NEVER a silent no-op.
 *   enabled === true   → write() upserts the row or THROWS on any non-2xx (→ 5xx → Stripe retries).
 */
export function createSupabaseFulfillment(opts = {}) {
  const url = (opts.url || '').replace(/\/+$/, '');
  const serviceKey = opts.serviceKey || '';
  const table = opts.table || 'subscriptions';
  const onConflict = opts.onConflict || 'subject';
  const now = opts.now || Date.now;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);

  const enabled = !!(url && serviceKey);

  async function write(record) {
    if (!record || typeof record.subject !== 'string' || !record.subject) {
      throw new Error('supabase-fulfillment: record requires a string subject');
    }
    if (!enabled) {
      // FAIL LOUD: a verified paid event reached fulfillment but the console mirror is unconfigured.
      // We throw so the caller returns 5xx (Stripe retries) and the founder sees a loud misconfig —
      // never a silent success that would leave the console showing the user as unpaid.
      throw new Error('supabase-fulfillment: Supabase creds absent (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) — refusing to silently drop the console write');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('supabase-fulfillment: no fetch implementation available');
    }
    const endpoint = `${url}/rest/v1/${encodeURIComponent(table)}?on_conflict=${encodeURIComponent(onConflict)}`;
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'authorization': `Bearer ${serviceKey}`,
        'content-type': 'application/json',
        // merge-duplicates → upsert on the conflict column; return nothing (no row echoed back).
        'prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([rowFromRecord(record, now())]),
    });
    if (!res || res.status < 200 || res.status >= 300) {
      let body = '';
      try { body = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      // Log status + body ONLY (never the key/headers). Throw → 5xx → Stripe retries → loud, not lost.
      const status = res ? res.status : 'no-response';
      throw new Error(`supabase-fulfillment: upsert failed (status ${status}): ${body}`);
    }
  }

  return { enabled, write };
}
