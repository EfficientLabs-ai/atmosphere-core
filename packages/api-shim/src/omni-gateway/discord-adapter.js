import crypto from 'node:crypto';

/**
 * DiscordAdapter: Normalizes incoming Discord events, mapping message signals
 * to standard dispatcher frames and establishing strict, isolated guild-level
 * contexts inside LanceDB queries.
 */
export class DiscordAdapter {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.clientToken = options.clientToken || 'mock-discord-client-token-99999';
  }

  /**
   * Translates incoming raw discord.js message objects into standard Stratos format.
   * Enforces mathematical context boundary tags to secure corporate files.
   * 
   * @param {Object} discordMessage - Raw message object from Discord client
   * @returns {Object} - Standardized request envelope
   */
  normalizeRequest(discordMessage) {
    const { author, content, channel, guild } = discordMessage;
    
    if (this.verbose) {
      console.log(`📡 [DiscordAdapter] Normalizing Discord prompt in guild [${guild ? guild.id : 'DM'}]`);
    }

    // Isolate context tag to isolate DM sessions from multi-tenant guild channels
    const isolatedContextTag = guild 
      ? `discord-context-guild_${guild.id}-channel_${channel.id}`
      : `discord-context-direct-user_${author.id}`;

    return {
      protocol: 'omni-acp-v1',
      channel: 'discord',
      sender: author.username || author.id,
      text: content,
      timestamp: Date.now(),
      messageId: discordMessage.id || crypto.randomBytes(16).toString('hex'),
      sessionMeta: {
        isolatedContextTag, // Prevents prompt leakage across guilds or channels
        platformMeta: {
          guildId: guild ? guild.id : null,
          channelId: channel.id,
          authorId: author.id
        }
      }
    };
  }
}
