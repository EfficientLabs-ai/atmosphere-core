> **Draft — structured by a research workflow (Claude Opus + 5 agents), 2026-06-02, for the operator to refine.**
> Grounded in `STATE_OF_REALITY.md` (the source of truth). Not a final commitment; the positioning is the operator's call.

# Sovereign-AI Infrastructure: Dev-Brand + Information Architecture Research

For Efficient Labs (StratosAgent + The Atmosphere). Lens applied throughout: **automate the file architecture, not the AI wrapper** — the site is content-addressable MD/MDX files compiled deterministically by an SSG; the agent only drafts copy, never runs the site.

---

## 1. Reference patterns — how dev-infra & protocol projects earn trust

The pattern that matters most for an honesty-moat brand: **documentation-first, not marketing-first.** The 2026 consensus is that docs are where developers (and the LLMs answering on their behalf) actually live, so docs are the product surface, not a support afterthought. Concretely the winning moves are: treat docs as a product (search/nav/versioning), keep them current with every release, **include working code not pseudocode**, and — critical for your moat — **acknowledge limitations and admit what you don't know** explicitly on the page.

**Exemplars and why they work:**

- **Tailscale (`tailscale.com`)** — the closest brand analog (zero-trust, WireGuard, identity-based, security-first). Trust is earned through: (a) quantified social proof ("30,000 businesses," "90% reduction in support requests"), (b) an **open-source page** (`/opensource`) that says "anyone can review our code and see how Tailscale really works" — transparency *as* the trust mechanism, (c) **public issues/feature requests** users can upvote, and (d) clean beta-labeling ("Aperture beta is now available") so mature vs in-progress is never ambiguous. Their subdomain discipline is exactly what you want to emulate: marketing on apex, `login.` for the admin console, `status.` for uptime, docs under a path.

- **Supabase (`supabase.com`)** — the **changelog as trust engine**. Consistent shipping cadence (even modest releases, daily during launch weeks) creates perceived momentum that is itself a moat. `supabase.com/changelog` is a first-class, dated, linkable surface. Launch Week (release one thing daily for five days) is the signature predictability ritual.

- **Resend** — docs-as-marketing: changelogs packed with **code snippets, migration guides, API examples**. The doc *is* the pitch; technical credibility is demonstrated, not claimed.

- **libp2p / IPFS / Holepunch** — the protocol-project template (directly relevant since your `packages/forks/*` are Holepunch). They win by being the **antithesis of bad P2P projects**: clear specs, friendly APIs, open licensing, a visible point of contact, a `/specs` repo separate from `/docs`. For a protocol brand, a published **spec + whitepaper surface** is a trust requirement, not a nicety.

**The "real vs roadmap" honesty pattern** (your single biggest moat lever, and the thing your own STATE_OF_REALITY work already demands): the best projects make a **hard typographic separation** between three states and never blur them —
- **Shipped / GA** — documented with working code.
- **Beta / Preview** — labeled inline (Tailscale "Aperture beta").
- **Roadmap / Direction** — on a separate page that *explicitly states plans can change*. Public roadmaps build trust by signaling "we're listening, here's what's next" while the disclaimer protects you when priorities shift.

For Efficient Labs specifically: a `STATE_OF_REALITY`-style status matrix (per-capability: GA / beta / mock / planned) published openly is *on-brand* — it operationalizes "honesty + sovereignty" as the moat and pre-empts the exact PRD-honesty gap flagged in your MVP QA NO-GO. Things like the ML-DSA mock-keypair fallback and the unimplemented `:5001` upstream should be *labeled in public*, not hidden — that labeling is the brand.

---

## 2. Subdomain information architecture proposal

You already run: `api.`, `platform.`, `install.`, `crm.`, `relay.`, `inbox.`, `n8n.`, `clients.`. The proposal **keeps all of these meaningful** and slots the new product surfaces alongside them, following the apex-marketing / function-per-subdomain discipline that Tailscale models. Keep top-level nav to 3–5 items (Product, Docs, Pricing, Status, Get Started) to avoid choice paralysis.

**Public, developer-facing (new or formalized):**

| Subdomain | Role | Notes |
|---|---|---|
| `efficientlabs.ai` (apex) | Marketing / brand home | StratosAgent + The Atmosphere story, the thesis, the honesty manifesto. Static SSG. |
| `docs.efficientlabs.ai` | Docs + guides + CLI reference | The product surface. MDX source-of-truth. Includes the real-vs-roadmap status matrix. |
| `install.efficientlabs.ai` *(exists)* | Install/CLI entry | Host `install.sh` here; the canonical one-liner targets this host (see §3). Already yours — formalize it. |
| `status.efficientlabs.ai` | Uptime / incident / mesh health | Mesh node count, relay health, real component status. Earns trust like `status.tailscale.com`. |
| `roadmap.efficientlabs.ai` *(or `/roadmap` path)* | Public direction page | Explicit "plans can change" disclaimer. Can be a docs path rather than a subdomain to keep surface small. |
| `spec.efficientlabs.ai` *(or `docs/spec`)* | Protocol spec + whitepaper | Atmosphere mesh topology, A2A/ACP, PQC envelope, DID/Proof-of-Intent. The protocol-project trust surface. |
| `relay.efficientlabs.ai` *(exists)* | Relay/DHT bootstrap endpoint | Already yours; this is *infrastructure*, not a marketing page — keep it as a service host, document it in `docs`. |
| `api.efficientlabs.ai` *(exists)* | API host | Keep as service host; its human-readable reference lives in `docs`. |
| `platform.efficientlabs.ai` *(exists)* | Dashboard / console | This is your `login.tailscale.com` analog — the authenticated app. Keep app here, not on apex. |

**Recommended consolidation rule** (file-architecture-first): **subdomains are for distinct origins/trust boundaries** (apps, service endpoints, status). **Content variants are paths, not subdomains** — `roadmap`, `spec`, API reference, and the status matrix can all live as paths under `docs.` if you want to minimize DNS/cert/deploy surface. Reserve a dedicated subdomain only when it's (a) an authenticated app, (b) a machine endpoint, or (c) third-party-hosted (status pages often are). This keeps the IA honest and low-maintenance: one marketing build (apex), one docs build (`docs.`), one app (`platform.`), one static file host (`install.`), plus pure service hosts (`api.`, `relay.`).

Avoid: scattering marketing copy across many subdomains, or letting `api./relay.` accrete prose. A documented, oversight-driven subdomain strategy with a clear purpose per host is the explicit best-practice recommendation.

---

## 3. Recommended build stack — file-architecture-first, low-maintenance

**Source of truth = MD/MDX files in the repo. The site is a deterministic compile of those files. The agent drafts copy into MDX; it never runs the running site.** This is the philosophy applied literally: content-addressed text in git, reproducible static build, near-zero token cost at serve time, fully auditable in PRs.

**Recommended: Astro + Starlight** for `docs.` (and Astro for apex marketing).
- Starlight is the 2026 default for new docs projects — it ships **zero JS by default** (better LCP than Docusaurus's React hydration), with **built-in search, sidebars, i18n, and versioning**, and takes MDX + Astro components. One framework (Astro) cleanly covers *both* the marketing apex and the docs site, so you maintain one toolchain.
- It has strong **LLM-friendly metadata generation** — important because 30–50% of doc-site traffic now arrives via LLM-synthesized answers; ignoring that buries you. (Mintlify and Docusaurus are also strong here; Starlight wins on perf + single-stack.)
- Alternatives, ranked for your case: **VitePress** (leaner, Vue, great if you want minimal) or **Nextra** (only if you're already committed to Next.js — note `efficientlabs-web` is Next.js, so Nextra is a defensible "stay in one ecosystem" choice). **Docusaurus** is the safe OSS-incumbent but heavier and JS-shipping.

**Architecture (deterministic core, thin agent layer):**
- `content/` — all marketing + docs as `.md/.mdx`, the single source of truth. Front-matter drives a **status field** (`ga | beta | mock | planned`) that the real-vs-roadmap matrix renders from *deterministically* — one data file, no AI in the render path.
- **Build** — Astro static build in CI (GitHub Actions) → static assets. Reproducible, no server-side AI.
- **Host** — static on Cloudflare Pages / your VPS behind the existing reverse proxy; `install.sh` as a plain static file under `install.`.
- **Status** — `status.` ideally a separate small service or third-party page reading real health probes (not authored copy).
- **The one-liner**, following the rustup/deno/uv convention developers already trust:
  `curl --proto '=https' --tlsv1.2 -sSf https://install.efficientlabs.ai | sh` — HTTPS-pinned, `STRATOS_INSTALL` env override for install root, script source-visible in repo. (Pair with a "read the script first" link for the security-conscious sovereign audience — that gesture *is* on-brand.)
- **Agent's role, bounded:** draft/refresh MDX copy, generate changelog entries from merged PRs, propose status-matrix updates — all landing as **git diffs reviewed in PRs**, never as runtime behavior. Genuine ambiguity (tone, positioning) is the only place the agent earns its keep; everything else (routing, rendering, status compilation) is deterministic plumbing.

**Rituals to adopt** (cheap, high-trust): a dated `changelog` page driven from PRs (Supabase pattern), a periodic Launch-Week-style cadence once GA, and the public roadmap with the "plans can change" disclaimer.

---

## Concrete recommendations (summary)

1. **Lead with the honesty matrix.** Publish a `STATE_OF_REALITY`-derived per-capability status table (GA/beta/mock/planned) on `docs.` — it converts your stated moat into a visible artifact and closes the PRD-honesty gap from your QA NO-GO. Label the mock ML-DSA and placeholder `:5001` upstream openly.
2. **Subdomain discipline:** apex = marketing, `docs.` = docs+spec+roadmap+API-ref (paths), `platform.` = app, `install.` = install.sh, `status.` = real health, and keep `api./relay.` as pure service hosts. Variants are paths, not subdomains.
3. **Stack:** Astro + Starlight, MDX as single source of truth, static build in CI, agent drafts copy into PRs only.
4. **Trust cadence:** PR-driven changelog + public roadmap with change-disclaimer + open-source/spec surface (libp2p/Holepunch model) + the trusted `curl | sh` one-liner with visible script source.
5. **Exemplars to clone:** Tailscale (security brand + subdomain IA + open-source-as-trust), Supabase (changelog engine + launch-week cadence), Resend (docs-as-marketing), libp2p/IPFS (spec+whitepaper protocol surface).

**Sources:**
- [Developer marketing best practices 2026 — Strategic Nerds](https://www.strategicnerds.com/blog/developer-marketing-best-practices-2026)
- [Subdomain strategy — NameSilo](https://www.namesilo.com/blog/en/domain-names/subdomain-strategy-chaos)
- [Information Architecture 2026 guide — ParallelHQ](https://www.parallelhq.com/blog/what-information-architecture)
- [Tailscale open source](https://tailscale.com/opensource) · [Tailscale homepage](https://tailscale.com)
- [Supabase changelog](https://supabase.com/changelog) · [Public roadmap trust — dev.to](https://dev.to/mark_walker/the-3-fastest-growing-saas-teams-we-studied-all-do-this-they-publish-a-public-roadmap-cf3) · [Dev tool launch weeks — daily.dev](https://business.daily.dev/resources/developer-tool-launch-week-run-lessons-resend-linear-supabase/)
- [What is libp2p](https://docs.libp2p.io/concepts/introduction/overview/) · [MCP roadmap (.well-known server cards)](https://modelcontextprotocol.io/development/roadmap)
- [rustup install convention](https://rust-lang.github.io/rustup/installation/index.html) · [Deno install](https://docs.deno.com/runtime/getting_started/installation/) · [uv single-line install proposal](https://github.com/astral-sh/uv/issues/6533)
- [SSG 2026 deep dive — youngju.dev](https://www.youngju.dev/blog/culture/2026-05-14-static-site-generators-2026-hugo-eleventy-astro-mkdocs-docusaurus-mintlify-starlight-comparison-deep-dive.en) · [Starlight vs Docusaurus — LogRocket](https://blog.logrocket.com/starlight-vs-docusaurus-building-documentation/)
