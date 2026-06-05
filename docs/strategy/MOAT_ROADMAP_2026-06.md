# Efficient Labs — Moat / Production / Automation Roadmap

> Output of a 6-lens strategic council (moat-architect · flywheel · business-automation · positioning · red-team → synthesis), 2026-06-06. The executable version lives in `docs/PROGRAM_STATUS.md`; this is the reasoning.

## 1. THE CORE MOAT — the cross-machine attribution / settlement rail
Build the signed, cross-machine attribution ledger — the **capability-receipt rail** that turns commodity compute into accountable, payable contribution. When Gemma/Qwen are free and "local-first" is table stakes, the *model* and the *locality* are worth nothing as moats. The problem that gets MORE valuable as compute commoditizes is: **who ran what, on whose machine, at what cost, and who should be paid?** Efficient Labs owns that proof layer. It makes the honesty matrix *structural* (cryptographic, not narrative) and is the substrate the deferred economic layer eventually settles on. Everything else — router, skills, mesh, voice — is a *feature that feeds this rail*.

## 2. TOP 7 BUILDS (impact/effort)
1. **Signed Capability Receipt schema + export** — every inference/skill-run emits a signed receipt; the meter the flywheel + economy require. *S.* Depends on the (built) attribution ledger + PQC signing. **← start here.**
2. **Wired vertical slice + 90s "bill goes to zero" demo** — local chat → router → signed skill → receipt; OpenAI-SDK drop-in, identical output at $0, data never leaves. *M.* Converts breadth into one undeniable proof.
3. **Honesty-matrix CI guard + public living page/RSS** — status-enum source of truth; CI blocks deploy on copy/README mismatch; signed timestamped changelog. *S.*
4. **GSI signed-skill registry + `stratos skill add`** — public signed index, one-command install, ledger meters every run; seed 10 first-party skills. *M.* The npm-of-sovereign-skills.
5. **Two-node "offload to my own desktop" mesh proof** — one inference job laptop→desktop over Hyperswarm, same-owner, publish the signed receipt. *M.* Mesh becomes a credibility artifact, not a claim.
6. **"Sovereign control plane over any model" positioning + router OSS under BSL** — own gateway/routing/attribution, stay model-agnostic; OSS the router, keep mesh economics private. *M.*
7. **Ops-orchestrator cron (founder = approver)** — runs business stages on schedule, logs to the ledger, escalates only exceptions to Telegram. *M.* The self-running business IS the demo.

## 3. EXISTENTIAL RISKS (top 5 + mitigation)
1. **No revenue × solo bandwidth (the actual killer)** → freeze mesh/evolution feature work ~30 days; monetization is product-led + TBD — wire the vertical slice + demo first, then settle the mechanic.
2. **Breadth without a wired slice** → wire ONE vertical slice E2E (Build #2) + record the demo; shelve the rest.
3. **Honesty-moat fragility** → CI guard (Build #3) blocking deploy on any mismatch vs the status enum.
4. **Mesh chicken-egg + CPU-only** → reframe mesh as post-launch R&D; ship the single cross-machine job as a credibility artifact, not a launch claim.
5. **"Sovereign" while routing to others' models** → sharpen to "sovereign control plane over any model" (Build #6).

## 4. START NOW — the Signed Capability Receipt
S-effort, sits on live substrate, keystone for #2/#4/#5/#7. Schema: `receipt_id, timestamp, actor_id, action(inference|skill-run), model_or_skill_ref, compute_node_id, input_hash, output_hash, cost_units, caller_id, prev_receipt_hash`. Emit + PQC-sign + append on every router inference and GSI skill run; `stratos receipt export|verify`. **Acceptance: a third party with only the public key can verify a given inference ran on a given node at a given cost, and that no receipt was altered or removed.** That verifiable claim — not the model, not "local" — is what makes Efficient Labs irreplaceable.
