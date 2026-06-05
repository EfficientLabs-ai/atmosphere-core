# atmos-core — Architecture

**Status:** mixed CURRENT / TARGET · **Date:** 2026-06-06
**Role:** the **core operating layer** of the Atmosphere AI Operating System (the substrate).

> Source of truth for current state: `../../STATE_OF_REALITY.md`. Vision: `../../NORTH_STAR.md`.
> The OS-level framing lives at `/opt/efficient-labs/context/architecture/atmosphere-core-operating-architecture.md`
> and the schemas at `/opt/efficient-labs/context/architecture/{CONTEXT_CAPTURE_SCHEMA,TRACE_SCHEMA}.md`.
> This file documents *this package* and references those — it does not duplicate or contradict them.
>
> **Honesty rule:** every capability is **CURRENT** (in code, file cited) or **TARGET** (specified,
> not built). The model is the borrowed brain; the durable asset is this operating structure.

## What this package is (CURRENT)

`atmos-core` is the sovereign **identity + signed-storage + P2P-transport + settlement** core. Its
barrel `index.js` exports four real subsystems:

| Export | File | Role |
| :-- | :-- | :-- |
| `KeyringManager` | `keyring.js` | Real Ed25519 node identity; sign/verify, fail-closed |
| `P2PNetwork` | `p2p-network.js` | Hyperswarm DHT discovery + NAT hole-punch + Noise transport |
| `StorageManager` | `storage.js` | Corestore + Autobase append-only **signed** log |
| `PaymentEngine` | `src/billing/payment-engine.js` | PoW micro-invoice + state-channel settlement (off-chain) |
| `X402InvoiceEngine` | `x402-invoice.js` | Lightweight standalone invoice signer |

`index.js` also installs Hypercore/Autobase compat monkey-patches (dummy replicator getters) so the
storage stack runs in this environment.

Mesh entry points (CURRENT): `mesh-demo.mjs` (broadcast/join cross-machine proof) and
`node-runner/mesh-node.mjs` (a sovereign mesh peer that opens **no listening port** and runs a
compute skill only if its hybrid PQC seal verifies against a **pinned** origin key; an optional
Solana `--wallet`/`config.walletAddress` attributes the node's measured compute to its owner —
public address only, validated base58, never a key).

## What atmos-core owns conceptually (the OS substrate)

Per `../../NORTH_STAR.md` and the OS vision, atmos-core is the layer beneath agents: event schema,
context ingestion, routing, memory graph, model abstraction, tool permissions, trace storage, eval
loops, self-improvement. Today several of these engines live as real code in the sibling package
`../stratos-agent/src/` and are cited below; promoting them into `atmos-core` as first-class engines
is the TARGET (identical to the split `../../README.md` "Status (honest)" describes).

## The primitive

```
Workspace > Project > Workflow > Task > Subtask
  instructions.md · tools.json · data/ · memory/ · outputs/ · traces/ · evals/ · skills/

Input → Capture → Classify → Route → Store → Execute → Trace → Evaluate → Compress → Improve
```

Folder *standard* defined in `CONTEXT_CAPTURE_SCHEMA.md`. ICM scaffold exists
(`../stratos-agent/src/context/icm-workspace.js`, `stratos icm init|validate` — CURRENT); the live,
populated tree as the contract is **TARGET**.

## The trace/attribution primitive (CURRENT — keystone)

`../stratos-agent/src/ledger/capability-receipt.js` — the package atmos-core conceptually owns. An
append-only, **hash-chained**, JSONL `ReceiptLog`: each receipt binds
actor/action/ref/node/owner_wallet/input-hash/output-hash/cost_units/prev_hash, is **hybrid-PQC
signed** (Ed25519 + ML-DSA-65, both verify), stores **hashes never content**, `verify()` is
fail-closed, and `exportBundle()`/`verifyBundle()` let a third party verify with **only the public
key**. `summarize()` reports measured cost per actor/node/wallet — **not a payout** (measurement
before rewards). Built on the proven chain in `attribution-ledger.js`. This is the tamper-evident
spine of the full Trace Schema (`TRACE_SCHEMA.md`); the full per-step trace record + `trace-engine`
are TARGET.

## Component docs

- `CONTEXT_ROUTING.md` — context ingestion + the capture pipeline (this package's view).
- `MODEL_ROUTING.md` — the model-abstraction / routing layer.
- `SELF_IMPROVEMENT_LOOP.md` — trace → eval → lesson → skill flywheel.

## Current-vs-Target (one line)

CURRENT and cited: Ed25519 node identity, signed Corestore/Autobase storage, Hyperswarm
DHT+hole-punch transport, PQC-pinned mesh skill execution, off-chain settlement, and the PQC-signed
capability-receipt trace/attribution primitive (with the sibling-package router, capability gate,
identity broker, memory banks, and scoped self-evolution loop it composes with). TARGET: promoting
context-capture, the unified routing pipeline, the full trace-engine, a general eval-engine, and
general self-improvement into first-class `atmos-core` engines, plus the live `Workspace>…>Task`
tree and the on-chain economy. Nothing here is claimed live until it is.
