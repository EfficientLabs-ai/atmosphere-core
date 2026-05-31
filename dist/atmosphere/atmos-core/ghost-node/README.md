# Atmosphere Ghost Node — per-platform bundles

Self-contained mesh nodes that let any machine join the **Atmosphere** sovereign compute mesh
with zero setup. Each node joins the **public Hyperswarm DHT via NAT hole-punching** — it opens
**no inbound port** and exposes **no public internet surface**. It runs a compute skill **only
if** the skill's hybrid post-quantum seal (**ML-DSA-65 + Ed25519**) verifies against the
**pinned origin public key** in `config.json`. Unsigned / tampered / wrong-origin skills are
refused and never executed.

## Why separate per-platform bundles
Windows (PowerShell), macOS (zsh), and Linux (bash) have different shells, path rules, and
native binaries. Merging them into one installer is fragile. Each platform therefore gets its
**own** download: its own bundled Node runtime, only its own native prebuilds, and a
native-syntax installer. Same protocol, same trust model, clean separation.

| Bundle | Runtime | Installer | Prebuilds |
| :-- | :-- | :-- | :-- |
| `atmosphere-ghost-windows-x64` | bundled `node.exe` | `install-windows.ps1` | `win32-x64` |
| `atmosphere-ghost-macos-arm64` | bundled `node` | `bash install-unix.sh` | `darwin-arm64` |
| `atmosphere-ghost-linux-x64`   | bundled `node` | `bash install-unix.sh` | `linux-x64` |

## Install (registers a private "secret command")
- **Windows:** `powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Name <yourname>` (or double-click `atmos-ghost.cmd`).
- **macOS / Linux:** `bash install-unix.sh <yourname>` (unzip drops the execute bit, so run via `bash`).

Then open a new terminal and run your command:
- `<yourname>` — join the mesh and stand by for verified skills.
- `<yourname> --once` — run one verified skill and exit (proof mode).

`config.json` holds the topic (your rendezvous) and the pinned origin key (your trust anchor) —
keep it private.

## Building the bundles
`build.sh` assembles all three from source. It needs `node`/`npm`/`curl`/`python3` and must run
on an **exec-allowed** filesystem (not `/tmp`, which is often `noexec` and blocks loading native
`.node` prebuilds). It pins the origin trust anchor from `STRATOS_NODE_KEYS`:

```bash
STRATOS_NODE_KEYS=~/atmosphere-core/.stratos-profile/node-keys.json bash build.sh
```

The standalone joiner (`atmos-ghost.mjs`) reuses the repo's real verifier — the dependency-free
`wasm-sections.js` parsers and `quantum-crypto.js` `verifyPayload` — so a device validates a
skill block with the exact same code path as the origin, without pulling in `wabt`/`lancedb`.
