# Parallel Work — Multiple Terminals Runbook

> How to run more than one Claude session at once so we ship faster. Answers: *"How do I create
> multiple terminals for Claude to access?"*

---

## The honest constraint (read this first)

A Claude Code session **cannot reach into another Claude terminal and drive it.** There is no
"Claude finds and controls your other sessions." Each `claude` process is independent. So the model
is **not** "spin up terminals and I puppet them." The model is:

> **One orchestrator (this session) + a shared file board. Worker sessions read their assignment
> from a file, do the work, and write results back. You relay 'worker N is done' and I integrate.**

Coordination happens through files in this repo, not through live session-to-session control.
That's the durable, reliable pattern — and it's how real distributed teams work (a ticket board,
not telepathy).

**Also true:** within *this one session* I already run a whole team in parallel — multiple
subagents at once + long jobs in the background (the audit running right now is exactly that).
So you often **don't need** extra terminals. Use them only for big, genuinely independent tracks
(e.g. a website sprint and a core-engine sprint that don't touch the same files).

---

## How the two layers work

| Layer | What it is | When |
|---|---|---|
| **In-session parallelism** | I dispatch N subagents + background tasks from this session. One board, one context. | Default. Most work. The audit, multi-file builds, reviews. |
| **Multi-terminal workers** | You open extra `claude` sessions; each consumes a dispatch file; results come back to the board. | Only for large independent workstreams you want running truly simultaneously. |

---

## Setup: creating worker terminals on the VPS

Claude already runs 24/7 in **tmux** on this VPS, so the cleanest path is more tmux windows — no
SSH juggling, and they survive disconnects.

**Option A — tmux on the VPS (recommended):**
```bash
# from any terminal already on the VPS:
tmux new-window -n worker-1   # Ctrl-b c also works
# inside the new window:
cd /home/neo/atmosphere-core && claude
# repeat for worker-2, worker-3 as needed
# switch windows: Ctrl-b <number> ; list: Ctrl-b w
```

**Option B — SSH from your desktop (one terminal app, multiple tabs):**
```bash
# each desktop terminal tab:
ssh neo@<vps-tailscale-name>     # Tailscale-only, no public ports
cd /home/neo/atmosphere-core && claude
```

You do **not** need to "notify me to find the sessions" — I can't attach to them anyway. You
notify me when a worker **finishes** so I run the merge gate on its output.

---

## The workflow (how a parallel sprint actually runs)

1. **You:** "Run sprint X and Y in parallel."
2. **Me (orchestrator):** I write a scoped dispatch file per track to
   [`dispatch/`](dispatch/) — each has the task, the files to touch, and acceptance criteria.
   I update [`STATE.md`](STATE.md) § NOW so the board shows both tracks.
3. **You:** open a worker terminal per track. In each, one line:
   > `Execute docs/operating/dispatch/<file>.md. Follow OPERATING-MODEL.md. Write results + a DONE line back into that same file, then stop.`
4. **Workers:** run independently, in parallel.
5. **You:** "worker-1 done" (and/or "worker-2 done").
6. **Me:** read the worker's dispatch file + its diff, run the **Definition of Done** gate
   (tests → Codex review → security if needed → behavioral check), then commit + push on green,
   and update `STATE.md`.

This keeps **one source of truth** (`STATE.md`) no matter how many terminals are open.

---

## Why one orchestrator, not many

If every terminal updated the board, they'd race and the truth would fragment — the exact "I'm
lost" problem. So: **workers execute; this session owns the board and the gate.** That single rule
is what makes parallelism safe instead of chaotic.
