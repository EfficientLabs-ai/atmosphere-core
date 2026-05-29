# Product Requirements Document (PRD) — Version 1.0: Sovereign Agentic Architecture

## 🪐 Executive Summary: The New Agentic Standard

The transition from a centralized, cloud-dependent technological paradigm toward an autonomous, decentralized agentic web represents the most consequential architectural shift in modern systems engineering. 

To systematically dismantle the centralized mass surveillance economy and eradicate "Shadow AI" (which accounts for over 410 million enterprise Data Loss Prevention violations annually), Efficient Labs establishes the **New Agentic Standard**. This PRD locks down the authoritative requirements, capability-based sandboxing, multi-writer consensus, transport-agnostic coordination, and hybrid post-quantum cryptography blueprints for **The Atmosphere P2P Compute Mesh** and the **StratosAgent** framework.

---

## 📡 1. Architectural Decision Records (ADRs)

We permanently lock in the following four core architectural decision records (ADRs) for the 1.0 launch:

### 1.1 Horizontal Coordination: Hyperswarm RPC Sockets (Option A)
*   **Decision**: Map the **Agent Communication Protocol (ACP)** horizontal coordinator frames directly over our existing **Hyperswarm Noise-encrypted P2P connections**.
*   **Reasoning**: We strictly reject WebRTC/DataChannels to eliminate reliance on external STUN/TURN signaling servers. By natively encapsulating ACP coordinates over Hyperswarm's UDP hole-punching DHT network, we achieve a 100% decentralized, zero-server overlay.

### 1.2 WASI Capability-Based Access Control: Strict Enclave (Option A)
*   **Decision**: Enforce a **Strict Enclave** sandboxing model. All StratosAgent skills compile to `.wasm` bytecode running on the WebAssembly System Interface (WASI) and utilizing `libpreopen` directories.
*   **Reasoning**: We deprecate all raw OS shell executions. Ambient authority is set to zero. Wasm modules are physically constrained to isolated `/skills` folders and local SQLite socket descriptors. Outgoing network requests or general directory traversal are mathematically blocked at the capability interface, neutralizing prompt-injection privilege escalations.

### 1.3 Verifiable Intent (SD-JWT) Signature Binding: Hardware-Isolated Key (Option B)
*   **Decision**: Anchor all high-stakes (Tier 3) agentic transactions to **Hardware-Isolated Keys** (TPM 2.0 or Apple Secure Enclave coprocessors).
*   **Reasoning**: Autonomous agents must not have authority to sign financial or high-risk administrative state changes on their own. Creating a transaction mandate requires a physical or biometric user handoff. The mandate is issued as an SD-JWT (Selective Disclosure JWT) signed by the local TPM, proving the bounded human authorization.

### 1.4 Node.js Post-Quantum Cryptography: Hybrid-Only (Option A)
*   **Decision**: Enforce **Composite Hybrid Cryptographic Exchanges** globally across all transport and identity channels.
*   **Reasoning**: To mitigate the risk of mathematical weaknesses or algorithmic breaks in early lattice-based schemes, we combine classical and post-quantum layers:
    *   **Transport Encapsulation**: `X25519` + `ML-KEM-768` (FIPS 203)
    *   **Identity & Skill Signing**: `Ed25519` + `ML-DSA-65` (FIPS 204)

---

## 🏗️ 2. Core Functional Requirements

### 2.1 Local-First Software & Consensus
*   **Autoritative Copy**: All user prompts, agent memories, and vector databases (`LanceDB`) must reside natively on the user's edge hardware device.
*   **Consensus Engine**: Peer synchronization operates asynchronously over decentralized, append-only logs (`Autobase`/`Corestore`) linearized via multi-writer consensus, ensuring robust offline functionality without central PostgreSQL clusters.

### 2.2 Dual-Protocol Orchestration Stack
```
+-----------------------------------------------------------------------+
|                         StratosAgent Swarm                            |
+-----------------------------------------------------------------------+
        |                                                 |
        | Horizontal Coordination                         | Vertical Integration
        v (ACP over Hyperswarm)                           v (MCP JSON-RPC 2.0)
+-------------------------------+                 +---------------------+
|      Remote Peer Agent        |                 | Local Tools / DB    |
+-------------------------------+                 +---------------------+
```
*   **Vertical Integration (MCP)**: Anthropic's Model Context Protocol (JSON-RPC 2.0 over stdin/stdout) is used exclusively to hook the agent to local databases and secure tools on the client machine.
*   **Horizontal Coordination (ACP)**: IBM's Agent Communication Protocol is integrated natively over Hyperswarm RPC sockets for Agent-to-Agent (A2A) task delegation, reducing federated communication latency by 40%.

### 2.3 Zero-Trust Identity
*   **W3C Decentralized Identifiers**: Every StratosAgent generates its own sovereign key pair and hosts its DID document utilizing the `did:atmos` (base58btc multibase SHA-256) method. No third-party certificate authorities are permitted.

### 2.4 Tiered Security & Formal Verification
*   **Tier 1 (Read-Only)**: Static analysis linting running on every compile path.
*   **Tier 2 (Moderated API)**: Promptfoo red-teaming and runtime behavioral threat checking.
*   **Tier 3 (High-Risk)**: Zero-trust execution requires intent compliance proofs validated mathematically through **Z3 SMT Solvers** before local transaction release.

---

## 🔒 3. Memory Security & Decryption Specifications

To guarantee absolute memory hygiene within Node.js garbage-collected environments:

### 3.1 Node.js Cryptographic Integration (Node.js v24.7+)
*   Utilize native `node:crypto` library configured with FIPS flags to execute lattice-based calculations natively.

### 3.2 Secure Seed Decryption (AES-GCM-256)
*   The raw 32-byte seed is derived using PBKDF2-HMAC-SHA256 from a user master passcode and salt.
*   Decryption utilizes native `createDecipheriv` with a 12-byte IV and a 16-byte authentication tag.
*   Upon successful decryption and hand-off to the WASM linear memory heap, all intermediate buffers (including the PBKDF2 derived key, salt, and decrypted seed) are explicitly zeroed out utilizing `.fill(0)`.

### 3.3 WASM Guest Memory Wiping (Zeroize)
*   The private `ML-DSA-65` key pair computed inside the WASM linear memory heap is wrapped in Rust's `zeroize` and `ZeroizeOnDrop` traits, ensuring that all lattice private key bytes are explicitly scrubbed from hardware RAM as soon as the enclave instance is dropped.

---

## 💻 4. Operational Run & Auditing Settings

To enforce FIPS-compliant, quantum-hardened execution on Node.js runtimes:

### 4.1 FIPS Node.js Execution Commands
```bash
# Execute local RAG and deep-scan tests under native FIPS configuration
node --enable-fips packages/stratos-agent/test-deepscan-telegram.js
```

### 4.2 Security Auditing Script
*   **Heap Snapshot Audits**: Programmatic instantiation of `v8.writeHeapSnapshot()` is run under testing to verify that no traces of decrypted private keys or seed fragments reside in standard GC memory outside the WASM boundary.
