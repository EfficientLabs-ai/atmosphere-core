/**
 * approval-flow tests (Gap 4, #36) — the pure channel-side cost-approval logic that every adapter shares.
 */
import assert from 'node:assert';
import { parseApprovalResponse, interpretReply, formatApprovalPrompt, replayHeaders, dispatchAgentTurn, convKey } from './src/omni-gateway/approval-flow.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

const body402 = {
  error: 'approval_required', reason: 'would incur API spend', wouldSpendOn: 'claude-3-5-sonnet',
  estCostUsd: 0.03, alternativeLocal: 'qwen2.5:7b', options: ['reroute-local', 'proceed-spend'],
  approvalToken: 'tok-abc123',
};

console.log('=== parseApprovalResponse: only a real 402 approval gate is an approval ===');
const a = parseApprovalResponse(402, body402);
ok(a.approvalRequired === true && a.token === 'tok-abc123' && a.wouldSpendOn === 'claude-3-5-sonnet', 'a 402 approval_required is parsed with its token + model');
ok(parseApprovalResponse(200, { choices: [{ message: { content: 'hi' } }] }).approvalRequired === false, 'a normal 200 completion is NOT an approval');
ok(parseApprovalResponse(402, { error: 'something else' }).approvalRequired === false, 'a 402 that is not approval_required is ignored');
ok(parseApprovalResponse(402, { error: 'approval_required' }).token === null, 'a missing token parses as null (caller must not replay spend without one)');

console.log('\n=== interpretReply: DENY-BY-DEFAULT toward spend (Codex #36) ===');
ok(interpretReply('approve') === 'spend', '“approve” → spend');
ok(interpretReply('ok') === 'spend' && interpretReply('yes') === 'spend', 'bare “ok”/“yes” → spend (exact affirmation)');
ok(interpretReply('local') === 'local', '“local” → local');
ok(interpretReply('use local model') === 'local', '“use local” → local');
ok(interpretReply('cancel') === 'cancel', '“cancel” → cancel');
ok(interpretReply('no thanks') === 'cancel', '“no thanks” → cancel');
// the ambiguous/mixed replies that used to spend:
ok(interpretReply('ok cancel') === 'cancel', '“ok cancel” → cancel (cancel wins, NEVER spends)');
ok(interpretReply('yes use local') === 'local', '“yes use local” → local (local wins, no spend)');
ok(interpretReply('ok thanks') === null, '“ok thanks” → null (not an exact affirmation → re-ask, no spend)');
ok(interpretReply('yes but wait') === null, '“yes but wait” → null (re-ask, no spend)');
ok(interpretReply('what is the weather') === null, 'an unrelated reply → null');
ok(interpretReply('') === null, 'empty → null');

console.log('\n=== formatApprovalPrompt: lists only the offered options, names cost + model ===');
const prompt = formatApprovalPrompt(a);
ok(/claude-3-5-sonnet/.test(prompt) && /\$0\.03/.test(prompt), 'prompt names the paid model + est cost');
ok(/approve/.test(prompt) && /local/.test(prompt) && /qwen2\.5:7b/.test(prompt) && /cancel/.test(prompt), 'prompt lists approve + local(alt) + cancel');
const spendOnly = formatApprovalPrompt(parseApprovalResponse(402, { ...body402, options: ['proceed-spend'], alternativeLocal: null }));
ok(/approve/.test(spendOnly) && !/“local”/.test(spendOnly), 'when no local alternative is offered, the prompt omits the local option');

console.log('\n=== replayHeaders: spend needs the token, local is free, cancel replays nothing ===');
ok(JSON.stringify(replayHeaders('spend', 'tok-abc123')) === JSON.stringify({ 'x-stratos-route': 'proceed-spend', 'x-stratos-approval': 'tok-abc123' }), 'spend → proceed-spend + approval token header');
ok(replayHeaders('spend', null) === null, 'spend with NO token → null (cannot force spend without the minted token)');
ok(JSON.stringify(replayHeaders('local')) === JSON.stringify({ 'x-stratos-route': 'reroute-local' }), 'local → reroute-local header (no token needed, it is free)');
ok(replayHeaders('cancel', 'tok') === null && replayHeaders(null, 'tok') === null, 'cancel / unrecognized → no replay');

console.log('\n=== dispatchAgentTurn: the full 402 handshake (every adapter shares this) ===');
// askAgent stub: a fresh call (no headers) → 402 approval; a replay (with headers) → the real answer.
const makeAskAgent = () => { const calls = []; return { calls, fn: async (text, headers) => { calls.push({ text, headers }); return headers ? `answered: ${text}` : { approval: parseApprovalResponse(402, body402) }; } }; };

{ // (1) fresh paid request → stores pending + asks the human (no spend yet)
  const pending = new Map(); const sent = []; const aa = makeAskAgent();
  await dispatchAgentTurn({ pending, key: 'u1@chanA', text: 'write a plan', askAgent: aa.fn, send: (t) => sent.push(t), chunk: (s) => [s] });
  ok(aa.calls.length === 1 && !aa.calls[0].headers, 'fresh request calls the agent WITHOUT replay headers (no forced spend)');
  ok(pending.has('u1@chanA') && pending.get('u1@chanA').token === 'tok-abc123', 'the pending approval (with its token) is stored for the user');
  ok(sent.length === 1 && /paid model/.test(sent[0]), 'the user is asked to approve, not silently charged');
}
{ // (2) user replies "approve" → replays with the spend token → gets the answer
  const pending = new Map([['u1@chanA', { text: 'write a plan', token: 'tok-abc123' }]]); const sent = []; const aa = makeAskAgent();
  await dispatchAgentTurn({ pending, key: 'u1@chanA', text: 'approve', askAgent: aa.fn, send: (t) => sent.push(t), chunk: (s) => [s] });
  ok(aa.calls.length === 1 && aa.calls[0].headers?.['x-stratos-approval'] === 'tok-abc123' && aa.calls[0].text === 'write a plan', 'approve → replays the ORIGINAL prompt with the single-use spend token');
  ok(sent.length === 1 && sent[0] === 'answered: write a plan' && !pending.has('u1@chanA'), 'the real answer is delivered + pending cleared');
}
{ // (3) user replies "local" → reroutes to a free local model (no token needed)
  const pending = new Map([['u1@chanA', { text: 'write a plan', token: 'tok-abc123' }]]); const sent = []; const aa = makeAskAgent();
  await dispatchAgentTurn({ pending, key: 'u1@chanA', text: 'local', askAgent: aa.fn, send: (t) => sent.push(t), chunk: (s) => [s] });
  ok(aa.calls[0].headers?.['x-stratos-route'] === 'reroute-local' && !aa.calls[0].headers?.['x-stratos-approval'], 'local → reroute-local header, no spend token');
  ok(sent[0] === 'answered: write a plan' && !pending.has('u1@chanA'), 'answered via local + pending cleared');
}
{ // (4) user replies "cancel" → nothing sent to the agent, pending cleared
  const pending = new Map([['u1@chanA', { text: 'write a plan', token: 'tok-abc123' }]]); const sent = []; const aa = makeAskAgent();
  await dispatchAgentTurn({ pending, key: 'u1@chanA', text: 'cancel', askAgent: aa.fn, send: (t) => sent.push(t), chunk: (s) => [s] });
  ok(aa.calls.length === 0 && !pending.has('u1@chanA') && /cancel/i.test(sent[0]), 'cancel → agent NOT called, pending cleared, user told');
}
{ // (5) unrecognized reply → re-asks, keeps pending (deny-by-default, no spend)
  const pending = new Map([['u1@chanA', { text: 'write a plan', token: 'tok-abc123' }]]); const sent = []; const aa = makeAskAgent();
  await dispatchAgentTurn({ pending, key: 'u1@chanA', text: 'maybe?', askAgent: aa.fn, send: (t) => sent.push(t), chunk: (s) => [s] });
  ok(aa.calls.length === 0 && pending.has('u1@chanA') && /approve.*local.*cancel/is.test(sent[0]), 'an unclear reply → re-asks, keeps pending, never spends');
}
{ // (6) a normal (free/local) request just answers — no approval involved
  const pending = new Map(); const sent = [];
  await dispatchAgentTurn({ pending, key: 'u1@chanA', text: 'hi', askAgent: async () => 'hello there', send: (t) => sent.push(t), chunk: (s) => [s] });
  ok(sent.length === 1 && sent[0] === 'hello there' && !pending.has('u1@chanA'), 'a non-paid request answers directly, no approval prompt');
}

console.log('\n=== convKey: distinct conversations never collapse; missing non-DM id fails safe (Codex #36) ===');
ok(convKey('u1', 'chanA') === 'u1@chanA' && convKey('u1', 'chanB') === 'u1@chanB', 'two channels → two distinct keys');
ok(convKey('u1', 'chanA') !== convKey('u2', 'chanA'), 'two users in the same channel → distinct keys');
ok(convKey('u1', null, true) === 'u1@dm', 'a DM with no channel id → user@dm (1:1, safe)');
ok(convKey('u1', null, false) === '' && convKey('u2', null, false) === '', 'a NON-DM with no conversation id → EMPTY key (never a shared bucket)');
{ // an empty key must NOT queue a pending (so a later approve can never replay it)
  const pending = new Map(); const sent = []; const aa = makeAskAgent();
  await dispatchAgentTurn({ pending, key: convKey('u1', undefined, false), text: 'paid', askAgent: aa.fn, send: (t) => sent.push(t), chunk: (s) => [s] });
  ok(pending.size === 0 && /paid model/.test(sent[0]), 'a 402 with no resolvable conversation → prompt shown but NOTHING queued (fail-safe)');
}

console.log('\n=== conversation isolation (Codex #36): a 402 in channel A is NOT consumable from channel B ===');
{ // same USER, two conversations. The pending approval belongs to chanA; an "approve" in chanB must NOT replay it.
  const pending = new Map([['u1@chanA', { text: 'paid prompt in A', token: 'tok-A' }]]); const sent = []; const aa = makeAskAgent();
  await dispatchAgentTurn({ pending, key: 'u1@chanB', text: 'approve', askAgent: aa.fn, send: (t) => sent.push(t), chunk: (s) => [s] });
  ok(!aa.calls.some((c) => c.text === 'paid prompt in A'), 'the chanA paid prompt is NEVER replayed from chanB');
  ok(pending.has('u1@chanA') && pending.get('u1@chanA').token === 'tok-A', 'the chanA pending approval is untouched by chanB activity');
  ok(pending.has('u1@chanB'), 'chanB gets its OWN independent pending state (approve was a fresh request there)');
}

console.log(`\n✅ ALL ${pass} approval-flow checks passed.`);
