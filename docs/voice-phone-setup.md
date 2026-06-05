# Call StratosAgent over the phone

Give StratosAgent a phone number you can call. An **ElevenLabs Conversational-AI Agent** handles the
phone leg (Twilio/SIP + speech-to-text + text-to-speech + turn-taking) and delegates the "brain" to a
**Custom LLM** that points at StratosAgent's OpenAI-compatible gateway. This is the same pattern
ElevenLabs documented for Hermes — only the LLM is your sovereign, local-first gateway instead of a
cloud model.

```
  [caller's phone]
        │  PSTN
        ▼
  [Twilio / ElevenLabs number]
        │
        ▼
  [ElevenLabs Conversational-AI Agent]   ← does STT, TTS, turn-taking
        │  Custom LLM (chat_completions), Authorization: Bearer <gateway secret>
        ▼
  https://<tunnel>/v1/chat/completions    ← HTTPS tunnel (Tailscale Funnel / ngrok)
        │
        ▼
  127.0.0.1:4099  (api-shim gateway)  →  local model gemma2:2b  (your hardware)
```

You get **talk + hear** over the phone. ElevenLabs does the voice; StratosAgent does the thinking on
your own box. **Vision ("see") is separate** — that needs the Gemma-4 multimodal model, which is not
pulled yet; this runbook does not cover it.

---

## What YOU must provide

1. **An ElevenLabs account + API key** (`ELEVENLABS_API_KEY`). This is the only paid third party here
   (for STT/TTS/telephony). Bring your own key — nothing is hardcoded.
2. **A phone number.** Either import a **Twilio** number into ElevenLabs, or buy an
   **ElevenLabs-native** number in their dashboard. Attached to the agent in the dashboard (step 5).
3. **A tunnel choice.** The gateway is loopback-only by design. Pick **Tailscale Funnel**
   (recommended, sovereign) or **ngrok** (the article's alternative). See step 2.

Everything else (the gateway, the local model, the routing) is already running in this repo.

---

## Step 1 — Set the gateway secret and apply it

The gateway accepts a per-request secret via **either** `x-atmos-gateway: <secret>` (first-party
callers) **or** `Authorization: Bearer <secret>` (the OpenAI convention ElevenLabs' Custom LLM uses).
Same secret, timing-safe compare. If `ATMOS_GATEWAY_SECRET` is unset the gateway is loopback-perimeter
only (no per-request auth) — but once it's reachable through a public tunnel you **must** set it.

```bash
# pick a strong random secret (store it in your vault)
export ATMOS_GATEWAY_SECRET="$(openssl rand -hex 24)"

# apply it to the running daemon (pm2). IMPORTANT: the daemon also needs PORT=4099 and
# LOCAL_FALLBACK_ENABLED=true in its env (see "Fast model" below) — preserve those when you reload.
pm2 restart atmos-secure-bridge --update-env   # only after exporting ALL required vars in this shell
pm2 save
```

> Do not run a bare `pm2 restart` from a fresh shell — it drops `PORT` / `LOCAL_FALLBACK_ENABLED`
> and breaks the bridge. Export every required var first, then `--update-env`, then `pm2 save`.

---

## Step 2 — Start the tunnel (public HTTPS → 127.0.0.1:4099)

```bash
scripts/phone-tunnel.sh 4099    # detects tailscale/ngrok and prints the exact commands
```

**Recommended (sovereign default): Tailscale Funnel** — no third-party account, HTTPS via your own
tailnet identity. Requires Funnel enabled in the tailnet admin/ACL.

```bash
tailscale funnel --bg 4099
tailscale funnel status        # read the https://<machine>.<tailnet>.ts.net URL → PUBLIC_GATEWAY_URL
```

**Alternative (the article's example): ngrok** — quick, but a third-party account + public endpoint.

```bash
ngrok http 4099
# read the https URL from http://127.0.0.1:4040/api/tunnels
```

`PUBLIC_GATEWAY_URL` is the **base** https URL — **without** a trailing `/v1` (the setup script
appends `/v1`).

---

## Step 3 — Provision the ElevenLabs agent

```bash
export ELEVENLABS_API_KEY="xi-..."                       # your ElevenLabs key
export PUBLIC_GATEWAY_URL="https://<machine>.<tailnet>.ts.net"   # from step 2, no /v1
export ATMOS_GATEWAY_SECRET="<same value you set on the daemon in step 1>"

node scripts/phone-setup.mjs
```

It will:
1. store the gateway secret as an ElevenLabs workspace secret named `stratos_gateway_token`
   (`POST /v1/convai/secrets`) and capture its `secret_id`;
2. create an agent (`POST /v1/convai/agents/create`) whose LLM is `custom-llm` →
   `${PUBLIC_GATEWAY_URL}/v1`, `api_type=chat_completions`, authenticated by that stored secret, and
   **pinned to the fast local model `gemma2:2b`**, with a sovereign-branded first message and system
   prompt.

It prints `AGENT_ID` and `SECRET_ID`. **No secret values are ever printed.**

To **update** instead of recreate (idempotent-friendly), re-run with the captured ids:

```bash
AGENT_ID=<id> SECRET_ID=<id> node scripts/phone-setup.mjs
```

Optional env: `PHONE_MODEL` (default `gemma2:2b`), `AGENT_NAME`, `ELEVENLABS_VOICE_ID`.

---

## Step 4 — Latency: phone turns MUST use the fast model

`qwen2.5:7b` on this CPU-only VPS is ~100s per reply — **unusable on a live call.** Phone turns must
be served by the fast local model **`gemma2:2b`** (warm eval ~a few seconds).

Two things make that happen, and **both** matter:

1. **The agent pins the model.** `phone-setup.mjs` sends `model_id: "gemma2:2b"` in the Custom LLM
   config, so every turn arrives at the gateway with `model:"gemma2:2b"`. The router then pins that
   model exactly (`selectLocalModel` returns `gemma2:2b`). Without pinning, a default model name
   (e.g. `gpt-4o`) falls through the local tier ladder and can resolve to a **slower** model
   (gemma2:9b / qwen2.5:7b) depending on detected RAM — verified on this box. **Always keep the
   model pinned.**

2. **The daemon must have `LOCAL_FALLBACK_ENABLED=true`.** The route only sends to local inference
   when `classification.decision==='local' && (isLocalRequest || saveApiCostEnabled)`. The model name
   `gemma2:2b` does **not** match the `isLocalRequest` keyword test (`local|quantized|qwen|llama`), so
   local routing relies on `LOCAL_FALLBACK_ENABLED=true` (a.k.a. `SAVE_API_COST_ENABLED=true`). This
   is already set on the running bridge — preserve it across any pm2 reload (see step 1).

**Keep models warm.** This box is RAM-pressured; a cold model load adds ~25s. Either keep the daemon
warm (periodic local pings) or accept that the *first* call after idle is slow. For consistently fast
turns, consider `OLLAMA_KEEP_ALIVE` so Ollama holds `gemma2:2b` resident.

> BYOK cloud is the other fast option: if you set e.g. `OPENAI_API_KEY` and send a cloud model, turns
> are answered by your own cloud key. That leaves your machine (not the sovereign default) — only use
> it deliberately.

---

## Step 5 — Attach a phone number (ElevenLabs dashboard)

In the ElevenLabs dashboard, on the agent created above:
- **Import a Twilio number** (account SID + auth token + the number), or **buy an ElevenLabs-native
  number**, and assign it to this agent.
- Call the number. You should hear the first message, then talk to StratosAgent running on your own
  hardware.

---

## Verify

```bash
# gateway accepts a Bearer-authed OpenAI-format POST, served by the fast local model:
curl -s -X POST http://127.0.0.1:4099/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $ATMOS_GATEWAY_SECRET" \
  -d '{"model":"gemma2:2b","messages":[{"role":"user","content":"Reply with one word: pong"}]}'
# (first call after idle may be slow due to cold model load; a warm call returns in seconds)

# unit-test the auth matrix without any live service:
node packages/api-shim/test-gateway-auth.mjs
```

---

## What this is / isn't

- **Is:** a phone number that reaches StratosAgent; voice handled by ElevenLabs, reasoning local.
- **Isn't (yet):** vision over the phone. "See" needs Gemma-4 multimodal, not pulled. Out of scope.
- **Sovereignty:** the only third party is ElevenLabs (voice + telephony). The model stays on your
  hardware unless you deliberately enable a BYOK cloud key.
