# Environment Modernization and Production Readiness Report

Date: 2026-06-30
Owner: Efficient Labs engineering
Scope: atmosphere-core VPS/runtime evidence, command-center doctrine, open GitHub PRs, current launch-readiness files, and external research.

## Executive summary

Efficient Labs should not start by adding every proposed architecture layer. The company is past the point where ad hoc prompts and chat-only memory are enough, but it is not yet at the point where a large graph-memory or event-sourced enterprise platform should be built ahead of proof.

The highest-ROI path is to consolidate what already exists: SEIF as the deterministic governance kernel, ECP as the context and continuity protocol, a tripartite memory contract backed by Redis plus self-hosted PostgreSQL plus rebuildable retrieval indexes, ADRs for every canonical decision, and strict production gates before any public launch claim.

The current engineering foundation is real and materially stronger than a prototype: GitHub main is green, production dependency audit gates exist, branch protection is enforced, SEIF/ECP/receipt architecture exists, Redis and the live local model stack exist, and the repo has active test coverage. The launch risk is not lack of vision. The launch risk is drift: stale docs, stale live surfaces, unproven clean install, unproven payment provisioning, freshness gaps in ECP/read-model artifacts, and live claims that outrun current evidence.

For the next 72 hours, the company should ship a coherent, honest, narrow slice: install, verify, receipt/proof, local-first continuity, founder-gated checkout/onboarding in test mode, and a public status/proof surface that only claims what is live. Defer full mesh economy, full graph memory, multi-tenant enterprise claims, broad autonomous execution, and live billing until the proof rails and restore drills are demonstrably production-grade.

## Evidence baseline

### Verified on 2026-06-30

- `atmosphere-core` main is at `fb8f5bf chore(runtime): pin node 22 preflight (#123)`.
- Main CI is green on the latest run for `fb8f5bf`.
- PR #132, `docs(ops): gate production readiness evidence`, is merged. `docs/operating/PRODUCTION-READINESS.md` is now the launch/no-go gate.
- PR #123, `chore(runtime): pin node 22 preflight`, is merged. `.nvmrc` pins Node `22.22.3`, the preflight gate is present, and the PM2 interpreter pin is committed but still requires an explicit founder-approved PM2 reload before it changes the running bridge.
- Main branch protection is enabled with admin enforcement, strict required checks, one required approving review, stale-review dismissal, last-push approval, and required conversation resolution.
- Required checks on main now use the satisfiable `.nvmrc` context: `Hermetic tests (Node from .nvmrc)`.
- `docs/operating/ISSUES.md`, `STATE.md`, and older launch-readiness files contain known doc/runtime drift, especially qwen/Gemma model identity, Vercel deploy state, Supabase/auth references, stale status pages, active-vision fabrication, vector isolation, and receipt CLI gaps.
- `/opt/efficient-labs/command-center/00_truth/EFFICIENT_CONTEXT_PROTOCOL.md` already defines ECP as canonical file architecture with manifests, compiler, ledger, receipts, lifecycle gates, and disclosure fail-closed behavior.
- `/opt/efficient-labs/command-center/00_truth/DATA_BRIDGING_LAYER.md` already defines local-first, user-owned continuity, secret refusal, hashed proof receipts, active/archive routing, and a realistic bridge matrix.
- `/opt/efficient-labs/command-center/00_truth/LIFECYCLE.md` already defines lifecycle states and the completion ladder: `DOCUMENTED -> PARTIAL -> WIRED -> ENFORCED -> MEASURED -> PRODUCTION`.
- Current disk pressure is acceptable on `/` but `/tmp` is tight; use repo/worktree paths for installs and builds, not `/tmp`.

### External research used

- Anthropic, [Building effective agents](https://www.anthropic.com/research/building-effective-agents): favors simple, composable workflows such as routing, prompt chaining, parallelization, orchestrator-workers, and evaluator-optimizer loops before complex autonomous systems.
- MemGPT, [Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560): supports hierarchical memory and virtual context management, but not magical infinite recall.
- Redis, [RedisVL semantic cache](https://redis.io/docs/latest/develop/ai/redisvl/user_guide/llmcache/): supports semantic response caching with vector similarity; it should be treated as cache, not durable truth.
- PostgreSQL, [Continuous archiving and point-in-time recovery](https://www.postgresql.org/docs/current/continuous-archiving.html): supports self-hosted durable database operations only if WAL archiving and restore drills exist.
- pgvector, [open-source vector similarity search for Postgres](https://github.com/pgvector/pgvector): supports a practical first vector layer inside PostgreSQL before introducing a separate graph or vector service.
- Temporal, [Durable execution](https://docs.temporal.io/temporal): supports event-history-backed workflow durability for long-running business processes, but is heavier than needed before simpler timers and queues are proven.
- OpenTelemetry, [What is OpenTelemetry](https://opentelemetry.io/docs/what-is-opentelemetry/): supports a standard traces, metrics, and logs foundation for production observability.
- Open Policy Agent, [policy as code](https://www.openpolicyagent.org/docs): supports centralized deny-by-default policy decisions when protected actions move beyond hardcoded checks.
- OWASP, [Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/): prompt injection, unsafe plugin/tool use, and supply-chain risks justify a default-deny agent security model.
- Microsoft Research, [GraphRAG](https://arxiv.org/abs/2404.16130): supports graph-structured retrieval for large corpora and global questions, but the cost and complexity are not justified until retrieval misses or enterprise use cases are measured.
- Michael Nygard ADR practice, [Architecture Decision Records](https://github.com/joelparkerhenderson/architecture-decision-record): supports lightweight durable decision history for architecture drift control.
- DORA, [Accelerate State of DevOps / DORA research](https://dora.dev/research/): supports the business value of fast feedback, reliable CI/CD, platform discipline, and clear operational capabilities.

## Environment readiness report

### Current readiness

The engineering environment is ready for disciplined production hardening. It is not yet ready for an unrestricted public launch or broad enterprise onboarding.

Strengths:

- CI on main is green and dependency audit gating has landed.
- Branch protection is real and prevents silent direct-to-main production changes.
- The repo has a visible operating model, issue register, backlog, and production-readiness PR.
- The command-center doctrine is more mature than the public docs: it has ECP, lifecycle, disclosure, receipt, and continuity concepts already specified.
- SEIF, ECP, Redis, local model routing, receipts, and health endpoints have already been exercised in prior evidence.
- The security posture is trending in the right direction: protected actions, no secret reads, no deploy/restart without founder authorization, and branch review gates.

Blocking weaknesses:

- The repository and command-center have multiple truth planes, and some truth planes are stale.
- `docs/operating/STATE.md` and older status docs are not a reliable current source without live verification.
- Live production surfaces have previously lagged local/audited state.
- Stripe/payment provisioning is not founder-key-live and should not accept real purchases until end-to-end test-mode fulfillment is proven.
- The self-hosted database plan is not yet a production plan until backup, restore, migration, access, encryption, and observability are documented and drilled.
- ECP continuity mechanisms exist, but freshness and scheduling remain a production gap.
- Tripartite memory exists as concept/code, but production write-recall reuse is not yet proven across durable tiers.
- Mesh, graph memory, and autonomous loops are not launch claims until second-device, signed queue, and liveness evidence exist.

Readiness classification: `READY_FOR_FOUNDATION_HARDENING`, not `READY_FOR_LOUD_LAUNCH`.

## Architecture modernization recommendation

### Recommendation

Adopt the next-generation architecture only as a consolidation layer, not as a broad rewrite.

The canonical production architecture should be:

1. SEIF as deterministic governance and policy kernel.
2. LOGOS as probabilistic reasoning/generation, always downstream of SEIF gates.
3. ECP as the context, continuity, packet, disclosure, and receipt protocol.
4. PostgreSQL as durable operational memory and business system of record.
5. Redis as L1 cache and coordination primitive, never durable truth.
6. FTS/vector/graph stores as rebuildable indexes derived from durable sources.
7. ADRs and lifecycle status as the decision control plane.
8. GitHub as evidence court of record for code, review, tests, and production gates.
9. Founder approval as the gate for secrets, pricing, public claims, billing, deploys, and npm publishes.

### Candidate system decision matrix

| System | Decision today | Priority | ROI | Cost | Complexity | Production risk | Launch impact | Rationale |
|---|---|---:|---:|---:|---:|---:|---:|---|
| SEIF | Adopt and consolidate | P0 | High | Medium | Medium | Medium | High | Governance kernel is already aligned with the company's moat. The immediate work is queue/timer/proof discipline, not a rewrite. |
| LOGOS | Keep, measure, and constrain | P1 | Medium | Medium | Medium | High if overclaimed | Medium | Useful as generation layer, but public claims need statistically meaningful eval evidence. |
| ECP | Adopt as canonical context protocol | P0 | High | Medium | Medium | Low if enforced | High | Existing ECP doctrine matches research on context management and lowers agent drift. Fix freshness and scheduler gaps first. |
| Tripartite memory | Adopt as a contract | P0/P1 | High | Medium | Medium | Medium | High | Use Redis L1, Postgres durable L2, and vector/graph indexes as L3 projections. Prove write-recall before calling it production. |
| Graph memory | Defer as source of truth | P2 | Medium later | High | High | High | Low now | Graph retrieval is valuable at scale, but current evidence points to doc drift and stale stores first. Use graph as derived projection only. |
| Redis semantic cache | Implement narrowly | P1 | Medium | Low/Medium | Medium | Medium | Medium | Good for repeated LLM/tool responses and cost control. Cache entries need TTL, namespace isolation, and invalidation. |
| Persistent DB memory | Implement now via self-hosted Postgres | P0 | High | Medium | Medium | Medium | High | Required for customers, Stripe state, audit events, job queues, and durable memory. Must include backups and restore drills. |
| Knowledge graph | Defer to measured need | P2 | Medium later | High | High | High | Low | Do not create another canonical memory plane until use cases demand cross-entity graph questions. |
| Context compiler | Enforce now | P0 | High | Medium | Medium | Low | High | ECP compiler is the right answer to prompt sprawl, disclosure risk, and agent packet discipline. |
| Event sourcing | Use selectively | P1 | High for protected actions | Medium/High | High | High if broad | Medium | Receipt/audit ledgers are valuable. Full event sourcing for every entity is premature; start with billing, approvals, deployments, and memory transitions. |
| ADRs | Implement now | P0 | High | Low | Low | Low | High | Cheapest way to stop architecture drift and resolve Supabase/Postgres, graph, memory, and launch-scope decisions. |
| Governance/policy engine | Implement in layers | P1 | High | Medium | Medium | Medium | High | Start with local deny-by-default policy registry. Add OPA/Rego when policy count or team size justifies it. |

### What not to do now

- Do not introduce a separate graph database before PostgreSQL, migrations, backups, and restore drills are production-grade.
- Do not make Redis the durable memory store.
- Do not claim autonomous SEIF operation until timers, founder queue, signed/provable events, and failure recovery are working.
- Do not connect live Stripe purchases to provisioning until test-mode webhooks and idempotent fulfillment pass.
- Do not merge another VPS into one undifferentiated compute pool. If another Hostinger KVM4 is purchased, assign it a clear role such as database/backup/standby, not agent experimentation.

## Memory architecture recommendation

### Canonical memory model

Use a tripartite memory spine with explicit ownership:

| Tier | Role | Backing store | Truth status | Launch requirement |
|---|---|---|---|---|
| L1 working/cache | Short-lived context, semantic cache, locks, rate counters | Redis | Cache only | TTL, namespace isolation, no secrets, eviction-safe |
| L2 durable operational memory | customers, subscriptions, events, approvals, jobs, continuity entries, ADR index | Self-hosted PostgreSQL | Source of truth | migrations, backups, PITR, restore drill, least-privilege roles |
| L3 derived retrieval | FTS, pgvector, graph projections, read models | PostgreSQL FTS/pgvector first, optional graph later | Rebuildable index | source pointers, freshness metrics, rebuild script |

### Self-hosted database plan

Use PostgreSQL rather than Supabase for the production control plane, because the user's direction is to avoid vendor lock-in and recurring platform cost. PostgreSQL is mature enough, open enough, and directly compatible with future pgvector and event/audit tables.

Do not buy another KVM4 just to say the system is distributed. Buy another KVM4 only if it gets a hard production role:

- Option A, 72-hour launch: current VPS hosts app + Postgres for staging/soft launch, with encrypted off-host backups and a documented restore drill. Lowest cost, acceptable only for quiet launch and no high-volume paid traffic.
- Option B, recommended before paid public launch: second KVM4 as `db-vps-1`, current VPS as app/agent host, off-host backup storage separate from both. No autonomous agent experiments on the DB host.
- Option C, later: primary/standby Postgres, WAL archiving, monitoring, and failover runbook.

Minimum Postgres production bar:

- migrations checked into repo
- separate roles for app, migration, readonly, and backup
- no service secrets in repo
- daily encrypted base backup plus WAL archiving
- restore drill to a clean host before accepting paid customers
- idempotent Stripe webhook fulfillment table
- `events` or `receipts` table for billing, approvals, memory transitions, and deploy evidence
- pgvector only after the durable schema is stable

### Semantic cache and retrieval

Redis semantic cache is justified only for repeated expensive prompts, tool summaries, and public status/proof responses. It needs:

- per-tenant and per-channel key namespaces
- similarity threshold and TTL
- source hash and model/version stamp
- invalidation on source document or prompt template changes
- no cache hits across security boundaries

For retrieval, start with Postgres FTS and pgvector. Add a knowledge graph only when a measured query class cannot be served by relational joins plus vector/FTS.

## Context consolidation plan

The project needs one authoritative architecture chain, not more memory layers.

Proposed authority order:

1. `00_truth` command-center doctrine: private canonical doctrine and lifecycle.
2. `docs/operating/STATE.md`: current operational board, but only after it is refreshed and explicitly date-stamped.
3. `docs/operating/PRODUCTION-READINESS.md`: merged launch/no-go gate.
4. ADRs in repo: canonical public engineering decisions.
5. GitHub PRs/checks: evidence for code state.
6. Generated status/read-model artifacts: derived, never canonical unless freshness is proven.

Consolidation steps:

1. Keep the merged production-readiness gate as the repo launch/no-go authority.
2. Keep branch protection aligned to the merged `.nvmrc` CI context and treat stale required contexts as production blockers.
3. Add ADR-0001 for self-hosted Postgres replacing Supabase as the durable business store.
4. Add ADR-0002 for the memory contract: Redis cache, Postgres durable memory, derived retrieval indexes.
5. Refresh `docs/operating/STATE.md` from live evidence and remove stale counts.
6. Mark `docs/PROGRAM_STATUS.md` as stale or rewrite it into a dated archive.
7. Reconcile all qwen/Gemma model identity claims.
8. Replace Supabase launch language with self-hosted Postgres language where the user decision has changed.
9. Make every generated status/read-model file publish its source, generated timestamp, and stale-after threshold.
10. Create a weekly drift check that scans for forbidden stale claims: removed model names, old package versions, Supabase-as-default, stale generated dates, and unsupported production claims.

## Repository cleanup plan

P0 cleanup:

- Enforce the merged production-readiness gate before any launch action.
- Apply the committed Node 22 PM2 interpreter pin only through the founder-approved reload path after native modules are rebuilt under Node 22.22.3.
- Fix qwen/Gemma model identity drift across docs and receipts.
- Fix or quarantine active-vision paths that fabricate live analysis.
- Fix vector retrieval isolation before multi-user or multi-channel memory goes live.
- Update `STATE.md` and `PROGRAM_STATUS.md` so they stop contradicting live evidence.
- Add `.env`, vault, key, and secret path checks to every new context/compiler path.
- Add migrations and backup runbooks before any self-hosted DB goes production.

P1 cleanup:

- Consolidate old launch-readiness documents under an archive header with supersession links.
- Add ADR index and ADR template.
- Add a docs drift test for model names, package versions, and stale generated timestamps.
- Remove or document duplicate vector stores and choose one canonical retrieval path.
- Add receipt export/import demos that actually run.
- Add observability surface for CI, PM2, web, DB, Redis, Stripe webhook, and status publisher.

P2 cleanup:

- Archive abandoned experiments with provenance rather than deleting blindly.
- Create code ownership map by package.
- Split public launch docs from private doctrine docs.
- Add dependency ownership and update cadence.
- Add a minimal architecture graph generated from repo facts, not hand-maintained diagrams.

## Claude collaboration strategy

Claude Code should remain the primary builder/refactorer. Codex should remain the independent infrastructure auditor, reviewer, red-team engineer, and evidence collector. The founder remains the final authority for protected production actions.

Division of labor:

| Role | Owns | Must not do without founder |
|---|---|---|
| Claude Code | implementation branches, refactors, docs reconciliation, tests, migrations, local verification | deploy production, publish npm, set live Stripe keys, change pricing/public claims, read secrets |
| Codex | infra audit, PR review, security review, launch gates, CI/branch protection checks, evidence reports | deploy production, restart live services, read secrets, override review gates |
| Founder | secrets, pricing, public claims, production deploys, billing activation, npm publish, final launch approval | delegate final authority to an agent |

Synchronization protocol:

- Every unit of work starts from a GitHub issue or `docs/operating/STATE.md` task.
- Claude implements on one branch per task.
- Codex reviews the branch or writes a request-changes prompt with concrete file/line blockers.
- Accepted changes land through protected PRs only.
- Chat summaries are not source of truth. Durable state goes into docs, ADRs, PR bodies, or receipts.
- If Claude and Codex disagree, live commands/tests and current source win. If it is a protected business decision, founder decides.

Best near-term Claude prompts:

1. Fix the qwen/Gemma and Supabase/Postgres doc drift without touching secrets or production services.
2. Implement ADR scaffolding and add ADRs for self-hosted Postgres and memory tiering.
3. Build the self-hosted Postgres migration/runbook skeleton with restore-test instructions.
4. Fix active-vision fabrication and add regression tests.
5. Fix vector retrieval isolation and add multi-channel leakage tests.
6. Add heartbeat/read-model freshness checks and scheduled proof without reloading live PM2 until founder authorizes.

## Production readiness assessment

### Ready now

- Main CI is green.
- Production dependency audit gate exists.
- Branch protection is real.
- The merged production-readiness gate gives launch/no-go criteria a repo home.
- SEIF/ECP/receipt concepts are strong enough to become production governance primitives.
- Redis can be used as L1 cache/coordination.
- GitHub can serve as the evidence court of record.

### Not ready yet

- Live billing and provisioning are not ready.
- Self-hosted DB production posture is not ready until backup/restore and migration discipline exist.
- Full autonomous SEIF operation is not ready as a public claim.
- Graph memory/knowledge graph is not ready as canonical memory.
- ECP read-model/heartbeat freshness is not ready as production liveness proof until scheduled and monitored.
- Mesh and cross-agent claims are not ready until second-device and receipt evidence exist.
- The live web/deploy state needs direct verification before any loud launch.

### Launch posture

Quiet launch / design partner onboarding: possible after P0 gates, with transparent limitations.

Loud launch / HN/Product Hunt / paid self-serve: no-go until install, live web, Stripe test-mode fulfillment, database restore, public status freshness, and no-go gates are all proven.

## 72-hour launch roadmap

### Hours 0-8: establish truth and gates

- Use the merged `PRODUCTION-READINESS.md` gate as the launch/no-go authority.
- Confirm main remains green on `Hermetic tests (Node from .nvmrc)` after each production-readiness PR.
- Refresh `STATE.md` from live evidence.
- Freeze public claims to the measured set only.
- Add ADRs for self-hosted Postgres and memory architecture.
- Confirm no launch path depends on Supabase as default.

Exit criteria: one current production-readiness page, no stale source-of-truth ambiguity, and a known CI/protection plan.

### Hours 8-24: fix credibility blockers

- Reconcile model identity docs and receipt labels.
- Remove or gate fabricated active-vision live paths.
- Fix vector retrieval isolation or keep multi-channel memory disabled.
- Prove clean install on a clean host/container.
- Vercel CLI is not installed; install it with `npm i -g vercel` for the web/deploy lane if web launch work is active, so agents can use `vercel env pull`, `vercel deploy`, and `vercel logs` instead of guessing deploy state.
- Verify live web equals audited code before any traffic.

Exit criteria: no known false public claims, install proof captured, deploy proof captured or launch downgraded.

### Hours 24-48: production data and money path

- Stand up self-hosted Postgres in staging with migrations.
- Add backup and restore drill.
- Implement Stripe Checkout Sessions/webhook fulfillment in test mode or prove existing Stripe path end-to-end.
- Add idempotent provisioning event table.
- Add observability for Stripe webhook, DB, Redis, PM2, and status publisher.
- Keep live payments disabled until founder keys and test purchases pass.

Exit criteria: test-mode purchase produces a durable subscription/provisioning record and can be replayed safely.

### Hours 48-72: launch cut

- Generate evidence bundle: CI, install, web, DB restore, Stripe test, status freshness, receipt verify, secret scan.
- Run the no-go gate in `docs/operating/PRODUCTION-READINESS.md`.
- If any gate fails, launch waitlist/early-access only.
- If all gates pass, launch the narrow product slice: install, proof/verify, local-first continuity, founder-approved checkout/onboarding.
- Keep mesh economy, graph memory, enterprise integrations, and broad autonomy out of launch copy.

Exit criteria: launch claims match evidence exactly.

## Prioritized engineering backlog

### P0 - before public launch

1. Enforce the merged production-readiness gates.
2. Complete the founder-approved PM2 reload plan for the committed Node 22 runtime pin without exposing secrets.
3. Add ADRs for self-hosted Postgres, memory tiering, launch scope, and protected actions.
4. Refresh `STATE.md` and archive or rewrite stale status docs.
5. Reconcile qwen/Gemma and Supabase/Postgres references.
6. Prove clean install from public instructions.
7. Prove live web/deploy matches audited branch.
8. Add Postgres migrations, roles, backup, restore drill.
9. Prove Stripe test-mode checkout-to-provisioning.
10. Fix active-vision fabrication or disable the path.
11. Fix vector isolation before multi-channel memory.
12. Add ECP heartbeat/read-model freshness monitoring.

### P1 - immediately after launch gate

1. Add Redis semantic cache with TTL, namespaces, and source hashes.
2. Add pgvector or Postgres FTS retrieval from durable memory.
3. Add OPA-style policy registry or lightweight local policy engine for protected actions.
4. Add OpenTelemetry-compatible traces/metrics/logs for production flows.
5. Add receipt export CLI and tamper demo.
6. Add docs drift CI.
7. Add scheduled backup verification.
8. Add Claude/Codex handoff template tied to PR evidence.

### P2 - defer until measured need

1. Persistent knowledge graph.
2. Graph memory as retrieval default.
3. Full event sourcing of all entities.
4. Temporal or equivalent workflow engine.
5. Multi-node mesh economy.
6. Cross-agent database memory plane.
7. Enterprise migration tooling for locked-in vendor data.
8. Broad autonomous production execution.

## Business impact

The moat is not the number of AI wrappers. The moat is ownership plus governance: local-first data, explicit receipts, durable continuity, default-deny security, verifiable claims, and low-friction migration away from vendor lock-in.

The product architecture should make adoption easy by offering three entry paths:

1. Developer path: install CLI, run local proof, verify receipt, connect repo.
2. Business path: import docs/chats/repos into a local continuity spine, prove no secrets were ingested, generate audit trail.
3. Enterprise path: self-hosted control plane, policy engine, database-backed memory, exportable receipts, and migration adapters.

For Fortune 100 credibility, the first product cannot look like an experiment. It must be boring where trust matters: backup/restore, logs, permissions, billing, incident response, docs, and rollback. The advanced AI layers should be presented as governed capabilities, not magic.

## Final recommendation

Proceed with modernization, but in this order:

1. Lock production gates and truth docs.
2. Choose self-hosted Postgres and write the ADR.
3. Define tripartite memory contract and prove write-recall.
4. Fix launch credibility blockers.
5. Add observability and restore drills.
6. Let Claude implement and Codex review through GitHub PRs.
7. Defer graph memory, full event sourcing, and broad autonomy until measured production evidence justifies them.

This gets Efficient Labs closer to launch than another architecture expansion would. The company already has enough conceptual architecture. The next advantage comes from making the current architecture provable, repeatable, recoverable, and honest.
