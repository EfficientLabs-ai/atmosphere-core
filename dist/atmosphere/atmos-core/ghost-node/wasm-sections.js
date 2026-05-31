/**
 * wasm-sections.js — dependency-free WebAssembly custom-section parsing.
 *
 * Extracted from gsi-compiler.js so the lightweight verification path (e.g. a mesh peer
 * receiving and validating a signed skill block) can reuse the EXACT same section parsing
 * without dragging in wabt / node-cron / lancedb. The compiler re-exports these for
 * backward compatibility, so this is a pure refactor — identical bytes, identical behavior.
 */

/** Return the raw payload bytes of the named custom section, or null. */
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
