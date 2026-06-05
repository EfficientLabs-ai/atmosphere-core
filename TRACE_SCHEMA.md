# TRACE_SCHEMA — traces in atmosphere-core

**Status:** living map · **Date:** 2026-06-06

The **canonical** Trace Schema is `/opt/efficient-labs/context/architecture/TRACE_SCHEMA.md`. Read it
for the full trace record, the per-call logging contract, and the relationship to the capability
receipt. **This root doc does not redefine the schema** — it maps the canonical schema onto what is
actually implemented in this monorepo, with honest status.

> Tags: **CURRENT** = exists in code (file cited). **TARGET** = specified, not built.

## What the canonical schema requires (summary)

- A trace record per execution at `/traces/{task-id}.json`: workspace/project/workflow, model_used,
  model_class, ordered `steps[]` (plan/tool/model/subagent/io with input/output hashes + cost),
  tools_used, outputs, approval fields, result, receipt_path, eval_path.
- **Every tool call logs:** who requested it, which model, what data it touched, what permission
  allowed it, what output, and whether approval was required.
- The PQC-signed **capability receipt** is the *cryptographic spine* of the trace; where they overlap,
  the receipt is the source of truth.

## What exists in code

### Capability receipt — CURRENT (the real spine)
`packages/stratos-agent/src/ledger/capability-receipt.js` (326 LOC). A PQC-signed, **hash-chained**
record: actor / action / node / input-hash / output-hash / cost / prev-hash / owner_wallet,
verifiable with a public key. This is the tamper-evident trace primitive and it is **live** (every
verified skill run is recorded). This is exactly the "cryptographic spine" the canonical doc names.

### Attribution ledger — CURRENT
`packages/stratos-agent/src/ledger/attribution-ledger.js`: append-only hash chain attributing every
verified run to this node's `did:atmos`. `summarize()` reports **measured units per contributor** and
is **explicitly NOT a payout** (measurement before rewards — Vision/Architecture/Claim discipline).
Observable via `stratos ledger summary | verify | list` (`verify` fails code-1 on any tamper).

### Capability gate logging — CURRENT (partial)
`packages/stratos-agent/src/security/capability-gate.js` enforces deny-by-default before a skill runs
and is wired through `SkillExecutor`. Grants/denials feed the receipt. The full "every tool call logs
who/which-model/what-data/what-permission/what-output/approval" record is **partially** covered
(receipts cover verified runs; a complete per-tool-call trace log is TARGET).

### The full trace record + trace-engine — TARGET
There is **no** `/traces/{task-id}.json` writer and **no** `trace-engine` package today. The full
operational record (steps array, eval_path linkage, approval workflow fields) is specified, not built.

## Mapping table

| Canonical field / behavior | Code today | Status |
| :-- | :-- | :-- |
| Tamper-evident spine (hashes, prev-hash, signature) | `capability-receipt.js` | CURRENT |
| Per-contributor attribution (`did:atmos`) | `attribution-ledger.js` | CURRENT |
| `model_used` / `model_class` recorded | receipt + router | CURRENT (in receipt) |
| Deny-by-default permission on each action | `capability-gate.js` | CURRENT |
| Full `/traces/{task-id}.json` record + steps[] | — | TARGET |
| Per-tool-call log (data touched, permission, output) | partial via receipt | TARGET (full) |
| `approval_required` / `approved_by` workflow | policy in `governance/approval_gates.md`; in-conversation today | TARGET (UX in `/app`) |
| `eval_path` linkage to evaluations | — (no eval-engine) | TARGET |

## One-line current-vs-target

**The cryptographic trace spine (PQC-signed, hash-chained capability receipt + attribution ledger) is
CURRENT and live; the full operational trace record, the trace-engine, complete per-tool-call logging,
and the approval workflow surface are TARGET.**

## Pointers
- **Canonical schema:** `/opt/efficient-labs/context/architecture/TRACE_SCHEMA.md`
- Receipt + ledger code: `packages/stratos-agent/src/ledger/`
- Capture (where traces originate): `CONTEXT_ROUTING.md`
- Improvement (what consumes traces): `SELF_IMPROVEMENT_LOOP.md`
- Approval gates: `/opt/efficient-labs/governance/approval_gates.md`
