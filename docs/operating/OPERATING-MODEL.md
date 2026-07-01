# Efficient Labs — Operating Model

> **What this is:** the org chart and the production pipeline. How the company ships.
> You give instructions. Claude orchestrates. Codex + tests verify. Nothing ships unverified.
>
> This governs *how* we work. [`../doctrine/DOCTRINE.md`](../doctrine/DOCTRINE.md) governs *what* we build and *why*.
> The live board is [`STATE.md`](STATE.md) — always check there first to see what's in flight.

---

## 1. The roles (your engineering team)

You have one input — instructions — and a virtual team that executes them. Each role is a Claude
subagent, the Codex agent, or a skill. Claude (this session) is the **orchestrator**: it assigns,
sequences, and holds the line on the definition of done.

| Role | Who runs it | Does what |
|---|---|---|
| **Orchestrator** | Claude (lead session) | Turns your instruction into a sequenced plan, dispatches the team, keeps `STATE.md` current, holds the merge gate. |
| **Product Manager** | Claude / `feature-dev:code-architect` | Turns the instruction into a scoped spec + acceptance criteria *before* any code. |
| **Architect** | Claude / `feature-dev:code-architect` | Designs the approach, names the files to touch, picks the build sequence. |
| **Software Engineer ×N** | parallel Claude subagents (`general-purpose`) | Implement, in parallel where work is independent (isolated worktrees if they'd collide). |
| **Security Engineer** | Codex MCP + `code-modernization:security-auditor` | OWASP/STRIDE + secret-leak + capability-boundary audit on every change touching auth, crypto, channels, or external surface. |
| **Reviewer / Verifier** | Codex MCP (independent) + `pr-review-toolkit` agents + the test suite | Independent second opinion. Adversarial. **Blocks the merge** until green. |
| **Growth Marketer** | `marketing-skills:*` | Only on public-facing surface (site copy, launch, pricing). Bound by the honesty caveats in [`../doctrine/STRATEGY-BRIEF.md`](../doctrine/STRATEGY-BRIEF.md). |

**Why Codex is the verifier, not a second builder:** independent review catches what the author is
blind to. Claude builds and self-checks; Codex reviews with fresh eyes and no sunk cost. Two
perspectives beat one perspective twice. (Codex runs inline — diffs pass in the prompt body; its
shell sandbox is restricted on this host, so we feed it context, not a checkout.)

---

## 2. The pipeline (every instruction flows through this)

```
  YOU                ORCHESTRATOR (Claude)
  instruction  ──▶   1. SCOPE      PM writes spec + acceptance criteria  ─┐
                     2. DESIGN     Architect names files + sequence       │  posted to
                     3. BUILD      Engineers implement (parallel)         │  STATE.md as
                     4. TEST       run the suite — must be green          │  it happens
                     5. REVIEW     Codex + reviewer agents (adversarial)  │
                     6. SECURITY   security audit if surface/crypto/auth  │
                     7. GATE       all green? ─▶ commit + push    ────────┘
                                   not green? ─▶ back to BUILD
  YOU            ◀── 8. REPORT     honest result: what shipped, what didn't, evidence
```

**Handoffs are explicit.** Each stage produces an artifact the next stage consumes (spec → file list
→ diff → test output → review verdict). No stage is skipped silently; if one is skipped, the report says so.

---

## 3. Definition of Done (the merge gate)

A change is **DONE** only when **all** of these are true — this is the discipline behind "100% working":

- [ ] **Tests green.** The relevant suite passes (`npm run test:ci` in atmosphere-core; `node run-tests.mjs` in the public repos). New behavior ships with a new assertion, or the report states why not.
- [ ] **Codex review clean.** Independent review returned no unresolved high-severity finding.
- [ ] **Security audit** (only if the change touches auth, crypto, secrets, channels, or any external surface) returned clean.
- [ ] **Verified behaviorally**, not just compiled — the thing actually does what was asked (run it, hit the endpoint, observe).
- [ ] **STATE.md updated** to reflect new reality, and the commit message is honest.

> **Honest framing of "100% working every time":** this gate does not magically guarantee
> bug-free code. What it guarantees is that *nothing ships without independent verification* — a
> regression has to get past tests **and** Codex **and** a behavioral check. That's the realistic
> version of the guarantee, and it's the one worth having. Aspiration is labeled aspiration
> (doctrine rule). We never report something as done that wasn't verified.

Production launch readiness is stricter than an ordinary merge gate. The launch/no-go checklist,
backup/restore discipline, PM2 reload rules, observability proof, and founder-gated money/secret steps live in [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md).
The 2026-06-30 environment modernization assessment, memory architecture recommendation, and
72-hour launch roadmap live in [`ENVIRONMENT-MODERNIZATION-READINESS-2026-06-30.md`](ENVIRONMENT-MODERNIZATION-READINESS-2026-06-30.md).

---

## 4. How you drive it (your interface)

You give instructions in plain language. You never need to specify *how*. Useful shapes:

- **"Build X."** → full pipeline, you get a report at the gate.
- **"What's the state of Y?"** → I read `STATE.md` + verify against disk, answer.
- **"What are you working on?"** → `STATE.md` § NOW always answers this; that's its job.
- **"Ship it."** → run the gate; commit + push only when green (and only when you've authorized the push).
- **"Faster."** → I widen parallelism (more engineer subagents, background tasks) and/or recommend you open additional Claude terminals for genuinely independent tracks.

**Throughput model.** Default is **in-session orchestration**: I run multiple subagents in parallel
and long jobs in the background — that's most of the "20x." Separate Claude terminals add real
parallel capacity for *independent* tracks (e.g. you drive a website sprint in one while I run a
core-engine sprint in another), at the cost of coordination. Recommendation: one orchestrator
(this session) as the source of truth for `STATE.md`; spin up terminals only for clearly separable
workstreams, and hand their results back here to keep one board.

---

## 5. Standing rules (non-negotiable)

- **Honesty moat.** Never inflate progress. Verify counts/state against disk before reporting. The
  edge in a field full of fabricated benchmarks is that ours are real. (See `STATE_OF_REALITY.md`.)
- **Secrets never in tool output.** No `.env`/keys/tokens read, echoed, or interpolated. No `bash -x` on vault scripts. No raw tokens handed to other agents.
- **Public-surface discipline.** Anonymization + secret grep before any public commit. Doctrine canon stays private. Public claims stay inside what `STATE_OF_REALITY.md` can measure.
- **Irreversible actions are gated.** Repo deletes, force-pushes, financial/infra changes need your explicit go-ahead. I never bypass the classifier.
- **One board.** `STATE.md` is the single source of truth for in-flight work. It is updated every session, not at session end.
