# The Atmosphere Economy — structure for obtainable, profitable, transparent rewards

**Status:** design / decision-pending (not yet built beyond the measurement layer)
**Date:** 2026-06-03
**Author:** Neo The Architect + Claude Opus 4.8
**Audience:** internal canonical spec. A public-facing derivative (the transparency page) is
generated FROM this; the candid legal/economic analysis below stays internal.

> ⚠️ **Not legal advice.** The legal sections flag risk vectors so we engage the right counsel
> before anything goes live. Nothing here is a guaranteed financial return to anyone.

---

## 0. The first principle (the 100-year frame)

In 100 years the model weights of today are fossils. The protocols that survive are the ones whose
**incentives are aligned and whose accounting is trustless** — Bitcoin, Ethereum, TCP/IP, the Internet
itself. So the durable design is not "a token that goes up." It is:

> **Pay people for real contribution, out of real revenue, measured provably, disclosed completely.**

The remarkable part: the **legally-survivable** path and the **100-year-durable** path are the *same
path*. Both demand: real utility first, rewards as a share of real revenue second, never a speculative
promise. A reward system that over-promises returns is both an SEC magnet *and* the thing that kills
crypto projects on a long horizon. Under-promise on returns, over-deliver on transparency and utility.
That coincidence is the whole strategy.

We already built the hardest, most defensible piece of this: the **capability receipt** rail with
**wallet attribution**. Every unit of compute is signed, hash-chained, attributed to a wallet, and
verifiable by anyone with a public key. That is the *unit of account* for the entire economy — a
proof-of-contribution that needs no central auditor. The economy is the receipt rail with a payout
valve bolted on top, once revenue exists.

---

## 1. Why a user connects a wallet (the opt-in hook)

Three reasons, in priority order — utility first, money last:

1. **Their AI OS** — the console they'd pay for even with no rewards (see §6). This is the retention
   engine. Rewards get people in the door; *utility keeps them*.
2. **A provable contribution balance** — credits earned for compute supplied + referrals + early
   adoption, every credit receipt-backed (auditable, not a marketing number).
3. **A live, public progress bar to payout activation** — they watch the collective get closer, and
   they see exactly where they rank. Transparency *is* the motivation.

The wallet is **address-only** (we already enforce this: validated base58, never a private key). Baking
the address in at connect time means contribution accrues from day one — rewardable the moment the
valve opens.

---

## 2. The reward mechanism — recommended structure

**Recommendation: Contribution Credits → revenue-share payouts. NOT a token (yet).**

### Phase 0 — now: credits, not money
- Contributors earn **Atmosphere Credits** for: (a) **compute supplied** (the receipt rail measures
  CPU/RAM/VRAM·time, the dominant signal), (b) **referrals that convert to paying subscribers**,
  (c) an **early-adopter multiplier** (a credit earned in month 1 is worth more than one earned in
  month 20 — this is the honest engine behind "the sooner you adopt, the bigger your share").
- Credits are **explicitly not money, not equity, not a promised return.** They are a transparent
  record of contribution, governed by published program terms. This wording matters legally.
- Why credits-first isn't a dodge: **you literally cannot pay people before there is revenue.** Credits
  are the honest way to accrue contribution *during* the build, so early believers aren't erased when
  the valve opens.

### Phase 1 — activation: revenue-share, framed as payment for compute supplied
- When the **activation thresholds** (§4) are met, a **published percentage of real mesh-rental
  revenue** distributes **pro-rata by credits**.
- Critical framing: this is **payment to a supplier for compute they actually delivered** — structurally
  like a cloud provider paying for spot capacity, or YouTube paying creators a revenue share. It is
  *not* "invest money, earn a return from other people's work." That distinction is the difference
  between a defensible supplier-payment model and an unregistered security (see §7).

### Why not a token (yet)
A Solana SPL token gives maximum hype and liquidity — and maximum legal exposure: securities law,
exchange listing, KYC/AML, global regulatory surface, almost certainly an offshore foundation. It is a
*later, counsel-gated* decision, not the launch mechanism. **Credits → revenue-share gets us 90% of the
motivational power at 10% of the legal risk.** If we tokenize later, credits convert at a published
ratio — but only after specialized counsel.

---

## 3. The transparency dashboard (the trust + motivation engine)

This is the single best idea in the brief, and it's *only* credible because of the receipt rail.

**Live, public, cryptographically-auditable counters:**
- Active nodes online (right now)
- Total compute contributed (receipt-verified — anyone can audit the chain)
- Total platform revenue (the honest number, updated on a cadence)
- **% to payout activation** — the progress bar, against the §4 thresholds
- Leaderboard / your-rank (opt-in, pseudonymous by wallet)

Why this is a moat, not a gimmick: every competitor's "community rewards" dashboard is a marketing
number you must trust. Ours is **backed by signed receipts** — a progress bar you can *verify*. That is
the brand ("no secrets, full transparency") rendered as infrastructure.

**Honesty discipline (non-negotiable):** every number is real and receipt-backed. We never fabricate
progress. The dashboard's credibility *is* the company's credibility; one inflated number ends it.

---

## 4. Activation thresholds — why two gates, and the math

Payouts activate only when **both**:
- **Revenue ≥ R_min** (monthly mesh-rental revenue), AND
- **Active nodes ≥ N_min**

Why both, from first principles:
- Below a revenue floor, the contributor share is *dust* — a payout smaller than the Solana transaction
  cost to send it. Paying out dust destroys trust and wastes money.
- Below a node floor, the network isn't real yet — paying out would concentrate rewards in a handful of
  early nodes and look like exactly the insider-enrichment we exist to end.

**The sizing formula (numbers are yours to set, §8):**

```
Per-contributor monthly payout ≈ (CONTRIBUTOR_SHARE × Revenue × your_credits / total_credits)
Constraint A (not dust):   smallest meaningful payout  >  tx_cost × safety_margin
Constraint B (viable co.): (1 − CONTRIBUTOR_SHARE) × Revenue  >  platform_opex + target_margin
```

`R_min` is the revenue where both constraints hold simultaneously. That's the honest threshold — not a
hype number, the point where payouts are *real* and the company is *viable*. We publish it and count up
to it in the open.

---

## 5. The affiliate / referral system — clean by construction

**Structure: single-level affiliate on real paid conversions. Nothing else.**

- You refer someone → they **subscribe (pay)** → you earn a referral reward (a % of their subscription
  for N months, *or* a credit bonus, or both).
- Referral credits **also count toward your payout share** — so growth and reward are the same lever.

**What we deliberately do NOT do (the pyramid/MLM landmine):**
- ❌ No reward for a signup that never pays (rewarding recruitment over real sales = FTC pyramid risk).
- ❌ No multi-level / "your referrals' referrals" overrides (the classic MLM structure).
- Single-level, conversion-gated affiliate is what every clean SaaS runs (Stripe-style). It stays an
  *affiliate program*, never a *scheme*.

---

## 6. The AI OS — the utility that funds everything ("ClickUp 3.0 × Claude")

Rewards acquire users; **the OS retains them and generates the revenue that funds the rewards.** They
are two halves of one flywheel. The OS is the unified sovereign console:

- **Chat with your agents** (StratosAgent, local-first, multimodal — built)
- **Monitor agent-to-agent communication** (the mesh job/receipt stream, visualized)
- **Autonomous skills feed** — skills the agent obtained/sealed on its own (signed-skill rail — built)
- **Workflow / automation board** — automations building your projects/infra or running your business
- **Email & chat tracking** — ← this is exactly where the **sovereign Composio layer** plugs in
  (1000 integrations, keys never leave home — just built, Path A)
- **Wallet panel** — credits, rank, live payout-progress (this section's economy)

Much of this exists or is in flight: the dashboard (done), sovereign Composio (just built), wallet
attribution + receipts (just built), local multimodal agent (built). **The OS is the integration of
these into one screen** — not a from-scratch build.

The positioning: ClickUp gives you boards; Claude gives you a brain; neither gives you a *sovereign,
self-improving, agent-run operating system you own*. That's the category.

---

## 7. The legal landmines (engage counsel before go-live)

The one thing that sinks this. Flagged honestly so we de-risk *before* anything is public:

| Vector | Risk | Our mitigation |
|---|---|---|
| **Securities (Howey)** | "Invest money, expect profit from others' work" = investment contract | Pay for **compute actually supplied** (supplier/rev-share), never "buy in to earn." No token at launch. |
| **Pyramid/MLM (FTC)** | Paying for recruitment over real sales | **Single-level** affiliate, **paid-conversion-gated** only. |
| **Money transmission / MSB** | Handling crypto payouts may require registration | Counsel on payout rails; consider fiat option; possibly a licensed processor. |
| **KYC/AML** | Payouts at scale → identity obligations | KYC threshold on payouts; design the gate now. |
| **Tax (1099 etc.)** | Payouts are income | Reporting/withholding design; tax counsel. |
| **Public promise** | "We'll pay at $X" could be a binding/ misleading representation | Publish **program terms**, frame as intention not guarantee, no promised return. |
| **Token (if ever)** | Full securities + global regime | Specialized crypto counsel + likely offshore foundation. Separate, later decision. |

**Eat our own dog food:** our audience is compliance-conscious (regulated industries, CEOs with
shadow-AI problems). A *visibly* well-structured, counsel-backed economy is itself a sales asset. Doing
this right is on-brand, not a tax.

---

## 8. What's yours to decide (the forks)

1. **Reward instrument:** revenue-share Credits *(recommended)* vs SPL token *(hype, high legal lift,
   later)*.
2. **The numbers:** `CONTRIBUTOR_SHARE` (the 80/20 you've stated — confirm 80% to contributors on
   mesh-rental revenue), `R_min`, `N_min`, early-adopter multiplier curve, affiliate %/duration.
3. **Counsel:** securities + crypto counsel engaged **before** the transparency page publishes any
   payout promise. (This is the gate on going public with §3/§4.)
4. **Fiat vs crypto payouts** (or both) — drives the money-transmission/KYC design.

---

## 9. Build sequence (and what already exists)

1. ✅ **Measurement** — capability receipts + wallet attribution + per-wallet aggregation. *Done.*
2. **Credits ledger** — extend the receipt rail to accrue credits (compute + referral + early multiplier).
   Pure measurement, no payout logic, no legal exposure. *Buildable now.*
3. **Transparency dashboard** — the public receipt-backed counters + progress bar + rank. *Buildable now*
   (numbers real, "activation TBD pending counsel" until §8.3 clears).
4. **Affiliate system** — referral codes, paid-conversion attribution, single-level. *Buildable now.*
5. **Activation / payout engine** — the valve. **Build LAST, counsel-gated.** Never ships before §8.3.

The discipline: build the measurement + transparency + utility (legally safe, immediately motivating)
now; gate the actual money valve behind counsel. We get the full flywheel effect — visible progress,
real adoption, real revenue — *before* we touch the one piece with real legal exposure.

---

## 10. The flywheel (why it compounds)

```
adopt → contribute (measured) → AI OS value → subscribe / refer → revenue
  ↑                                                                   ↓
  └──────────────  payout valve opens, rewards flow  ←── thresholds met
```

The transparency dashboard makes the loop **visible**, and visibility is itself a growth input: people
adopt *because* they can see the collective getting closer and their own rank rising. That is the
"ultimate motivation" in the brief — and it's honest, because every number is provable.

Abundance as a business model, rendered as infrastructure: ~$0 marginal compute (idle hardware),
high-margin arbitrage to compute-buyers, 80% of that flowing back to the people who powered it,
20% building the company — all of it on a ledger anyone can audit. No landlord. No meter. No secrets.

---

## 11. Refinements validated 2026-06-06 (external counsel-style review folded in)

An independent review aligned with this spec and sharpened five things — adopted:

- **Claim discipline (hard).** The wallet hook ships as *"Connect your wallet to reserve your Atmosphere
  contributor identity and track eligible Contribution Credits **before rewards go live**"* — never "earn
  payouts." Reward state on the dashboard reads **"Contribution tracking active · Payouts not live"**,
  with **no dollar/SOL projection** shown. Credits are **"Contribution Credits"** (non-branded,
  non-transferable for now). Banned phrases: *"Earn SOL today," "guaranteed passive income," "DePIN
  rewards live," "invest in the Atmosphere."*
- **Sequencing (hard order).** 1) **Atmosphere OS dashboard** → 2) **wallet connect** (sign-message to
  prove ownership, public address only, **no custody, no deposits, never required to use the product**) →
  3) **contribution ledger** → 4) **verified contribution receipts** → 5) **reward policy** → 6) **Solana
  payout rail** (LAST, counsel-gated). The wedge is the OS (daily-use), not the wallet (incentive layer).
- **Product surface = "Atmosphere OS"** — a sovereign AI operating *environment*, NOT a literal kernel
  (don't claim "OS" unless a desktop/runtime layer justifies it). Modules: **Home · Agents · Workflows ·
  Projects · Skills · Integrations** (Composio invisible behind "Connect Gmail/GitHub/Notion/Slack/…") **·
  Memory · Atmosphere** (node status) **· Wallet · Rewards** (Coming Soon) **· Settings**. Make the user
  feel: *my AI is alive, my node is contributing, my skills are growing, my account is accruing credit, my
  wallet is ready when rewards go live.* Visibility, not ideology, drives opt-in.
- **Subdomains:** `app.efficientlabs.ai` = customer AI OS · `dashboard.efficientlabs.ai` = founder/admin ·
  `get.efficientlabs.ai` = installer · `docs.efficientlabs.ai` = docs · `status.efficientlabs.ai` =
  honesty/status matrix.
- **Tiers:** Free / Pro / Builder(Max) / Team / Enterprise. Wallet + contribution tracking across **all**
  tiers; skill publishing, higher node limits, and business/policy controls scale up.

**Regulatory anchors to brief counsel on (not legal advice):** IRS treats reward/award/payment-for-
services/mining/staking receipts as reportable digital-asset transactions (business receipts can be
ordinary income); SEC 2026 crypto-asset guidance covers airdrops/mining/staking/investment-contract
analysis (structure + claims matter); FinCEN MSB exposure arises whenever value substituting for currency
is transmitted; Solana Pay is the eventual payment-request plumbing — *not* a reason to promise payouts
early.

**Net:** the economy stays **decision-pending on §8**, but the *contribution-accounting layer* (wallet
connect + ledger + receipts, payouts disabled) is buildable **now** with zero economic-layer exposure —
and it's the strongest honest opt-in mechanic we have.
