/**
 * ecosystem.config.cjs — PM2 process definition for the Atmosphere secure bridge.
 * EFL-014 / EFL-015 (infra-hardening lane). OPERATOR-APPLIED, not auto-deployed.
 *
 * Apply with a CONTROLLED reload that preserves environment:
 *
 *     pm2 reload ecosystem.config.cjs --update-env
 *     pm2 reset  atmos-secure-bridge        # EFL-015: zero the stale 42-restart counter
 *                                           #          (shutdown bug already fixed in code)
 *     pm2 save
 *
 * A bare `pm2 restart --update-env` from a fresh shell drops PORT / LOCAL_FALLBACK_ENABLED
 * and breaks the bridge — this file pins them so the reload is safe.
 *
 * cwd is the REPO ROOT to match the live process exactly: the bridge resolves
 * `./.stratos-vector-store` (and other paths) relative to cwd, so it must NOT change.
 *
 * EFL-014:
 *   - node_args `--max-old-space-size=256` lifts the V8 old-space ceiling off the ~80 MiB
 *     floor the bridge was GC-thrashing against (audit: heap 93.7%).
 *   - max_memory_restart '400M' is a hard backstop if a leak ever outruns GC.
 *   - The matching code-side fix (per-request upstream timeout + circuit breaker) ships in
 *     packages/api-shim/src/upstream-breaker.js + server.js so a slow/down upstream fails
 *     fast instead of stacking 8s waits (audit: HTTP p95 71s).
 *
 * EFL-015:
 *   - Pin the interpreter to the deployed Node (v22.x) and run `npm rebuild better-sqlite3`
 *     in the deploy step to stop NODE_MODULE_VERSION (ABI) drift.
 *
 * ATMOS_GATEWAY_SECRET is intentionally NOT defined here — it is provisioned by the operator
 * from the vault at deploy time (issue #58). This config only passes through process.env;
 * it never embeds a secret value.
 */
module.exports = {
  apps: [
    {
      name: 'atmos-secure-bridge',
      script: 'packages/api-shim/index.js',
      cwd: __dirname, // repo root — keep cwd-relative paths (.stratos-vector-store) stable
      node_args: '--max-old-space-size=256',
      max_memory_restart: '400M',
      exp_backoff_restart_delay: 200,
      env: {
        PORT: '4099',
        LOCAL_FALLBACK_ENABLED: 'true',
      },
    },
  ],
};
