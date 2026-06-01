# The Orchestration-Layer Thesis — StratosAgent as the sovereign assembler

**Status:** STRATEGY (durable). The "why we win" doc. Honest about real vs designed vs aspirational.

## The insight
The bottleneck was never the models — it's **human orchestration.** Everyone has GPT/Claude/Gemini.
The months-long skill of wiring models + tools + memory + workflows so the human is **out of the loop**
is the wall ~99% never cross. **StratosAgent's value = it removes that bottleneck** — the layer that
brings the blocks together and sets them up for you, so the skill becomes "speak to Stratos."

## Why we beat the building blocks (OpenCode / Hermes / frontier)
They're powerful **blocks**, not the assembled sovereign system; most run through someone else's cloud
(your data flows out). Four structural differences they can't copy without abandoning their model:
1. **Assembles + auto-configures** the blocks (kills the orchestration bottleneck)
2. **Sovereign** — your hardware, your keys, data never leaves
3. **Security + audit + human-on-loop** layer — autonomous ≠ reckless
4. **Owns the stack** (BSL) — no rent, no lock-in

## "Human ON the loop, not IN the loop"
Runs 24/7; notifies, asks, lets you redirect — you're never the copy-paste middleman, but you stay in
control. This is BOTH the safety model (Codex enforced approval-for-writes + verify-before-trust) AND
the trust unlock for handing an agent your keys + your business: *"infinite autonomy you control."*

## Honest state of the building blocks (so we articulate it truthfully)
| Block | State |
|---|---|
| Universal model gateway (BYOK 100+, one key) | ✅ shipped (PR #14) |
| **Native MCP connectivity** (plug into + expose MCP) | 🟡 secure design (Half B) |
| Sovereign connector vault (Composio self-hosted, $0 fees, MIT) | 🟡 secure design |
| Run Claude Code / any CLI from the Atmosphere (sovereign dev env) | 🟡 designed (Codex redesign) |
| ACP / agent-to-agent comms | 🔴 **scaffold/spec only — NOT functional** |
| "Just speak → it orchestrates everything" | 🌟 north star, being assembled |
| Real-time STS voice (NVIDIA Riva/ACE/Parakeet) | 🔭 roadmap, post-launch (needs GPU mesh) |

⚠️ Never claim agent-to-agent or the 24/7 autonomous business-runner exists *today*. Say "we're
building the protocol / assembling the blocks." The integrity IS the moat.

## The pitch (quotable)
> *"Everyone has the AI models. Almost nobody can wire them into a system that runs without them in the
> loop — it took me months. StratosAgent is that system, assembled for you, on YOUR hardware so you own
> it. You speak; it orchestrates; you stay ON the loop — it asks, notifies, you redirect — but OUT of
> the grind. The autonomous system everyone's chasing, finally sovereign and secure because someone
> assembled the blocks instead of renting you a wrapper."*

## Cost truth
- Composio: **$0** (MIT, self-hosted). Costs = third-party APIs at scale + your compute (have it).
- LiteLLM/OpenRouter: BYOK — your keys, pay-per-use to the providers, no wrapper tax.
- The sovereign edge: our COGS is near-zero because compute is the user's/mesh's → flat pricing works.

## Build sequence (each: design → Codex/Gemini review → build + tests → commit; QA'd before prod)
1. **Secure credential vault** — opaque handles, separate from config/env, non-egress audit (CRITICAL #5/#8). ← bedrock of native MCP
2. **Native MCP client** (read-only) — connect to MCP servers, deterministic broker, curated tool subset
3. **Connector OAuth + write-approval** (human-on-loop) — Half B Step 2 (second security review)
4. **Skill-sync demo across 2 nodes** — the moat made visible (launch asset)
5. **ACP / agent-to-agent** — make the scaffold real, securely
6. **Sovereign dev env** — run any CLI on your/mesh compute
7. **Content-orchestrator** — script→image→video→Remotion, on the gateway
