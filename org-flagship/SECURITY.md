# Security Policy

Security and privacy are the product, so we hold ourselves to a higher bar than the incumbents.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub Security Advisories on the relevant
repository, or by email to **security@efficientlabs.ai**. Do not open a public issue for a
suspected vulnerability.

- We acknowledge reports within 72 hours.
- Please give us a reasonable window to remediate before public disclosure.
- Good-faith research is welcome; please avoid privacy violations, data destruction, and service
  disruption while testing.

## Our security posture (what we promise)

- **Secrets never travel through chat.** Inbound messages are scanned and key-shaped content is
  refused before it can reach a model, a log, or storage.
- **Off by default.** Agents start with zero ambient authority — file, network, and shell access are
  granted only by you, locally, never from a chat message.
- **Real cryptography.** Signatures are genuine (Ed25519 today; post-quantum ML-DSA-65 + Ed25519 for
  skill seals), verified fail-closed. We do not ship placeholder crypto.
- **No silent privilege.** Installers are user-space and never use `sudo`; background services are an
  explicit, separate step that you run.
- **Honest reporting.** We do not fabricate status, balances, or capabilities.

## Scope

This policy covers the published `@efficientlabs/stratos` package, the StratosAgent and The Atmosphere
repositories, and their installers.
