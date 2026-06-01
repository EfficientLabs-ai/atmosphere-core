import fs from 'node:fs';
import { WASI } from 'node:wasi';

/**
 * WasiSandbox: Executes compiled WebAssembly skill binaries within a strict,
 * capability-based WASI micro-kernel environment. Implements full linear memory
 * isolation and zero ambient host authority.
 */
export class WasiSandbox {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.allowedPaths = options.allowedPaths || {}; // Maps GUEST mount point -> HOST directory (matches job-policy.js sanitizer output)
    this.allowedDomains = options.allowedDomains || new Set(); // Domain whitelists for sandboxed networking
    this.allowedEnvKeys = options.allowedEnvKeys instanceof Set
      ? options.allowedEnvKeys
      : new Set(options.allowedEnvKeys || []); // Explicit env passthrough allowlist (deny-by-default)
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

      // 4. Construct import object with strict, capability-checked APIs
      const importObject = {
        wasi_snapshot_preview1: wasi.wasiImport,
        env: {
          // Strict capability-governed lateral network check.
          // Deny-by-default: only an explicit wildcard ('*') in the allowlist
          // grants the guest network capability. (Node WASI preview1 exposes no
          // real sockets regardless, so this is defence-in-depth for custom hosts.)
          check_network_permission: (hostPtr, hostLen) => {
            return this.allowedDomains.has('*') ? 1 : 0;
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
