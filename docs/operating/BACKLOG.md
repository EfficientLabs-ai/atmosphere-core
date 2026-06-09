# Master Backlog — Merged Audit (Claude + Codex)

> The single clear path. Fuses Claude's independent audit ([`ISSUES.md`](ISSUES.md), EFL-001…018)
> with Codex's independent audit (GitHub issues). **Rule:** where both auditors agree → promote to
> a sprint. Where one found it alone → verify before actioning. Detail/patches live in
> [`REMEDIATION.md`](REMEDIATION.md); process in [`OPERATING-MODEL.md`](OPERATING-MODEL.md).

**Verified 2026-06-09.** Two audits ran independently. Two facts conflicted; live checks settled them:

| Conflict | Claude said | Codex said | Live check | Winner |
|---|---|---|---|---|
| `@efficientlabs/atmosphere-mesh-node` | published `@1.0.0` | not published (404) | `npm view` → **404** | **Codex** |
| CI status | "main clean" (didn't check CI) | both repos RED | `gh run list` → **FAILURE** ×3 each | **Codex** |
| `@efficientlabs/stratos` | `@1.1.0` | (n/a) | `npm view` → **1.1.0** | confirmed |

Lesson recorded: "working tree clean" ≠ "CI green" ≠ "package published." All three are now checked
explicitly, never assumed.

---

## The production-fix sequence (Codex's order — features wait)

> Codex directive, adopted: *do not start new features. First pass = make issues visible (done) →
> fix CI truth → resolve status contradictions → stabilize runtime.* Discord/Slack is queued **after** this.

### Tier 0 — Truth & CI (both auditors agree → ship first)
| GitHub | EFL | Repo | Item |
|---|---|---|---|
| core**#59** | — | atmosphere-core | **CI red**: Node-20 vs deps needing Node ≥22 — fix the matrix, document Node policy |
| web**#5** | EFL-011 | efficientlabs-web | **honesty.yml red**: stale clean-fixture false positive in `honesty-guard.mjs:354` |
| core**#61** | — | atmosphere-core | **Untracked operating docs made false claims** — commit corrected, verified versions *(this PR)* |
| web**#6** / web**#4** | EFL-010 | efficientlabs-web | `/status` framed "live" while in baseline-fallback; deploy-status vs readiness |
| atmos**#5** / web**#8** | — | TheAtmosphere | **mesh-node npm 404** — publish from `node-runner` OR remove all "installable" claims |
| core (model) | EFL-001, EFL-007 | atmosphere-core | qwen2.5:7b claimed everywhere but not on box; hardcoded fake model strings on live/receipt paths |

### Tier 1 — Runtime stability & honesty gates (agree)
| GitHub | EFL | Repo | Item |
|---|---|---|---|
| core**#60** | EFL-014, EFL-015 | atmosphere-core | PM2: bridge heap ~94% / p95 71s; 42 restarts; ABI/shutdown logs — circuit-breaker + max-old-space + `pm2 reset` + ABI pin |
| core**#58** | — | atmosphere-core | `ATMOS_GATEWAY_SECRET` unset → enable per-request auth on spend/mcp routes |
| core**#62** | **EFL-002** | atmosphere-core | `/vision` fabricates fake VLM analysis on the live path → honest path or synthetic-demo flag |
| core**#63** | EFL-013 | atmosphere-core | channel adapters: verify e2e or mark config-needed (they're real + token-gated, under-claimed) |

### Tier 2 — Public-repo first-touch (mostly Claude-found → Codex to confirm)
| GitHub | EFL | Repo | Item |
|---|---|---|---|
| stratos**#1** | EFL-004, EFL-005 | StratosAgent | README import name wrong; "verify-it-yourself" demo not reproducible (no `receipt export` CLI) |
| atmos**#4** | EFL-006, EFL-008 | TheAtmosphere | onboarding crashes (raw stack trace on placeholder key); placeholder wallet refuses to start |
| stratos**#3** | EFL-016, EFL-017 | StratosAgent | release provenance; cwd-scoped node-keys → per-user home |
| atmos**#4** | EFL-018 | TheAtmosphere | `config.json` trust anchor not gitignored |

### Tier 3 — Governance & substrate
| GitHub | Repo | Item |
|---|---|---|
| stratos**#2**, atmos**#3** | public repos | **AGENTS.md** — public-safe doctrine + truth-gate + Claude/Codex roles *(drafting in remediation workflow)* |
| (internal) | core, web | AGENTS.md → point to `docs/doctrine/` + `docs/operating/STATE.md` |
| atmos**#2** | TheAtmosphere | doctrine artifacts (VISION/AUTH/CONTEXT/ATMOSPHERE/ROADMAP) — already exist privately; public-safe variants |
| web**#7** | efficientlabs-web | `/app` preview → real control-plane APIs, or label "preview" everywhere |
| solo**#140**, solo**#141** | Solo-AI | deprecate/restore n8n + memcompute; resolve untracked control-plane sqlite |

### ⚠️ Claude-only, NOT yet Codex-confirmed (verify before promoting)
- **EFL-003 — cross-channel context bleed** (vector-bank.js: 2 of 3 memory layers retrieve with no isolation). Security-class leak, but Codex did **not** independently flag it. **Action: Codex verifies this specific finding before it goes into a fix PR.** (Adjacent to core#63 but distinct — that's adapter config, this is RAG isolation.)
- **EFL-012 — `getLiveBalance` fabricates 1 SOL on RPC failure** (latent; not on live path). Codex flagged Active Vision but not this. Low, deferred-economic.

---

## PR cadence (the loop you blessed)
1. Claude picks an issue / coherent batch → branch → fix → tests + behavioral check.
2. Open PR, link the GitHub issue, attach **verification evidence** (commands + output).
3. Request Codex review. Codex inspects the diff, runs CI/tests, probes endpoints, compares claims vs evidence.
4. Green from Codex + your go → **then** merge to `main`. Never before.

**First PR (this turn):** `ops/operating-docs-truth` → resolves core**#61** (commit the corrected,
verified operating docs + this backlog). It's the end-to-end proof of the loop: small, docs-only,
Codex-verifiable.
