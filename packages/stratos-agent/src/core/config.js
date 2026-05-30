import fs from 'node:fs';
import path from 'node:path';

/**
 * ConfigParser: Advanced configuration and model-agnostic endpoint manager
 * that merges legacy OpenClaw/Hermes variables, maps model endpoint routing
 * (OpenAI, Anthropic, OpenRouter, Ollama), and registers multi-channel gateways.
 */
export class ConfigParser {
  constructor(options = {}) {
    this.env = {};
    this.verbose = options.verbose !== false;
    this.modelMap = new Map();
    this.initializeDefaultModelMap();
  }

  /**
   * Registers default model endpoints (Portal, OpenAI, Anthropic, Ollama local weights)
   */
  initializeDefaultModelMap() {
    this.modelMap.set('qwen2.5:7b', { provider: 'ollama', url: 'http://127.0.0.1:11434' });
    this.modelMap.set('gpt-4o', { provider: 'openai', url: 'https://api.openai.com/v1' });
    this.modelMap.set('claude-3-5-sonnet', { provider: 'anthropic', url: 'https://api.anthropic.com/v1' });
    this.modelMap.set('hermes-3-70b', { provider: 'openrouter', url: 'https://openrouter.ai/api/v1' });
  }

  /**
   * Parses raw .env file contents recursively and maps them to environment variables.
   */
  loadEnv(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        if (this.verbose) {
          console.log(`📡 [ConfigParser] Configuration file not found (skipping): ${filePath}`);
        }
        return false;
      }
      
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        const index = trimmed.indexOf('=');
        if (index === -1) continue;
        
        const key = trimmed.slice(0, index).trim();
        const val = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, ''); // strip quotes
        
        this.env[key] = val;
        process.env[key] = val; // Inject into active runtime environment
      }
      
      if (this.verbose) {
        console.log(`✅ [ConfigParser] Loaded configuration file: ${path.basename(filePath)}`);
      }
      return true;
    } catch (err) {
      if (this.verbose) {
        console.warn(`⚠️  [ConfigParser] Env load error for ${filePath}:`, err.message);
      }
      return false;
    }
  }

  /**
   * Maps legacy variables gracefully to Stratos sovereign properties.
   */
  mapLegacyConfig() {
    const config = {
      apiKey: process.env.OPENAI_API_KEY || this.env.OPENAI_API_KEY || null,
      ollamaHost: process.env.OLLAMA_HOST || this.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
      browserVisible: (process.env.BROWSER_VISIBLE || this.env.BROWSER_VISIBLE) === 'true',
      
      // Sovereign State Machine specifications
      vectorStorePath: process.env.STRATOS_VECTOR_STORE_PATH || './.stratos-vector-store',
      pqcMode: process.env.STRATOS_PQC_MODE || 'ML-KEM-768',
      x402SolanaTreasury: process.env.X402_SOLANA_TREASURY || '6GH6mS462pJ1ys286shV8dyka29DCwNZKACETBPRj27x',

      // Multi-channel interface configs
      telegramToken: process.env.TELEGRAM_BOT_TOKEN || this.env.TELEGRAM_BOT_TOKEN || null,
      discordWebhook: process.env.DISCORD_WEBHOOK_URL || this.env.DISCORD_WEBHOOK_URL || null,
      slackToken: process.env.SLACK_BOT_TOKEN || this.env.SLACK_BOT_TOKEN || null
    };

    if (this.verbose) {
      console.log('📡 [ConfigParser] Mapped legacy configurations gracefully to Stratos State Machine:');
      console.log(`   - Browser Visible:   ${config.browserVisible}`);
      console.log(`   - Local Inference Host: ${config.ollamaHost}`);
      console.log(`   - Solana Treasury:      ${config.x402SolanaTreasury}`);
      console.log(`   - Telegram Gateway:     ${config.telegramToken ? 'ACTIVE [VAULT]' : 'DISABLED'}`);
    }
    return config;
  }

  /**
   * Resolves a model target to its corresponding endpoint coordinates.
   */
  resolveModelEndpoint(modelName) {
    const custom = this.modelMap.get(modelName);
    if (custom) return custom;

    // Fallback detection
    if (modelName.startsWith('gpt-')) {
      return { provider: 'openai', url: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY };
    }
    if (modelName.startsWith('claude-')) {
      return { provider: 'anthropic', url: 'https://api.anthropic.com/v1', apiKey: process.env.ANTHROPIC_API_KEY };
    }
    if (modelName.includes(':7b') || modelName.includes('qwen') || modelName.includes('llama')) {
      return { provider: 'ollama', url: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434' };
    }

    // Generic OpenRouter default fallback
    return { provider: 'openrouter', url: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY };
  }

  /**
   * Registers a custom model to the endpoint registry dynamically.
   */
  registerModel(modelName, provider, url, apiKey = null) {
    this.modelMap.set(modelName, { provider, url, apiKey });
    if (this.verbose) {
      console.log(`📡 [ConfigParser] Registered custom endpoint for model [${modelName}]: provider=${provider}, url=${url}`);
    }
  }
}
