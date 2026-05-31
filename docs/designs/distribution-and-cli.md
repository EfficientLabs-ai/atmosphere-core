# Design: Launch distribution architecture + the `stratos` CLI

**Status:** ✅ Codex Pattern-C reviewed → **BUILD WITH CHANGES**. The **"✅ REVISED per Codex"**
section at the bottom governs; the body is the original draft. Build proceeds in tested increments;
Increment 1 (standalone enforcement) is DONE.
**Goal:** ship the **full launch structure** so StratosAgent and The Atmosphere are separately
installable, with a clean user-facing CLI — zero-bug, clean-slate launch. Decisions locked with the
operator (2026-06-01):
1. **`atmosphere-core` = private upstream**, the single source of truth (all dev happens here).
2. **Monorepo + publish pipeline** — products are built/split OUT to public repos; we never fragment dev.
3. **Install = both** `npx @efficientlabs/stratos` AND a `curl … | bash` installer.
4. **New official repo** = org flagship (`.github` profile + docs hub) under `EfficientLabs-ai`.
**Authority:** subordinate to STATE_OF_REALITY.md. No fabricated claims — the CLI must be HONEST
(the current `stratos-ctl status/sync/compile/audit` prints fabricated data; that is a launch blocker).

## Ground truth (verified)
StratosAgent's runtime (`api-shim` + `stratos-agent/src`) has **no hard dependency on `atmos-core`**
(the mesh) — only a configurable output-path string in `gsi-compiler.js` and two test files reference
it. So **Stratos runs standalone** on local Ollama / BYOK; The Atmosphere is an *optional* layer.

## Product → repo mapping
| Public repo | Product | Built from (monorepo) | Mesh? |
|---|---|---|---|
| `StratosAgent` | the agent (drop-in for legacy agents) | `stratos-agent` + `api-shim` + `stratos` CLI | optional |
| `TheAtmosphere` | the P2P/DePIN compute grid (node) | `atmos-core` + `maximus-telemetry` + bundles | is the mesh |
| `.github` (org) | official Efficient Labs flagship | new `profile/README.md` + docs | — |
| `atmosphere-core` | private upstream / source of truth | everything | — |

## 1. The `stratos` CLI (StratosAgent's front door)
A single, honest, dependency-light CLI (`bin: stratos`), evolved from `stratos-ctl` but **mesh-optional
and free of fabricated output**. Commands:
- `stratos init` — the setup wizard (reuses PR #7 `agent-config` + the chat-config model): name the
  agent, pick local model OR add a BYOK key (env, never stored by us), optional mesh opt-in. Writes
  `agent-config.json` (authoritative).
- `stratos start` — boot the local agent daemon (api-shim) on 127.0.0.1; prints the real endpoint.
- `stratos status` — **honest** status: agent name, model + effective readiness (from
  `effectiveCapabilities`), endpoint, daemon up/down, mesh = real `fleet.json` or "off". NO fake SOL
  balance, NO fake peer list, NO fake record counts.
- `stratos bind <chat-id>` — owner binding (PR #7).
- `stratos models` — list installed local models (Ollama probe) + configured route.
- `stratos doctor` — preflight: Node version, Ollama reachable?, port free?, config valid? — the
  zero-bug-at-launch guardrail (tells the user exactly what's missing).
- `stratos version` / `stratos help`.
- `stratos mesh …` — only present/active when the optional Atmosphere add-on is installed (lazy).
Mock-laden commands (`sync`/`compile`/`audit` fabricated output) are **removed or made honest** before
launch. The CLI degrades gracefully when the mesh package is absent (Stratos-only install).

## 2. npm package boundary
- `@efficientlabs/stratos` — the publishable agent: bundles `stratos-agent` + `api-shim` + CLI, deps
  pruned to runtime-only, mesh code NOT required. `bin.stratos` → the CLI. `files` allowlist (no tests,
  no `.stratos-profile`, no secrets). `engines.node`.
- `@efficientlabs/atmosphere` (later) — the mesh node (`atmos-core`), optional peer dependency of
  stratos for users who opt into the grid.
- Inside the monorepo these stay `file:` workspaces; the publish pipeline rewrites to versioned deps.

## 3. The installer (`curl … | bash`)
A POSIX script: detect OS/arch, check/instruct Node + Ollama, `npm i -g @efficientlabs/stratos` (or a
pinned tarball), then run `stratos doctor` and print the next step (`stratos init`). Idempotent, no
sudo unless installing a system service, honest about prerequisites. Hosted from the StratosAgent repo.

## 4. The publish pipeline (monorepo → product repos)
A `scripts/publish-product.mjs` that, per product, assembles a clean distributable from the monorepo
and pushes it to the product repo (build-artifact push, NOT `git subtree` history surgery — simpler,
deterministic, and keeps the private upstream's history private):
- `stratos`: copy the runtime packages + CLI + generated README/LICENSE + the rewritten
  `package.json`; run the test suite against the assembled tree; commit to `StratosAgent` repo.
- `atmosphere`: same for the mesh node + ghost/relay bundles → `TheAtmosphere` repo.
- Dry-run by default; `--push` to actually publish; never pushes secrets (reuses `secret-guard`
  scanning of the assembled tree as a pre-push gate). Versioned + tagged.
- **No npm publish or repo push happens unattended** — these are operator-gated release steps.

## 5. Official Efficient Labs repo (`.github` flagship)
- `EfficientLabs-ai/.github` with `profile/README.md` (renders on the org page): what Efficient Labs
  is, the two products, install one-liners, links, honest status. Plus `docs/` (getting-started,
  architecture, security posture) and org `LICENSE`/`SECURITY.md`/`CODE_OF_CONDUCT.md`.
- Public. Must pass the anonymization check (no client data, no internal substrate names, no secrets).

## Build order (each its own PR, tested, Codex-reviewed where security-relevant)
1. `stratos` CLI (honest, mesh-optional) + CLI tests + `stratos doctor`.    ← start here
2. `@efficientlabs/stratos` package manifest + assemble/build script + a "runs with mesh absent" test.
3. Installer script + `stratos doctor` integration + shellcheck.
4. Publish pipeline (dry-run + secret-gate) — operator runs `--push`.
5. `.github` flagship repo content (profile + docs), anonymization-checked.

## Honesty / zero-bug guardrails
- No CLI command prints data it didn't measure (kills the current fake `status/sync/compile/audit`).
- `stratos doctor` is the pre-launch self-check; CI runs the assembled-tree test (Stratos with mesh
  code physically absent) so "standalone" is proven, not asserted.
- Nothing is pushed to a public repo or npm without an explicit operator `--push`, behind a
  secret-scan gate.

## Open questions for Codex
1. Build-artifact push vs `git subtree split` for the publish pipeline — is artifact-copy the right
   call to keep the private upstream's history private, or does subtree give enough value to justify it?
2. CLI: evolve `stratos-ctl` in place vs. a new `stratos` bin that imports the same core — which
   minimizes drift and dead mock code?
3. Package boundary: is one `@efficientlabs/stratos` package right, or should the CLI, the agent core,
   and the api-shim be separately versioned packages from day one?
4. Standalone proof: is "assemble tree with `atmos-core` removed + run tests" a strong enough gate that
   Stratos truly has no mesh dependency, or should CI lint-ban `atmos-core` imports in the two packages?
5. Anything in the install path (`curl|bash`, global npm, doctor) that's a security or trust footgun?

---
## ✅ REVISED per Codex Pattern-C review (verdict: BUILD WITH CHANGES) — THIS governs

Seven required changes (all adopted) + 5 answered questions:

1. **CRITICAL — Installer fails closed.** `curl … | bash` becomes a thin **verifier/downloader of a
   pinned, signed artifact**, **user-space only**, nothing privileged by default. Daemon/service setup
   moves to an explicit `stratos service install`. The existing `scripts/install.sh` (silent
   `npm i -g pear`, `sudo npm i -g`) is an anti-pattern and is **replaced/removed**.
2. **CRITICAL — Honesty enforced in code.** Delete the fake `status/sync/compile/audit/logs` behavior;
   missing optional features/deps surface as **`doctor` failures, never mock success**.
3. **CRITICAL — Standalone is ENFORCED, not asserted.** ✅ DONE (Increment 1): `api-shim` no longer
   imports the `stratos-agent` barrel (which re-exported browser/mesh/scheduler); `node-cron` made
   lazy in `gsi-compiler`. `test-standalone-graph.mjs` statically walks the daemon load graph and
   bans `playwright/hyperswarm/corestore/autobase/node-cron/atmos-core`. Will also add a packed-tarball
   smoke install with dev deps omitted (Increment 3).
4. **CRITICAL — Publish pipeline = allowlist-assemble, not content scan.** Assemble from an explicit
   allowlist into a clean tree; then filesystem secret scan **+ hard reject** `.env*`, `.secrets-vault`,
   `.stratos-profile`, tests, logs, local state before push. Add a **provenance manifest** (source
   commit, build-script version, file hashes) so privacy is kept without losing traceability.
5. **HIGH — Freeze the public surface before first publish.** One public `@efficientlabs/stratos` with
   `exports`, `bin`, `files`, `engines`, declared internal deps, and a stable config/data-dir policy.
6. **HIGH — `stratos init` is strictly local.** No wallet / mesh-rewards prompts in base onboarding;
   wallet + mesh enrollment live behind the optional Atmosphere add-on install. (The current
   `stratos-ctl init` asks for a Solana wallet — that moves out.)
7. **MEDIUM — Trust footguns.** Version-pin all install commands; `doctor` is **read-only / never
   mutates / never phones home**; add a clean-tarball smoke test in CI before GA.

**Answers:** (1) artifact-copy (not subtree) **+ provenance manifest**. (2) **new `stratos` bin** backed
by an extracted shared core; keep `stratos-ctl` only as a short-lived compat shim. (3) **one** public
`@efficientlabs/stratos` for day one; finer splits stay private/internal. (4) assemble-without-mesh +
tests is necessary but not sufficient — **also** CI-ban mesh/browser imports in shipped entrypoints
(done) **and** a clean packed-artifact install smoke test, dev deps omitted. (5) yes — `curl|bash`,
unpinned `npx`, `sudo npm -g`, auto-start services, silent second-stage installs, mutating/phone-home
`doctor` are all footguns; the installer verifies a pinned signed artifact and does nothing privileged.

### Revised build order (each its own tested increment)
1. ✅ **Standalone enforcement** (import-graph fix + `test-standalone-graph.mjs`). DONE.
2. Honest `stratos` bin (new) + `doctor` (read-only) + local-only `init`; `stratos-ctl` → thin shim;
   delete fabricated `status/sync/compile/audit/logs`. + CLI tests.
3. `@efficientlabs/stratos` manifest (`exports/bin/files/engines/deps/data-dir`) + clean packed-tarball
   smoke (dev deps omitted) in CI.
4. Installer: pinned-signed-artifact verifier, user-space, no privilege; `stratos service install` for
   the daemon. Replace `scripts/install.sh`.
5. Publish pipeline: allowlist-assemble → secret-scan + hard rejects → provenance manifest; `--push`
   operator-gated.
6. `.github` org flagship (profile + docs), anonymization-checked.
