import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { getDatabase, queryCognitiveSkill } from './src/memory/vector-bank.js';
import { signPayload, verifyPayload } from './src/security/quantum-crypto.js';
import { TraceAnalyzer } from './src/evolution/trace-analyzer.js';
import wabtFactory from 'wabt';

let _wabtPromise = null;
async function getWabt() {
  if (!_wabtPromise) _wabtPromise = wabtFactory();
  return _wabtPromise;
}

/**
 * Generates REAL WebAssembly text for a skill's deterministic computation.
 * - Computational skills (e.g. affine fee = a*x + b, or a constant) compile to wasm
 *   whose exported `compute` genuinely executes and returns the correct value.
 * - Automation skills (browser/DOM workflows) cannot run as sandboxed wasm; their
 *   `compute()` returns a real integrity value (the signed manifest's byte length),
 *   and the workflow itself is replayed from the signed `stratos.gsi.pathway` section.
 */
function watForComputation(computation, pathwayLen) {
  if (computation && computation.type === 'affine') {
    const a = (computation.a | 0), b = (computation.b | 0);
    return `(module
  (memory (export "memory") 1)
  (func (export "compute") (param $x i32) (result i32)
    (i32.add (i32.mul (local.get $x) (i32.const ${a})) (i32.const ${b}))))`;
  }
  if (computation && computation.type === 'const') {
    return `(module
  (memory (export "memory") 1)
  (func (export "compute") (result i32) (i32.const ${computation.value | 0})))`;
  }
  if (computation && computation.type === 'poly2') {
    // c2*x^2 + c1*x + c0  — induced quadratic, executes for real.
    const c2 = (computation.c2 | 0), c1 = (computation.c1 | 0), c0 = (computation.c0 | 0);
    return `(module
  (memory (export "memory") 1)
  (func (export "compute") (param $x i32) (result i32)
    (i32.add
      (i32.add
        (i32.mul (i32.mul (local.get $x) (local.get $x)) (i32.const ${c2}))
        (i32.mul (local.get $x) (i32.const ${c1})))
      (i32.const ${c0}))))`;
  }
  // Default: real integrity compute() returning the signed manifest byte length.
  return `(module
  (memory (export "memory") 1)
  (func (export "compute") (result i32) (i32.const ${pathwayLen | 0})))`;
}

/**
 * Helper to encode Varuint32 (variable-length unsigned 32-bit integer) for WebAssembly binary sections.
 */
function encodeVaruint32(val) {
  const bytes = [];
  let temp = val;
  while (true) {
    const byte = temp & 0x7F;
    temp >>>= 7;
    if (temp === 0) {
      bytes.push(byte);
      break;
    } else {
      bytes.push(byte | 0x80);
    }
  }
  return Buffer.from(bytes);
}

/**
 * Parses and extracts the payload of a custom section in a WebAssembly binary.
 */
export function parseCustomSection(wasmBuf, targetName) {
  try {
    let idx = 8; // Skip WebAssembly Magic Header (4 bytes) and Version (4 bytes)
    
    while (idx < wasmBuf.length) {
      if (idx >= wasmBuf.length) break;
      const sectionId = wasmBuf[idx];
      idx++;

      // Read section content length (Varuint32)
      let len = 0;
      let shift = 0;
      while (true) {
        const byte = wasmBuf[idx];
        idx++;
        len |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }

      const sectionEnd = idx + len;

      if (sectionId === 0) { // Custom section ID is 0
        // Read custom section name length (Varuint32)
        let nameLen = 0;
        let nameShift = 0;
        while (true) {
          const byte = wasmBuf[idx];
          idx++;
          nameLen |= (byte & 0x7F) << nameShift;
          if ((byte & 0x80) === 0) break;
          nameShift += 7;
        }

        const name = wasmBuf.subarray(idx, idx + nameLen).toString('utf8');
        idx += nameLen;

        if (name === targetName) {
          const payloadLen = sectionEnd - idx;
          return wasmBuf.subarray(idx, idx + payloadLen);
        }
      }

      idx = sectionEnd;
    }
  } catch (err) {
    console.error('❌ Error parsing WebAssembly custom sections:', err.message);
  }
  return null;
}

/**
 * Like parseCustomSection, but returns the section's byte range too:
 *   { payload, sectionStart }  where sectionStart is the index of the section-id byte.
 * Used by verification to reconstruct the exact prefix that was signed (everything
 * before the trailing signature section = real code bytes + the pathway manifest).
 */
export function findCustomSectionRange(wasmBuf, targetName) {
  try {
    let idx = 8; // Skip magic (4) + version (4)
    while (idx < wasmBuf.length) {
      const sectionStart = idx;
      const sectionId = wasmBuf[idx];
      idx++;

      let len = 0, shift = 0;
      while (true) {
        const byte = wasmBuf[idx]; idx++;
        len |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      const sectionEnd = idx + len;

      if (sectionId === 0) {
        let nameLen = 0, nameShift = 0;
        while (true) {
          const byte = wasmBuf[idx]; idx++;
          nameLen |= (byte & 0x7F) << nameShift;
          if ((byte & 0x80) === 0) break;
          nameShift += 7;
        }
        const name = wasmBuf.subarray(idx, idx + nameLen).toString('utf8');
        idx += nameLen;
        if (name === targetName) {
          return { payload: wasmBuf.subarray(idx, sectionEnd), sectionStart };
        }
      }
      idx = sectionEnd;
    }
  } catch (err) {
    console.error('❌ Error scanning WebAssembly custom section range:', err.message);
  }
  return null;
}

/**
 * GsiCompiler handles overnight trace evaluation, WebAssembly translation,
 * and post-quantum cryptographic sealing of decentralized skills.
 */
export class GsiCompiler {
  constructor(options = {}) {
    this.distSkillsDir = options.distSkillsDir || '../atmos-core/dist/skills';
    this.cronSchedule = options.cronSchedule || '0 2 * * *'; // Default 2:00 AM Night Shift
    this.cronJob = null;
    this.verbose = options.verbose !== false;
    this.analyzer = new TraceAnalyzer({ verbose: this.verbose });

    // Ensure output distribution directory exists
    if (!fs.existsSync(this.distSkillsDir)) {
      fs.mkdirSync(this.distSkillsDir, { recursive: true });
    }
  }

  // ---- skill registry (dedupe + provenance) -------------------------------
  _registryPath() { return path.join(this.distSkillsDir, 'registry.json'); }
  _safeName(id) { return String(id).replace(/[^a-zA-Z0-9_.-]/g, '_'); }
  _loadRegistry() {
    try { return JSON.parse(fs.readFileSync(this._registryPath(), 'utf8')); }
    catch { return {}; }
  }
  _saveRegistry(reg) {
    fs.writeFileSync(this._registryPath(), JSON.stringify(reg, null, 2));
  }

  /**
   * Initializes the Cron Scheduler to trigger overnight compilation runs.
   */
  startNightShift(privateKeyBundle) {
    if (this.cronJob) return;

    console.log(`🌙 [GsiCompiler] Night Shift cron scheduler initialized (Schedule: "${this.cronSchedule}").`);
    
    this.cronJob = cron.schedule(this.cronSchedule, async () => {
      console.log('🌙 [GsiCompiler] Night Shift triggered! Initiating autonomous compilation...');
      try {
        await this.compileFromDatabase(privateKeyBundle);
      } catch (err) {
        console.error('❌ Night Shift compilation error:', err.message);
      }
    });
  }

  /**
   * Stops the running Night Shift cron job.
   */
  stopNightShift() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log('☀️ [GsiCompiler] Night Shift scheduler stopped.');
    }
  }

  /**
   * Evaluates the LanceDB cognitive_skills store, filtering for successful state transitions,
   * compiles them to signed .wasm modules, and outputs them to the mesh distribution.
   */
  async compileFromDatabase(privateKeyBundle, opts = {}) {
    if (this.verbose) console.log('🕵️ [GsiCompiler] Night Shift: harvesting LanceDB cognitive_skills...');
    const db = await getDatabase();
    const tableNames = await db.tableNames();
    if (!tableNames.includes('cognitive_skills')) {
      console.log('⚠️  No cognitive_skills table found. Aborting compiler run.');
      return { compiled: [], skipped: [], failed: [], registry: this._loadRegistry() };
    }

    const table = await db.openTable('cognitive_skills');
    const records = await table.query().where('success_rate = 1.0').toArray();
    if (this.verbose) console.log(`🕵️ [GsiCompiler] Found ${records.length} verified-success pathways.`);

    // 1. Distill raw traces -> classified, content-addressed skill descriptors.
    const descriptors = this.analyzer.distill(records);

    // 2. Dedupe against the registry: only (re)compile new or changed skills.
    const registry = this._loadRegistry();
    const compiled = [], skipped = [], failed = [];

    for (const d of descriptors) {
      try {
        const prev = registry[d.id];
        if (prev && prev.hash === d.contentHash && !opts.force) {
          skipped.push({ id: d.id, kind: d.kind, reason: 'unchanged' });
          continue;
        }

        // 3. Compile to signed wasm. Computational -> real executing `compute`;
        //    automation -> signed replayable manifest + integrity `compute`.
        //    The descriptor's clean manifest becomes the signed pathway section.
        const wasmModule = await this.compile(d.manifest, privateKeyBundle);

        // 4. Deterministic filename (overwrites the prior build of the same skill).
        const fileName = `skill_${this._safeName(d.id)}.wasm`;
        const filePath = path.join(this.distSkillsDir, fileName);
        fs.writeFileSync(filePath, wasmModule);

        registry[d.id] = {
          hash: d.contentHash,
          kind: d.kind,
          file: fileName,
          bytes: wasmModule.length,
          quality: d.qualityScore,
          compiledAt: new Date().toISOString()
        };
        compiled.push({ id: d.id, kind: d.kind, file: filePath, bytes: wasmModule.length });
        if (this.verbose) console.log(`✅ [GsiCompiler] Sealed ${d.kind} skill "${d.id}" -> ${fileName} (${wasmModule.length}B)`);
      } catch (err) {
        failed.push({ id: d.id, error: err.message });
        console.error(`❌ Failed to compile skill "${d.id}":`, err.message);
      }
    }

    // 5. Persist the registry so the next night shift can dedupe.
    this._saveRegistry(registry);
    if (this.verbose) {
      console.log(`🌙 [GsiCompiler] Night Shift complete: ${compiled.length} compiled, ${skipped.length} unchanged, ${failed.length} failed.`);
    }
    return { compiled, skipped, failed, registry };
  }

  /**
   * Compiles an abstract logic graph and AST pathways into a signed .wasm module buffer.
   * Fuses post-quantum signature directly into the WebAssembly custom binary section.
   */
  async compile(astGraph, privateKeyBundle) {
    // Serialize the pathway, build the real executable module, then sign the WHOLE
    // module (code bytes + manifest) — see _generateWasmBinary for the integrity model.
    const pathwayPayload = JSON.stringify(astGraph);
    return this._generateWasmBinary(pathwayPayload, privateKeyBundle, astGraph.computation);
  }

  /**
   * Constructs a valid WebAssembly module containing embedded custom sections for:
   *   - "stratos.gsi.pathway" -> contains the serialized logic graph JSON.
   *   - "stratos.gsi.signature" -> contains the hybrid signature bundle JSON.
   */
  async _generateWasmBinary(pathwayPayload, privateKeyBundle, computation) {
    // 1. Compile a REAL executable module (with a working `compute` export) from WAT.
    const wabt = await getWabt();
    const wat = watForComputation(computation, Buffer.byteLength(pathwayPayload, 'utf8'));
    const parsed = wabt.parseWat('skill.wat', wat);
    const baseWasm = Buffer.from(parsed.toBinary({}).buffer); // magic+version+type+func+mem+export+code
    if (parsed.destroy) parsed.destroy();

    // 2. Append the pathway manifest as a custom section.
    const pathwaySec = this._createCustomSection('stratos.gsi.pathway', Buffer.from(pathwayPayload, 'utf8'));

    // 3. Sign the ENTIRE module-so-far — executable code bytes AND the manifest. This
    //    closes the prior integrity gap: an attacker can no longer swap the compiled
    //    `compute` logic while keeping a valid manifest signature. Any byte change to
    //    code or manifest invalidates the seal.
    const signedRegion = Buffer.concat([baseWasm, pathwaySec]);
    const signatureBundle = signPayload(signedRegion, privateKeyBundle);

    // 4. Append the signature as the FINAL custom section, so verification can
    //    reconstruct the signed prefix as everything before it.
    const sigPayload = JSON.stringify({
      ed25519Sig: signatureBundle.ed25519Sig.toString('base64'),
      mldsaSig: signatureBundle.mldsaSig.toString('base64')
    });
    const signatureSec = this._createCustomSection('stratos.gsi.signature', Buffer.from(sigPayload, 'utf8'));

    return Buffer.concat([signedRegion, signatureSec]);
  }

  /**
   * Encodes a standard WebAssembly Custom Section (ID 0).
   */
  _createCustomSection(name, payloadBuf) {
    const sectionId = Buffer.from([0x00]);
    const nameBuf = Buffer.from(name, 'utf8');
    const nameLenBuf = encodeVaruint32(nameBuf.length);

    // Total content: name length bytes + name bytes + payload bytes
    const contentLength = nameLenBuf.length + nameBuf.length + payloadBuf.length;
    const contentLenBuf = encodeVaruint32(contentLength);

    return Buffer.concat([
      sectionId,
      contentLenBuf,
      nameLenBuf,
      nameBuf,
      payloadBuf
    ]);
  }

  /**
   * Verifies the cryptographic authenticity and integrity of a WebAssembly skill binary.
   * Extracts the pathway and signature from custom sections and mathematically checks them.
   */
  static verifyWasmSkill(wasmBinary, publicKeyBundle) {
    try {
      // 1. The manifest must be present (it is part of what was signed).
      if (!parseCustomSection(wasmBinary, 'stratos.gsi.pathway')) {
        console.warn('⚠️  WebAssembly is missing "stratos.gsi.pathway" custom section.');
        return false;
      }

      // 2. Locate the trailing signature section (and where it starts).
      const sigRange = findCustomSectionRange(wasmBinary, 'stratos.gsi.signature');
      if (!sigRange) {
        console.warn('⚠️  WebAssembly is missing "stratos.gsi.signature" custom section.');
        return false;
      }

      // 3. Reconstruct the EXACT bytes that were signed: the whole module up to (not
      //    including) the signature section = executable code + the pathway manifest.
      const signedRegion = wasmBinary.subarray(0, sigRange.sectionStart);

      const sigData = JSON.parse(sigRange.payload.toString('utf8'));
      const signatureBundle = {
        ed25519Sig: Buffer.from(sigData.ed25519Sig, 'base64'),
        mldsaSig: Buffer.from(sigData.mldsaSig, 'base64')
      };

      // 4. Verify the hybrid seal over the full code+manifest region (ML-DSA-65 + Ed25519).
      return verifyPayload(signedRegion, signatureBundle, publicKeyBundle);
    } catch (err) {
      console.error('❌ Critical verification failure for WASM skill:', err.message);
      return false;
    }
  }
}
