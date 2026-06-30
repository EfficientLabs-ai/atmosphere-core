/**
 * test-audit-prod-gate.mjs — hermetic tests for the production dependency audit gate.
 *
 * No network and no npm registry access: fixtures exercise the npm-audit JSON contract directly.
 */
import assert from 'node:assert';
import { evaluateAudit, formatAuditResult, runAuditGate } from './audit-prod-gate.mjs';

let pass = 0;
const ok = (condition, message) => { assert.ok(condition, message); console.log('  ✓ ' + message); pass++; };

const audit = (vulnerabilities = {}, counts = {}) => ({
  vulnerabilities,
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...counts } },
});

console.log('=== clean and moderate-only audits pass ===');
{
  const clean = evaluateAudit(audit());
  ok(clean.ok === true, 'empty audit passes');
  ok(/0 critical \/ 0 high/.test(formatAuditResult(clean)), 'summary reports zero high/critical');

  const moderate = evaluateAudit(audit({ postcss: { severity: 'moderate', via: [] } }, { moderate: 1, total: 1 }));
  ok(moderate.ok === true, 'moderate-only audit passes the launch gate');
  ok(moderate.blocking.length === 0, 'moderates are tracked but not blocking');
}

console.log('\n=== high and critical audits fail with actionable package names ===');
{
  const result = evaluateAudit(audit({
    next: { severity: 'high', via: [{ name: 'next' }, 'postcss'] },
    request: { severity: 'critical', via: [{ name: 'form-data' }] },
    uuid: { severity: 'moderate', via: [] },
  }, { critical: 1, high: 1, moderate: 1, total: 3 }));

  ok(result.ok === false, 'high/critical audit fails');
  ok(result.blocking.length === 2, 'only high/critical entries are blocking');
  const text = formatAuditResult(result);
  ok(text.includes('critical: request via form-data'), 'critical package appears in output');
  ok(text.includes('high: next via next,postcss'), 'high package appears in output');
  ok(!text.includes('uuid'), 'moderate package is not listed as blocking');
}

console.log('\n=== CLI runner handles npm audit exit codes and malformed JSON ===');
{
  let out = '';
  let err = '';
  const stdout = { write: (chunk) => { out += chunk; } };
  const stderr = { write: (chunk) => { err += chunk; } };

  const passCode = runAuditGate({ execFile: () => JSON.stringify(audit({}, { total: 0 })), stdout, stderr });
  ok(passCode === 0 && /passed/.test(out), 'runAuditGate returns 0 for clean audit JSON');

  out = ''; err = '';
  const npmAuditError = new Error('audit found vulnerabilities');
  npmAuditError.stdout = JSON.stringify(audit({ undici: { severity: 'high', via: ['undici'] } }, { high: 1, total: 1 }));
  const failCode = runAuditGate({ execFile: () => { throw npmAuditError; }, stdout, stderr });
  ok(failCode === 1 && /undici/.test(err), 'runAuditGate evaluates npm audit JSON even when npm exits non-zero');

  out = ''; err = '';
  const malformedCode = runAuditGate({ execFile: () => '{not-json', stdout, stderr });
  ok(malformedCode === 2 && /valid JSON/.test(err), 'malformed audit output is an infrastructure failure');
}

console.log(`\n✅ ALL ${pass} audit-prod-gate checks passed.`);
