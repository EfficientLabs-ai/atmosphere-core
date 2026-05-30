import crypto from 'node:crypto';

/**
 * SlackAdapter: Manages Slack Events API incoming webhook signals,
 * translating payloads to standardized dispatcher frames while strictly
 * enforcing session isolation at the database retrieval layer.
 */
export class SlackAdapter {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.signingSecret = options.signingSecret || 'mock-slack-signing-secret-12345';
  }

  /**
   * Validates inbound Slack requests using official header signatures.
   */
  verifyRequestSignature(rawBody, timestamp, signature) {
    if (!rawBody || !timestamp || !signature) return false;
    
    // Check for replay attacks (within 5 minutes)
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
    if (parseInt(timestamp) < fiveMinutesAgo) return false;

    const sigBasestring = `v0:${timestamp}:${rawBody}`;
    const hmac = crypto.createHmac('sha256', this.signingSecret)
                       .update(sigBasestring)
                       .digest('hex');

    const expectedSignature = `v0=${hmac}`;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  }

  /**
   * Normalizes incoming event data to standard Stratos request format.
   * Injects strict, platform-specific metadata tags to preserve polymorphic memory isolation.
   * 
   * @param {Object} slackEvent - Raw parsed body from Slack Events API
   * @returns {Object} - Standardized request envelope
   */
  normalizeRequest(slackEvent) {
    const { event, team_id, api_app_id } = slackEvent;
    
    if (this.verbose) {
      console.log(`📡 [SlackAdapter] Processing inbound Slack signal from team [${team_id}]`);
    }

    // Isolate context tags using the Slack Team/Channel boundaries
    const isolatedContextTag = `slack-context-team_${team_id}-channel_${event.channel}`;

    return {
      protocol: 'omni-acp-v1',
      channel: 'slack',
      sender: event.user,
      text: event.text,
      timestamp: Date.now(),
      messageId: event.client_msg_id || crypto.randomBytes(16).toString('hex'),
      sessionMeta: {
        isolatedContextTag, // Bound directly to LanceDB queries to prevent prompt leakage
        platformMeta: {
          teamId: team_id,
          channelId: event.channel,
          apiAppId: api_app_id
        }
      }
    };
  }
}
