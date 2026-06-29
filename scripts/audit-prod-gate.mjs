#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const BLOCKING = new Set(['critical', 'high']);

export function parseAuditJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`npm audit did not return valid JSON: ${err.message}`);
  }
}

export function evaluateAudit(audit) {
  const counts = audit?.metadata?.vulnerabilities || {};
  const critical = Number(counts.critical || 0);
  const high = Number(counts.high || 0);
  const moderate = Number(counts.moderate || 0);
  const low = Number(counts.low || 0);
  const total = Number(counts.total || 0);
  const blocking = [];

  for (const [name, vuln] of Object.entries(audit?.vulnerabilities || {})) {
    if (BLOCKING.has(vuln?.severity)) {
      blocking.push({
        name,
        severity: vuln.severity,
        via: (vuln.via || []).map((item) => typeof item === 'string' ? item : item.name).filter(Boolean),
      });
    }
  }

  blocking.sort((a, b) => a.severity.localeCompare(b.severity) || a.name.localeCompare(b.name));
  return { counts: { critical, high, moderate, low, total }, blocking, ok: critical === 0 && high === 0 };
}

export function formatAuditResult(result) {
  const { critical, high, moderate, low, total } = result.counts;
  const summary = `production audit: ${critical} critical / ${high} high / ${moderate} moderate / ${low} low / ${total} total`;
  if (result.ok) return `${summary}\nProduction dependency audit gate passed.`;

  const lines = [
    summary,
    'Production dependency audit gate failed: high/critical vulnerabilities are launch-blocking.',
  ];
  for (const vuln of result.blocking) {
    const via = vuln.via.length ? ` via ${vuln.via.join(',')}` : '';
    lines.push(`- ${vuln.severity}: ${vuln.name}${via}`);
  }
  return lines.join('\n');
}

export function readProductionAudit(execFile = execFileSync) {
  try {
    return execFile('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err?.stdout) return String(err.stdout);
    throw err;
  }
}

export function runAuditGate({ execFile = execFileSync, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const audit = parseAuditJson(readProductionAudit(execFile));
    const result = evaluateAudit(audit);
    const output = formatAuditResult(result);
    (result.ok ? stdout : stderr).write(`${output}\n`);
    return result.ok ? 0 : 1;
  } catch (err) {
    stderr.write(`Production dependency audit gate failed to run: ${err.message}\n`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runAuditGate();
}
