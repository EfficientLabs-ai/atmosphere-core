# Scope — Sovereign Ambient Desktop Agent (eyes · ears · voice)

**Thesis (from cited research):** the agent loop is commoditized (OpenClaw 160K★, Hermes 64K★).
The differentiated hook is **sovereign ambient sensing** — give StratosAgent eyes, ears, and a
voice, **fully on-device, across Windows / Linux / Mac.** omi (BasedHardware) proves the demand
(~300K users) but is **macOS-only and cloud-backed** (Deepgram STT, Firebase). Our opening: the same
ambient UX with **zero cloud** — local Whisper STT + local LLM, events piped to StratosAgent over the
Atmosphere P2P transport. Neither omi nor OpenClaw/Hermes offers this.

## What already exists (do not rebuild)
`packages/atmos-desktop/src/`:
- `sensory-ingestion.js` — mic capture loop, local **Whisper** transcription, **screen capture**
  (PowerShell on Win), active-window-title context. (Just hardened in the red-team → execFile/no-shell.)
- `sensory/conversational-audio.js` — **TTS** (say / espeak / Windows System.Speech), Whisper STT.
- `stratos-agent/src/sensory/audio-ingestion.js` / `audio-synthesis.js` — STT/TTS engines (status: Mock per the honest board — this is where the real work lands).

## Target architecture (all local)
```
[ mic ] → VAD (Silero) → diarize → Whisper.cpp STT ─┐
[ screen ] → capture → OCR / local VLM ─────────────┼─► event stream ─► StratosAgent
[ camera (opt) ] → frame → local vision ────────────┘     (over loopback / P2P transport)
                                                              │
                                       local model (gemma2:2b / qwen) ⇄ frontier (BYOK, on demand)
                                                              │
                                                          response → TTS (Piper / OS voice) → [ speaker ]
```
- **Privacy by construction:** nothing leaves the machine. `secret-guard` scans transcripts before
  any inference (already wired). Hard mute + consent indicator; opt-in per modality.
- **Transport:** sensory events enter via the api-shim gateway (now auth-gated — F2) / P2P mesh.

## Platform matrix
| | Windows | macOS | Linux |
|---|---|---|---|
| Audio in | WASAPI / native | CoreAudio | PipeWire/ALSA |
| STT | whisper.cpp (local) | whisper.cpp | whisper.cpp |
| Screen | .NET / PowerShell (have) | `screencapture` | `grim`/`scrot` |
| TTS | System.Speech (have) | `say` (have) | `espeak`/Piper (have) |
| Vision | local OCR + opt VLM | same | same |

## Phased build
- **P1 — Ears:** mic → VAD → Whisper → agent. Replace the Mock STT with real whisper.cpp end-to-end; verify latency on CPU (pair with gemma2:2b fast path).
- **P2 — Voice:** agent reply → Piper TTS (higher quality than OS voices) → speaker; barge-in/interrupt.
- **P3 — Eyes:** screen capture → local OCR (+ optional small VLM) → "what's on screen" context for the agent.
- **P4 — Ambient memory:** sensory events → LanceDB (channel-tagged, the isolation we verified) so the agent recalls context.
- **P5 — Consent/Privacy UX:** per-modality toggles, visible recording indicator, local-only guarantee, audit log.

## Differentiation vs omi / OpenClaw / Hermes
- **vs omi:** cross-platform (omi = macOS only), fully local STT+LLM (omi = Deepgram + Firebase cloud), P2P transport, post-quantum sealed.
- **vs OpenClaw/Hermes:** they have **no ambient sensory layer** at all — this is net-new capability on top of a (now table-stakes) local agent loop.

## Honesty
Today the STT/TTS/vision adapters are **Mock** on the status board. This scope is the plan to make
them **Live** — and every flip ships through `scripts/ship.mjs` to the public /updates feed. No
claiming "eyes/ears/voice" as done until the board says Live.
