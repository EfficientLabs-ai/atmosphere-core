# Atmosphere Mesh Node

A self-contained mesh node that lets any machine join the **Atmosphere** sovereign compute mesh
with zero setup. The node joins the **public Hyperswarm DHT via NAT hole-punching** — it opens
**no inbound port** and exposes **no public internet surface**. It runs a compute skill **only
if** the skill's hybrid post-quantum seal (**ML-DSA-65 + Ed25519**) verifies against the
**pinned origin public key** in `config.json`. Unsigned / tampered / wrong-origin skills are
refused and never executed.

## Run

```bash
node mesh-node.mjs            # join the mesh and stand by for verified skills
node mesh-node.mjs --once     # run one verified skill and exit (proof mode)
```

`config.json` holds the topic (your rendezvous) and the pinned origin key (your trust anchor) —
keep it private. See `config.example.json` for the shape.

The node reuses the repo's real verifier — the dependency-free `wasm-sections.js` parsers and
`quantum-crypto.js` `verifyPayload` — so a device validates a skill block with the exact same
code path as the origin.
