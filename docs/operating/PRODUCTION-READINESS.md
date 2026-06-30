# Production Readiness Gate

> Scope: infrastructure truth before product packaging. This is the launch/no-go gate for the
> private `atmosphere-core` repo and the VPS-operated bridge. It does not authorize production
> deploys, live billing, secret provisioning, public claims, or data migration by itself.

## Binding Rules

1. Tested capability is the only capability that can be called done.
2. No `.env`, vault, private-key, token, or secret file is read to prove readiness.
3. No production deploy, PM2 reload, live billing, or customer-data migration happens without the
   founder's explicit go-ahead for that action.
4. Every launch claim must cite an evidence command, a GitHub check, or a SEIF/LOGOS/ECP receipt.
5. Any failed gate returns the system to `not production ready` until the failure is fixed and the
   evidence is regenerated.

## P0 Launch Gates

### 1. Source Control and Branch Protection

Required before launch:

- `main` branch protection is enabled with strict status checks and required review.
- The required status-check names match the current CI workflow. Stale contexts are blockers, even
  when the new check is green.
- Every production PR has a Codex verification record and either a non-author approval or a founder
  approved compensating-control receipt when GitHub's review model cannot be satisfied.
- No open security remediation PR is left in a conflicting or draft-only state.

Evidence commands:

```bash
gh api repos/EfficientLabs-ai/atmosphere-core/branches/main/protection \
  --jq '{enforce_admins:.enforce_admins.enabled, required_status_checks:.required_status_checks.contexts, strict:.required_status_checks.strict, reviews:.required_pull_request_reviews}'

gh pr list --repo EfficientLabs-ai/atmosphere-core --state open \
  --json number,title,headRefName,isDraft,mergeable,reviewDecision,url
```

### 2. Runtime and Dependency Gate

Required before launch:

- Node runtime is pinned and checked before install, test, process execution, and PM2 reload.
- `npm ci --no-audit --no-fund` succeeds under the pinned runtime.
- `npm run audit:prod` reports `0 critical / 0 high` for production dependencies.
- The hermetic suite and web build pass from a clean install.
- Dependency worktrees are not placed in `/tmp`; `/tmp` is a small tmpfs on this VPS and is not a
  safe dependency workspace.

Evidence commands:

```bash
export PATH="/home/neo/.nvm/versions/node/v22.22.3/bin:$PATH"
npm run preflight
npm ci --no-audit --no-fund
npm run audit:prod
npm test
npm run build --workspace=packages/efficientlabs-web
git diff --check
```

### 3. PM2 and Process Discipline

Required before launch:

- PM2 process definitions live in `ecosystem.config.cjs`; runtime changes are committed before they
  are applied.
- Reloads use `pm2 reload --update-env` from a shell that has the full intended environment.
- The rule is never a bare restart: pm2 restart is forbidden for the bridge because it can drop
  required env and create false health.
- Native modules are rebuilt under the pinned Node runtime before reload.
- Restart counters are reset only after root cause is understood and the reset is recorded.

Evidence commands:

```bash
pm2 status
curl -fsS http://127.0.0.1:4099/health
curl -fsS http://127.0.0.1:5001/health
```

Do not use `pm2 jlist` or `/proc/*/environ` as routine evidence because those surfaces can expose
environment values. Prefer behavior checks and redacted logs.

### 4. Observability and Alerting

Required before launch:

- Health endpoints for the bridge and upstream agent respond locally.
- Alerts exist for bridge down, upstream down, repeated 5xx, high p95 latency, high heap, restart
  count increase, disk pressure, and backup failure.
- Logs used for diagnosis are redacted before they enter agent context.
- Observability proof is behavior-based: endpoint status, PM2 status, bounded log tails, and receipt
  counts. It is not secret/env inspection.

Minimum launch thresholds:

- Bridge `/health` responds within 3 seconds from loopback.
- Upstream `/health` responds within 3 seconds from loopback.
- Root disk has at least 20 percent free space.
- Backup target has enough free space for two full restore points plus the current active dataset.

### 5. Self-Hosted Database Gate

Efficient Labs will operate its own database rather than depend on Supabase as the production system
of record. Supabase scaffolding can remain as code history or prototype context, but production data
ownership requires self-hosted Postgres or an equivalent founder-controlled datastore.

Required before customer data:

- Self-hosted Postgres has a named owner, firewall boundary, upgrade path, and backup role.
- Application credentials are least-privilege and provisioned through vault-aware deployment, never
  through chat or committed files.
- Redis remains L1/cache/continuity acceleration, not the only durable record.
- Schema migrations are reversible or have a written forward-only recovery plan.
- A restore drill proves the database can be rebuilt on a clean host from backup artifacts.

KVM decision gate:

- Do not buy another KVM only to fix `/tmp` or build-worktree pressure; use `/home/neo` or a proper
  workspace volume for dependency installs.
- Add another Hostinger KVM4, a managed volume, or a separate database host when production Postgres
  needs isolated CPU/RAM/IO, when backup restore needs a clean target, or when the current VPS cannot
  reserve enough resources for bridge plus database plus observability.
- Never keep the only backup on the same failure domain as the primary database.

### 6. Backup and Restore Gate

Required before launch:

- Nightly encrypted backup job exists for Postgres, Redis persistence, receipt ledgers, and operator
  state that cannot be regenerated from Git.
- Backups include a manifest with timestamp, source path or logical source, checksum, byte size,
  retention class, and restore command.
- At least one off-host encrypted copy exists for every production backup set.
- Monthly restore drill runs against a clean target and records pass/fail evidence.
- Restore is tested before any public claim of production readiness.

Minimum restore receipt fields:

```text
receipt_id:
source:
backup_started_at:
backup_completed_at:
checksum:
restore_target:
restore_completed_at:
validation_command:
validation_result:
operator:
```

### 7. Stripe and Money Gate

Stripe is the payment rail, but live money is founder-gated.

Required before live billing:

- Stripe keys and webhook secrets are founder-provisioned through a vault-aware path.
- Webhook signature verification is tested in test mode.
- Entitlement grant/revoke path is tested without moving live money.
- Refund, failed-payment, cancellation, and chargeback handling are documented.
- No live billing route is enabled until the founder explicitly approves live mode.

### 8. SEIF/LOGOS/ECP Continuity Receipt

Production readiness must be recoverable from files and receipts, not chat memory.

Required before launch:

- SEIF records deterministic governance facts: commit, PR, check, branch-protection state, and gate
  verdict.
- LOGOS records probabilistic analysis only when it is marked as analysis, not fact.
- ECP packets carry scoped context with deny-pattern scanning before external model use.
- Tripartite memory contracts are unified: Redis can accelerate recall, but durable truth lands in
  the receipt ledger and database.
- Any admin override or compensating control has a receipt that names the risk, the authority, the
  exact window, and the restore verification.

### 9. Launch No-Go Conditions

Any one of these blocks launch:

- Any high or critical production dependency vulnerability.
- CI red or branch protection requiring stale/missing contexts.
- Required review or Codex verification missing.
- Backup exists but restore has not been tested.
- Database credentials or Stripe credentials are not vault-provisioned.
- PM2 reload requires reading or echoing secrets.
- Health endpoints are down or only pass through a mock/stub path that is not labeled as such.
- Public copy claims a capability that is only built, not live.

## Launch-Day Evidence Bundle

The final launch-day bundle must include:

- GitHub PR links and commit SHAs.
- Branch-protection JSON summary.
- CI run URLs.
- Local validation command transcript with secrets excluded.
- Backup manifest and restore receipt.
- PM2 reload receipt if a reload happened.
- Stripe test-mode receipt if billing is activated.
- SEIF/LOGOS/ECP continuity receipt.
- Founder approval line for every protected action.

## Current Infrastructure Note

During this hardening pass, dependency installation failed when a worktree was placed under `/tmp`
because `/tmp` is a small tmpfs. Root disk had enough room. The operational correction is to place
build and review worktrees under `/home/neo` or another real workspace volume; this does not by
itself justify another KVM. A second KVM becomes justified for database isolation, restore drills,
or failover, not for temporary build space.
