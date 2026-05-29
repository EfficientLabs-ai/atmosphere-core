import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { getDatabase, queryCognitiveSkill } from './src/memory/vector-bank.js';
import { signPayload, verifyPayload } from './src/security/quantum-crypto.js';

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
 * GsiCompiler handles overnight trace evaluation, WebAssembly translation,
 * and post-quantum cryptographic sealing of decentralized skills.
 */
export class GsiCompiler {
  constructor(options = {}) {
    this.distSkillsDir = options.distSkillsDir || '../atmos-core/dist/skills';
    this.cronSchedule = options.cronSchedule || '0 2 * * *'; // Default 2:00 AM Night Shift
    this.cronJob = null;

    // Ensure output distribution directory exists
    if (!fs.existsSync(this.distSkillsDir)) {
      fs.mkdirSync(this.distSkillsDir, { recursive: true });
    }
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
  async compileFromDatabase(privateKeyBundle) {
    console.log('🕵️ [GsiCompiler] Evaluator: Accessing LanceDB memory banks...');
    const db = await getDatabase();
    const tableNames = await db.tableNames();
    if (!tableNames.includes('cognitive_skills')) {
      console.log('⚠️  No cognitive_skills table found. Aborting compiler run.');
      return [];
    }

    const table = await db.openTable('cognitive_skills');
    
    // Select all successful pathways (success_rate == 1.0)
    // In LanceDB, we can perform standard SQL-like filtering on records
    const records = await table.query().where('success_rate = 1.0').toArray();
    console.log(`🕵️ [GsiCompiler] Evaluator: Found ${records.length} successful pathways ready for compile.`);

    const compiledFiles = [];

    for (const record of records) {
      try {
        const skillId = record.skill_id;
        const trigger = record.trigger_intent;
        const astGraph = JSON.parse(record.ast_graph);

        console.log(`⚙️ [GsiCompiler] Transformer: Serializing skill "${skillId}" (${trigger})...`);

        // Compile and sign the workflow pathway
        const wasmModule = await this.compile(astGraph, privateKeyBundle);

        // Write the signed .wasm module into the public mesh skills directory
        const fileName = `skill_${skillId}_${Date.now()}.wasm`;
        const filePath = path.join(this.distSkillsDir, fileName);
        fs.writeFileSync(filePath, wasmModule);

        console.log(`✅ [GsiCompiler] PQC Sealed: Saved skill to ${filePath}`);
        compiledFiles.push(filePath);
      } catch (err) {
        console.error(`❌ Failed to compile skill record:`, err.message);
      }
    }

    return compiledFiles;
  }

  /**
   * Compiles an abstract logic graph and AST pathways into a signed .wasm module buffer.
   * Fuses post-quantum signature directly into the WebAssembly custom binary section.
   */
  async compile(astGraph, privateKeyBundle) {
    // 1. Serialize the pathway to JSON
    const pathwayPayload = JSON.stringify(astGraph);

    // 2. Generate hybrid signatures (classical Ed25519 + post-quantum FIPS 204 ML-DSA-65)
    const signatureBundle = signPayload(pathwayPayload, privateKeyBundle);

    // 3. Construct the WebAssembly binary including custom data sections
    const wasmBinary = this._generateWasmBinary(pathwayPayload, signatureBundle);

    return wasmBinary;
  }

  /**
   * Constructs a valid WebAssembly module containing embedded custom sections for:
   *   - "stratos.gsi.pathway" -> contains the serialized logic graph JSON.
   *   - "stratos.gsi.signature" -> contains the hybrid signature bundle JSON.
   */
  _generateWasmBinary(pathwayPayload, signatureBundle) {
    const magicHeader = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
    const versionHeader = Buffer.from([0x01, 0x00, 0x00, 0x00]);

    // Section 1: Custom section for the AST pathway
    const pathwaySec = this._createCustomSection('stratos.gsi.pathway', Buffer.from(pathwayPayload, 'utf8'));

    // Section 2: Custom section for the Cryptographic Signature Seal
    const sigPayload = JSON.stringify({
      ed25519Sig: signatureBundle.ed25519Sig.toString('base64'),
      mldsaSig: signatureBundle.mldsaSig.toString('base64')
    });
    const signatureSec = this._createCustomSection('stratos.gsi.signature', Buffer.from(sigPayload, 'utf8'));

    return Buffer.concat([
      magicHeader,
      versionHeader,
      pathwaySec,
      signatureSec
    ]);
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
      // 1. Extract the custom pathway section
      const pathwayBytes = parseCustomSection(wasmBinary, 'stratos.gsi.pathway');
      if (!pathwayBytes) {
        console.warn('⚠️  WebAssembly is missing "stratos.gsi.pathway" custom section.');
        return false;
      }

      // 2. Extract the custom signature section
      const signatureBytes = parseCustomSection(wasmBinary, 'stratos.gsi.signature');
      if (!signatureBytes) {
        console.warn('⚠️  WebAssembly is missing "stratos.gsi.signature" custom section.');
        return false;
      }

      // 3. Deserialize signature and payload
      const sigData = JSON.parse(signatureBytes.toString('utf8'));
      const signatureBundle = {
        ed25519Sig: Buffer.from(sigData.ed25519Sig, 'base64'),
        mldsaSig: Buffer.from(sigData.mldsaSig, 'base64')
      };

      const payloadString = pathwayBytes.toString('utf8');

      // 4. Mathematically verify payload signatures (ML-DSA-65 + Ed25519)
      return verifyPayload(payloadString, signatureBundle, publicKeyBundle);
    } catch (err) {
      console.error('❌ Critical verification failure for WASM skill:', err.message);
      return false;
    }
  }
}
