/**
 * approval-flow.js — the channel-side half of the cost/ToS approval loop (Gap 4, #36).
 *
 * When a request would incur paid-model spend under costApproval:'ask', the gateway answers with HTTP 402
 *   { error:'approval_required', reason, options:['reroute-local'?, 'proceed-spend'], approvalToken,
 *     wouldSpendOn, estCostUsd, alternativeLocal }
 * Channels (Telegram/Discord/Slack/Matrix/Signal) didn't parse this, so the user just saw a dead
 * "(no response)". This is the SHARED, pure logic so every adapter handles it identically and is unit-
 * testable without a live gateway:
 *   - parseApprovalResponse(status, body): is this the 402 approval gate? pull out the fields.
 *   - formatApprovalPrompt(approval): the user-facing question + the words they can reply with.
 *   - interpretReply(text): map a reply to 'spend' | 'local' | 'cancel' | null (unrecognized).
 *   - replayHeaders(decision, token): the headers to replay the ORIGINAL request with (single-use token).
 *
 * The interactive per-user "pending approval" state + the actual replay live in each adapter's handler;
 * they all call these helpers so the behavior (and wording) is consistent across every channel.
 */

/** Detect + parse the gateway's 402 approval response. Returns { approvalRequired:false } otherwise. */
export function parseApprovalResponse(status, body) {
  if (status !== 402 || !body || body.error !== 'approval_required') return { approvalRequired: false };
  return {
    approvalRequired: true,
    reason: typeof body.reason === 'string' ? body.reason : 'This request would use a paid model.',
    wouldSpendOn: body.wouldSpendOn || null,
    estCostUsd: body.estCostUsd ?? null,
    alternativeLocal: body.alternativeLocal || null,
    options: Array.isArray(body.options) ? body.options : [],
    token: typeof body.approvalToken === 'string' && body.approvalToken ? body.approvalToken : null,
  };
}

// Reply intent — checked cancel → local → spend so an explicit "cancel"/"local" never reads as "spend".
const REPLY = {
  cancel: /^\s*(cancel|stop|abort|nvm|never\s?mind|no thanks)\b/i,
  local: /^\s*(local|free|reroute|cheaper?|use local)\b/i,
  spend: /^\s*(approve|approved|spend|yes\b|proceed|pay|confirm|go ahead|ok\b)/i,
};

/** Map a user's free-text reply to a decision. Returns 'spend' | 'local' | 'cancel' | null (unclear). */
export function interpretReply(text) {
  const t = String(text || '');
  if (REPLY.cancel.test(t)) return 'cancel';
  if (REPLY.local.test(t)) return 'local';
  if (REPLY.spend.test(t)) return 'spend';
  return null;
}

/** The user-facing approval question, listing only the options the gateway actually offered. */
export function formatApprovalPrompt(approval) {
  const cost = approval.estCostUsd != null ? ` (~$${approval.estCostUsd})` : '';
  const model = approval.wouldSpendOn ? ` "${approval.wouldSpendOn}"` : '';
  const opts = [];
  if (approval.options.includes('proceed-spend')) opts.push('“approve” to spend');
  if (approval.options.includes('reroute-local') && approval.alternativeLocal) opts.push(`“local” for free ${approval.alternativeLocal}`);
  opts.push('“cancel” to drop it');
  return `⚠️ This needs a paid model${model}${cost}. ${approval.reason}\nReply ${opts.join(' · ')}.`;
}

/** Headers to replay the original request with. 'spend' needs the single-use token; 'local' is free. */
export function replayHeaders(decision, token) {
  if (decision === 'spend') return token ? { 'x-stratos-route': 'proceed-spend', 'x-stratos-approval': token } : null;
  if (decision === 'local') return { 'x-stratos-route': 'reroute-local' };
  return null; // cancel / unrecognized → no replay
}

/**
 * The shared, channel-agnostic agent turn with the cost-approval loop. Every adapter's dispatch() calls
 * this so the 402 handshake behaves identically everywhere. State (the per-sender pending approval) lives
 * in the caller's `pending` Map; everything else is injected so this stays pure + unit-testable:
 *   - askAgent(text, headers?) → a reply string, OR { approval } when the gateway answered 402.
 *   - send(text) → deliver a message on the channel.   - chunk(text) → split a long reply.
 *   - typing?() → optional "typing…" indicator before a real answer.
 *
 * Flow: a fresh request that hits a 402 stores the pending approval + asks the human; the human's next
 * message ("approve"/"local"/"cancel") replays the ORIGINAL request with the right header (single-use
 * token for spend) or cancels. Deny-by-default: an unrecognized reply re-asks without spending.
 */
export async function dispatchAgentTurn({ pending, sender, text, askAgent, send, chunk, typing }) {
  const pend = pending.get(sender);

  // (A) the user is answering a prior approval prompt
  if (pend) {
    const choice = interpretReply(text);
    if (choice === 'cancel') { pending.delete(sender); await send('Okay — cancelled. Nothing was sent to a paid model.'); return; }
    if (!choice) { await send('Please reply “approve” to spend, “local” for a free local model, or “cancel”.'); return; } // keep pending
    const headers = replayHeaders(choice, pend.token);
    pending.delete(sender);
    if (!headers) { await send('That approval expired — please send your request again.'); return; }
    if (typing) await typing();
    const result = await askAgent(pend.text, headers);
    if (result && result.approval) { await send('Could not complete that — please send your request again.'); return; }
    for (const part of chunk(String(result ?? ''))) await send(part);
    return;
  }

  // (B) a fresh request
  if (typing) await typing();
  const result = await askAgent(text);
  if (result && result.approval) {
    pending.set(sender, { text, token: result.approval.token });
    await send(formatApprovalPrompt(result.approval));
    return;
  }
  for (const part of chunk(String(result ?? ''))) await send(part);
}
