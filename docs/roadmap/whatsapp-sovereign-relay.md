# WhatsApp on StratosAgent — why it's not here yet, and the sovereign way we'll do it

**Status:** ROADMAP (planned). This document explains, plainly, why WhatsApp is the one major messaging
platform StratosAgent does **not** yet support out of the box — and the design we'll ship to support it
**without** compromising the sovereignty that is the whole point of The Atmosphere.

We'd rather tell you the truth than ship a backdoor.

## TL;DR

- **Telegram, Discord, Slack, Matrix, and Signal** all let your agent connect **outward** — your machine
  dials the platform; nothing needs to reach *you*. So they need **no open ports** and work on your
  sovereign node as-is. ✅
- **WhatsApp's official Cloud API is webhook-inbound by design.** Meta's servers POST your messages to a
  **public HTTPS URL**. Meta is not a peer on The Atmosphere mesh, so the mesh can carry that traffic to
  your node but cannot remove the need for *some* public endpoint to exist.
- The naive fix (a company-run server that receives Meta's webhook and forwards it) would **see your
  message content** — a trust/privacy hole we refuse to ship.
- The sovereign fix is a **blind SNI-routing relay**: it forwards *encrypted bytes only*; your node holds
  the TLS key and decrypts. Your content never leaves your box in the clear, and you still open no ports.
- Why it's "later": it's **infrastructure we operate**, not just code — a public relay fleet + DNS +
  automated per-user certificates. We're building it as **The Atmosphere's first public service.**

## Why the other platforms are easy and WhatsApp isn't

| Platform | How the agent receives messages | Needs a public inbound endpoint? |
|---|---|---|
| Telegram | long-poll (outward) | No |
| Discord | gateway websocket (outward) | No |
| Slack | Socket Mode websocket (outward) | No |
| Matrix | client sync (outward) | No |
| Signal | signal-cli (outward) | No |
| **WhatsApp (Cloud API)** | **Meta POSTs to your webhook** | **Yes** |

The first five let *you* initiate the connection. WhatsApp's Cloud API requires *Meta* to initiate a
connection to a public, TLS-verified URL. That's the entire difference.

> The unofficial route (libraries like Baileys that log in as a WhatsApp Web client and connect outward)
> *would* be sovereign — but it's reverse-engineered and **gets phone numbers banned**. We hold to the
> clean path: official APIs only, no ToS/CFAA gray zones. So that door stays closed.

## What The Atmosphere already solves (the hard part)

Reaching a machine that's **behind NAT with no open ports** is exactly what our public-DHT + hole-punch
transport does. Your node dials *out* and becomes reachable over the mesh without exposing a port. That
part is done and proven. WhatsApp's remaining problem is narrower: **a non-peer (Meta) needs a public URL.**

## The sovereign design: a blind SNI-routing relay

The key insight is that a relay does **not** have to see your messages to forward them.

```
  Meta (WhatsApp servers)
        │  HTTPS to  you.relay.efficientlabs.ai   (public, TLS)
        ▼
  ┌─────────────────────────┐
  │  Blind relay (Atmosphere)│   reads ONLY the SNI hostname; forwards the RAW encrypted TLS bytes.
  │  - no TLS termination     │   never holds your cert key → cannot decrypt your messages.
  └───────────┬─────────────┘
              │  hole-punched mesh tunnel (encrypted bytes)
              ▼
  ┌─────────────────────────┐
  │  YOUR StratosAgent node  │   holds the TLS cert + key for your subdomain → terminates TLS here,
  │  (no open ports)         │   decrypts, processes the webhook locally, replies via the Graph API.
  └─────────────────────────┘
```

- Each user gets a subdomain (`you.relay.efficientlabs.ai`) and **your node holds the TLS private key**
  (auto-issued via Let's Encrypt DNS-01 — the relay never sees the key).
- The relay is a **TLS pass-through / SNI router**: it reads the destination hostname and forwards the
  encrypted stream over the mesh tunnel. It sees ciphertext + a hostname, never plaintext.
- **Your node terminates TLS** and handles the webhook. Your WhatsApp content is decrypted only on *your*
  hardware. No company server reads your messages.

Residual honesty: this introduces an **availability** dependency on the relay fleet (if it's down,
WhatsApp delivery pauses) — but **not a privacy** dependency (the relay is blind). And you still expose no
inbound port on your own machine.

## Why "later," precisely

Not a technical impossibility — two real reasons:

1. **It's production infrastructure to operate, not just code:** a public relay fleet, DNS, automated
   per-user certificate issuance, and webhook delivery over the mesh transport. That's an ops + cost +
   abuse-handling commitment.
2. **Real engineering:** the SNI proxy, DNS-01 cert orchestration, and the mesh tunnel wiring.

We're prioritizing a frictionless, fully-sovereign launch on the five outward-connecting channels first,
then standing up the relay as The Atmosphere's first public service.

## A note on WhatsApp's privacy

WhatsApp messages are end-to-end encrypted in transit, but the platform still sits inside a large
advertising company, with metadata collection and a history of security and privacy concerns. Part of why
we're deliberate here is that "add WhatsApp" should not quietly mean "route your life through Meta's
infrastructure on Meta's terms." When we add it, we add it the sovereign way.

## Want it sooner?

Tell us — `stratos channels` will let you request platforms, and demand will move WhatsApp (and the relay)
up the roadmap. Until the blind relay ships, the honest answer is: we're not going to fake sovereignty to
get a checkmark.
