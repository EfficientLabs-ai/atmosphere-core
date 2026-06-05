> **Draft — structured by a research workflow (Claude Opus + 5 agents), 2026-06-02, for the operator to refine.**
> Grounded in `STATE_OF_REALITY.md` (the source of truth). Not a final commitment; the positioning is the operator's call.

# Jake Van Clief / MWP — Research Brief for Atmosphere

## 1. Who/what this is + best sources

**The person is Jake Van Clief** (the operator misremembered "Van Cleef"). He is a practitioner-author, not an academic lab. He runs a Skool community ("Clief Notes" / cliefnotes) and a Substack (jakevanclief.substack.com), publishes on GitHub under the handle **RinDig**, and co-authored a 2026 arXiv paper with **David McDermott**.

**"MWP" = Model Workspace Protocol**, the protocol; the surrounding methodology is **ICM = Interpretable Context Methodology** (sometimes spelled "Interpreted Context Methodology" — his repo name is even misspelled "Methdology"). One-line thesis: *replace framework-level agent orchestration with filesystem structure — numbered folders are pipeline stages, markdown files carry the per-stage prompts/context, local scripts do the deterministic work, and a single agent walks the folders.*

**Confidence: high** that this is the source. The exact phrasing the operator half-remembered ("file architecture beats AI-agent wrappers," "MWP," a name like "Jake Van Cle—") maps precisely onto Van Clief + MWP. One honest caveat: this is **recent, self-published, lightly-validated** work. The arXiv paper is a methodology/experience report, not a controlled study — the authors themselves admit no controlled comparison was run, data is from an invite-only self-selected community (enthusiasm/selection bias), and all testing was on a single model family. Treat it as a well-articulated *design pattern*, not proven science.

**Best sources, ranked:**
- **arXiv paper** (primary, most rigorous): "Interpretable Context Methodology: Folder Structure as Agentic Architecture" — https://arxiv.org/abs/2603.16021 · HTML: https://arxiv.org/html/2603.16021v1
- **GitHub reference implementation**: https://github.com/RinDig/Interpreted-Context-Methdology (workspaces: script-to-animation, course-deck-production, workspace-builder)
- **Related repo**: https://github.com/RinDig/Content-Agent-Routing-Promptbase ("separation of concerns applied to context windows instead of code modules")
- **Author**: https://jakevanclief.substack.com · https://www.skool.com/cliefnotes · https://www.linkedin.com/in/jake-van-clief
- **Movement context (the real heavyweights behind the same idea):** Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); Anthropic, [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) (the "don't build an agent if a workflow will do" canon); Anthropic, [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) and [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp); Manus's "filesystem as context"; Cognition's "Don't Build Multi-Agents" (sub-agents isolate context, they don't simulate org charts); academic [Everything is Context (arXiv 2512.05470)](https://arxiv.org/pdf/2512.05470).

## 2. Core teachings, file architectures, workflow patterns, ideology

**The architecture.** A "workspace" is just a folder, version-controlled, portable as a zip:

```
workspace/
├── CLAUDE.md          # Layer 0 — global identity: "where am I?" (~800 tok)
├── CONTEXT.md         # Layer 1 — workspace routing: "where do I go?" (~300 tok)
├── stages/
│   ├── 01_research/
│   │   ├── CONTEXT.md # Layer 2 — stage contract: "what do I do?" (~200-500 tok)
│   │   ├── references/# Layer 3 — stable rules (voice, design system, conventions)
│   │   └── output/    # Layer 4 — working artifacts (this run only)
│   ├── 02_script/ ...
│   └── 03_production/ ...
└── _config/           # Layer 3 — shared brand/voice/style
```

**The five-layer context hierarchy** (the genuinely useful idea): Layer 0 global identity → Layer 1 routing → Layer 2 stage contract → Layer 3 *reference* material (stable, "internalize as constraints") → Layer 4 *working* artifacts (per-run, "process as input"). The Layer-3/Layer-4 split — stable rules vs. ephemeral data — is the conceptual core.

**The CONTEXT.md stage contract** — three mandatory sections, the load-bearing primitive:
```
## Inputs    — explicit table of which files, which layer, why (scoped, auditable)
## Process   — the ordered steps the agent executes this stage
## Outputs   — named artifacts + destination paths
```
Output of stage `01` is the input of stage `02` (Unix pipe by filesystem). Numbering encodes execution order; folder boundaries enforce separation of concerns.

**Deterministic vs. ambiguous split** (this is the operator's exact philosophy, independently arrived at): *"Local Python scripts handle the parts that do not need AI: fetching data, moving files, formatting output, sending emails."* The agent only does generative/ambiguous work (research synthesis, scriptwriting, tone matching). One orchestrating agent (they tested Opus) optionally delegates sub-tasks to a smaller model (Sonnet) — and the folder it's pointed at *is* the context-isolation mechanism.

**Five design principles:** (1) one stage, one job; (2) plain text as the interface; (3) layered/just-in-time context loading; (4) every output is an edit surface (human can open/edit any intermediate file before the next stage runs — mandatory HITL gates); (5) "configure the factory, not the product" (one-time setup, every run differs).

**The quantified arguments** (cite-able, but theoretical not measured):
- **Token cost:** scoped per-stage context = 2,000–8,000 tokens; a monolithic "load everything" prompt blows past 40,000 tokens, "most of it irrelevant." Backed by the "lost in the middle" (Liu et al.) finding — irrelevant context *degrades* performance, so scoping is a quality argument, not just a cost one.
- **Reproducibility/portability:** the workspace is a folder — copy, `git commit`, zip, sync. Git-compatible by default; every prompt/output diffable and reversible.
- **Auditability/interpretability:** "the entire system state is visible at all times because the system state *is* the filesystem." No logging layer to build. Invokes Cynthia Rudin's "build inherently interpretable systems."

**Ideology / lineage.** Explicitly Unix: do one thing well, output→input, plain text as universal interface — plus modular decomposition, multi-pass compilation, and literate programming. Distinguished from MCP (MCP = how models reach tools/data; ICM = how context is structured across a multi-stage workflow — complementary). It is the small-practitioner echo of the same conclusion the labs reached: Anthropic's "don't build an agent when a workflow suffices," Manus's filesystem-as-context, Cognition's "sub-agents isolate context, they aren't an org chart."

**Skeptic's separation of substance from hype:**
- *Substance:* the Layer-3/Layer-4 stable-vs-ephemeral split; CONTEXT.md as an explicit, diffable I/O contract; filesystem-as-state for auditability; deterministic scripts around an ambiguity-only agent; HITL edit surfaces at every boundary. These are real, durable engineering ideas, convergent with Anthropic/Manus/Cognition.
- *Hype/limits:* It is **sequential, single-agent, human-reviewed pipelines only.** The authors explicitly say it is *not* for real-time multi-agent collaboration, high-concurrency with state isolation, or complex mid-pipeline branching. Almost all observed real use is *content production* (videos, decks). No controlled benchmark exists — the quality claims rest on theory. The "5-layer," numbered-folder packaging is somewhat marketing veneer over what is, fundamentally, "well-organized prompt files + Unix pipes." Don't oversell it as a general agent architecture; it's a workflow-orchestration pattern for linear processes.

## 3. Concrete principles to adopt for Atmosphere

These are the ideas worth importing into the VPS/repos, framed against Atmosphere's determinism / content-addressing / capability / end-to-end / do-one-thing bias:

1. **Make the dataflow contract a file, not code.** Adopt the CONTEXT.md three-section contract (Inputs table with explicit source+scope+why / Process / Outputs) as the standard pipeline-stage descriptor across Atmosphere workers. The Tally→n8n→Stripe→delivery-worker→Resend pipeline and the audit-delivery flow should each have a declarative stage contract that is diffable in git — orchestration as data, not glue.

2. **Enforce the Layer-3 / Layer-4 split everywhere.** Stable reference material (voice rules, ADRs, design system, capability policy) is "internalized as constraints"; per-run working artifacts are "processed as input" and never mixed in. This directly attacks the secret-leak class of incidents — config/reference (Layer 3) is mounted read-only and scoped; per-run data (Layer 4) is the only thing that varies and gets logged. Scoping context = smaller blast radius.

3. **Agent only where ambiguity lives; scripts for everything mechanical.** This is already the operator's thesis — MWP validates it with a published rule of thumb. Audit each Atmosphere step: file-moving, fetching, formatting, dispatch, signing, hashing → deterministic script/binary (cheaper, reproducible, content-addressable, auditable). Reserve the LLM for genuinely ambiguous synthesis. Track token cost per stage; a 40k→4k context reduction is both a cost and a *quality* win (lost-in-the-middle).

4. **Filesystem (better: content-addressed store) as the state machine.** MWP says "system state IS the filesystem." Atmosphere can go one better aligned to its content-addressing bias: stage outputs are content-addressed blobs, the pipeline is a Merkle DAG of `output→input` edges. You get MWP's auditability/portability *plus* tamper-evidence and dedup — "observable by default, verifiable by default." Each stage output is reproducible and pin-able across the P2P mesh.

5. **Every intermediate output is an inspectable, signable edit surface.** Plain-text, git-diffable artifacts at every boundary = the audit deliverables become reviewable before the next stage and before client delivery. Pair the HITL gate with a capability check: who may advance the pipeline past a gate is a capability token, not an ambient permission.

6. **One stage, one job; plain text as the universal interface.** Compose Atmosphere workers as Unix-style do-one-thing units that read/write plain artifacts, not a monolithic agent. This makes stages independently testable, swappable, and mesh-distributable — the end-to-end principle applied to the agent pipeline.

7. **Borrow the discipline, not the branding.** Implement the *contracts, layer split, determinism boundary, and content-addressed state*; do **not** adopt MWP as a load-bearing "framework" or oversell numbered folders as architecture. It is a linear-pipeline pattern with no concurrency/branching story and no benchmark — exactly the "thin ambiguity layer on solid plumbing" the operator wants, provided the plumbing (content addressing, capabilities, deterministic scripts) is the real foundation.

**Sources:**
- https://arxiv.org/abs/2603.16021 · https://arxiv.org/html/2603.16021v1 (Van Clief & McDermott, ICM/MWP)
- https://github.com/RinDig/Interpreted-Context-Methdology · https://github.com/RinDig/Content-Agent-Routing-Promptbase
- https://jakevanclief.substack.com · https://www.skool.com/cliefnotes · https://www.linkedin.com/in/jake-van-clief
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents · https://www.anthropic.com/engineering/building-effective-agents · https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills · https://www.anthropic.com/engineering/code-execution-with-mcp
- https://arxiv.org/pdf/2512.05470 (Everything is Context) · Manus "filesystem as context" / Cognition "Don't Build Multi-Agents" (referenced in secondary coverage)
