/**
 * cloud-byok.js — BYOK pass-through to OFFICIAL provider endpoints (OpenAI / Gemini).
 *
 * Forwards the user's OWN request with the user's OWN key to the official HTTPS endpoint. Per the
 * Codex review:
 *  - forwards the RAW inbound body ONLY (the caller passes the un-mutated body) — no RAG/identity
 *    context is ever leaked to a third party.
 *  - reads the provider's status + headers FIRST; only a 2xx is streamed/returned as success; a
 *    4xx/5xx relays the provider's real status + error body (no fake success stream).
 *  - the key is read from env and NEVER logged; propagates client aborts.
 */
import fetch from 'node-fetch';

export async function passthroughCloud(req, res, route, rawBody) {
  const key = process.env[route.envKey];
  if (!key) return res.status(501).json({ error: { message: `${route.provider} key missing`, type: 'provider_not_configured' } });

  // RAW body only — never the locally-mutated (RAG/identity-injected) copy.
  const body = JSON.stringify({ ...rawBody, model: route.model });

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(route.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, // key never logged
      body,
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) return; // client gone
    return res.status(502).json({ error: { message: `BYOK ${route.provider} unreachable: ${e.message}`, type: 'upstream_unreachable' } });
  }

  // Status FIRST — a non-2xx must relay the provider's error, not become a fake success stream.
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(errText || JSON.stringify({ error: { message: `${route.provider} returned ${upstream.status}` } }));
  }

  if (rawBody.stream) {
    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    upstream.body.on('error', () => { try { res.end(); } catch {} });
    upstream.body.pipe(res);
  } else {
    const text = await upstream.text();
    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  }
}
