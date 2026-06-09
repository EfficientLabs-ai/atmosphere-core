# Issue Register — Claude Independent Audit

**Auditor:** Claude (Opus 4.8), audit lead, synthesizing 5 parallel auditors
**Date:** 2026-06-09
**Status:** Independent audit. To be cross-referenced with Codex's parallel audit before any issue is actioned. Two-agent agreement (Claude + Codex) is the bar for promoting an issue into a sprint.
**Scope:** Four repos — `atmosphere-core`, `StratosAgent`, `TheAtmosphere`, `efficientlabs-web` — plus live VPS infra/security posture.

This register deduplicates the raw findings (merging items that share a single root cause), assigns stable ids ordered by severity, and maps every issue to a named sprint. Positive verifications (things checked and found honest/correct) are recorded inline where they bound an issue's blast radius, but only real defects/mismatches receive an `EFL-` id.

---

## Summary

| Severity | Count | Issue IDs |
|----------|-------|-----------|
| Critical | 0 | — |
| High | 6 | EFL-001 … EFL-006 |
| Medium | 5 | EFL-007 … EFL-011 |
| Low | 7 | EFL-012 … EFL-018 |
| **Total** | **18** | |

Dedup notes: `STATE_OF_REALITY.md:24` ("falls through to qwen") was merged into the qwen doc-reconciliation issue (EFL-001, same root + same fix pass). The two hardcoded-qwen-string code defects (`telegram-bridge.js` model id and `LocalInferenceEngine` constructor default) were merged into one code-honesty issue (EFL-007, same root: fake model identifier emitted on live/receipt paths). The `ATMOS_GATEWAY_SECRET unset` and `.env 644` items remained distinct (different layers, different fixes). All other distinct real issues preserved.

---

## Critical

None found by this audit. The headline trust-core (offline fail-closed hybrid PQC seal in `TheAtmosphere`, the WASI deny-by-default sandbox, the VaultHost seed wipe, and the hermetic suite — 76 tests, green **locally**) were all verified as genuinely sound — see the "Verified closed / honest" appendix. *(Caveat: GitHub Actions CI itself is RED — 1/76 fails in CI; see #59 below. "Sound locally" ≠ "CI green.")*

---

## High

### EFL-001 — Docs assert a live `qwen2.5:7b` that does not exist on the box
- **Repo:** atmosphere-core
- **Evidence:** Live `/api/tags` lists only `gemma4:e4b`, `gemma2:2b`, `nomic-embed-text`, `all-minilm` — no qwen. Upstream `:5001 /health` → `{"backing":"gemma2:2b"}`. `docs/PROGRAM_STATUS.md:8` says "removed qwen2.5:7b → freed 4.7 GB", yet qwen is still asserted live in `README.md:17,78`, `STATE_OF_REALITY.md:16,24,32,52`, `ARCHITECTURE.md:74`, `MODEL_ROUTING.md:54,56,69`, `docs/doctrine/STRATOS.md:100,148,150`, `docs/doctrine/PRD.md:113,246`, `docs/operating/STATE.md:45`, `GROUNDED_STRATEGY.md:14,25`. `STATE_OF_REALITY.md:24` even claims the inverse of reality (gemma4 absent / qwen the floor) — both wrong.
- **Impact:** The flagship public/doctrine claim ("answers from a real local qwen2.5:7b") is false on the running system; the doc set is internally inconsistent (PROGRAM_STATUS contradicts every other doc). Undermines the project's own honesty discipline.
- **Fix:** Treat `PROGRAM_STATUS.md:8` as source of truth. Global find/replace `qwen2.5:7b` → actual served models (`gemma2:2b` fast default + `gemma4:e4b` chat/multimodal) across all listed docs; rewrite `STATE_OF_REALITY.md:24` and `MODEL_ROUTING.md:54-69` to match real model state; update latency note to measured gemma2:2b figure.
- **Sprint:** status.json re-audit

### EFL-002 — `active-vision.js` fabricates a fake "VLM analysis" on the live `/vision` path
- **Repo:** atmosphere-core
- **Evidence:** `packages/atmos-desktop/src/sensory/active-vision.js:102-119` returns a hardcoded `elementsParsed` array labeled "[Local Vision-Language Model Analysis]"; lines 94-95 hardcode `activeWindow`/`focusedProcess` on non-Windows; `captureScreenFrame()` (60-65) writes a 100-byte mock on failure. Called live by `packages/api-shim/src/local-inference.js:233-238` and the Telegram `/vision` command (`telegram-bridge.js:168-183`).
- **Impact:** On the live agent path a user asking about their screen gets a fully fabricated, plausible-sounding description unrelated to reality — the single most dishonest behavior in the repo, directly violating the stated HONESTY CONTRACT (`voice-engine.js:16-17`).
- **Fix:** Replace the `active-vision.parseActiveVisualContext` import/use in `local-inference.js` with the honest `voice-engine.see()` (`packages/stratos-agent/src/sensory/voice-engine.js:222` — real Ollama vision call returning `{ok:false,reason}` on failure). Delete/quarantine the fabricated branches or gate behind an explicit synthetic-demo flag.
- **Sprint:** security hardening

### EFL-003 — Cross-channel context bleed in vector retrieval (multi-tenant data leak)
- **Repo:** atmosphere-core
- **Evidence:** `packages/stratos-agent/src/memory/vector-bank.js`: `queryAmbientMemory()` (138-154) applies tag isolation only when `contextTag` is passed (defaults null, opt-in); `queryInterceptedReasoning()` (222-231) and `queryCognitiveSkill()` (193-202) take **no** tag param and search the whole table. `local-inference.js:101` calls intercepted-reasoning with no isolation. Inserts never tag by channel/user (`sensory-ingestion.js`, `genesis-harvester.js:390` tag by sensor type), so the ambient filter matches zero rows; `telegram-bridge.js` sets no `isolatedContextTag` at all.
- **Impact:** Reasoning traces, learned skills, and ambient memory from one user/channel can surface in another user's RAG context. The `/stratos` page markets "Metadata Isolation … preventing cross-client trace bleeding", but the live path does not back it for 2 of 3 memory layers. Real multi-tenant leak class, not a deferral.
- **Fix:** Add a mandatory `channelKey`/`contextTag` column to all three tables, written on every insert (channel+user identity). Make the tag a required arg on all three query fns and fail-closed (empty result) when absent. Wire `isolatedContextTag` through `telegram-bridge.js`. Add a test asserting a query under channel A returns 0 rows written under channel B.
- **Sprint:** security hardening

### EFL-004 — README "Prove it #2" verify demo is not reproducible — no CLI exports a bundle
- **Repo:** StratosAgent
- **Evidence:** `README.md:134-144` presents `node bin/stratos.js receipt verify ./bundle.json` / `./tampered.json` as runnable. Neither file ships and there is no `receipt export` subcommand — `cmdReceipt` (`src/cli/stratos-cli.js:509-544`) implements only `verify`. Running it fails live: `cannot read bundle: ENOENT … bundle.json`. The capability exists in the library (`src/ledger/capability-receipt.js:278 exportBundle()`) but is unreachable from the CLI.
- **Impact:** The single most-emphasized trust claim in the README — the substrate the product pitch rests on — cannot be reproduced by a user following the README verbatim. First-touch credibility failure.
- **Fix:** Add `receipt export <ws/proj/wf/task> [--out bundle.json]` to `cmdReceipt` calling `ReceiptLog.exportBundle()`, then update README to show export → verify → tamper. Alternatively ship a checked-in sample `bundle.json` + `tampered.json`.
- **Sprint:** skill-executor wiring

### EFL-005 — README package-import examples use the wrong package name
- **Repo:** StratosAgent
- **Evidence:** `README.md:203-205` shows `import … from 'stratos-agent/cli'` / `'stratos-agent/receipt'` / `'stratos-agent/router'`. Published name is `@efficientlabs/stratos` (`package.json:2`) with export keys `./cli`, `./receipt`, `./router` (`package.json:16-29`). As written all three throw `ERR_MODULE_NOT_FOUND`.
- **Impact:** Every developer who copy-pastes the "Import the engines directly" examples after `npm i -g @efficientlabs/stratos` gets an immediate module-not-found error; the documented programmatic API looks broken.
- **Fix:** Replace `stratos-agent/` with `@efficientlabs/stratos/` in `README.md:203-205`.
- **Sprint:** skill-executor wiring

### EFL-006 — Documented onboarding path crashes with a raw stack trace (placeholder `pinnedPubKey`)
- **Repo:** TheAtmosphere
- **Evidence:** `node-runner/mesh-node.mjs:74-76` decodes `cfg.pinnedPubKey` via `JSON.parse(b4a.toString(b4a.from(...,'base64')))` with no try/catch; `config.example.json:6` ships the literal placeholder `<base64 of origin public key …>`. Following the README exactly (`cp config.example.json config.json` → `node mesh-node.mjs`) throws `SyntaxError: Unexpected token 'm' … is not valid JSON at mesh-node.mjs:75` with a full stack trace, exit 1 — the exact "raw stack trace" class commits 3e86949/dac8e51 claim to have eliminated.
- **Impact:** The one documented "join a live mesh" path dumps an unfriendly stack trace for any first-time operator without a hand-given origin key; looks broken on first contact.
- **Fix:** Wrap the decode (73-76) in try/catch like `loadConfig()` already does; on failure print a friendly message pointing to `verify.mjs` and to obtaining a real origin key. Replace the placeholder with a structurally-valid (clearly fake) base64 bundle so the decode reaches a meaningful "not a real origin key" state.
- **Sprint:** mesh

---

## Medium

### EFL-007 — Hardcoded nonexistent qwen model identifiers emitted on live + receipt paths
- **Repo:** atmosphere-core
- **Evidence:** (a) `packages/api-shim/src/telegram-bridge.js:177,316,454` hardcode `model:'qwen-2.5-vlm-telegram-local'` while the real chat model is `gemma4:e4b` (line 28); the gateway normalizes the `-local` alias back to `gemma2:2b` (`local-inference.js:32`), so the label is cosmetic and resolves to neither qwen nor the gemma4 the `/status` line claims. (b) `packages/api-shim/src/local-inference.js:38` defaults `this.modelName` to `'Qwen-2.5-7B-Quantized-Local'`, used as receiptRef/responseModel fallback (205-206); code paths not reaching the `normalizeOllamaModelName` set (264-266) can stamp the fake qwen label. Commit 8966f41's honesty fix left this constructor default intact.
- **Impact:** Wire-level model ids and tamper-evident capability receipts can record a model that never ran — a provenance rail recording a false model identity partially defeats its purpose. The prior honesty-fix is incomplete.
- **Fix:** Set the three telegram request bodies to `this.telegramModel`/`'local'`; change the `LocalInferenceEngine` default to `'local'` (resolve via `normalizeOllamaModelName` → `LOCAL_MODEL_DEFAULT`). Remove the `qwen-2.5-vlm-telegram-local` and `Qwen-2.5-7B-Quantized-Local` strings entirely. Add a hermetic assertion that `responseModel` is always an installed tag or explicit `'local'`.
- **Sprint:** status.json re-audit

### EFL-008 — `config.example.json` placeholder wallet makes a literal copy refuse to start
- **Repo:** TheAtmosphere
- **Evidence:** `config.example.json:5` sets `walletAddress` to a placeholder sentence; `mesh-node.mjs:55-67 resolveWallet()` runs base58 validation and `process.exit(2)` on any non-empty invalid string, before the Hyperswarm load. `cp config.example.json config.json && node mesh-node.mjs --once` → "✗ invalid … Refusing to start." exit 2. README (`node-runner/README.md:36`, top README:126-130) and STATE file all describe wallet as optional/omittable.
- **Impact:** A user copying the example verbatim cannot start the node, even though docs say wallet is optional and the node should "join unattributed". Direct README-vs-behavior mismatch.
- **Fix:** Treat the placeholder sentinel (or any value containing `<`) as absent → null/unattributed instead of fatal, OR omit `walletAddress` from `config.example.json` and document it only as an optional flag. Keep strict validation only for real-looking attempts.
- **Sprint:** mesh

### EFL-009 — Transport-failure message misattributes the cause to Node version
- **Repo:** TheAtmosphere
- **Evidence:** `mesh-node.mjs:178-183` catches the Hyperswarm require failure and asserts "Node 20 or 22 is recommended (newer Node may lack a prebuild)". On Node 22 the require fails with "Cannot find addon …"; `require-addon/lib/node.js:34-39` swallows the real cause, which is actually "failed to map segment from shared object" (an exec/mmap constraint). The prebuild `node_modules/udx-native/prebuilds/linux-x64/udx-native.node` does exist.
- **Impact:** When transport fails for reasons other than a missing prebuild (noexec /tmp, seccomp, glibc mismatch), the node tells the operator the wrong thing and sends them down a dead-end — and the message shows on the very Node versions it recommends.
- **Fix:** Print the addon error's `.cause`/`err.code`/candidate list when present; soften wording to "the native transport could not load on this machine (Node version, missing prebuild, or restricted exec environment)". Keep the `verify.mjs` pointer.
- **Sprint:** mesh

### EFL-010 — `/status` page is permanently in baseline-fallback while framed as "live, real-time"
- **Repo:** efficientlabs-web
- **Evidence:** `lib/live-activity.ts:30` `ORG='EfficientLabs-ai'`, `LIVE_REPOS` = the four repos. Verified: `api.github.com/repos/EfficientLabs-ai/atmosphere-core` → 404 (private), org → 200. With no `GITHUB_READ_TOKEN`, `gh()` 404s every repo, `liveEntries` stays empty, `getActivity()` returns `isLive:false` (161-163). `app/status/page.tsx:19` `revalidate=300` + metadata call it "Live, commit-driven proof of work … pulled in real time from GitHub". Page does not 500 (graceful fallback) but ISR re-fetches 404 every 5min with no effect.
- **Impact:** `/status` serves the committed baseline and shows `isLive=false` until repos go public or a token is set; the "live/real-time" framing overstates reality at launch.
- **Fix:** Either (a) set server-only `GITHUB_READ_TOKEN` in Vercel env, (b) make the repos public before launch, or (c) ensure `ActivityHeadline` visibly reflects `live=false` honestly. Data path is sound; only the source is unavailable.
- **Sprint:** web deploy

### EFL-011 — `honesty:self-test` script exits 1 on a stale clean-fixture false positive
- **Repo:** efficientlabs-web
- **Evidence:** `node scripts/honesty-guard.mjs --self-test` → exit 1 ("self-test: FAIL"). Root cause `honesty-guard.mjs:354`: clean fixture "Five channel adapters are live. Speech & vision are still mock." now trips the guard because `status.json` classifies "Channel adapters" as level `config` (not `live`), so `scanText` flags it as an overclaim, violating the self-test assertion at line 359. The real build guard (non-self-test path) still exits 0, so the production build is unaffected.
- **Impact:** The regression guard's own self-test is red; any CI step running `npm run honesty:self-test` fails. Does not block `npm run build`, but the self-verification harness is no longer trustworthy.
- **Fix:** Update the clean fixture at line 354 to not pair a now-`config`-level capability with "live" (use a genuinely-live capability) or sync the fixture to current `status.json` levels; re-run `--self-test` to confirm exit 0.
- **Sprint:** status.json re-audit

---

## Low

### EFL-012 — `payment-engine.getLiveBalance` returns a fabricated "1 SOL" on RPC failure
- **Repo:** atmosphere-core
- **Evidence:** `packages/atmos-core/src/billing/payment-engine.js:42-45` logs a warning then `return 1000000000; // 1 SOL mock fallback`. Imported by `x402-invoice.js`/`index.js`. Not reached by the live Telegram `/balance` (which is hardcoded-honest, `telegram-bridge.js:187-192`).
- **Impact:** Low — the economic layer is an intentional deferral and the user-facing path is honest. But the function silently returns a fake non-zero balance; any future caller inherits a fabricated number (latent honesty landmine).
- **Fix:** Throw or return `{ok:false,reason}` on RPC failure. Given the economic freeze, alternatively gate the module behind the same not-live guard the Telegram command uses, with a comment forbidding synthetic balances.
- **Sprint:** misc (deferred economic-layer guardrail)

### EFL-013 — Channel adapters underclaimed: docs call real-but-token-gated adapters "scaffold-only"
- **Repo:** atmosphere-core
- **Evidence:** `discord-adapter.js:8` header: "a REAL two-way Discord channel"; `start()` (103) lazy-imports discord.js and connects when `DISCORD_BOT_TOKEN` is set; `index.js:31-44` wires Discord/Slack/Matrix/Signal as no-op-without-token. `STATE_OF_REALITY.md:91` and `GROUNDED_STRATEGY.md:14` still call them "SCAFFOLD … not connected to live platforms."
- **Impact:** Low and in the safe direction (underclaiming), but still a doc-vs-reality mismatch worth correcting for accuracy.
- **Fix:** Update `STATE_OF_REALITY.md:91` / `GROUNDED_STRATEGY.md:14` to: "adapters are implemented and connect when platform tokens are configured; currently inert because tokens are not set on this host."
- **Sprint:** channel integration

### EFL-014 — `pm2` bridge metrics show heap at 93.7% and HTTP p95 71s (saturating under load)
- **Repo:** atmosphere-core
- **Evidence:** `pm2 jlist` axm_monitor for `atmos-secure-bridge`: Heap 93.72% (74.58 / 79.58 MiB), HTTP P95 71273 ms, Mean 13225 ms, RSS 232.3mb. The 71s p95 lines up with log `EFATAL read ETIMEDOUT` / `ETELEGRAM 502`.
- **Impact:** Gateway runs near its heap ceiling (GC-thrash / OOM-restart risk under sustained traffic) and some requests take >70s, consistent with the `/v1/chat/completions` proxy blocking on a slow/unreachable upstream. Tolerable single-tenant now; will manifest as hangs/restarts as channel traffic grows.
- **Fix:** Raise `--max-old-space-size` for the bridge interpreter; add a per-request upstream timeout + circuit-breaker around the `127.0.0.1:5001` proxy call; add a `pm2 max_memory_restart` guard.
- **Sprint:** security hardening (infra-hardening lane)

### EFL-015 — `atmos-secure-bridge` 42 restarts from now-fixed shutdown bug + node-ABI churn
- **Repo:** atmosphere-core
- **Evidence:** `pm2 restart_time=42` but `pm_uptime` 14h and running code is current (index.js mtime predates start). Error log holds 8× `TypeError: signal.stop is not a function at shutdown (index.js:70:12)` and 30× `NODE_MODULE_VERSION 127 … requires 115` (better-sqlite3 ABI), all before the last restart. Current `index.js:54-63` guards each component via `stopComponent()`; `require('better-sqlite3')` loads OK under v22.22.3; `/health` → 200 in 1.5ms.
- **Impact:** Not currently crash-looping; both root causes are resolved in the running build. Risk is only that the high restart count masks future regressions.
- **Fix:** `pm2 reset atmos-secure-bridge` to zero the counter; pin the node version in the pm2 ecosystem and add `npm rebuild better-sqlite3` to the deploy step to prevent ABI drift. No code change needed (shutdown bug already fixed).
- **Sprint:** security hardening (infra-hardening lane)

### EFL-016 — `package.json` `files` whitelist references a nonexistent `docs/` directory
- **Repo:** StratosAgent
- **Evidence:** `package.json:30-36` `files` lists `"docs/"`, but there is no `docs/` dir (`ls -d docs` → not found). Docs live at repo root and ship via the `*.md` glob (confirmed in `npm pack --dry-run`: 27 files, all docs present).
- **Impact:** Cosmetic — npm silently ignores the missing glob, tarball is correct. Signals a stale packaging config.
- **Fix:** Remove `"docs/"` from the `files` array (or create `docs/` and move the `*.md` there if that was the intent).
- **Sprint:** misc

### EFL-017 — `stratos init`/`trace`/`complete` write node-keys + workspaces under CWD, not a per-user home
- **Repo:** StratosAgent
- **Evidence:** `src/cli/stratos-cli.js:375 nodeKeysPath()` defaults to `<cwd>/.stratos-profile/node-keys.json` (`_ROOT = process.cwd()`, line 45); `src/workspace/workspace-tree.js:38` defaults workspaces to `<cwd>/.stratos-profile`. After a global install the private signing key and workspaces land in whatever dir the user is `cd`'d into; a second `init` from a different cwd silently creates a NEW node identity. `.gitignore:13` only protects the repo's own cwd.
- **Impact:** Surprising for a global CLI: persistent node identity is cwd-scoped, producing different `did:atmos` identities and orphaned key files across directories.
- **Fix:** Default keys/workspaces to a stable per-user home (`os.homedir()/.stratos-profile`) when not run inside a project, keeping the `STRATOS_PROFILE_DIR`/`STRATOS_WORKSPACES_DIR`/`STRATOS_NODE_KEYS` overrides. Document the behavior if cwd-relative is intentional.
- **Sprint:** skill-executor wiring

### EFL-018 — `config.json` trust anchor is documented "keep it private" but not gitignored
- **Repo:** TheAtmosphere
- **Evidence:** `node-runner/README.md:39` "config.json holds your trust anchor — keep it private." Repo-root `.gitignore` lists `node_modules/`, `.env*`, `*.key`, `*.pem`, `*.pat`, `.secrets-vault/` but **not** `config.json`; there is no `node-runner/.gitignore`.
- **Impact:** An operator who creates `config.json` in a fork and runs `git add .` can commit their pinned origin key (a public key, lower risk than a secret — but docs frame it as private, so the gitignore should back that up).
- **Fix:** Add `config.json` to `.gitignore` (or a `node-runner/.gitignore`); keep `config.example.json` tracked.
- **Sprint:** mesh

---

## Web/infra Low-severity hygiene (also tracked)

These efficientlabs-web and security-hygiene items are real but low; folded into the count above where they carry an id. The remaining web/infra polish items below are grouped here for completeness and carry the next id range only where they are distinct defects:

> Note on dedup scope: the following four items appeared in the raw findings as distinct low-severity issues. They are preserved as real but were judged web-polish / infra-hygiene rather than promoted into the High/Medium tiers. They share the `misc` and `security hardening` / `web deploy` buckets. To keep ids contiguous and avoid renumbering, they are documented here with their evidence and fix; if the cross-reference with Codex confirms them, assign EFL-019…EFL-022 at action time.

- **Footer dead links** (efficientlabs-web): `components/Footer.tsx:8` — "Manifesto" and "Careers" both point to `'#'`. Fix: route, remove, or relabel. → **web deploy** (dead-link sweep).
- **No server-side route protection on `/dashboard` + `/app/*`** (efficientlabs-web): `lib/supabase.ts:9-10` returns null when env unset; `app/dashboard/page.tsx` and `app/app/*` are `'use client'` gating only on `supabase.auth.getUser()` in `useEffect`; `proxy.ts` does host-based noindex only. Low now (all values are placeholders, no real data served); becomes a real authz gap the moment any module renders real per-user data. Fix: add Supabase SSR/middleware server-session verification before wiring real data (contrast `/ops`, which is correctly server-gated, HMAC constant-time, fail-closed). → **security hardening**.
- **Integrations copy overclaims a live broker** (efficientlabs-web): `app/app/integrations/page.tsx:90-95` present-tense "runs through a … write-approval-gated broker" while the broker is built-but-not-wired (heavily hedged by "nothing connected yet" elsewhere). Fix: soften to future tense or wire the broker before launch. → **channel integration**.
- **`prebuild` rewrites `data/activity.json`, dirtying the tree** (efficientlabs-web): `package.json` prebuild regenerates the file every build; `git status -s` shows ` M data/activity.json`. No functional impact (Vercel builds clean). Fix: gitignore the generated file or make `build-activity-feed` idempotent. → **misc** (repo hygiene).
- **`ATMOS_GATEWAY_SECRET` unset — spend/mcp routes have no per-request auth** (atmosphere-core): `/proc/<pid>/environ` confirms MISSING; live log "spend/mcp routes are loopback-perimeter only (no per-request auth)". `gateway-auth.js:16,44` makes it optional. Mitigated by loopback bind (`server.js:826`), non-loopback reject (237/546), ufw (tailscale0 + 80/443 only). Low blast radius but perimeter-only, not defense-in-depth. Fix: set `ATMOS_GATEWAY_SECRET` in the bridge pm2 env (resolved from vault at boot) to enable the existing `x-atmos-gateway` check. → **security hardening**.
- **`.env` / `.env.local` are mode 644 (world-readable)** (atmosphere-core): `stat` → 644 `neo:neo`; not currently exploitable because `/home/neo` is 750 with no other group members. Fix: `chmod 600` both; add a deploy-time check failing on any group/other-readable `.env`. → **security hardening**.

---

## Verified closed / honest (no id — positive findings, recorded to bound blast radius)

- **TheAtmosphere offline PQC proof** — `verify.mjs` + `npm test` both 5/5 pass, EXIT 0; all 4 tamper cases fail-closed (`quantum-crypto.js:137-165` requires both Ed25519 and ML-DSA-65). Real Hyperswarm `swarm.join` with no mock and no inbound `.listen()` — "no open ports" claim accurate. (L4 cross-machine DHT-join could not be independently reproduced in-sandbox due to the exec/mmap restriction; rests on team hardware.)
- **WASI sandbox** (`wasi-sandbox.js:95-105`) — deny-by-default env allowlist, egress DENY_ALL; the prior caller-env-leak gap is closed. (Optional: denylist `/KEY|SECRET|TOKEN|KEYPAIR/`.)
- **VaultHost** (`vault-host.js`) — decrypted seed/passcode/salt/key all zeroized; only the long-lived PQC `secretKey` persists (inherent to an in-process signer, by design).
- **Hermetic suite (LOCAL only)** — `npm run test:ci` → 76/76 pass **locally**, honestly scoped (explicit allowlist; live-Ollama integration tests excluded). **GitHub Actions CI is RED**, though: `test-composio-sovereign.mjs` fails (1/76) on BOTH Node 20 and 22 — passes locally, so it is env/network-dependent (not hermetic) → #59. Inverse risk: evolution-seam + chat-memory are never automated → see misc test-coverage note.
- **No committed secrets** — `git grep`/`git log -p` over both repos found only test-fixture dummy values; `.gitignore` correct. (Operator must confirm previously-noted leaked tokens were rotated out-of-band.)
- **efficientlabs-web build GREEN** — `npm run build` compiles all 49 routes, TS clean, honesty-guard passes 55 surfaces. The `/app/*` "stub pages" premise is outdated: they are 10 fully-built, honesty-gated preview modules that degrade safely signed-out.
- **Deploy blocker is external** — `.vercel/project.json` links `efficient-labs`; build is green locally; the hold is a Vercel account/email verification issue requiring Vercel support, not an engineering fix. → tracked under **web deploy** (ops escalation).

---

## Sprint mapping

**skill-executor wiring**
- EFL-004 — receipt-export CLI (unreachable `exportBundle` from CLI)
- EFL-005 — README package-name import fix
- EFL-017 — cwd-scoped node-keys/workspaces → stable per-user home

**status.json re-audit** (model-identity / honesty-guard truth pass)
- EFL-001 — qwen-doc reconciliation across all docs (incl. STATE_OF_REALITY:24)
- EFL-007 — hardcoded qwen model strings on live/receipt paths
- EFL-011 — `honesty:self-test` stale clean-fixture false positive

**channel integration**
- EFL-013 — docs call real adapters "scaffold-only" (underclaim correction)
- (web) integrations-page broker overclaim → soften copy / wire broker

**mesh**
- EFL-006 — `pinnedPubKey` placeholder crash (raw stack trace)
- EFL-008 — placeholder wallet refuses to start vs "optional" docs
- EFL-009 — transport-failure message misattributes cause to Node version
- EFL-018 — `config.json` trust anchor not gitignored

**web deploy**
- EFL-010 — `/status` permanently baseline-fallback while framed "live"
- (web) footer dead links ("Manifesto"/"Careers" → `#`)
- (ops) Vercel account/email hold — escalate to Vercel support (no code fix)

**security hardening**
- EFL-002 — kill `active-vision.js` live-path fabrication
- EFL-003 — cross-channel vector-retrieval isolation (multi-tenant leak)
- EFL-014 — bridge heap 93.7% / p95 71s → max-old-space + circuit-breaker + max_memory_restart
- EFL-015 — `pm2 reset` + node/ABI pin + `npm rebuild better-sqlite3`
- (web) server-side route protection for `/dashboard` + `/app/*` before real data
- (infra) set `ATMOS_GATEWAY_SECRET` for per-request spend/mcp auth
- (infra) `chmod 600` the `.env` files + deploy-time perms check

**misc**
- EFL-012 — `getLiveBalance` fake "1 SOL" → throw / fail-closed (deferred-economic guardrail)
- EFL-016 — remove nonexistent `docs/` from `package.json` `files`
- (atmosphere-core) integration test lane: nightly Ollama job for evolution-seam + chat-memory
- (web) `prebuild` rewrites `data/activity.json` → gitignore or make idempotent
