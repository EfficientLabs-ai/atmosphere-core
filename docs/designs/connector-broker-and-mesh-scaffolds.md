# Connector-Broker & Mesh — build scaffolds (Tasks #12, #14, #15, #16, #17)

**Status: SCAFFOLD / DRAFT.** This is the honest spine for the remaining auto-build tasks. Each section
is a *draft design + interface + security model + review gate* — NOT a shipped feature. The two pieces
already built and tested (vault #11, write-approval gate #13) are the primitives these assemble.

> Integrity rule (from the orchestration thesis): never claim a capability here exists *today*. The
> sections below say exactly what is real, what is designed, and what each needs before it ships.
> Every functional build runs the same loop: design → Codex/Gemini review → build + tests → commit.

---

## #12 — Native MCP client (read-only) + the deterministic broker PROCESS

**Why it's the keystone:** it completes the vault's isolation (Codex CRIT #2/#1, deferred from #11) and
the write-gate's cross-process enforcement (#13). The broker is a SEPARATE process so the model never
holds `resolveSecret` or the approval ledger in-memory.

**Real now:** vault (#11), write-approval logic (#13). **Designed:** everything below. **Needs:** build + a dedicated security review before any connector touches a live account.

### Architecture
```
  model / agent process                 broker process (separate; owns secrets + approvals)
  ─────────────────────                 ──────────────────────────────────────────────────
  - sees opaque handles only            - vault.resolveSecret  (plaintext NEVER crosses back)
  - calls tools via broker IPC   ──▶    - write-approval ledger (consumeApproval before any write)
  - gets RESULTS, never secrets         - MCP client: stdio JSON-RPC to pinned, least-priv sidecars
                                        - curated risk-tagged tool registry (READ subset exposed)
        ▲                                       │
        └────────── unix socket (0600), capability token per session ──────────┘
```

### Interface sketch (`src/connectors/broker.js`, runs as its own process)
- `startBroker({ socketPath })` → listens on a 0600 unix socket; mints a per-session capability token.
- IPC verbs (model side): `listTools()` → curated read-only subset; `callTool(name, args, capToken)`;
  `proposeWrite(...)` → returns proposal id (the nonce goes to the OWNER channel, never the socket).
- The broker resolves `cvault:` handles internally to inject auth into MCP calls — **plaintext stays
  in the broker**; only tool *results* return to the model.
- Untrusted MCP tool output is returned as INERT data — the broker never auto-chains it into another
  tool call (Codex connector control #3).

### MCP client (`src/connectors/mcp-client.js`)
- stdio JSON-RPC 2.0: `initialize` → `tools/list` → `tools/call`. Pin the sidecar binary + args; run
  least-privilege. Risk-tag each tool (read/write/destructive); only `read` is exposed by default.

### Security review gate (before merge)
- [ ] plaintext secrets provably never cross the socket back to the model (test with a sentinel)
- [ ] capability token required + checked on every verb; socket is 0600
- [ ] writes route through `consumeApproval`; no tool call executes a `write`/`destructive` tag without it
- [ ] no autonomous chaining from tool output; connector traffic excluded from all persistence/export

---

## #14 — Federated skill-sync demo across 2 nodes (launch asset)

**Why:** makes the MOAT visible — node A learns a skill, seals it (PQC), broadcasts; node B verifies the
seal against the pinned origin key and runs it. The learning/economic engine itself is PRIVATE (carved
out of the public build); this demo exercises the DISTRIBUTE/VERIFY surface only.

**Real now:** the self-evolution engine + PQC primitives exist in the monorepo (private moat). **Designed:** the 2-node demo harness. **Needs:** build against the engine's real `broadcastSkill`/`ingestRemoteSkill` interfaces + a "reject tampered seal" assertion.

### Demo shape (`scripts/demo-skill-sync.mjs`)
1. Instantiate two engine contexts A and B with distinct keypairs; B pins A's public origin key.
2. A captures→compiles a trivial skill, `broadcastSkill()` → sealed record onto a shared in-proc channel
   (real network/Hyperswarm is the mesh layer; the demo proves the crypto + verify path in-process).
3. B `ingestRemoteSkill(record)` → verifies the PQC seal → accepts + can invoke.
4. **Adversarial assertion (the point):** flip one byte of the sealed record → B MUST reject (seal breach).

### Gate
- [ ] uses the engine's real interfaces (no reimplemented crypto); honest log: "in-process channel,
      not live mesh" so the demo never overclaims a network it didn't run.

---

## #15 — ACP / agent-to-agent comms (make the scaffold real, securely)

**Honest status today (from the thesis): 🔴 scaffold/spec only — NOT functional.** This task upgrades it
from spec to a minimal, *capability-gated, signed* message path — still narrow, never claimed as the
"24/7 autonomous business runner."

**Designed:** signed task-envelope + capability check. **Needs:** build + review; explicit "alpha, single-hop" labeling.

### Interface sketch (`src/connectors/acp.js`)
- `sendTask({ toNode, capability, payload })` → wraps payload in a PQC-signed envelope; refuses if the
  local node lacks a grant for `capability` toward `toNode`.
- `receiveTask(envelope)` → verify signature against pinned peer key → check the capability is granted
  inbound → hand to a handler; UNKNOWN/unsigned/over-scope → drop + audit. Deny by default.
- No transitive auto-forwarding; every hop re-checks grants (no ambient authority).

### Gate
- [ ] unsigned/forged/over-scope envelopes are dropped (tested); [ ] grants are explicit + revocable;
- [ ] docs say "alpha, single-hop, human-on-loop" — no autonomous-fleet claim.

---

## #16 — Sovereign dev environment (run any CLI on your/mesh compute)

**Real now:** there is a Codex-reviewed redesign at `docs/designs/sovereign-compute-environment.md`
(WASM-first, capability-scoped). **Designed there.** **Needs:** build the exec-controller identity
primitive first (pure, testable), then the scoped runner.

### First buildable increment (`src/exec/controller-identity.js`)
- Reuse the REAL hybrid PQC keyring (Ed25519 + ML-DSA) already in the repo — NOT a placeholder — to give
  each exec-controller a verifiable identity + signed job receipts. Pure crypto → unit-testable in isolation.
- Then: scoped job spec (image, mounts, env allowlist, network policy) → run on local/mesh compute with
  preopens-empty default + explicit grants (mirrors the VaultHost WASI `env:{} preopens:{}` posture).

### Gate
- [ ] identity keys are real PQC (sentinel test vs placeholder); [ ] job receipts verify;
- [ ] runner denies `..`/`/` over-grants + forwards no caller `env` without an allowlist (closes the
      `wasi-sandbox.js` gaps the audit flagged).

---

## #17 — Sovereign content-orchestrator (script→image→video→Remotion)

**Real now:** the model gateway (#PR14) can route generation calls; Remotion scaffold exists in the
separate `content-studio` repo. **Designed:** the chain. **Needs:** build the orchestrator + a dry-run
mode (no external spend) before any keyed run.

### Interface sketch (`content-studio/src/orchestrator.js`)
- `plan(brief)` → script + shotlist (via the gateway, local model default).
- `renderAssets(shotlist, { dryRun })` → image/video calls through the gateway; `dryRun` returns the
  planned calls + cost estimate WITHOUT spending (default on).
- `compose(assets)` → drives Remotion to a final cut.

### Gate
- [ ] `dryRun` is the default; a keyed run requires an explicit flag; [ ] cost estimate printed before
      spend; [ ] no fabricated metrics in any generated copy (the standing honesty rule).

---

## Sequence to execute (each gated by its review)
`#12 broker` (unlocks safe live connectors) → `#14 skill-sync demo` (launch asset, low-risk) →
`#16 exec-identity` (pure primitive) → `#15 ACP alpha` → `#17 orchestrator dry-run`.
The two security-critical ones (#12, #15) get a dedicated review before any live account/peer.
