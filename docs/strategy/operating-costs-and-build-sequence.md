# Operating Costs + Build Sequence

**Tagline (locked):** *The cloud is a ceiling. The Atmosphere is limitless.*

## Part 1 — What it actually costs to run Efficient Labs
**Excluded per operator:** ChatGPT ($100) + Claude ($100) personal AI subs, and electricity.
This is the *hard recurring* cost to keep the business running + ship the product. Ranges; items
marked ⓘ depend on operator specifics.

| Expense | Cost | Notes |
|---|---|---|
| Domain (`efficientlabs.ai`) | **~$6–9/mo** | .ai ≈ $60–100/yr amortized. ⓘ not yet purchased |
| VPS (origin/relay + site) | **~$10–40/mo** | already running. ⓘ depends on plan |
| Business email | **$0–7/mo** | Cloudflare Email Routing = free receive; sending via Zoho (~$1) / Google Workspace (~$7) |
| Transactional email (Resend) | **$0** → $20/mo | free to 3k/mo; pay only at volume |
| Website hosting (Vercel / CF Pages) | **$0** | free tier covers the marketing site |
| GitHub org (private repos) | **$0** | unlimited private repos on Free; Team $4/user only if you need SSO |
| npm (public packages) | **$0** | |
| Stripe | **$0 fixed** | 2.9% + 30¢ per charge — only on revenue |
| Solana **devnet** | **$0** | no real value |
| Mesh compute | **$0** | your hardware / peers — NOT cloud GPU |
| Registered agent / corp annual | **~$5–25/mo** | ⓘ state-dependent, amortized |
| Trademark (recommended, one-time) | ~$250–350/class | not recurring until yr 5–6 |

### The bottom line
**≈ $25–80/month** in hard recurring cost to run the entire business — and most of that is just a
domain + the VPS you already have. The things that normally dominate a software/AI company's budget —
**compute, model serving, website, repos, low-volume email — are all $0 or free-tier.**

That's not luck; it's the thesis paying off: **your COGS is near-zero because the compute is sovereign
(yours + the mesh), not rented.** Two consequences:
1. **Free-forever is genuinely sustainable** — serving a free user costs you ~nothing.
2. **Your prices aren't cost-constrained, they're market-anchored.** $20 (Stratosphere) matches the
   ChatGPT/Claude anchor — don't go higher there or you lose the wedge. The **pricing power is in
   Exosphere (Enterprise)** — that's value-based (compliance + sovereignty), priced on what a breach
   or a cloud-AI bill costs them, not on your costs. That's where you're "undercut" today — fix it
   with custom enterprise pricing, keep the consumer anchor at $20.

## Part 2 — Build sequence (ship the product, then the site is easy)
Each step uses the cadence: **design → Codex Pattern-C review → build with tests → PR**. Free product
first (drives adoption); monetization plumbing later.

1. **Universal Gateway — LiteLLM + Composio seam.** ⭐ highest leverage. One sovereign endpoint → BYOK
   to 100+ models (LiteLLM, MIT) + 1,000+ tools with a local credential vault (Composio, MIT). This is
   the "all your models + all your tools in one place, keys on your hardware" core promise.
2. **Sovereign dev/compute environment.** The Codex-redesigned WASM-first exec + terminal (E2B/WASI) —
   the "replace your VPS/cloud" promise.
3. **Federated skill-sync across 2 nodes.** The moat made visible — the "learns once, every agent
   knows it" demo. Marketing gold + proves the thesis.
4. **Devnet economic layer ("Lift").** Real mechanics, zero value — unlocks the paid tiers' compute
   credits.
5. **OpenHands coding agent.** The dev/engineering brain inside StratosAgent.
6. **Finalize:** honest themed pricing page → website polish → launch (with trademark + domain done).

Rationale: 1–3 make the **free product irresistible** (adoption), 4 enables **revenue**, 5 deepens the
dev wedge, 6 is "easy once the product is real" (operator's call). Start at **#1 today.**
