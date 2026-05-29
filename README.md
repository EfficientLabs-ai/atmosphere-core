# 🌌 The Atmosphere (Atmos) 1.0 — Post-Quantum Sovereign AI & Compute Grid

> *Sovereign computing, post-quantum end-to-end encryption, off-chain DePIN stablecoin state channels, localized multimodal sensory loops, and deep-scan vector reasoning.*

Atmosphere (Atmos) is a high-performance, completely decentralized, and quantum-hardened peer-to-peer (P2P) compute layer and dynamic browser automation framework. Engineered for real-world DePIN deployment, Atmos provides high-fidelity local AI reasoning capabilities with zero external API dependencies, offline speech-to-text and text-to-speech loops, native primary display tracking, and secure on-chain batch settlements.

---

## 🏛️ System Architecture Overview

```mermaid
graph TD
    subgraph Client Workstation (Tauri Desktop App)
        TA[packages/atmos-desktop] -->|Local Frame Grabber & Voice| SI[Sensory Ingestion]
        SI -->|Hearing & Vision Context| VB[(Vector Bank LanceDB)]
        TA -->|State Machine Execution| SA[StratosAgent]
    end

    subgraph Hostinger VPS / Server Node (Production Daemon)
        TB[Telegram Bot Bridge] -->|Telegram Bot API| TApp[(User Mobile Telegram App)]
        TB -->|REST Completions Webhook| Shim[Local API Interception Shim]
        Shim -->|Fallback Inference & Code RAG| LI[Local Inference Engine]
        GH[Genesis Harvester] -->|Recursive Crawler Workspace| VB
    end

    subgraph Sovereign P2P Network (Hyperswarm & Corestore Grid)
        VB <-->|P2P sync via Noise Sockets & DHT| DHT[(Global Peer Swarm)]
        SA -->|State Updates| DB[Autobase Multi-Writer Ledger]
    end
    
    subgraph Microtransaction Layer (x402 Payments)
        SA -->|Micropayment Invoices| PE[Solana Payment Engine]
        PE -->|Consolidated rollups| SOL[(Solana Ledger)]
    end
```

---

## ⚡ Core Features & Technical Specification

### 1. 🛡️ Post-Quantum Cryptography & Identity Hardening (`packages/atmos-core`, `packages/stratos-agent`)
Traditional TLS/ECDSA signatures are vulnerable to store-now-decrypt-later attacks by quantum adversaries. Atmosphere 1.0 implements a hybrid quantum-classical key exchange and signature scheme using native Node.js FIPS-compliant bindings:
*   **Hybrid Key Agreement:** Integrates classical **X25519 Elliptic Curve Diffie-Hellman (ECDH)** with **FIPS 203 ML-KEM-768** (Kyber) via standard HKDF-SHA256 derivation.
*   **Hybrid Digital Signatures:** Combines classical **Ed25519** with **FIPS 204 ML-DSA-65** (Dilithium) to sign workflow manifests and P2P communication packages.
*   **Quantum-Sealed WebAssembly (GSI Compiler):** Autonomous overnight "Night Shift" compilers gather successful browser execution pathways from LanceDB, compile them into sandboxed `.wasm` skills, and cryptographically seal them using ML-DSA signatures embedded directly into native WASM custom sections.

### 2. 📡 Ambient Cognition & The Triple-Layer Vector Memory (`packages/stratos-agent`)
Our memory architecture runs locally using **LanceDB** backed by **Apache Arrow** to strictly enforce column schemas, enabling ultra-fast, zero-dependency 384-dimensional semantic similarity projection and retrieval:
*   **Layer 1: `ambient_memory`** — Continual context streams containing physical ambient speech logs, active screen captures (window coordinates, titles, and text contents), and deep-scan workspace source code files.
*   **Layer 2: `cognitive_skills`** — AST execution logs compiled from successful workflows, cataloged with triggers, state transitions, and success metrics.
*   **Layer 3: `intercepted_reasoning`** — Detailed `<think>` thoughts and reasoning traces intercepted from open-weights LLMs to maximize offline task comprehension.

### 3. 🎙️ Multimodal Senses & offline Conversational Audio (`packages/atmos-desktop`)
Atmosphere features native "eyes, ears, and voice" that run 100% offline:
*   **Hearing (Whisper.cpp):** Integrates native Whisper.cpp bindings for instantaneous offline speech-to-text (STT) parsing via hotkey mic feeds.
*   **Voice (SAPI TTS):** Synthesizes local model responses back into spoken speech using native Windows SAPI (`System.Speech.Synthesis`) to eliminate latency and avoid heavy Node wrappers.
*   **Active Vision (VLM Screenshot Ingest):** Bypasses visual screen captures by performing zero-dependency PowerShell GDI frame grabs, feeding the visual coordinates and process titles directly into a spatial Vision-Language Model to map active app states.

### 4. 💳 The Solana x402 Micropayment Engine (`packages/atmos-core`)
Atmosphere defines a non-custodial, execution-based DePIN micropayment protocol that settles off-chain execution fees on Solana:
*   **x402 Compliance:** To satisfy strict SEC/CFTC compliance rules and avoid the Howey Test classification, every single micro-invoice requires a cryptographic promise-to-pay referencing a measurable **Proof-of-Work (PoW)**: the `skill_id` and the `execution_hash`.
*   **P2P State Channels:** Micro-transactions of $0.001 USDC (or lamport equivalent) are transacted off-chain instantly over Hyperswarm Noise sockets, maintaining near-zero fee footprints.
*   **Batch Rollup Settlement:** Rollups consolidate up to 10,000 asynchronous micro-invoices into a single serialized Solana transaction (offline signed, under 215 bytes) for daily blockchain finality.

### 5. 🤖 API Subscription Interception & Telegram Bot Bridge (`packages/api-shim`)
A fully-featured background daemon that enables direct remote control of your Stratos agent from a mobile phone:
*   **API Interception Shield:** Binds strictly to `127.0.0.1:4000` or custom VPS ports, acting as an OpenAI and Anthropic compatible completions proxy. If the primary upstream browser agent is offline or encounters timeouts, it triggers a fallback circuit-breaker, rerouting requests to a localized quantized LLM engine.
*   **Deep-Scan Workspace Crawler:** Crawls the entire user workspace recursively (excluding node_modules and private keys), reads all source code (`.js`, `.ts`, `.py`, `.rs`, `.css`, `.html`, `.json`) and markdown docs, and indexes them into LanceDB RAG to allow the LLM to learn the code architecture out-of-the-box.
*   **Telegram Bot Bridge:** Polling bridge using `node-telegram-bot-api` that reads secrets securely from `.secrets-vault/`, routes text commands to our completions engine with automated Deep-Scan RAG context injection, formats thinking traces beautifully, and posts responses back to the user's phone.

---

## 📂 Monorepo Folder Structure

```
├── .secrets-vault/               # STRICT GITIGNORE EXCLUSION (HSM Keys, bot tokens)
├── .stratos-vector-store/        # LanceDB database storing vectorized embeddings
├── packages/
│   ├── atmos-core/               # P2P keyring, Hyperswarm network, Corestore, & x402 payment engine
│   ├── stratos-agent/            # Playwright CDP residential automation, LanceDB, & PQC GSI Compiler
│   ├── api-shim/                 # OpenAI proxy, localized fallback engine, & Telegram bot bridge
│   ├── atmos-desktop/            # Tauri system tray launcher & offline STT/TTS sensory interfaces
│   └── maximus-telemetry/        # Alpine-based Maximus Docker telemetry compose configs
└── scripts/
    ├── deploy_cloudflare.js      # Global Coordination Cloudflare DNS propagation tool
    └── install.sh                # Frictionless 1-line script for cross-platform node installations
```

---

## 🛠️ Verification & Testing Matrix

Atmosphere features a comprehensive, Senior-Level Chaos Engineering stress suite to verify absolute stability under network partitioning, concurrent stablecoin micro-spam, bottlenecking, and supply-chain WASM alterations.

### Local Stress Tests Execution

To run all integration checks locally from the monorepo root:

1.  **Run Atmos Core P2P, Keyring, and Ledger Tests:**
    ```bash
    npm run test --workspace=packages/atmos-core
    ```
2.  **Verify Interception API Shim & fallbacks:**
    ```bash
    node verify-proxy-flow.js
    ```
3.  **Verify Post-Quantum Cryptography & Claw AST translation:**
    ```bash
    node packages/stratos-agent/test-quantum-ingestion.js
    ```
4.  **Verify LanceDB Vector banks & screen/audio ingestion schemas:**
    ```bash
    node packages/stratos-agent/test-vector-sensory.js
    ```
5.  **Verify Overnight GSI Compiler and ML-DSA custom-section WASM signature sealing:**
    ```bash
    node packages/stratos-agent/test-gsi-compiler.js
    ```
6.  **Verify Solana x402 state channel off-chain aggregation & daily transaction batching:**
    ```bash
    node packages/atmos-core/test-payment-engine.js
    ```
7.  **Verify Cursor history harvesting & completions RAG:**
    ```bash
    node packages/stratos-agent/test-genesis-inference.js
    ```
8.  **Verify Multimodal hearing/vision audio loops offline:**
    ```bash
    node packages/atmos-desktop/test-multimodal.js
    ```
9.  **Run full Phase 14 Deep-Scan Ingestion & Telegram Completions Routing RAG Verification:**
    ```bash
    node packages/stratos-agent/test-deepscan-telegram.js
    ```

---

## 🛡️ License

Copyright © 2026 **Efficient Labs**. All Sovereign Rights Reserved.
Licensed under the proprietary Sovereign DePIN Compute License.
