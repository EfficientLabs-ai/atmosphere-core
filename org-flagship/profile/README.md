<div align="center">

# Efficient Labs

### Sovereign, local-first AI — owned by you, not rented from a monopoly.

</div>

We build AI infrastructure on a simple principle: **your intelligence should run on your hardware,
under your control, without sharecropping your data.** Two products, one thesis.

---

## 🛰️ StratosAgent — your sovereign AI agent

A drop-in agent that runs on **your** machine. Use a local open-weights model (private, no API key) or
bring your own cloud key (BYOK) — you choose, and you can switch. Configure it by talking to it.
Secure-by-default: zero ambient authority, every capability off until you grant it.

```sh
npm i -g @efficientlabs/stratos      # or: curl -fsSL <installer-url> | sh
stratos init      # name it + pick a model (local-only setup)
stratos doctor    # read-only preflight
stratos start     # runs on 127.0.0.1
```

- **Private by default** — runs offline-capable on your hardware; your data stays with you.
- **Model-agnostic** — local (Ollama) or BYOK (OpenAI / Anthropic / Google). No lock-in.
- **Secure-by-default** — files / network / shell are off until you explicitly grant them, locally.
- **Honest** — no fabricated status, balances, or capabilities. It tells you what's real.

→ **[StratosAgent repo](https://github.com/EfficientLabs-ai/StratosAgent)**

## 🌍 The Atmosphere — the optional sovereign compute mesh

A peer-to-peer network (public DHT + NAT hole-punch, no open ports) with post-quantum-signed skill
sharing. StratosAgent works fully standalone; **joining the Atmosphere is always opt-in.** It's how
verified capabilities can compound across your own trusted nodes.

→ **[The Atmosphere repo](https://github.com/EfficientLabs-ai/TheAtmosphere)**

---

## Why this, and not a cloud AI subscription?

Things a sovereignty-first design can offer that a surveillance-funded one structurally cannot:

| | Efficient Labs | Cloud AI monopolies |
|---|---|---|
| Where your data lives | **your device** | their servers (their revenue depends on it) |
| Works offline / air-gapped | **yes** | no |
| Model choice | **local + any BYOK** | locked to theirs |
| Skills you create | **yours, portable, forkable** | locked in |
| Default capabilities | **off until you grant them** | broad, opaque |

We say what's real and what isn't. Aspirations are marked as aspirations.

<div align="center"><sub>Efficient Labs · sovereign AI infrastructure</sub></div>
