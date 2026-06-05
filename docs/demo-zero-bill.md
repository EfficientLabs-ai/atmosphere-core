# The "$0 bill" demo — `stratos demo`

The single **wired vertical slice** that turns StratosAgent's scattered capabilities into ONE
undeniable, reproducible, screen-recordable proof.

In ~90 seconds it shows that a request:

1. runs as an **ordinary OpenAI-compatible call** (same request shape any OpenAI SDK client sends),
2. is answered by a **real local model** on *this* machine (gemma2:2b),
3. is **sovereign-routed** — the one router decides *local*, and cloud is provably **not** used,
4. produces a **signed Capability Receipt** that a third party can verify with the **public key only**,
5. at **$0 marginal cost**, with the **data never leaving the box**.

It reuses the existing substrate and invents nothing: the gateway
(`packages/api-shim/server.js`), the sovereign router
(`packages/stratos-agent/src/routing/model-router.js`), and the signed receipt
(`packages/stratos-agent/src/ledger/capability-receipt.js`). The slice logic lives in
`packages/stratos-agent/src/cli/demo-harness.js`; the command is `stratos demo`.

---

## How to run it

Prerequisite: the local daemon must be running and a local model pulled.

```bash
# one-time
ollama pull gemma2:2b

# start the sovereign daemon (binds 127.0.0.1:4099, local fallback on)
stratos start            # or: PORT=4099 LOCAL_FALLBACK_ENABLED=true stratos start

# in another terminal — the proof
stratos demo
```

Flags:

| Flag | Effect |
|---|---|
| *(none)* | Run the proof with the default sovereignty-thesis prompt. |
| `--prompt "<text>"` | Use your own prompt. |
| `--json` | Emit the machine-readable proof bundle (for pipelines / CI / a verifier). |
| `help` | Describe the command and the honesty caveats. |

If the daemon is **not** running, `stratos demo` does **not** fake anything: it prints a clear
"the daemon isn't answering" message with the exact `stratos start` command, still shows the
(pure) local routing decision, and exits non-zero. No response is ever fabricated.

---

## What it proves (and exactly how it stays honest)

**Step 1 — a real local response.** The harness POSTs an OpenAI-shaped body to
`127.0.0.1:4099/v1/chat/completions` and uses the assistant content the gateway returns. A
connection error, a non-200, or a 200 with empty content all **degrade** (with an actionable fix)
instead of showing a synthetic answer.

**Step 2 — sovereign routing.** The decision comes from the same `route()` the live shim uses,
called with no frontier key / no escalate / no mesh — the pure sovereign-default path. The output
shows `tier`, `reason`, and `cloud NOT used — data stays on this machine`. This is the router's
verdict, not an assertion by the demo.

**Step 3 — signed, third-party-verifiable receipt.** The inference is recorded in a `ReceiptLog`,
PQC-signed (Ed25519 + ML-DSA-65) and hash-chained. The receipt stores **hashes** of the input and
output (never the content), and a **measured** `cost_units` (the token count — never a price). The
demo exports a self-contained bundle carrying **only the node's public key** and re-verifies it via
`verifyBundle()` — the exact path a third party would use. Tampering with any field fails closed.

**Step 4 — the $0 bill, honestly.**
- **Local marginal cost = $0** — your own open weights, your own electricity, no API key, no
  per-token charge. This is the real local number.
- **Cloud column is an explicit estimate** — published list price (gpt-4o: $2.50/1M input,
  $10.00/1M output) × the **same measured token counts**. It is labelled *"illustrative estimate,
  NOT billed"* everywhere it appears. The demo never claims a measured cloud figure — no cloud call
  is ever made.
- **Data locality = on-device** — the router proved local, so nothing egressed.

---

## 90-second recording script (operator-facing narrative)

> Have `stratos start` already running in a background terminal. Record a single clean terminal.

1. **(0:00–0:10) Set the stakes.** "When models are free, the value isn't the inference — it's the
   *proof* of who ran what, for whom, at what cost, without your data leaving the machine. Here's
   that proof in one command."

2. **(0:10–0:20) Show it's an ordinary OpenAI call.** Type `stratos demo` and hit enter. As Step 1
   renders: "Same request shape any OpenAI client sends — but it went to `127.0.0.1`, and a real
   local model answered. No key, no cloud."

3. **(0:20–0:40) Sovereign routing.** Point at Step 2: "The one sovereign router decided *local*.
   Cloud was **not** used — and that's the router saying so, not a marketing line. The data never
   left this box."

4. **(0:40–1:05) The receipt — the moat.** Point at Step 3: "Every run emits a signed capability
   receipt — post-quantum signed, hash-chained. It stores *hashes*, not your content. And anyone
   holding just the **public key** can verify it: `verifiable proof ✓`. That's the cross-machine
   trust rail."

5. **(1:05–1:25) The $0 bill.** Point at Step 4: "Marginal cost: **$0**. The same call on a frontier
   API would be about this much — and notice that figure is clearly labelled *illustrative*, an
   estimate from published list prices, not a bill we paid. We don't fake cloud numbers."

6. **(1:25–1:30) Land it.** Read the verdict line: "**Local. Sovereign. Signed and verifiable.
   Zero marginal cost.** Reproduce it yourself with `stratos demo --json`."

Optional B-roll: run `stratos demo --json | stratos receipt verify /dev/stdin` is **not** wired
(the bundle is embedded in the demo output, not a receipts file) — to show standalone verification,
pipe the `receipt.bundle` field to a file and run `stratos receipt verify <file>`.

---

## Caveats (honest by construction)

- **The cloud comparison is an estimate, never a measured charge.** It multiplies published list
  prices by the measured local token usage. No cloud API is contacted.
- **$0 is the *marginal* cost** — it excludes the one-time hardware and the ambient electricity, which
  the on-screen basis line states plainly. The claim is "no API/cloud/per-token charge," which is true.
- **The demo mints an ephemeral node identity** if none is supplied, so it is self-contained and
  reproducible. The live daemon signs with its persistent `node-keys.json`; the verification path is
  identical either way (public key only).
- **Token counts come from the local engine** (Ollama may report fractional counts); the receipt and
  the estimate use exactly those measured numbers.
