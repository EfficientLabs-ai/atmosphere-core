#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docPath = path.join(ROOT, 'docs', 'operating', 'PRODUCTION-READINESS.md');
const operatingModelPath = path.join(ROOT, 'docs', 'operating', 'OPERATING-MODEL.md');

const doc = fs.readFileSync(docPath, 'utf8');
const operatingModel = fs.readFileSync(operatingModelPath, 'utf8');

const requiredSections = [
  '# Production Readiness Gate',
  '## Binding Rules',
  '### 1. Source Control and Branch Protection',
  '### 2. Runtime and Dependency Gate',
  '### 3. PM2 and Process Discipline',
  '### 4. Observability and Alerting',
  '### 5. Self-Hosted Database Gate',
  '### 6. Backup and Restore Gate',
  '### 7. Stripe and Money Gate',
  '### 8. SEIF/LOGOS/ECP Continuity Receipt',
  '### 9. Launch No-Go Conditions',
  '## Launch-Day Evidence Bundle',
];

for (const section of requiredSections) {
  assert.ok(doc.includes(section), `missing production readiness section: ${section}`);
}

const requiredPhrases = [
  'No `.env`, vault, private-key, token, or secret file is read',
  'required status-check names match the current CI workflow',
  'npm run audit:prod',
  'pm2 reload --update-env',
  'never a bare restart',
  'Do not use `pm2 jlist` or `/proc/*/environ` as routine evidence',
  'Self-hosted Postgres',
  'Redis remains L1/cache/continuity acceleration',
  'KVM decision gate',
  'off-host encrypted copy',
  'restore drill',
  'Stripe is the payment rail, but live money is founder-gated',
  'SEIF records deterministic governance facts',
  'ECP packets carry scoped context',
  'Any high or critical production dependency vulnerability',
  'Founder approval line for every protected action',
];

for (const phrase of requiredPhrases) {
  assert.ok(doc.includes(phrase), `missing production readiness guardrail: ${phrase}`);
}
