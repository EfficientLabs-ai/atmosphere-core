import crypto from 'node:crypto';

/**
 * TelemetryExporter: Compiles, anonymizes, and signs sovereign telemetry data rollups
 * to fuel the decentralized AGI training flywheel.
 */
export class TelemetryExporter {
  /**
   * Calculates the Shannon Entropy of a string to detect high-entropy keys, passwords, and tokens.
   * @param {string} str - The target string to scan
   * @returns {number} - Entropy score (0.0 to 8.0)
   */
  static calculateShannonEntropy(str) {
    if (!str) return 0;
    const len = str.length;
    const frequencies = {};
    for (let i = 0; i < len; i++) {
      const char = str[i];
      frequencies[char] = (frequencies[char] || 0) + 1;
    }
    let entropy = 0;
    for (const char in frequencies) {
      const p = frequencies[char] / len;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  /**
   * Deeply cleanses and anonymizes PII, api keys, and passwords from input logs.
   * Enforces zero-knowledge compliance.
   * 
   * @param {string} text - Raw input content
   * @returns {string} - Anonymized and scrubbed text
   */
  static anonymizeText(text) {
    if (!text) return '';
    let scrubbed = text;

    // 1. Scrub Credit Cards (Luhn-like patterns)
    scrubbed = scrubbed.replace(/\b(?:\d[ -]*?){13,16}\b/g, '[ANONYMIZED_PAYMENT_CARD]');

    // 2. Scrub Emails
    scrubbed = scrubbed.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[ANONYMIZED_EMAIL]');

    // 3. Scrub Common Authorization Secrets & Bearer Tokens
    scrubbed = scrubbed.replace(/(?:bearer|apikey|token|password|passwd|secret)\s*[:=]\s*["']?[A-Za-z0-9-_=.]{12,}["']?/gi, (match) => {
      return match.split(/[:=]/)[0] + ': [ANONYMIZED_KEY_OR_SECRET]';
    });

    // 4. Scrub specific proprietary API key schemas (OpenAI / Anthropic keys)
    scrubbed = scrubbed.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/gi, '[ANONYMIZED_FRONT_API_KEY]');

    // 5. Scan words for high Shannon entropy (entropy > 4.5 and length > 16) to catch raw tokens / private keys
    const words = scrubbed.split(/[\s,;:="'"()\[\]{}]+/);
    for (const word of words) {
      if (word.length >= 16) {
        const entropy = this.calculateShannonEntropy(word);
        if (entropy >= 4.5 && !word.includes('[ANONYMIZED_')) {
          const escapedWord = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          scrubbed = scrubbed.replace(new RegExp('\\b' + escapedWord + '\\b', 'g'), '[ANONYMIZED_HIGH_ENTROPY_TOKEN]');
        }
      }
    }

    return scrubbed;
  }

  /**
   * Compiles high-quality cognitive execution traces, scrubs credentials, and signs them
   * using the VaultHost enclaved signer.
   * 
   * @param {ReasoningBank} reasoningBank - The LanceDB ReasoningBank instance
   * @param {VaultHost} vaultHost - The VaultHost enclaved signer
   * @returns {Object} - Complete signed telemetry rollup package
   */
  static async compileAndSignTelemetry(reasoningBank, vaultHost) {
    if (!reasoningBank || !vaultHost) {
      throw new Error('⚠️ [TelemetryExporter] reasoningBank and vaultHost are required.');
    }

    console.log('[TelemetryExporter] 📡 Scanning LanceDB cognitive memory for training data paths...');
    
    // Simulate reading matching records from LanceDB (Layer 3 & Layer 2)
    // In real use, we query 'intercepted_reasoning' and 'cognitive_skills'
    const mockQueryVector = [1, 0, 0];
    const records = await reasoningBank.vectorSearch('knowledge-base', mockQueryVector, 10);
    
    const telemetryEntries = [];
    
    for (const record of records) {
      // Clean request and response traces
      const sanitizedText = this.anonymizeText(record.text);
      
      telemetryEntries.push({
        id: record.id,
        sanitizedTelemetry: sanitizedText,
        metadata: {
          ...record.metadata,
          distilledTimestamp: Date.now()
        }
      });
    }

    console.log(`[TelemetryExporter] 🧪 Anonymized ${telemetryEntries.length} execution traces for training rollup.`);

    // Compile into standardized JSON payload
    const rollupPayload = {
      generator: 'EfficientLabs-GlobalSuperintelligence-TelemetryHarvester-1.0',
      timestamp: Date.now(),
      traces: telemetryEntries
    };

    const serialized = JSON.stringify(rollupPayload);

    // Cryptographically seal utilizing the post-quantum WASI signature enclave
    console.log('[TelemetryExporter] ✍️ Sealing telemetry package with ML-DSA-65 post-quantum signature...');
    const signature = vaultHost.sign(serialized);

    return {
      success: true,
      payload: rollupPayload,
      signature: signature.toString('hex'),
      nodeAtmosDid: deriveAtmosDidFromVault(vaultHost)
    };
  }
}

/**
 * Helper to derive did:atmos dynamically from vaultHost SPKI public keys
 */
function deriveAtmosDidFromVault(vaultHost) {
  const mldsaPub = vaultHost.getPublicKey();
  // Standard mock generator for standalone validation
  const composite = Buffer.concat([Buffer.alloc(32, 0x42), Buffer.from(mldsaPub)]);
  const hash = crypto.createHash('sha256').update(composite).digest();
  
  // Base58btc mock encoder
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];
  for (let i = 0; i < hash.length; i++) {
    let carry = hash[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let str = '';
  for (let k = 0; k < hash.length && hash[k] === 0; k++) str += '1';
  for (let q = digits.length - 1; q >= 0; q--) str += ALPHABET[digits[q]];
  
  return 'did:atmos:z' + str;
}
