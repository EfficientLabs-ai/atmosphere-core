import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { gatewayAuthHeaders } from './gateway-auth.js';
import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';

// F4 — escape dynamic text before embedding it in a Telegram parse_mode:'HTML' message,
// so stray <, >, & in error messages / model output can't break entity parsing or inject markup.
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Import the dispatcher from its OWN module, NOT the stratos-agent barrel (index.js) — the barrel
// re-exports BrowserHarness/GsiScheduler/P2pSkillSync, which would drag playwright + node-cron + the
// hyperswarm mesh into the standalone agent's load graph. Enforced by test-standalone-graph.mjs.
import { UnifiedDispatcher } from '../../stratos-agent/src/ingestion/unified-dispatcher.js';
import { getAgentName, capabilitiesSummary } from '../../stratos-agent/src/core/identity.js';
import * as chatHistory from './chat-history.js';
import { scanForSecrets, SECRET_REFUSAL } from './secret-guard.js';
import { handleConfigIntent } from './config-intents.js';
import { LocalInferenceEngine } from './local-inference.js';
import { persistentTyping, streamOllamaChat, streamToTelegram } from './telegram-streamer.js';
import { MODEL_NUM_CTX } from './memory-manager.js';

// The conversational Telegram agent runs on the MOST-CAPABLE local model (gemma4:e4b by default),
// over the fast gemma2:2b used elsewhere — the operator wants quality for chat. Configurable via env.
// On this CPU-only host this model is genuinely slow (minutes for long answers); the persistent typing
// indicator + token-by-token streaming below make that wait tolerable. Routing to a GPU mesh node for
// speed is a separate, future concern.
const TELEGRAM_MODEL = process.env.TELEGRAM_MODEL || 'gemma4:e4b';

/**
 * Telegram Bot Bridge: Interfaces user phone commands
 * directly with the Atmos Local Inference & LanceDB RAG completions core
 * using StratosAgent's refined UnifiedDispatcher.
 */
export class TelegramBridge {
  constructor(options = {}) {
    this.port = options.port || process.env.PORT || 4000;
    this.token = options.token || process.env.TELEGRAM_BOT_TOKEN || null;
    this.bot = null;
    this.verbose = options.verbose !== false;
    this.dispatcher = new UnifiedDispatcher({ verbose: this.verbose });
    // Local inference engine reused for its RAG retrieval + identity/memory/user-model prompt
    // compilation, so the STREAMED Telegram path keeps the SAME augmented prompt the gateway builds.
    this.inference = new LocalInferenceEngine({ verbose: this.verbose });
    this.ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    this.telegramModel = options.telegramModel || TELEGRAM_MODEL;

    // 1. Attempt dynamic retrieval from Secrets Vault if no token environment exists
    if (!this.token) {
      try {
        const vaultPath = path.join(process.cwd(), '.secrets-vault', 'env_blueprint.md');
        if (fs.existsSync(vaultPath)) {
          const content = fs.readFileSync(vaultPath, 'utf8');
          // Match standard table rows: | `TELEGRAM_BOT_TOKEN` | <TOKEN> |
          const match = content.match(/\|\s*`TELEGRAM_BOT_TOKEN`\s*\|\s*([^\s|]+)\s*\|/);
          if (match && match[1] && !match[1].startsWith('PASTE_')) {
            this.token = match[1];
            if (this.verbose) console.log('🔑 [Telegram Bridge] Securely retrieved TELEGRAM_BOT_TOKEN from Vault.');
          }
        }
      } catch (err) {
        if (this.verbose) console.warn('[Telegram Bridge] Vault load warning:', err.message);
      }
    }
  }

  /**
   * Best-effort list of locally-installed Ollama models (for honest "is this model ready?" reporting
   * in config-intents). Short timeout; returns [] on any failure rather than blocking the chat.
   */
  async probeInstalledModels() {
    try {
      const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
      const r = await fetch(`${host}/api/tags`, { timeout: 1500 });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.models) ? j.models.map((m) => m.name).filter(Boolean) : [];
    } catch { return []; }
  }

  /**
   * Initializes and starts the Telegram Bot polling daemon.
   */
  start() {
    if (!this.token) {
      console.warn('⚠️  [Telegram Bridge] No TELEGRAM_BOT_TOKEN configured. Polling client disabled (Dry-Run mode active).');
      return false;
    }

    try {
      console.log('📡 [Telegram Bridge] Initializing Node-Telegram-Bot-API polling client...');
      this.bot = new TelegramBot(this.token, { polling: true });

      // Register message listeners
      this.bot.on('message', async (msg) => {
        const chatId = msg.chat.id;

        // Handle voice triggers natively using dispatcher
        if (msg.voice) {
          await this.handleVoiceMessage(chatId, msg.voice);
          return;
        }

        // 🔒 SECRET GUARD — runs on the RAW inbound message BEFORE normalization, because the
        // dispatcher's normalizer verbose-logs the text. A key-shaped message is refused and
        // forwarded NOWHERE (never normalized, logged, persisted, or sent to the model).
        if (scanForSecrets(`${msg.text || ''} ${msg.caption || ''}`)) {
          await this.bot.sendMessage(chatId, SECRET_REFUSAL).catch(() => {});
          return;
        }

        // Normalize incoming requests using UnifiedDispatcher (safe now — no secret present)
        const normalized = this.dispatcher.normalizeIncomingRequest('telegram', msg);
        const text = normalized.text;

        if (!text) return;

        if (this.verbose) {
          console.log(`💬 [Telegram Chat] Received message from Chat ID: ${chatId} -> "${text.slice(0, 32)}..."`);
        }

        // Send a temporary typing indicator to satisfy sub-500ms UX responsive guidelines
        this.bot.sendChatAction(chatId, 'typing').catch(() => {});

        // Handle native /commands
        if (text.startsWith('/')) {
          const command = text.split(' ')[0].toLowerCase();
          try {
            if (command === '/start' || command === '/whoami') {
              const name = getAgentName();
              const caps = capabilitiesSummary(false).split('\n').map(c => '  ' + c).join('\n');
              const intro = `👋 Hello — I'm <b>${name}</b>, your sovereign, local-first AI agent (part of the Atmosphere by Efficient Labs).\n\nI run on your own hardware — private and offline-capable. Here's what I can genuinely do:\n\n${caps}\n\n🔒 I have <b>zero ambient authority</b>: I'm sandboxed by default and only use the permissions you granted at setup. I'll ask before acting outside them.\n\nJust send me a message to chat. Commands: /whoami · /status · /help`;
              await this.bot.sendMessage(chatId, intro, { parse_mode: 'HTML' });
              return;
            }

            if (command === '/forget') {
              chatHistory.clear(chatId);
              await this.bot.sendMessage(chatId, `🧹 Conversation memory for this chat has been wiped. I won't recall anything from before this point.`, { parse_mode: 'HTML' });
              return;
            }

            if (command === '/status') {
              const os = await import('node:os');
              const cpus = os.cpus();
              const loadAvg = os.loadavg ? os.loadavg()[0] : 0;
              const freeMemGB = (os.freemem() / (1024 ** 3)).toFixed(2);
              const totalMemGB = (os.totalmem() / (1024 ** 3)).toFixed(2);

              // REAL mesh node count, read from the origin's fleet.json if it exists — never fabricated.
              let meshLine = '<code>not joined from this bridge (run the mesh origin separately)</code>';
              for (const base of [process.cwd(), path.resolve(process.cwd(), '.stratos-profile')]) {
                try {
                  const f = JSON.parse(fs.readFileSync(path.join(base, 'fleet.json'), 'utf8'));
                  if (f?.totals?.nodes != null) { meshLine = `<code>${f.totals.nodes} node(s), ${f.totals.cores} cores (self-reported)</code>`; break; }
                } catch { /* no fleet file */ }
              }
              const statusReply = `📡 <b>${getAgentName()} — status</b>:
• <b>Gateway:</b> <code>127.0.0.1:${this.port}</code> (local)
• <b>Local model (chat):</b> <code>${escapeHtml(this.telegramModel)} via Ollama</code>
• <b>Mesh:</b> ${meshLine}
• <b>This host:</b> <code>${cpus.length} cores, ${(loadAvg).toFixed(2)} load, ${freeMemGB}/${totalMemGB} GB free</code>
• <b>Crypto:</b> <code>X25519+ML-KEM-768 / Ed25519+ML-DSA-65 (real)</code>`;
              await this.bot.sendMessage(chatId, statusReply, { parse_mode: 'HTML' });
              return;
            }

            if (command === '/vision') {
              // HONEST: this bridge cannot see your screen, and there is no live screen-capture VLM
              // wired to Telegram — the previous behavior fabricated a screen "analysis". Real, local
              // vision works per-image via gemma (STRATOS_SENSORY_MODEL, e.g. gemma4:e4b): send a photo,
              // or run `stratos voice see <image>` on the host. We won't invent what's on your screen.
              const visionReply = `👁️ <b>Vision — no live screen capture</b>\n\nI can't see your screen from this chat, and I won't make one up. Local, sovereign image vision (gemma via Ollama) is real and works per-image: <b>send me a photo</b> and I'll describe it, or run <code>stratos voice see &lt;image&gt;</code> on the host.`;
              await this.bot.sendMessage(chatId, visionReply, { parse_mode: 'HTML' });
              return;
            }

            if (command === '/balance') {
              // HONEST: there is no live wallet or on-chain settlement. The x402 logic is
              // off-chain accounting only. Never fabricate a balance.
              const balanceReply = `💳 <b>Payments — not live</b>\n\nOn-chain payments and a wallet are <b>not connected</b>. The x402 engine implements off-chain micro-invoice accounting (state channels, PoW, rollup math) that's been stress-tested, but <b>no real funds move</b> and no token has launched. I won't show you a balance I can't back.`;
              await this.bot.sendMessage(chatId, balanceReply, { parse_mode: 'HTML' });
              return;
            }

            if (command === '/compile') {
              // HONEST: don't print a fabricated compiled-skill result. Describe what the real
              // night-shift GSI compiler does and that it's opt-in.
              const compileReply = `⚙️ <b>Skill compiler (night-shift GSI)</b>\n\nWhen enabled, I harvest successful task traces, induce a deterministic spec, compile it to WebAssembly, and PQC-seal it (ML-DSA-65 + Ed25519) so it can run verified in the sandbox or be shared on the mesh.\n\nThis runs on a schedule (opt-in via <code>STRATOS_EVOLUTION</code>); I won't claim a compile that didn't happen. Currently it learns one class of skill (deterministic numeric transforms).`;
              await this.bot.sendMessage(chatId, compileReply, { parse_mode: 'HTML' });
              return;
            }
          } catch (cmdErr) {
            console.error(`❌ [Telegram Bridge] Error executing command ${command}:`, cmdErr.message);
            await this.bot.sendMessage(chatId, `⚠️  <b>Command Error</b>: <code>${escapeHtml(cmdErr.message)}</code>`, { parse_mode: 'HTML' });
            return;
          }
        }

        // Owner-gated setup shortcuts (deterministic). Falls through to normal chat if not a config
        // intent. Privileged grants / cloud-provider switches / API keys are explained, never applied.
        try {
          const isDM = !!(msg.chat && msg.chat.type === 'private');
          const installedModels = await this.probeInstalledModels();
          const intent = handleConfigIntent({ text, chatId, isDM, installedModels });
          if (intent.handled) {
            await this.sendFormattedMessage(chatId, intent.reply);
            return;
          }
        } catch (cfgErr) {
          if (this.verbose) console.warn('[Telegram Bridge] config-intent skipped:', cfgErr.message);
        }

        try {
          // Per-chat memory: record the user turn (FTS5/user-model hooks fire inside appendUser).
          chatHistory.appendUser(chatId, text);
          // Stream the reply token-by-token with a persistent "typing…" indicator the whole time.
          const aiResponseText = await this.streamReply(chatId, text);
          chatHistory.appendAssistant(chatId, aiResponseText); // remember the reply too
        } catch (err) {
          console.error('❌ [Telegram Bridge] Completions processing error:', err.message);
          await this.bot.sendMessage(chatId, `⚠️  <b>Local Processing Error</b>: <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' }).catch(() => {
            this.bot.sendMessage(chatId, `⚠️  Local Processing Error: ${err.message}`);
          });
        }
      });

      console.log('✅ [Telegram Bridge] Polling daemon successfully started. Listening for user chat triggers.');
      return true;
    } catch (err) {
      console.error('❌ [Telegram Bridge] Initialization error:', err.message);
      return false;
    }
  }

  /**
   * Processes incoming voice message payloads natively using UnifiedDispatcher formatting
   */
  async handleVoiceMessage(chatId, voicePayload) {
    if (this.verbose) {
      console.log(`🎙️ [Telegram Voice] Intercepted voice payload. File ID: ${voicePayload.file_id}`);
    }

    // Set typing / record_voice indicator for responsive UX
    this.bot.sendChatAction(chatId, 'record_voice').catch(() => {});

    try {
      const tempDir = path.join(process.cwd(), '.secrets-vault', 'temp_audio');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // 1. Download inbound voice .ogg file securely
      const oggPath = await this.bot.downloadFile(voicePayload.file_id, tempDir);
      if (this.verbose) {
        console.log(`💾 [Telegram Voice] Audio downloaded securely: ${oggPath}`);
      }

      // 2. Transcode .ogg/.oga to 16kHz mono .wav for Whisper.
      // Telegram delivers voice notes as ".oga" (OGG audio), so a strict /\.ogg$/
      // replace left input === output and ffmpeg refused to edit in-place.
      let wavPath = oggPath.replace(/\.[a-z0-9]+$/i, '.wav');
      if (wavPath === oggPath) wavPath = `${oggPath}.wav`;
      await new Promise((resolve) => {
        execFile('ffmpeg', ['-y', '-i', oggPath, '-ac', '1', '-ar', '16000', wavPath], (err) => {
          if (err) {
            if (this.verbose) console.warn('⚠️ [Telegram Voice] ffmpeg transcoding failed (using fallback wav):', err.message);
            const mockWavHeader = Buffer.alloc(44);
            mockWavHeader.write('RIFF', 0);
            mockWavHeader.write('WAVE', 8);
            fs.writeFileSync(wavPath, mockWavHeader);
          }
          resolve();
        });
      });

      // 3. Transcribe speech using the LOCAL sensory engine (gemma-class audio via Ollama, with an
      //    optional whisper.cpp fallback). FAIL-OPEN: if no local STT path works we never throw into
      //    the message path — we tell the user plainly and stop (no fabricated transcript).
      const { AudioIngestionEngine } = await import('../../stratos-agent/src/sensory/audio-ingestion.js');
      const ingestion = new AudioIngestionEngine({ verbose: this.verbose });
      let transcribedText;
      try {
        transcribedText = await ingestion.transcribeSpeech(wavPath);
      } catch (sttErr) {
        if (this.verbose) console.warn('⚠️ [Telegram Voice] STT degrade (fail-open):', sttErr.message);
        await this.bot.sendMessage(chatId, "🎙️ I couldn't transcribe that voice note locally right now — please send it as text and I'll respond.").catch(() => {});
        return;
      }

      // 🔒 SECRET GUARD on the transcript too — refuse before logging/persisting/inferring.
      if (scanForSecrets(transcribedText)) {
        await this.bot.sendMessage(chatId, SECRET_REFUSAL).catch(() => {});
        return;
      }

      if (this.verbose) {
        console.log(`🎙️ [Telegram Voice] Transcribed text: "${transcribedText}"`);
      }

      // 4. Feed transcribed text into completions WITH the running conversation (same memory as text).
      chatHistory.appendUser(chatId, transcribedText);
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...gatewayAuthHeaders() },
        body: JSON.stringify({
          model: this.telegramModel,
          messages: chatHistory.getMessages(chatId),
          conversationId: chatHistory.conversationId(chatId),
          stream: false
        })
      });

      if (!response.ok) {
        throw new Error(`Inference returned status code: ${response.status}`);
      }

      const data = await response.json();
      const aiResponseText = data.choices[0].message.content;
      chatHistory.appendAssistant(chatId, aiResponseText);

      // 5. Clean thoughts and formatting elements for TTS voice synthesizing
      const cleanVoiceText = this.dispatcher.cleanTextForVoice(aiResponseText);

      // 6. Convert response to spoken .wav output via the local Piper TTS engine.
      //    FAIL-OPEN: if Piper is unavailable (returns null), send the answer as TEXT instead of a
      //    voice note — the user always gets the reply.
      const { AudioSynthesisEngine } = await import('../../stratos-agent/src/sensory/audio-synthesis.js');
      const synthesis = new AudioSynthesisEngine({ verbose: this.verbose });
      const replyWavPath = path.join(tempDir, `reply_${Date.now()}.wav`);
      const synthOk = await synthesis.speakToBuffer(cleanVoiceText, replyWavPath);

      if (!synthOk) {
        if (this.verbose) console.warn('⚠️ [Telegram Voice] TTS unavailable — replying with text (fail-open).');
        await this.sendFormattedMessage(chatId, aiResponseText);
        return;
      }

      // 7. Transcode WAV response into Opus-encoded OGG for Telegram bot
      const replyOggPath = replyWavPath.replace(/\.wav$/, '.ogg');
      await new Promise((resolve) => {
        execFile('ffmpeg', ['-y', '-i', replyWavPath, '-c:a', 'libopus', replyOggPath], (err) => {
          if (err) {
            if (this.verbose) console.warn('⚠️ [Telegram Voice] ffmpeg output transcoding failed, falling back:', err.message);
            fs.copyFileSync(replyWavPath, replyOggPath);
          }
          resolve();
        });
      });

      // 8. Send the synthesized voice note back to the user. If even that fails, fall back to text.
      await this.bot.sendVoice(chatId, replyOggPath).catch(async (sendErr) => {
        if (this.verbose) console.warn('⚠️ [Telegram Voice] sendVoice failed, replying with text:', sendErr.message);
        await this.sendFormattedMessage(chatId, aiResponseText);
      });

      // Clean up temporary voice files safely
      setTimeout(() => {
        try {
          if (fs.existsSync(oggPath)) fs.unlinkSync(oggPath);
          if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
          if (fs.existsSync(replyWavPath)) fs.unlinkSync(replyWavPath);
          if (fs.existsSync(replyOggPath)) fs.unlinkSync(replyOggPath);
        } catch (cleanupErr) {
          // Silent catch
        }
      }, 5000);

    } catch (err) {
      console.error('❌ [Telegram Voice] Processing error:', err.message);
      await this.bot.sendMessage(chatId, `⚠️  <b>Voice Processing Error</b>: <code>${escapeHtml(err.message)}</code>`, { parse_mode: 'HTML' }).catch(() => {
        this.bot.sendMessage(chatId, `⚠️  Voice Processing Error: ${err.message}`);
      });
    }
  }

  /**
   * The ALIVE chat path: persistent "typing…" + token-by-token typewriter streaming on gemma4:e4b.
   *
   * Builds the SAME augmented prompt the gateway would (RAG + identity + memory window + per-conversation
   * user-model), then streams Ollama's /api/chat directly so progress is visible during the multi-minute
   * CPU generation. Fail-safe in layers (a reply is NEVER lost):
   *   • typing indicator is cleared on every exit (finish AND throw) — no leaked intervals.
   *   • streaming/edit failures fall back to a single full sendMessage inside streamToTelegram().
   *   • if Ollama streaming itself can't start, we fall back to the existing non-streaming gateway call
   *     (still under the persistent typing indicator) and send one formatted message.
   * Returns the full assistant text (for chat-history persistence).
   */
  async streamReply(chatId, userText) {
    const stopTyping = persistentTyping(this.bot, chatId);
    try {
      // Build the augmented prompt envelope (RAG + identity + Tier-0 windowed memory + user-model).
      const conversationId = chatHistory.conversationId(chatId);
      const messages = chatHistory.getMessages(chatId);
      let augmented = messages;
      try {
        const ragContext = await this.inference.retrieveRagContext(userText, 2, conversationId);
        augmented = this.inference.compileAugmentedPrompt(messages, ragContext, '', conversationId);
      } catch (compErr) {
        if (this.verbose) console.warn('[Telegram Bridge] prompt compile degraded (raw history):', compErr.message);
      }

      // Token stream from Ollama on the configured chat model.
      const tokenStream = streamOllamaChat({
        fetchImpl: fetch,
        ollamaHost: this.ollamaHost,
        model: this.telegramModel,
        messages: augmented,
        options: { num_ctx: MODEL_NUM_CTX },
      });

      const result = await streamToTelegram({
        bot: this.bot,
        chatId,
        tokenStream,
        formatFinal: (s) => this.dispatcher.formatResponseHTML(s),
        parseModeOpts: { parse_mode: 'HTML' },
      });

      // If streaming produced no text at all, fall back to the non-streaming gateway path so the
      // user still gets an answer (e.g. Ollama up but model not pulled → empty/early stream).
      if (!result.text || !result.text.trim()) {
        const full = await this._gatewayFullReply(chatId, conversationId);
        await this.sendFormattedMessage(chatId, full);
        return full;
      }
      return result.text;
    } catch (streamErr) {
      // Ollama streaming unusable → FAIL-SAFE: non-streaming gateway reply, still under typing.
      if (this.verbose) console.warn('[Telegram Bridge] stream path failed, falling back to full reply:', streamErr.message);
      const full = await this._gatewayFullReply(chatId, chatHistory.conversationId(chatId));
      await this.sendFormattedMessage(chatId, full);
      return full;
    } finally {
      stopTyping(); // ALWAYS clear the typing indicator — no leaked intervals.
    }
  }

  /** Non-streaming fallback: the original gateway /v1/chat/completions call (returns the text). */
  async _gatewayFullReply(chatId, conversationId) {
    const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...gatewayAuthHeaders() },
      body: JSON.stringify({
        model: this.telegramModel,
        messages: chatHistory.getMessages(chatId),
        conversationId,
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`Completions request failed with status: ${response.status}`);
    const data = await response.json();
    return data.choices[0].message.content;
  }

  /**
   * Leverages the refined UnifiedDispatcher HTML formatter.
   */
  async sendFormattedMessage(chatId, aiResponseText) {
    const formattedText = this.dispatcher.formatResponseHTML(aiResponseText);
    try {
      await this.bot.sendMessage(chatId, formattedText, { parse_mode: 'HTML' });
    } catch (sendErr) {
      if (this.verbose) console.warn('⚠️  [Telegram Bridge] HTML parse failed, retrying in Plaintext:', sendErr.message);
      await this.bot.sendMessage(chatId, aiResponseText);
    }
  }

  /**
   * Stops the active Telegram polling bot.
   */
  stop() {
    if (this.bot) {
      this.bot.stopPolling();
      this.bot = null;
      console.log('💤 [Telegram Bridge] Polling daemon stopped.');
    }
  }
}
