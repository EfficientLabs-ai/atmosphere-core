/**
 * runner.js — the sovereign exec RUNNER (Task #16, final increment). Composes the two primitives:
 *
 *   job spec ──▶ sanitizeJobSpec (job-policy.js)  ──▶  execute in the sandbox with ONLY the sanitized
 *                                                       config  ──▶  controller signs a receipt
 *                                                       committing to EXACTLY what ran (identity.js)
 *
 * Guarantees:
 *   - The executor NEVER sees the raw spec — only the sanitized config (no `..`/over-grant mounts, no
 *     secret-shaped env, deny-by-default network). A spec with violations is REJECTED before execution.
 *   - Every outcome — rejected, success, failure, error — produces a hybrid-signed receipt that an
 *     orchestrator can verify (verifyReceipt) against the controller's pinned key, so the audit trail is
 *     tamper-evident and bound to the exact sanitized spec.
 *
 * `execute(sanitized, spec)` is injected. Production wires it to WasiSandbox:
 *     const execute = (s) => new WasiSandbox({ allowedPaths: s.allowedPaths, allowedEnvKeys: s.allowedEnvKeys,
 *                                              allowedDomains: s.allowedDomains }).execute(wasmBytes, args, s.env);
 * `now` is passed in (the receipt timestamp) — deterministic, no implicit Date.now().
 */
import { sanitizeJobSpec } from './job-policy.js';

export async function runJob({ spec = {}, policy = {}, controller, jobId, execute, now } = {}) {
  if (!controller?.issueReceipt) throw new Error('runJob needs an exec controller (controller-identity.js)');
  if (typeof execute !== 'function') throw new Error('runJob needs an execute(sanitized, spec) function');
  if (!jobId || now == null) throw new Error('runJob needs jobId and now');

  const { ok, violations, sanitized } = sanitizeJobSpec(spec, policy);

  // policy rejection — never reaches the sandbox; still produces a signed, verifiable record
  if (!ok) {
    const receipt = controller.issueReceipt({ jobId, spec: sanitized, status: 'rejected', ts: now });
    return { ok: false, status: 'rejected', violations, sanitized, receipt };
  }

  let status, exitCode = null;
  try {
    const res = await execute(sanitized, spec); // executor sees ONLY the sanitized config
    exitCode = Number.isInteger(res?.exitCode) ? res.exitCode : 0;
    status = exitCode === 0 ? 'success' : 'failure';
  } catch {
    status = 'error'; // generic — never surface raw sandbox internals to the caller
  }

  // the receipt commits to the SANITIZED spec + outcome — proof of exactly what this controller ran
  const receipt = controller.issueReceipt({ jobId, spec: { sanitized, exitCode, status }, status, ts: now });
  return { ok: status === 'success', status, exitCode, sanitized, receipt };
}
