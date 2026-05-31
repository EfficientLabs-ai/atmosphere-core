/**
 * anthropic-adapter.js — BYOK adapter for Anthropic's /v1/messages (different shape from OpenAI).
 *
 * Per the Codex review: a narrow, text-first adapter — translate OpenAI chat ⇄ Anthropic messages,
 * forward the user's RAW body with the user's OWN key, surface provider errors, never log the key.
 * v1 is non-incremental for streaming (the full reply is emitted as one SSE chunk + [DONE]) — honest,
 * not pretend-token-streaming. Tool calls / images are not translated in v1.
 */
import fetch from 'node-fetch';

const ANTHROPIC_VERSION = '2023-06-01';

/** OpenAI chat request → Anthropic /v1/messages request. */
export function toAnthropicRequest(rawBody) {
  const msgs = Array.isArray(rawBody.messages) ? rawBody.messages : [];
  const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).filter(Boolean).join('\n\n');
  const messages = msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content ?? '') }));
  const out = {
    model: rawBody.model,
    max_tokens: Number(rawBody.max_tokens) > 0 ? Number(rawBody.max_tokens) : 1024, // Anthropic REQUIRES max_tokens
    messages,
  };
  if (system) out.system = system;
  if (typeof rawBody.temperature === 'number') out.temperature = rawBody.temperature;
  if (typeof rawBody.top_p === 'number') out.top_p = rawBody.top_p;
  return out;
}

/** Anthropic /v1/messages response → OpenAI chat.completion. */
export function toOpenAIResponse(a, fallbackModel) {
  const text = Array.isArray(a.content) ? a.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
  const stopMap = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls' };
  const inTok = a.usage?.input_tokens ?? 0, outTok = a.usage?.output_tokens ?? 0;
  return {
    id: a.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: a.model || fallbackModel,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: stopMap[a.stop_reason] || 'stop' }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

export async function passthroughAnthropic(req, res, route, rawBody) {
  const key = process.env[route.envKey];
  if (!key) return res.status(501).json({ error: { message: 'ANTHROPIC_API_KEY missing', type: 'provider_not_configured' } });

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(route.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }, // key never logged
      body: JSON.stringify(toAnthropicRequest(rawBody)),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) return;
    return res.status(502).json({ error: { message: `BYOK anthropic unreachable: ${e.message}`, type: 'upstream_unreachable' } });
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(errText || JSON.stringify({ error: { message: `anthropic returned ${upstream.status}` } }));
  }

  const openai = toOpenAIResponse(await upstream.json(), route.model);
  if (rawBody.stream) {
    // v1: non-incremental — emit the full reply as a single OpenAI SSE chunk + [DONE].
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    const chunk = { id: openai.id, object: 'chat.completion.chunk', created: openai.created, model: openai.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: openai.choices[0].message.content }, finish_reason: openai.choices[0].finish_reason }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  return res.status(200).json(openai);
}
