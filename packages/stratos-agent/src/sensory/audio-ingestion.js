import { hear } from './voice-engine.js';

/**
 * AudioIngestionEngine: local Speech-to-Text (STT).
 *
 * REAL transcription via the shared voice-engine: primary path is the local multimodal model
 * (gemma-class) through Ollama's OpenAI-compatible audio endpoint; optional whisper.cpp fallback if a
 * binary is configured. NO cloud. NO mock: if no local STT path works we throw an honest error rather
 * than return a fabricated transcript.
 */
export class AudioIngestionEngine {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.model = options.model;
    this.ollamaHost = options.ollamaHost;
  }

  /**
   * Transcribes an audio file (wav/ogg/…) into text. Throws on honest degrade (no local STT).
   * @returns {Promise<string>} the transcript.
   */
  async transcribeSpeech(audioPath) {
    const res = await hear(audioPath, { verbose: this.verbose, model: this.model, ollamaHost: this.ollamaHost });
    if (!res.ok) {
      if (this.verbose) console.warn(`⚠️ [AudioIngestionEngine] STT unavailable — ${res.reason}`);
      throw new Error(`local STT unavailable: ${res.reason}`);
    }
    if (this.verbose) console.log(`📡 [AudioIngestionEngine] STT (${res.engine}): "${res.text}"`);
    return res.text;
  }
}
