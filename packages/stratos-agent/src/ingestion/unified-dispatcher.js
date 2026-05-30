/**
 * UnifiedDispatcher: Standardized multi-channel gateway dispatcher
 * that consolidates user messages from multiple channels (Telegram, Slack, CLI),
 * escapes HTML entities safely, formats collapsible thought traces, and
 * prepares clean transcript text for voice/speech synthesizers.
 */
export class UnifiedDispatcher {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.whisperActive = options.whisperActive === true;
  }

  /**
   * Safe HTML Entity Escaper for Telegram HTML parse mode compatibility
   */
  escapeHTML(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Formats a raw AI reasoning payload into rich Telegram/Slack HTML.
   * Collapses thought traces inside tg-spoiler tags and wraps code inside pre-code tags.
   */
  formatResponseHTML(rawResponse) {
    if (!rawResponse) return '';

    let content = rawResponse;
    let thinkBlock = '';

    // Extract thinking blocks <think>...</think>
    const thinkRegex = /<think>([\s\S]*?)<\/think>/i;
    const match = content.match(thinkRegex);

    if (match) {
      // Escape and wrap the raw thinking process inside a collapsible spoiler
      const rawThink = match[1].trim();
      const escapedThink = this.escapeHTML(rawThink);
      thinkBlock = `🧠 <b>Thinking Process:</b>\n<tg-spoiler>${escapedThink}</tg-spoiler>\n\n`;
      content = content.replace(thinkRegex, '').trim();
    }

    // Escape the remaining main content body
    let escapedBody = this.escapeHTML(content);

    // Format bold markdown (**text** -> <b>text</b>)
    escapedBody = escapedBody.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

    // Format italic markdown (*text* -> <i>text</i>)
    escapedBody = escapedBody.replace(/\*(.*?)\*/g, '<i>$1</i>');

    // Format monospaced code blocks (```code``` -> <pre><code>code</code></pre>)
    // Using multiline regex
    escapedBody = escapedBody.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // Format inline code (`code` -> <code>code</code>)
    escapedBody = escapedBody.replace(/`(.*?)`/g, '<code>$1</code>');

    const result = `${thinkBlock}${escapedBody}`;

    // Safety net: odd numbers of markdown delimiters produce unclosed tags, which
    // Telegram's HTML parser rejects ("can't find end of the entity"). If the
    // converted body has unbalanced tags, fall back to escaped plaintext (always
    // valid HTML) while preserving the collapsible thinking block.
    if (!this._tagsBalanced(result)) {
      return `${thinkBlock}${this.escapeHTML(content)}`;
    }
    return result;
  }

  /**
   * Returns true only if every Telegram-supported tag is balanced (equal open/close).
   */
  _tagsBalanced(html) {
    for (const tag of ['b', 'i', 'code', 'pre', 'tg-spoiler']) {
      const open = (html.match(new RegExp(`<${tag}>`, 'g')) || []).length;
      const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      if (open !== close) return false;
    }
    return true;
  }

  /**
   * Strips out raw thinking blocks <think>...</think> and markdown syntax
   * to yield a clean text stream perfectly suited for speech synthesis.
   */
  cleanTextForVoice(rawResponse) {
    if (!rawResponse) return '';
    
    // Remove thinking block entirely
    let clean = rawResponse.replace(/<think>[\s\S]*?<\/think>/gi, '');
    
    // Strip markdown formatting symbols (bold, italic, code blocks)
    clean = clean.replace(/\*\*|`|_|\*/g, '');
    
    // Clean up redundant linebreaks
    clean = clean.replace(/\n+/g, ' ').trim();
    
    return clean;
  }

  /**
   * Normalizes incoming raw payloads from multiple platforms into a single API prompt structure.
   */
  normalizeIncomingRequest(channel, payload) {
    let normalized = {
      channel,
      user: 'unknown',
      text: '',
      hasAudio: false,
      rawPayload: payload
    };

    if (channel === 'telegram') {
      normalized.user = payload.from?.username || payload.from?.first_name || 'telegram-user';
      if (payload.text) {
        normalized.text = payload.text;
      } else if (payload.voice) {
        normalized.text = '[Audio Voice Inbound]';
        normalized.hasAudio = true;
      }
    } else if (channel === 'slack') {
      normalized.user = payload.user || 'slack-user';
      normalized.text = payload.text || '';
    } else if (channel === 'cli') {
      normalized.user = payload.user || 'developer';
      normalized.text = payload.text || '';
    }

    if (this.verbose) {
      console.log(`📡 [UnifiedDispatcher] Normalized ${channel.toUpperCase()} request from [${normalized.user}]: "${normalized.text.slice(0, 40)}"`);
    }

    return normalized;
  }
}
