import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';

/**
 * Telegram Bot Bridge: Interfaces user phone commands
 * directly with the Atmos Local Inference & LanceDB RAG completions core.
 */
export class TelegramBridge {
  constructor(options = {}) {
    this.port = options.port || process.env.PORT || 4000;
    this.token = options.token || process.env.TELEGRAM_BOT_TOKEN || null;
    this.bot = null;
    this.verbose = options.verbose !== false;

    // 1. Attempt dynamic retrieval from Secrets Vault
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

      // Register text listeners
      this.bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;

        if (!text) return;

        if (this.verbose) {
          console.log(`💬 [Telegram Chat] Received message from Chat ID: ${chatId} -> "${text.slice(0, 32)}..."`);
        }

        // Send a temporary typing indicator to satisfy sub-500ms UX responsive guidelines
        this.bot.sendChatAction(chatId, 'typing').catch(() => {});

        try {
          // Route inputs to local completions router featuring LanceDB deep-scan vector retriever
          const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'qwen-2.5-vlm-telegram-local',
              messages: [
                { role: 'user', content: text }
              ],
              stream: false
            })
          });

          if (!response.ok) {
            throw new Error(`Completions request failed with status: ${response.status}`);
          }

          const data = await response.json();
          const aiResponseText = data.choices[0].message.content;

          // Process and format Monaco-style thinking tags elegantly in Telegram HTML
          let formattedText = aiResponseText;
          if (formattedText.includes('<think>')) {
            formattedText = formattedText
              .replace('<think>', '🧠 *[Sovereign Thinking Process]*\n`')
              .replace('</think>', '`\n\n💬 *[Local Response]*\n');
          }

          // Reply back to Telegram
          await this.bot.sendMessage(chatId, formattedText, { parse_mode: 'Markdown' });

        } catch (err) {
          console.error('❌ [Telegram Bridge] Completions processing error:', err.message);
          this.bot.sendMessage(chatId, `⚠️  *Local Processing Error*: ${err.message}`, { parse_mode: 'Markdown' });
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
