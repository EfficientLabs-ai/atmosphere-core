import fs from 'node:fs';
import path from 'node:path';

/**
 * ConfigParser: Zero-dependency legacy configuration parser
 * that reads legacy OpenClaw/Hermes .env files and maps them
 * gracefully into the sovereign Stratos Agent state machine.
 */
export class ConfigParser {
  constructor(options = {}) {
    this.env = {};
    this.verbose = options.verbose !== false;
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
      x402SolanaTreasury: process.env.X402_SOLANA_TREASURY || '6GH6mS462pJ1ys286shV8dyka29DCwNZKACETBPRj27x'
    };

    if (this.verbose) {
      console.log('📡 [ConfigParser] Mapped legacy configurations gracefully to Stratos State Machine:');
      console.log(`   - Browser Visible:   ${config.browserVisible}`);
      console.log(`   - Local Inference Host: ${config.ollamaHost}`);
      console.log(`   - Solana Treasury:      ${config.x402SolanaTreasury}`);
    }
    return config;
  }
}
