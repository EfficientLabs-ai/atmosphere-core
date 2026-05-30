import fetch from 'node-fetch';
import crypto from 'node:crypto';

const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || 'http://127.0.0.1:8080';

/**
 * Checks if the local llama.cpp / LLM server is up.
 * Returns true if reachable, false otherwise.
 */
async function checkLocalServer() {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 600); // 600ms timeout
    const res = await fetch(`${LOCAL_LLM_URL}/health`, { 
      signal: controller.signal 
    });
    clearTimeout(id);
    return res.status === 200 || res.ok;
  } catch (err) {
    // If /health fails, try /v1/models as a fallback check
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 600);
      const res = await fetch(`${LOCAL_LLM_URL}/v1/models`, {
        signal: controller.signal
      });
      clearTimeout(id);
      return res.status === 200 || res.ok;
    } catch (err2) {
      return false;
    }
  }
}


/**
 * Handle OpenAI chat completions `/v1/chat/completions` request.
 * Seamlessly routes to llama.cpp if available, or serves the beautiful mock fallback.
 */
export async function handleOpenAIFallback(req, res) {
  const { messages, stream, model } = req.body;
  const isLocalServerUp = await checkLocalServer();

  if (isLocalServerUp) {
    console.log('🔄 Routing OpenAI request to active local llama.cpp server...');
    try {
      const response = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers.authorization || ''
        },
        body: JSON.stringify(req.body)
      });

      if (!response.ok) {
        throw new Error(`llama.cpp returned HTTP status ${response.status}`);
      }

      // Handle streaming from llama.cpp
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        response.body.pipe(res);
      } else {
        const data = await response.json();
        res.json(data);
      }
      return;
    } catch (err) {
      console.warn('⚠️ llama.cpp proxy failed, defaulting to inline mock:', err.message);
    }
  }

  // If llama.cpp is not active or failed, return the offline error message
  console.log('⚠️ Local inference engine is offline. Serving offline warning completion...');
  const text = "⚠️ Stratos Agent: Local inference engine is currently offline. Please ensure your open-weights model (Ollama/llama.cpp) is actively running on the host server.";
  const createdTime = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2)}`;

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Simulate chunk streaming with small delays
    const words = text.split(' ');
    let currentIdx = 0;

    const interval = setInterval(() => {
      if (currentIdx >= words.length) {
        res.write('data: [DONE]\n\n');
        res.end();
        clearInterval(interval);
        return;
      }

      // Send 2-3 words at a time for smooth premium flow
      const chunkWords = words.slice(currentIdx, currentIdx + 3);
      const deltaText = (currentIdx === 0 ? '' : ' ') + chunkWords.join(' ');
      currentIdx += 3;

      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: createdTime,
        model: model || 'llama3-8b-local-fallback',
        choices: [{
          index: 0,
          delta: { content: deltaText },
          finish_reason: null
        }]
      };

      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }, 40);
  } else {
    // Non-streaming OpenAI response
    res.json({
      id: completionId,
      object: 'chat.completion',
      created: createdTime,
      model: model || 'llama3-8b-local-fallback',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: (messages || []).reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0) / 4 + 10,
        completion_tokens: text.length / 4,
        total_tokens: (messages || []).reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0) / 4 + text.length / 4 + 10
      }
    });
  }
}

/**
 * Handle Anthropic messages `/v1/messages` request.
 * Seamlessly routes to llama.cpp if available (mapping input/output formats), or serves the beautiful mock fallback.
 */
export async function handleAnthropicFallback(req, res) {
  const { messages, system, stream, model } = req.body;
  const isLocalServerUp = await checkLocalServer();

  if (isLocalServerUp) {
    console.log('🔄 Routing Anthropic request to active local llama.cpp server (mapping formats)...');
    try {
      // Map Anthropic messages request payload to OpenAI format
      const openAiMessages = [];
      if (system) {
        openAiMessages.push({ role: 'system', content: system });
      }
      for (const msg of messages || []) {
        let content = '';
        if (Array.isArray(msg.content)) {
          content = msg.content.map(c => c.text || '').join('\n');
        } else {
          content = msg.content;
        }
        openAiMessages.push({ role: msg.role, content });
      }

      const openAiPayload = {
        model: 'llama3-8b-local-fallback',
        messages: openAiMessages,
        stream: !!stream
      };

      const response = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(openAiPayload)
      });

      if (!response.ok) {
        throw new Error(`llama.cpp returned HTTP status ${response.status}`);
      }

      const msgId = `msg_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2)}`;

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Parse standard OpenAI SSE chunk stream and map to Anthropic event-stream on-the-fly!
        // Anthropic stream lifecycle:
        // 1. message_start
        // 2. content_block_start
        // 3. content_block_delta
        // 4. content_block_stop
        // 5. message_delta
        // 6. message_stop
        
        res.write(`event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model: model || 'claude-3-5-sonnet-local-fallback',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 15, output_tokens: 0 }
          }
        })}\n\n`);

        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })}\n\n`);

        let buffer = '';
        response.body.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep last incomplete line in buffer

          for (const line of lines) {
            const cleanLine = line.trim();
            if (!cleanLine.startsWith('data:')) continue;
            const dataStr = cleanLine.substring(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const openAiChunk = JSON.parse(dataStr);
              const deltaText = openAiChunk.choices[0]?.delta?.content || '';
              if (deltaText) {
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: deltaText }
                })}\n\n`);
              }
            } catch (err) {
              // Ignore parse errors on stream framing
            }
          }
        });

        response.body.on('end', () => {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0
          })}\n\n`);

          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 120 }
          })}\n\n`);

          res.write(`event: message_stop\ndata: ${JSON.stringify({
            type: 'message_stop'
          })}\n\n`);
          res.end();
        });
      } else {
        // Map OpenAI non-streaming completion back to Anthropic response format
        const data = await response.json();
        const text = data.choices[0]?.message?.content || '';
        res.json({
          id: msgId,
          type: 'message',
          role: 'assistant',
          model: model || 'claude-3-5-sonnet-local-fallback',
          content: [
            {
              type: 'text',
              text
            }
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: data.usage?.prompt_tokens || 20,
            output_tokens: data.usage?.completion_tokens || 80
          }
        });
      }
      return;
    } catch (err) {
      console.warn('⚠️ llama.cpp proxy failed, defaulting to inline mock:', err.message);
    }
  }

  // If llama.cpp is not active or failed, return the offline error message
  console.log('⚠️ Local inference engine is offline. Serving offline warning message...');
  const text = "⚠️ Stratos Agent: Local inference engine is currently offline. Please ensure your open-weights model (Ollama/llama.cpp) is actively running on the host server.";
  const msgId = `msg_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2)}`;

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send Anthropic stream prelude
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: model || 'claude-3-5-sonnet-local-fallback',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 }
      }
    })}\n\n`);

    res.write(`event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    })}\n\n`);

    const words = text.split(' ');
    let currentIdx = 0;

    const interval = setInterval(() => {
      if (currentIdx >= words.length) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: 0
        })}\n\n`);

        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: Math.floor(text.length / 4) }
        })}\n\n`);

        res.write(`event: message_stop\ndata: ${JSON.stringify({
          type: 'message_stop'
        })}\n\n`);
        res.end();
        clearInterval(interval);
        return;
      }

      const chunkWords = words.slice(currentIdx, currentIdx + 3);
      const deltaText = (currentIdx === 0 ? '' : ' ') + chunkWords.join(' ');
      currentIdx += 3;

      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: deltaText }
      })}\n\n`);
    }, 40);
  } else {
    // Non-streaming Anthropic response
    res.json({
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: model || 'claude-3-5-sonnet-local-fallback',
      content: [
        {
          type: 'text',
          text
        }
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: (messages || []).reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0) / 4 + 15,
        output_tokens: text.length / 4
      }
    });
  }
}
