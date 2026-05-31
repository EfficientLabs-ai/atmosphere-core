# Multi-machine HA — zero single point of failure

The mesh tolerates losing any coordinator (including the VPS / key-holder) **without
duplicating the signing key**. This is the key design point: availability and signing
authority are separated.

## Architecture
- **Signing authority** lives in ONE place (the key-holder, normally the VPS). It signs the
  membership skill **once** → a static `signed-skill.wasm` artifact. The private key can even
  be taken offline afterward.
- **Keyless relays** run on any number of other machines. A relay holds **no private key** —
  it just re-broadcasts the pre-signed artifact, onboards ghosts, aggregates capacity, and can
  dispatch jobs (a job references the already-verified skill, so no new signature is needed).
- **Leader election:** every relay heartbeats the others (`RELAY_HELLO`). Only the leader (the
  lowest live `relay-id`) dispatches jobs, so redundant relays never double-dispatch. If the
  leader goes silent, the next-lowest promotes itself within ~16 s. Eventually-consistent: a
  brief overlap during failover only ever causes a duplicate *idempotent* compute job.
- **Result:** as long as ONE relay is up, the mesh lives. Kill the key-holder → a keyless relay
  keeps it running. No shared secret; the key's blast radius stays at exactly one machine.

Proven live (3 processes): killed the key-holder/leader `a`; keyless relay `b` (no key)
elected itself and kept dispatching; the worker kept computing slices after `a` was gone.

## Run it (real multi-machine)
**1. Key-holder (VPS)** — already wired into the `atmos-mesh-origin` PM2 service. It exports
the artifact:
```
--relay-id origin --export-skill .stratos-profile/signed-skill.wasm
```

**2. Backup relay on a second machine** (e.g. your mini-desktop) — distribute
`signed-skill.wasm` + the topic, then run a KEYLESS relay (no node-keys needed):
```
node mesh-demo.mjs broadcast --topic-file mesh-topic.txt --relay-id desktop \
  --signed-skill signed-skill.wasm --job-interval 15 --job-max 40
```

A relay's runtime dependencies are the same light set as the ghost (hyperswarm + b4a +
@noble/post-quantum) — the heavy compiler (wabt/lancedb) is only imported on the key-holder
path. So a **relay bundle** can be packaged exactly like the ghost bundle (next deployment
step) for plug-and-run backup coordinators on your hardware.

## Still a frontier
- **Threshold signing** (m-of-n origins must co-sign) would remove even the *signing* SPOF, but
  PQC (ML-DSA-65) has no production threshold scheme yet — classical FROST exists, hybrid does
  not. Today's model keeps signing single (offline-capable) and makes *availability* HA.
