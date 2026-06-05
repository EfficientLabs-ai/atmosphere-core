#!/usr/bin/env node
/**
 * phone-setup.mjs — provision an ElevenLabs Conversational-AI agent that "calls" StratosAgent.
 *
 * Pattern (the same one ElevenLabs documented for Hermes): an ElevenLabs Conversational-AI Agent
 * handles the phone leg (Twilio/SIP + STT + TTS + turn-taking) and delegates the "brain" to a
 * Custom LLM that points at StratosAgent's OpenAI-compatible gateway
 * (POST {PUBLIC_GATEWAY_URL}/v1/chat/completions). The gateway is loopback-only, so it is reached
 * through an HTTPS tunnel (Tailscale Funnel or ngrok — see scripts/phone-tunnel.sh).
 *
 * This script ONLY talks to api.elevenlabs.io. It NEVER prints secret values. It:
 *   1. stores the gateway token as an ElevenLabs workspace secret ("stratos_gateway_token")
 *   2. creates (or updates) an agent whose LLM is custom-llm → {PUBLIC_GATEWAY_URL}/v1,
 *      authenticated with that stored secret, pinned to the FAST local model (gemma2:2b) so phone
 *      turns are answered in seconds (qwen2.5:7b on a CPU VPS is ~100s/turn — unusable on a call).
 *
 * Required env:
 *   ELEVENLABS_API_KEY    your ElevenLabs API key (xi-api-key). NEVER hardcode.
 *   PUBLIC_GATEWAY_URL    https base of the tunnel to 127.0.0.1:4099 (e.g. https://host.ts.net)
 *                         — WITHOUT a trailing /v1 (this script appends it).
 *   ATMOS_GATEWAY_SECRET  the gateway secret (same value the daemon runs with). Sent as the Custom
 *                         LLM's Bearer token; gateway accepts it via Authorization: Bearer.
 *
 * Optional env (idempotent-friendly — update instead of recreate):
 *   AGENT_ID              update this existing agent instead of creating a new one
 *   SECRET_ID             reuse this stored-secret id instead of creating a new secret
 *   PHONE_MODEL           override the pinned local model (default: gemma2:2b)
 *   AGENT_NAME            display name for the agent (default: "StratosAgent (Sovereign Phone)")
 *   ELEVENLABS_VOICE_ID   override the TTS voice (else ElevenLabs default)
 *
 * Usage:
 *   node scripts/phone-setup.mjs
 */

const API = 'https://api.elevenlabs.io';

function need(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`\n❌ Missing required env: ${name}`);
    console.error('   This script will not run without it (no keys are hardcoded).');
    console.error('   Required: ELEVENLABS_API_KEY, PUBLIC_GATEWAY_URL, ATMOS_GATEWAY_SECRET');
    console.error('   See docs/voice-phone-setup.md for the full runbook.\n');
    process.exit(1);
  }
  return String(v).trim();
}

async function elevenlabs(pathname, { method = 'GET', body, apiKey } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      'xi-api-key': apiKey,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    // Surface the API error WITHOUT echoing our request body (which carries no secrets here anyway,
    // since secrets are referenced by id — but be conservative).
    const detail = data?.detail || data?.message || data?.raw || `HTTP ${res.status}`;
    throw new Error(`ElevenLabs ${method} ${pathname} → ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return data;
}

async function main() {
  const ELEVENLABS_API_KEY = need('ELEVENLABS_API_KEY');
  const PUBLIC_GATEWAY_URL = need('PUBLIC_GATEWAY_URL').replace(/\/+$/, ''); // strip trailing slash
  const ATMOS_GATEWAY_SECRET = need('ATMOS_GATEWAY_SECRET');

  const PHONE_MODEL = (process.env.PHONE_MODEL || 'gemma2:2b').trim();
  const AGENT_NAME = (process.env.AGENT_NAME || 'StratosAgent (Sovereign Phone)').trim();
  const VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || '').trim();
  let SECRET_ID = (process.env.SECRET_ID || '').trim();
  const AGENT_ID = (process.env.AGENT_ID || '').trim();

  const llmUrl = `${PUBLIC_GATEWAY_URL}/v1`;
  console.log('🛰️  StratosAgent phone setup');
  console.log(`   Custom LLM url : ${llmUrl}  (api_type=chat_completions)`);
  console.log(`   Pinned model   : ${PHONE_MODEL}  (fast local — keeps turns ~seconds, not ~100s)`);
  console.log('   Gateway token  : (hidden — stored as ElevenLabs secret "stratos_gateway_token")');

  // ── 1) store the gateway token as a workspace secret (unless SECRET_ID provided) ───────────────
  if (!SECRET_ID) {
    console.log('\n→ Storing gateway token as ElevenLabs workspace secret…');
    const secret = await elevenlabs('/v1/convai/secrets', {
      method: 'POST',
      apiKey: ELEVENLABS_API_KEY,
      body: { name: 'stratos_gateway_token', value: ATMOS_GATEWAY_SECRET },
    });
    SECRET_ID = secret.secret_id || secret.id || secret.secretId;
    if (!SECRET_ID) throw new Error(`secret created but no secret_id in response: ${JSON.stringify(secret)}`);
    console.log(`   ✓ secret stored (secret_id captured; value not shown)`);
  } else {
    console.log(`\n→ Reusing provided SECRET_ID (value not shown).`);
  }

  // ── 2) build the agent conversation_config ────────────────────────────────────────────────────
  const firstMessage =
    'Hi, this is StratosAgent — running on your own hardware. How can I help?';
  const systemPrompt =
    'You are StratosAgent speaking over the phone — warm, concise, sovereign; you run on the ' +
    "caller's own hardware. You are private by default: nothing leaves their machine unless they " +
    'ask. Keep replies short and natural for voice — one or two sentences, no markdown, no lists. ' +
    'If something needs a long answer, offer to continue rather than monologue.';

  const agentConfig = {
    prompt: {
      prompt: systemPrompt,
      llm: 'custom-llm',
      custom_llm: {
        url: llmUrl,
        model_id: PHONE_MODEL, // pin the FAST local model on the gateway side
        api_type: 'chat_completions',
        api_key: { secret_id: SECRET_ID }, // gateway accepts this as Authorization: Bearer
      },
    },
    first_message: firstMessage,
    language: 'en',
  };

  const conversationConfig = {
    agent: agentConfig,
    ...(VOICE_ID ? { tts: { voice_id: VOICE_ID } } : {}),
  };

  // ── 3) create OR update the agent ─────────────────────────────────────────────────────────────
  let agentId = AGENT_ID;
  if (AGENT_ID) {
    console.log(`\n→ Updating existing agent ${AGENT_ID}…`);
    await elevenlabs(`/v1/convai/agents/${AGENT_ID}`, {
      method: 'PATCH',
      apiKey: ELEVENLABS_API_KEY,
      body: { name: AGENT_NAME, conversation_config: conversationConfig },
    });
    console.log('   ✓ agent updated');
  } else {
    console.log('\n→ Creating agent…');
    const created = await elevenlabs('/v1/convai/agents/create', {
      method: 'POST',
      apiKey: ELEVENLABS_API_KEY,
      body: { name: AGENT_NAME, conversation_config: conversationConfig },
    });
    agentId = created.agent_id || created.agentId || created.id;
    if (!agentId) throw new Error(`agent created but no agent_id in response: ${JSON.stringify(created)}`);
    console.log('   ✓ agent created');
  }

  console.log('\n✅ Done.');
  console.log(`   AGENT_ID  = ${agentId}`);
  console.log(`   SECRET_ID = ${SECRET_ID}`);
  console.log('\nNext steps (ElevenLabs dashboard):');
  console.log('   • Attach a phone number to this agent (Twilio import, or buy an ElevenLabs-native number).');
  console.log('   • Make sure the tunnel to 127.0.0.1:4099 is up (scripts/phone-tunnel.sh) and the daemon');
  console.log('     is running with ATMOS_GATEWAY_SECRET set to the SAME value used here.');
  console.log('   • Re-run with AGENT_ID=' + agentId + ' SECRET_ID=' + SECRET_ID + ' to update in place.');
}

main().catch((err) => {
  console.error('\n❌ phone-setup failed:', err.message);
  process.exit(1);
});
