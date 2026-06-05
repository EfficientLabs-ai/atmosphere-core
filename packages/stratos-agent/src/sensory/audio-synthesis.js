import { say, cleanForSpeech } from './voice-engine.js';

/**
 * AudioSynthesisEngine: local Text-to-Speech (TTS).
 *
 * REAL synthesis via Piper (open-source, offline) through the shared voice-engine. No mock: if Piper
 * or its voice is missing we degrade HONESTLY (clear logged reason, no audio file) rather than write
 * a silent wav that pretends to be speech. execFile-based (no shell strings).
 */
export class AudioSynthesisEngine {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
  }

  stripThinkingTags(text) { return cleanForSpeech(text); }

  /**
   * Synthesizes text into a real WAV at outputPath via Piper.
   * @returns {Promise<string|null>} outputPath on success, or null on honest degrade.
   */
  async speakToBuffer(text, outputPath) {
    const res = await say(text, outputPath, { verbose: this.verbose });
    if (!res.ok) {
      if (this.verbose) console.warn(`⚠️ [AudioSynthesisEngine] TTS unavailable — ${res.reason} (no audio produced)`);
      return null;
    }
    if (this.verbose) console.log(`🔊 [AudioSynthesisEngine] Piper synthesis succeeded: ${res.path}`);
    return res.path;
  }
}
