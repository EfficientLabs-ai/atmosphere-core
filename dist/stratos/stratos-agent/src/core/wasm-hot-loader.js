import { verifyPayload } from '../security/quantum-crypto.js';

/**
 * WasmHotLoader: Coordinates dynamic hot-swapping and execution of cryptographically
 * sealed WebAssembly skill modules (seals signed via hybrid ML-DSA-65 / Ed25519 keys).
 */
export class WasmHotLoader {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.loadedSkills = new Map();
  }

  /**
   * Cryptographically validates and dynamically registers a new WASM skill module.
   * 
   * @param {string} skillId - Unique string identifier of the skill
   * @param {Buffer|Uint8Array} wasmBinary - The raw compiled WebAssembly binary bytes
   * @param {Object} signatureBundle - Classical + PQ signature bundle (ed25519Sig, mldsaSig)
   * @param {Object} peerPublicKeyBundle - The hybrid public key bundle of the compiler peer
   * @param {Object} [importObject={}] - Custom execution import bindings for the WASM sandbox
   */
  async hotSwap(skillId, wasmBinary, signatureBundle, peerPublicKeyBundle, importObject = {}) {
    if (this.verbose) {
      console.log(`🔄 [WasmHotLoader] Inbound hot-swap request for skill: [${skillId}]`);
    }

    // 1. Enforce Post-Quantum Signature Verification (Hybrid ML-DSA-65 + Ed25519)
    const isSignatureValid = verifyPayload(wasmBinary, signatureBundle, peerPublicKeyBundle);
    if (!isSignatureValid) {
      throw new Error(`❌ Cryptographic Violation: Inbound WASM skill [${skillId}] signature verification failed! Dynamic loading aborted.`);
    }

    if (this.verbose) {
      console.log(`🛡️ [WasmHotLoader] Post-Quantum ML-DSA-65 seal verified successfully for: [${skillId}]`);
    }

    try {
      // 2. Compile WebAssembly binary in-memory
      const wasmModule = await WebAssembly.compile(wasmBinary);

      // 3. Define default runtime import bindings if not provided
      const defaultImports = {
        env: {
          log_message: (offset, length) => {
            // Simulated console logger for sandboxed WASM executing steps
            console.log(`👾 [WASM Skill Sandbox: ${skillId}] Execution log offset: ${offset}, length: ${length}`);
          },
          get_timestamp: () => BigInt(Date.now()),
          ...importObject.env
        }
      };

      // 4. Instantiate the compiled WASM module
      const wasmInstance = await WebAssembly.instantiate(wasmModule, defaultImports);

      // 5. Cache and hot-swap active instance
      const record = {
        skillId,
        module: wasmModule,
        instance: wasmInstance,
        exports: wasmInstance.exports,
        timestamp: Date.now()
      };

      this.loadedSkills.set(skillId, record);

      if (this.verbose) {
        console.log(`✅ [WasmHotLoader] Dynamic hot-swap successful! Registered skill: [${skillId}] with ${Object.keys(wasmInstance.exports).length} exported symbols.`);
      }

      return record;
    } catch (err) {
      console.error(`❌ [WasmHotLoader] WebAssembly compilation or instantiation failed for [${skillId}]:`, err.message);
      throw err;
    }
  }

  /**
   * Safely invokes a dynamic function export inside a registered WASM sandbox.
   * 
   * @param {string} skillId - The target registered skill ID
   * @param {string} symbol - The exported function name to run
   * @param {...any} args - Numerical arguments to pass into WASM function
   * @returns {any} - Result of WebAssembly execution
   */
  executeSkill(skillId, symbol, ...args) {
    const record = this.loadedSkills.get(skillId);
    if (!record) {
      throw new Error(`❌ Error: Skill [${skillId}] is not active or registered in the hot-loader.`);
    }

    const fn = record.exports[symbol];
    if (typeof fn !== 'function') {
      throw new Error(`❌ Symbol Error: Skill [${skillId}] does not export an executable function [${symbol}].`);
    }

    try {
      if (this.verbose) {
        console.log(`👾 [WasmHotLoader] Executing dynamic symbol [${symbol}] on skill [${skillId}] with args:`, args);
      }
      return fn(...args);
    } catch (err) {
      console.error(`❌ [WasmHotLoader] Runtime error executing [${skillId}::${symbol}]:`, err.message);
      throw err;
    }
  }

  /**
   * Removes a loaded skill from the hot-loader memory.
   */
  unloadSkill(skillId) {
    if (this.loadedSkills.has(skillId)) {
      this.loadedSkills.delete(skillId);
      if (this.verbose) {
        console.log(`🔌 [WasmHotLoader] Unloaded skill: [${skillId}]`);
      }
      return true;
    }
    return false;
  }
}
