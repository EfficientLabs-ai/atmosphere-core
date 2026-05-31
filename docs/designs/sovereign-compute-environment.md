# Design: The Atmosphere as a sovereign compute environment — P1 (exec primitive)

**Status:** ⛔ **REDESIGN required before any code** — Codex Pattern-C verdict was REDESIGN (the
original Tier-1 below is kept for the record but is NOT to be built as written). The governing
architecture is the **"✅ REVISED per Codex"** section at the bottom. NO compute code ships until that
revised design is itself re-reviewed. A real prerequisite it surfaced — the fake `KeyringManager`
crypto — has been fixed separately (real Ed25519; see STATE_OF_REALITY).
**Original status:** DRAFT for Codex Pattern-C review (security-critical: this is remote code execution).
**Goal (user):** make The Atmosphere a place where development / coding / automation happen on the
user's **own** hardware over the mesh — open a terminal, be connected to your local device *and* the
mesh simultaneously, "replace cloud/VPS" with sovereign private compute. Secure, sovereign, private
**by default** — for regulated/compliance devs AND for "vibe coders" who lack secure-build knowledge.
**Authority:** subordinate to STATE_OF_REALITY.md. No fabricated claims. Builds on the owner-binding +
permission model just shipped (PR #7) and the real mesh primitives (`P2PNetwork`, `WasiSandbox`,
PQC-signed gossip, `SkillExecutor` verify-before-execute).

## Honest framing (what this is and is NOT)
This is **not** a managed cloud, not multi-tenant isolation for strangers, and not a one-day VPS
replacement. It is the **sovereign-exec primitive** that a dev environment grows from: the owner runs
work on **their own trusted nodes** (VPS, home box, laptop) over the PQC mesh, under the same
deny-by-default permission model as the rest of the agent. We ship the secure primitive first and say
so plainly; the IDE/terminal/automation layers compose on top in later, flagged tiers.

## Scope — three tiers, only Tier 1 is built now
- **Tier 1 (THIS design):** owner-signed **single-command remote exec** on a named own-node over the
  mesh. Deny-by-default; requires an explicit CLI-granted `remoteExec` permission. Workspace-jailed,
  replay-protected, rate-limited, fully audit-logged, output returned. No persistent shell yet.
- **Tier 2 (flagged, next):** interactive **PTY session** over the mesh (`node-pty`), persistent cwd,
  streamed I/O — "open a terminal connected to the mesh."
- **Tier 3 (flagged):** file sync + project workspaces + an automation runner (cron-on-mesh).
Each tier is a separate design + Codex review. Silent scope creep is a non-goal.

## Tier 1 design

### Trust model (the whole point)
1. **Owner-only.** A compute request is authenticated to the bound owner (reuse PR #7's owner binding)
   AND **PQC-signed** by the owner's private key (reuse the mesh ML-DSA-65 + Ed25519 keypair). The
   executing node verifies the signature against its **pinned owner public key** before doing anything.
   No valid owner signature → rejected, logged, no execution.
2. **Off by default.** Nothing executes unless the node operator granted `permissions.remoteExec`
   = `enabled` via `stratos-ctl` **locally on that node** (NOT via chat — consistent with PR #7: a
   privileged grant is CLI/local-only). Default `disabled`. A node with it disabled refuses every
   request, even a validly-signed one.
3. **Per-node allowlist.** When enabled, the operator configures (a) a **workspace root** (jail —
   all exec cwd is canonicalized under it; `..` escapes rejected) and (b) a **mode**:
   - `jailed` (default): only an **allowlisted set of binaries** may run (e.g. `git`, `node`, `npm`,
     `python`, `ls`, `cat`), args sanitized, no shell metacharacter interpolation (spawn argv array,
     never `sh -c`). Safe for "vibe coders."
   - `full-shell` (opt-in, loud warning): arbitrary commands. For experts who accept the risk.
4. **Replay protection.** Every request carries a monotonic `nonce` + `issuedAt`; the node keeps a
   high-water mark + a small recent-nonce set and rejects stale/duplicate requests (window e.g. 60 s).
5. **Rate limit + concurrency cap** per requester, to bound abuse if a key is ever compromised.
6. **Audit log (append-only).** Every request (signed digest, requester, command, decision, exit code,
   output hash, timestamp) is written to a tamper-evident local log. Refusals logged too.

### Components (new)
- NEW `packages/stratos-agent/src/compute/exec-request.js` — the signed request envelope: build
  (`{ v, nodeId, cwd, argv, nonce, issuedAt }` → canonical bytes → ML-DSA sign) + verify (sig, owner
  pubkey, nonce window). Pure crypto + schema; unit-testable with injected keypair, no network.
- NEW `packages/stratos-agent/src/compute/workspace-jail.js` — canonicalize a requested cwd under the
  configured root; reject traversal/symlink escape; resolve + validate the binary against the mode's
  allowlist; build a safe argv (no `sh -c`). Pure; unit-testable.
- NEW `packages/stratos-agent/src/compute/compute-node.js` — the node-side handler: gate on
  `permissions.remoteExec`, verify the envelope, jail, `child_process.spawn` (argv array, no shell,
  timeout, output cap, killed on overrun), append to the audit log, return `{exitCode, stdout, stderr,
  outputHash}` (truncated/capped). Streaming deferred to Tier 2.
- NEW `packages/stratos-agent/src/compute/audit-log.js` — append-only JSONL with a running hash chain
  (each entry includes `prevHash`) so tampering is detectable. Pure-ish; unit-testable.
- `stratos-ctl.js` — `compute grant <jailed|full-shell> <workspace-root>` (local, loud), `compute
  status`, `compute revoke`. Mirrors into `agent-config.permissions.remoteExec` + a `compute` block.
- agent-config: extend `permissions` with `remoteExec` (default `disabled`) + a `compute` config
  block `{ mode, workspaceRoot, allowlist, rateLimit }` (non-secret; same revision-guarded store).
- Mesh wiring: a dedicated PQC topic / request type on `P2PNetwork`; the node subscribes only when
  `remoteExec` is enabled. **NOT wired into the live daemon until Tier 1 passes review + tests** (same
  discipline as the self-evolution seam: built + unit-proven before any live activation).

### What it reuses (not reinvented)
- Owner binding + permission model + revision-guarded config (PR #7).
- Mesh PQC keypair + signing/verify + `P2PNetwork` transport (real today).
- `secret-guard` (a command line could contain a key — scan + redact before audit-logging).
- Optionally `WasiSandbox` for a `wasm` mode (deterministic sandboxed compute) in a later tier.

## Security / honesty checklist (pre-commit)
- [ ] No path → execution without a verified owner signature AND `remoteExec=enabled`.
- [ ] `jailed` mode: argv-only spawn, never `sh -c`; binary allowlist enforced; cwd canonicalized under
      root; traversal/symlink escape rejected (tests).
- [ ] Replay: duplicate/stale nonce rejected (tests).
- [ ] Output + time capped; process killed on overrun.
- [ ] Audit log hash-chained; refusals recorded.
- [ ] Chat can NEVER grant `remoteExec` or switch mode (CLI/local-only) — chat explains only.
- [ ] STATE_OF_REALITY.md: Tier 1 marked REAL only after live verification; Tiers 2–3 marked PLANNED.
- [ ] README/PR state the honest scope: "owner-only exec on your own nodes," not "serverless cloud."

## Open questions for Codex
1. Is single-command exec the right Tier-1 cut, or does the PTY (Tier 2) need to come first to be
   useful enough to matter? (Bias: ship the safe primitive first.)
2. Replay/freshness: nonce high-water + recent-set + time window — sufficient, or require a
   challenge–response handshake (node issues a nonce the request must echo)?
3. `jailed` allowlist: is an argv-array + binary allowlist a strong enough boundary for "vibe coders,"
   or should the default be **WASM-only** (`WasiSandbox`) compute and native exec be expert-only?
4. Audit-log hash chain: enough for tamper-evidence, or sign each entry with the node key?
5. Key compromise blast radius: if the owner key leaks, an attacker gets exec on every opted-in node.
   Should each node require its OWN local pairing approval (TOFU) on first use, beyond the owner sig?

---
## ✅ REVISED per Codex Pattern-C review (verdict: REDESIGN) — THIS governs the eventual build

Codex (adversarial security review) returned **REDESIGN**. Two blockers + a repo-reality correction:
- **Blocker A:** "workspace-jailed allowlisted **native** binary" is NOT a sandbox — `node`/`python`/`npm`
  are arbitrary-code runtimes; `git` pulls hooks/pagers/ssh/credential-helpers; `cat`/`ls` escape via
  absolute paths + symlinks. So the "safe-by-default for vibe coders" claim was false.
- **Blocker B:** PR #7 owner binding (`ownerChatId` string match) is **UI auth, not a cryptographic
  exec authority.** It must never be the exec gate.
- **Repo reality (now fixed):** the mesh's `KeyringManager` was non-cryptographic (verified nothing);
  `P2PNetwork` accepts raw JSON on sockets. Fixed the keyring (real Ed25519); the transport channel
  and key-pinning are still to be addressed by the revised design below.

### The revised architecture (all 10 required changes adopted)
1. **WASM-only Tier 1 (default).** Execution is the real `WasiSandbox` ONLY — empty `preopens`, empty
   `env`, no network, deterministic. Native exec is **removed from Tier 1** and becomes a separate,
   expert-only, separately-reviewed tier. (Blocker A, Q3.)
2. **Separate cryptographic exec authority.** Each node **locally pairs** a dedicated *exec-controller*
   public key (explicit fingerprint approval, not blind TOFU). Chat owner-binding is UI auth only and
   is never the exec gate. (CRITICAL #1, Q5.)
3. **No single long-lived owner key across nodes.** An **offline owner root** signs **short-lived,
   delegated exec-controller certs** scoped to `nodeId` + capability + mode + expiry, with per-node
   revocation. Blast radius of any one key is bounded. (CRITICAL #3.)
4. **Challenge–response freshness.** The node issues a one-time challenge nonce (short expiry); the
   request must echo it. Spent challenges persist across restart. Replaces client-only nonces. (#4, Q2.)
5. **No `full-shell` in Tier 1** — cut entirely; its own design + review later. (#5.)
6. **If/when a native tier exists:** per-binary protocol only — absolute-path mapping, no PATH lookup,
   empty env allowlist, fixed `HOME/TMP/PATH`, no inherited secrets, no interpreters/package managers,
   no config/hooks/pagers/loaders, path args re-resolved under root after symlink resolution. (#6.)
7. **Signed responses.** The node signs `{requestDigest, exitCode, outputHash}` with its node key;
   the requester rejects unsigned/mismatched results. Don't trust stdout/exit over the wire. (#7.)
8. **Authenticated unicast** to `nodeId` for commands + output; the mesh topic is **discovery only**,
   not the integrity/confidentiality channel. (#8.)
9. **Signed audit log.** Each entry (or segment head) is signed with the node key and the signed head
   is replicated/anchored to another owner-controlled device. Hash-chain alone is insufficient. (#9.)
10. **OS-level isolation.** Even WASM host process runs under a dedicated low-privilege account /
    cgroup / job object; kill the whole **process group** on timeout. (#10.)

### Tier cut (confirmed by Codex)
Single-command (here: single-WASM-job) exec **is** the right Tier-1 cut; **PTY first is wrong** (it
explodes state/replay/signal/escape surface). PTY = a later tier, only atop this foundation. (Q1.)

### Build sequencing (each step its own PR; nothing live until reviewed)
- **Step 0 (DONE):** fix `KeyringManager` real-crypto (prerequisite). ✅
- **Step 1:** exec-controller identity + offline-root→delegated-cert chain + per-node pairing (pure
  crypto, unit-tested; reuse `quantum-crypto.js` hybrid). No exec yet.
- **Step 2:** challenge–response envelope (node-issued nonce, persisted spent-set) + signed responses.
- **Step 3:** WASM-only `compute-node` over **authenticated unicast**, OS-isolated host, signed audit
  log. Built + unit/integration-proven; **NOT wired live** until a real second node + a security pass.
- **Native exec / PTY / file-sync:** separate later designs + reviews. Not promised, not implied.

**Honesty:** Tier 1 is "run a verified WASM job on your own paired node over the mesh" — a real
sovereign-compute primitive, NOT a shell, NOT a VPS replacement, NOT serverless-for-strangers. The
README/PR will say exactly that. Marked PLANNED in STATE_OF_REALITY until Step 3 is live-verified.
