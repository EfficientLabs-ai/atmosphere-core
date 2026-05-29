import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * LegacyBridge: Dynamically bridges existing user setups (Claude Desktop configs,
 * legacy MCP tools, custom project environments) into StratosAgent.
 */
export class LegacyBridge {
  static configPathOverride = null;

  /**
   * Resolves the default Claude Desktop configuration path based on the operating system.
   * @returns {string}
   */
  static getClaudeConfigPath() {
    if (this.configPathOverride) return this.configPathOverride;
    const homedir = os.homedir();
    if (process.platform === 'win32') {
      const appdata = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
      return path.join(appdata, 'Claude', 'claude_desktop_config.json');
    } else if (process.platform === 'darwin') {
      return path.join(homedir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    } else {
      return path.join(homedir, '.config', 'Claude', 'claude_desktop_config.json');
    }
  }

  /**
   * Dynamically loads and parses the Claude Desktop configuration.
   * @param {string} [customPath] - Optional override path
   * @returns {Object} - Parsed configuration file contents
   */
  static loadClaudeConfig(customPath = null) {
    const configPath = customPath || this.getClaudeConfigPath();
    console.log(`[LegacyBridge] 🔍 Scanning for Claude Desktop configuration at: ${configPath}`);
    
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(raw);
        console.log(`[LegacyBridge] ✅ Successfully parsed Claude Desktop config. Found ${Object.keys(config.mcpServers || {}).length} MCP servers.`);
        return config;
      } catch (err) {
        console.warn(`[LegacyBridge] ⚠️ Found configuration file but failed to parse: ${err.message}`);
      }
    } else {
      console.log(`[LegacyBridge] ℹ️ Claude Desktop config not found at default location. Setting up standard fallback overlay.`);
    }

    // Default mock/fallback config for testing and frictionless boot
    return {
      mcpServers: {
        "legacy-filesystem-server": {
          "command": "node",
          "args": ["./scripts/mock-fs-server.js"],
          "env": {
            "ALLOWED_DIRECTORIES": process.cwd()
          }
        }
      }
    };
  }

  /**
   * Ingests legacy prompts, directories, and configurations directly into LanceDB.
   * @param {ReasoningBank} reasoningBank - The LanceDB ReasoningBank instance
   * @param {string} [customConfigPath] - Optional custom config path
   */
  static async ingestLegacyContext(reasoningBank, customConfigPath = null) {
    const config = this.loadClaudeConfig(customConfigPath);
    const records = [];

    // Index MCP configurations into the local vector cognitive skill store
    if (config.mcpServers) {
      for (const [name, server] of Object.entries(config.mcpServers)) {
        const text = `Legacy Claude Desktop MCP Server: ${name}. Command: ${server.command}. Args: ${server.args.join(' ')}. Ingested for local enclaved execution.`;
        records.push({
          id: `legacy-mcp-${name}`,
          vector: [0.9, -0.2, 0.4], // Structured vector key
          text,
          metadata: {
            category: 'legacy-mcp',
            serverName: name,
            command: server.command,
            args: server.args
          }
        });
      }
    }

    // Attempt to ingest local project environments (.env variables, promts)
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      try {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const varsCount = envContent.split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#')).length;
        records.push({
          id: 'legacy-project-env',
          vector: [0.2, 0.8, -0.4],
          text: `Legacy Project Local .env File. Contains ${varsCount} active environment configurations. Securely ingested for isolated api-shim context fallback.`,
          metadata: { category: 'project-config', path: envPath }
        });
      } catch (err) {
        // Silent catch
      }
    }

    if (records.length > 0) {
      console.log(`[LegacyBridge] 📥 Injecting ${records.length} legacy context records into LanceDB...`);
      await reasoningBank.vectorInsert('knowledge-base', records);
      console.log(`[LegacyBridge] ✅ Ingestion complete.`);
    }
  }
}
