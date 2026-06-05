import fs from 'node:fs';
import { WASI } from 'node:wasi';
import { EgressPolicy, DENY_ALL, assertEgressAllowed, EgressDenied } from '../security/egress-policy.js';

/**
 * WasiSandbox: Executes compiled WebAssembly skill binaries within a strict,
 * capability-based WASI micro-kernel environment. Implements full linear memory
 * isolation and zero ambient host authority.
 *
 * EGRESS FIREWALL (default-DENY, fail-closed): outbound network attempts from a sandboxed guest are
 * checked against the policy-as-code egress firewall (egress-policy.js), COMPOSED with the skill's
 * declared `net` caps — a host must be permitted by BOTH the skill's caps AND the host policy. With
 * neither configured, NOTHING leaves the box (the safe, backward-compatible default for capless skills).
 * This replaces the prior STUB that only granted egress on a bare `*` wildcard.
 *
 * ENV DISCIPLINE: the guest env is deny-by-default — only NODE_ENV/ATMOS_PROTOCOL markers plus
 * caller-supplied keys that are EXPLICITLY allowlisted (allowedEnvKeys). Arbitrary caller env is never
 * forwarded, matching the VaultHost's empty-env enclave discipline (no API keys / SOLANA_KEYPAIR leak).
 */
export class WasiSandbox {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.allowedPaths = options.allowedPaths || {}; // Maps GUEST mount point -> HOST directory (matches job-policy.js sanitizer output)
    this.allowedDomains = options.allowedDomains || new Set(); // Legacy domain whitelist (kept for back-compat)
    this.allowedEnvKeys = options.allowedEnvKeys instanceof Set
      ? options.allowedEnvKeys
      : new Set(options.allowedEnvKeys || []); // Explicit env passthrough allowlist (deny-by-default)

    // Egress firewall. Accept (in priority order): an EgressPolicy instance, a {path} to hot-reload from,
    // a raw policy source, or nothing ⇒ DENY_ALL. Composed with the skill's declared net caps below.
    if (options.egressPolicy instanceof EgressPolicy) {
      this.egress = options.egressPolicy;
    } else if (options.egressPolicyPath) {
      this.egress = new EgressPolicy({ path: options.egressPolicyPath });
    } else if (options.egressPolicySource != null) {
      this.egress = new EgressPolicy({ source: options.egressPolicySource });
    } else {
      this.egress = new EgressPolicy({ source: DENY_ALL }); // default-deny: no egress unless configured
    }
    // Skill's declared net caps (from capability-gate's parseCapabilities). Absent ⇒ no net at all.
    this.caps = options.caps && Array.isArray(options.caps.net) ? options.caps : { net: [] };
  }

  /**
   * Enforce one outbound request against the COMPOSED firewall: caps ∩ host-policy. Returns the matched
   * rule on ALLOW; throws EgressDenied on any denial (fail-closed). This is the real check the guest's
   * network-permission shim calls — no more bare-`*` stub.
   */
  assertEgressAllowed(req) {
    return assertEgressAllowed(req, this.egress.current(), { caps: this.caps });
  }

  /**
   * Build the WASI preopen map from allowedPaths. allowedPaths is { guestMountPoint: hostRealPath }
   * — the exact shape job-policy.js's sanitizer emits — and WASI preopens are likewise
   * { guestMountPoint: hostPath }, so the mapping passes through 1:1 (only for hosts that exist).
   *
   * (Previously execute() destructured entries as [hostPath, guestPath], INVERTING the mapping: every
   * mount silently failed the existsSync(host) check or mounted the wrong directory. Pure + testable
   * now so the {guest -> host} contract with job-policy.js can't silently regress.)
   */
  buildPreopens() {
    const preopens = {};
    for (const [guestPath, hostPath] of Object.entries(this.allowedPaths)) {
      if (fs.existsSync(hostPath)) {
        preopens[guestPath] = hostPath;
        if (this.verbose) console.log(`📂 [WasiSandbox] Cryptographically delegating folder capability: ${hostPath} -> ${guestPath}`);
      }
    }
    return preopens;
  }

  /**
   * Spawns an isolated WASI guest instance and executes a target skill binary.
   * 
   * @param {Buffer|Uint8Array} wasmBytes - The target compiled WebAssembly binary
   * @param {Array<string>} [args=[]] - Execution arguments passed to the WASI guest
   * @param {Object} [env={}] - Environmental variables passed to the WASI guest
   * @returns {Promise<Object>} - Execution results including exit code and memory sweeps
   */
  async execute(wasmBytes, args = [], env = {}) {
    if (this.verbose) {
      console.log(`🤖 [WasiSandbox] Preparing sandboxed execution. Args: [${args.join(', ')}]`);
    }

    try {
      // 1. Configure pre-opened directory capabilities (libpreopen simulation).
      const preopens = this.buildPreopens();

      // 2. Initialize WASI instance with strict parameters.
      // Deny-by-default environment: the guest only ever sees the two protocol
      // markers below plus any caller-supplied vars whose keys are explicitly
      // allowlisted. We never spread arbitrary env (it could forward secrets like
      // API keys or SOLANA_KEYPAIR into an untrusted guest).
      const allowEnv = {};
      for (const [k, v] of Object.entries(env || {})) {
        if (this.allowedEnvKeys.has(k)) allowEnv[k] = v;
      }
      const wasi = new WASI({
        args: ['stratos-guest', ...args],
        env: {
          NODE_ENV: 'sovereign-enclave',
          ATMOS_PROTOCOL: 'x402-wasi-v1',
          ...allowEnv
        },
        preopens,
        version: 'preview1'
      });

      // 3. Compile the WebAssembly bytes
      const wasmModule = await WebAssembly.compile(wasmBytes);

      // Late-bound ref to the instance's memory so the network shim can read the guest-supplied host
      // string out of linear memory at call time (set right after instantiate, below).
      let guestMemory = null;
      const readGuestString = (ptr, len) => {
        if (!guestMemory || !Number.isInteger(ptr) || !Number.isInteger(len) || len < 0) return null;
        try {
          const buf = new Uint8Array(guestMemory.buffer, ptr, len);
          return Buffer.from(buf).toString('utf8');
        } catch { return null; }
      };

      // 4. Construct import object with strict, capability-checked APIs
      const importObject = {
        wasi_snapshot_preview1: wasi.wasiImport,
        env: {
          // REAL egress firewall (replaces the bare-`*` stub). The guest passes the target host (and,
          // optionally, method/path) it wants to reach; we resolve it against the COMPOSED policy:
          // skill net-caps ∩ host egress policy. Default-DENY + fail-closed: any unparseable host,
          // unlisted host, caps miss, or internal error ⇒ 0 (DENY). Returns 1 only on an explicit ALLOW.
          check_network_permission: (hostPtr, hostLen, methodPtr = 0, methodLen = 0, pathPtr = 0, pathLen = 0) => {
            const host = readGuestString(hostPtr, hostLen);
            if (host == null) return 0;
            const method = methodLen ? readGuestString(methodPtr, methodLen) : null;
            const path = pathLen ? readGuestString(pathPtr, pathLen) : null;
            try {
              this.assertEgressAllowed({ host, method, path });
              if (this.verbose) console.log(`🛡️  [WasiSandbox] EGRESS ALLOW → ${host}${method ? ' ' + method : ''}${path || ''}`);
              return 1;
            } catch (e) {
              if (this.verbose) {
                const why = e instanceof EgressDenied ? e.reason : e.message;
                console.warn(`⛔ [WasiSandbox] EGRESS DENY → ${host} (${why})`);
              }
              return 0; // fail-closed
            }
          },
          // Core logging channel
          log_execution_step: (msgPtr, msgLen) => {
            if (this.verbose) {
              console.log(`👾 [WASI Guest Log] Captured trace offset ${msgPtr}, len ${msgLen}`);
            }
          }
        }
      };

      // 5. Instantiate and run
      const wasmInstance = await WebAssembly.instantiate(wasmModule, importObject);
      guestMemory = wasmInstance.exports.memory || null;
      
      // Execute the WASI start routine
      const exitCode = wasi.start(wasmInstance);

      if (this.verbose) {
        console.log(`✅ [WasiSandbox] Sandboxed execution complete. Exit Code: ${exitCode}`);
      }

      // 6. Force-wipe memory bounds on completion to maintain RAM hygiene
      const memoryBuffer = wasmInstance.exports.memory ? new Uint8Array(wasmInstance.exports.memory.buffer) : null;
      if (memoryBuffer) {
        memoryBuffer.fill(0);
        if (this.verbose) {
          console.log(`🧹 [WasiSandbox] Zeroized guest linear memory buffer (${memoryBuffer.length} bytes) successfully.`);
        }
      }

      return {
        success: exitCode === 0,
        exitCode,
        memoryCleared: !!memoryBuffer
      };
    } catch (err) {
      console.error('❌ [WasiSandbox] Execution aborted due to sandbox boundary violation:', err.message);
      throw err;
    }
  }
}
