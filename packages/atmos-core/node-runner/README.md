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

## Attribute your compute to your wallet (`--wallet`)

Attribute every verified job your node completes to your **public Solana address** — connect and
attribute in one command:

```bash
node mesh-node.mjs --wallet <SOL_ADDRESS>
```

This is **measurement before rewards**: the origin records your address in the `owner_wallet` field of
each PQC-signed, hash-chained Capability Receipt, so the day a reward layer launches your node is
**already attributed and rewardable** on the basis of measured contribution alone. A wallet **address
is public** and safe to advertise; this **never touches a private key**, and there is **no
price/payout logic** anywhere — only the attribution basis. The address is validated (base58, 32–44
chars); an invalid one is refused at startup. Omit `--wallet` and the node still joins, logging
`unattributed (no wallet)`. You can also set `"walletAddress"` in `config.json` (the `--wallet` flag
overrides it).

The node reuses the repo's real verifier — the dependency-free `wasm-sections.js` parsers and
`quantum-crypto.js` `verifyPayload` — so a device validates a skill block with the exact same
code path as the origin.
