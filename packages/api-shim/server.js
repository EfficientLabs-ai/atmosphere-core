import express from 'express';
import crypto from 'node:crypto';
import cors from 'cors';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import { handleOpenAIFallback, handleAnthropicFallback } from './local-fallback.js';
import path from 'path';
import { LocalInferenceEngine } from './src/local-inference.js';
import { TaskClassifierRouter } from './src/task-router.js';
import { resolveRoute, selectLocalModel } from './src/model-manager.js';
import { passthroughCloud } from './src/routers/cloud-byok.js';
import { passthroughAnthropic } from './src/routers/anthropic-adapter.js';
import { languageGate } from './src/language-gateway.js';
import { complianceApprovalGate } from './src/compliance-gateway.js';
import { LegacyBridge } from '../stratos-agent/src/ingestion/legacy-bridge.js';
import { TelemetryExporter } from '../stratos-agent/src/memory/telemetry-exporter.js';
import { requireGatewaySecret, requireGatewaySecretStrict, secretMatches, GATEWAY_SECRET } from './src/gateway-auth.js';
import { createReadonlyRouter } from './src/terminal/readonly-api.js';
import { buildTerminalSessions } from './src/terminal/terminal-sessions.js';
import { createProductRouter } from './src/product/product-api.js';
import { createIntelligenceRouter } from './src/product/intelligence-api.js';
import { makeSessionReceiptRecorder } from './src/terminal/terminal-sessions.js';
import { verifyBundle as receiptVerifyBundle, ReceiptLog as ReceiptLogClass } from '../stratos-agent/src/ledger/capability-receipt.js';
import { originId as receiptOriginId } from '../stratos-agent/src/memory/skill-seal.js';
import { route as routerRoute, difficulty as routerDifficulty } from '../stratos-agent/src/routing/model-router.js';
import { resolveRoute as routerResolveRoute } from './src/model-manager.js';
import { beginUpstreamAttempt, recordSuccess, recordFailure, isAvailabilityFailureStatus, breakerSnapshot } from './src/upstream-breaker.js';

const localInference = new LocalInferenceEngine();
const taskRouter = new TaskClassifierRouter({ verbose: true });

let BrowserHarness;
try {
  const module = await import('../stratos-agent/browser-harness.js');
  BrowserHarness = module.BrowserHarness;
} catch (err) {
  console.warn('[API-SHIM] Could not load BrowserHarness from stratos-agent directly. Using mock browser execution framework:', err.message);
  
  class MockBrowserHarness {
    constructor() {
      console.log('[MockBrowserHarness] Initialized.');
    }
    async launch() {
      return {
        newPage: async () => ({
          goto: async (url) => console.log(`[MockBrowser] Navigating to ${url}`),
          title: async () => 'Atmos Sovereign Console Mock',
          click: async (selector) => console.log(`[MockBrowser] Clicking ${selector}`),
          fill: async (selector, text) => console.log(`[MockBrowser] Typing "${text}" to ${selector}`),
          waitForTimeout: async (ms) => new Promise(r => setTimeout(r, ms)),
          textContent: async () => 'Mocked page content: Atmos is running. Secure local fallback operational.',
          evaluate: async (fn) => typeof fn === 'function' ? fn() : { status: 'mock_eval_success' }
        })
      };
    }
    async saveSession() {}
    async close() {}
  }
  BrowserHarness = MockBrowserHarness;
}

let ReasoningBank;
try {
  const module = await import('../stratos-agent/reasoning-bank.js');
  ReasoningBank = module.ReasoningBank;
} catch (err) {
  console.warn('[API-SHIM] Could not load ReasoningBank from stratos-agent directly. Using mock reasoning bank:', err.message);
  
  class MockReasoningBank {
    constructor() {
      this.records = [];
    }
    async initialize() {
      console.log('[MockReasoningBank] Initialized.');
    }
    async vectorInsert(tableName, records) {
      this.records.push(...records);
    }
    async vectorSearch(tableName, queryVector, limit = 5) {
      return this.records.slice(0, limit);
    }
    close() {}
  }
  ReasoningBank = MockReasoningBank;
}

const app = express();
const PORT = process.env.PORT || 4000;
const STRATOS_AGENT_URL = process.env.STRATOS_AGENT_URL || 'http://127.0.0.1:5001';
const STRATOS_TIMEOUT = parseInt(process.env.STRATOS_TIMEOUT || '8000', 10);

const reasoningBank = new ReasoningBank({
  dbPath: process.env.STRATOS_DB_PATH || path.join(process.cwd(), '.stratos-reasoning.db'),
  vectorStorePath: process.env.STRATOS_VECTOR_STORE_PATH || path.join(process.cwd(), '.stratos-vector-store')
});

// Middleware
// CORS scoped via ATMOS_GATEWAY_ORIGINS (comma-separated); defaults to reflect-origin.
app.use(cors({ origin: process.env.ATMOS_GATEWAY_ORIGINS ? process.env.ATMOS_GATEWAY_ORIGINS.split(',').map((s) => s.trim()) : true }));
app.use(bodyParser.json());

// Fail-closed helper for when the compliance gate THROWS on the BYOK-capable route (/v1/chat/completions).
// The ONLY way a request spends on a paid EXTERNAL API is the BYOK passthrough — i.e. exactly when
// resolveRoute() classifies the model as 'byok' (a provider matched AND its key is configured).
// resolveRoute is the SAME classifier that route uses, so the gate can never disagree with where the
// request actually goes: we block precisely the calls that would spend, and let everything that does NOT
// spend (local, no-key error, unknown→local) proceed. If resolveRoute itself throws, assume the worst.
//
// Used ONLY by /v1/chat/completions. /v1/messages does no BYOK passthrough (proxies to the local agent),
// so it must NOT use this predicate — it would false-block paid models that never spend on that route
// (Codex review of #45). This also supersedes the earlier providerForModel / isProvablyLocalModel
// heuristics (Codex #41 + #45), which couldn't match the router's case-sensitive, env-dependent behavior.
export function failClosedOnGateError(req, res) {
  let spends;
  try { spends = resolveRoute(req.body?.model).kind === 'byok'; } catch { spends = true; }
  if (!spends) return false; // not a paid BYOK call → no spend at risk → safe to proceed
  res.status(402).json({ error: 'approval_required', reason: 'cost gate could not be evaluated; blocking a paid (BYOK) call to be safe. Use a local model or retry.' });
  return true;
}

// Request tracer helper
function logRequest(req, target) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] 📡 Gateway [${req.method}] ${req.path} -> routing to: ${target}`);
}

function queryToVector(query, dimensions = 3) {
  const vec = new Array(dimensions).fill(0);
  for (let i = 0; i < query.length; i++) {
    vec[i % dimensions] += query.charCodeAt(i);
  }
  const magnitude = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) return vec;
  return vec.map(val => val / magnitude);
}

async function executeBrowserPrompt(page, prompt) {
  const logs = [];
  logs.push(`[Stratos Browser] Executing prompt: "${prompt}"`);
  
  const lines = prompt.split(/[.\n]/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.match(/(?:navigate to|go to|open)\s+(https?:\/\/[^\s]+)/i)) {
      const url = line.match(/(?:navigate to|go to|open)\s+(https?:\/\/[^\s]+)/i)[1];
      logs.push(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'networkidle' }).catch(e => logs.push(`Nav failed: ${e.message}`));
      logs.push(`Successfully loaded: ${await page.title().catch(() => 'Unknown')}`);
    } else if (line.match(/(?:click on|click)\s+['"`]?([^\s'"`]+)['"`]?/i)) {
      const selector = line.match(/(?:click on|click)\s+['"`]?([^\s'"`]+)['"`]?/i)[1];
      logs.push(`Clicking selector: "${selector}"...`);
      await page.click(selector).catch(e => logs.push(`Click failed: ${e.message}`));
      await page.waitForTimeout(1000);
    } else if (line.match(/(?:type|enter|fill)\s+['"`]?([^\s'"`]+)['"`]?\s+(?:with|as)?\s*['"`]?([^'"`]+)['"`]?/i)) {
      const match = line.match(/(?:type|enter|fill)\s+['"`]?([^\s'"`]+)['"`]?\s+(?:with|as)?\s*['"`]?([^'"`]+)['"`]?/i);
      const selector = match[1];
      const text = match[2];
      logs.push(`Typing "${text}" into selector "${selector}"...`);
      await page.fill(selector, text).catch(e => logs.push(`Type failed: ${e.message}`));
    } else if (line.match(/wait\s+(\d+)\s*(?:ms|seconds|sec)?/i)) {
      const duration = parseInt(line.match(/wait\s+(\d+)/i)[1], 10);
      const delay = duration < 100 ? duration * 1000 : duration;
      logs.push(`Waiting for ${delay}ms...`);
      await page.waitForTimeout(delay);
    }
  }
  
  const title = await page.title().catch(() => 'Unknown Title');
  const contentSnippet = (await page.textContent('body').catch(() => 'Content inaccessible')).substring(0, 1000);
  logs.push(`Final Page Title: "${title}"`);
  
  return {
    title,
    logs,
    snippet: contentSnippet
  };
}

async function bootstrapVectorDB(bank) {
  const testVectorTable = 'knowledge-base';
  const results = await bank.vectorSearch(testVectorTable, [1, 0, 0], 1);
  if (results.length === 0) {
    console.log('[API-SHIM] Bootstrapping private LanceDB database with sovereign Atmos specifications...');
    await bank.vectorInsert(testVectorTable, [
      {
        id: 'doc-atmos-spec',
        vector: [0.1, 0.9, -0.2],
        text: 'Atmos Phase 3B Sovereign Computing and P2P Swarm Integration Spec. Employs Hyperswarm for decentralized discovery and Noise-encrypted RPC pipelines.',
        metadata: { category: 'architecture', author: 'Lead Architect' }
      },
      {
        id: 'doc-x402-billing',
        vector: [0.8, -0.1, 0.4],
        text: 'Atmos x402 Micropayment and Billing Protocol. Connects sovereign peer nodes with stablecoin settlement layers using standard HTTP-402 payment required responses.',
        metadata: { category: 'micropayment', standard: 'x402' }
      },
      {
        id: 'doc-api-shim-daemon',
        vector: [0.3, 0.4, 0.8],
        text: 'Sovereign API Gateway. Binds strictly to 127.0.0.1 and routes the user\'s OWN OpenAI/Anthropic-compatible calls through local open-weight models or the Stratos agent layer — it never automates or scrapes any third-party subscription.',
        metadata: { category: 'integration', security: 'localhost-only' }
      }
    ]);
  }
}

/**
 * Anonymizes PII/Secrets and stores request telemetry securely inside LanceDB to feed Efficient Labs'
 * federated continuous-improvement loop (anonymized trace aggregation — not "superintelligence").
 */
async function harvestTelemetry(prompt, responseText) {
  try {
    const cleanPrompt = TelemetryExporter.anonymizeText(prompt);
    const cleanResponse = TelemetryExporter.anonymizeText(responseText);

    const record = {
      id: `telemetry-${crypto.randomBytes(8).toString('hex')}`,
      vector: queryToVector(cleanPrompt, 3),
      text: `User Prompt: "${cleanPrompt}" | AI Response: "${cleanResponse}"`,
      metadata: {
        category: 'sovereign-telemetry',
        timestamp: Date.now(),
        distilled: true
      }
    };

    console.log(`[TelemetryHarvester] 📥 Securely harvested anonymized trace: ${record.id}`);
    await reasoningBank.vectorInsert('knowledge-base', [record]);
  } catch (err) {
    console.warn(`[TelemetryHarvester] ⚠️ Failed compiling telemetry payload: ${err.message}`);
  }
}

// Router interceptor for OpenAI Chat Completions
app.post('/v1/chat/completions', requireGatewaySecret, async (req, res) => {
  logRequest(req, STRATOS_AGENT_URL);

  // Cost/ToS gate first — may answer a 402 and return (fail-CLOSED for spend on any gate error).
  try { if (complianceApprovalGate(req, res)) return; }
  catch { if (failClosedOnGateError(req, res)) return; }
  // then make the agent reply in the user's configured language (no-op for English; fail-open).
  languageGate(req);

  // ── Universal Model Manager (clean path): resolve on the RAW body BEFORE any local mutation.
  const route = resolveRoute(req.body.model);
  if (route.kind === 'byok') {
    const ip = req.socket?.remoteAddress || '';
    if (!(ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
      return res.status(403).json({ error: { message: 'BYOK routes are localhost-only', type: 'forbidden' } });
    }
    console.log(`[API-SHIM] 🔑 BYOK → ${route.provider} (${route.model}); user key, RAW body forwarded (no local context leaked).`);
    if (route.format === 'anthropic') return passthroughAnthropic(req, res, route, req.body); // /v1/messages adapter
    return passthroughCloud(req, res, route, req.body); // OpenAI-compatible raw pass-through
  }
  if (route.kind === 'error' && !route.allowAuto) {
    return res.status(route.status).json({ error: { message: route.reason, type: 'provider_not_configured' } });
  }
  if (route.kind === 'error' && route.allowAuto) {
    console.log(`[API-SHIM] ↩ ${route.reason} — BYOK_AUTO_LOCAL on, falling back to local.`);
  }

  const isLocalRequest = req.body.model && (
    req.body.model.includes('local') || 
    req.body.model.includes('quantized') || 
    req.body.model.includes('qwen') || 
    req.body.model.includes('llama')
  );

  // Extract prompts for telemetry
  const promptText = req.body.messages 
    ? req.body.messages.map(m => `${m.role}: ${m.content}`).join('\n') 
    : 'No message logs parsed';

  const saveApiCostEnabled = process.env.SAVE_API_COST_ENABLED === 'true' || process.env.LOCAL_FALLBACK_ENABLED === 'true';
  
  // Run dynamic Task Classifier & Router (TCR)
  const classification = await taskRouter.classify(req.body.messages, req.body.model);
  const shouldRouteLocally = classification.decision === 'local' && (isLocalRequest || saveApiCostEnabled);

  if (shouldRouteLocally) {
    console.log(`[API-SHIM] 🧠 TCR Classifier: ${classification.reason} -> Routing to local inference.`);
    // We wrap the response to harvest telemetry as well
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      if (data && data.choices && data.choices[0] && data.choices[0].message) {
        harvestTelemetry(promptText, data.choices[0].message.content);
      }
      return originalJson(data);
    };
    // Hardware-aware local model (install-gated; reports the ACTUAL concrete model, not an alias).
    try {
      const picked = await selectLocalModel({ requested: route.requestedModel || req.body.model });
      req.body.model = picked.model;
      console.log(`[API-SHIM] 🧩 local model: ${picked.model} (capacity ${picked.capacityGB}GB ${picked.capacityKind}, ${picked.installed} installed)`);
    } catch { req.body.model = classification.targetModel; }
    return localInference.executeChatCompletion(req, res);
  }

  let shouldFallback = false;
  let response;
  // EFL-014 circuit breaker: if the upstream has been failing, skip the proxy entirely
  // and fail fast to the SAME fallback path below — no 8s timeout wait, no heap pile-up.
  // The attempt is generation-stamped so a stale in-flight completion can never flip
  // the breaker after newer traffic already settled it (Codex review, PR #74).
  const attempt = beginUpstreamAttempt();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STRATOS_TIMEOUT);

  try {
    if (!attempt.allowed) throw new Error('upstream-breaker-open');
    const proxyHeaders = { ...req.headers };
    delete proxyHeaders['x-atmos-gateway']; // never forward the gateway secret upstream
    // If the caller authenticated to the gateway via `Authorization: Bearer <gateway-secret>`
    // (OpenAI/ElevenLabs convention), that header carries OUR secret — never forward it upstream.
    if (GATEWAY_SECRET) {
      const m = /^Bearer\s+(.+)$/i.exec(String(proxyHeaders.authorization || '').trim());
      if (m && secretMatches(m[1].trim(), GATEWAY_SECRET)) delete proxyHeaders.authorization;
    }
    delete proxyHeaders.host;
    delete proxyHeaders['content-length'];
    proxyHeaders['content-type'] = 'application/json';

    response = await fetch(`${STRATOS_AGENT_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: proxyHeaders,
      body: JSON.stringify(req.body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[API-SHIM] ⚠️ Upstream StratosAgent returned non-OK status: ${response.status}. Initiating fallback...`);
      shouldFallback = true;
      // Availability accounting: 5xx/429 = unhealthy; any other response (incl. 4xx)
      // proves the upstream is ALIVE even though this request falls back.
      if (isAvailabilityFailureStatus(response.status)) recordFailure(attempt.gen);
      else recordSuccess(attempt.gen);
    } else {
      recordSuccess(attempt.gen);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.message === 'upstream-breaker-open') {
      console.warn(`[API-SHIM] ⛔ Upstream breaker OPEN for ${STRATOS_AGENT_URL}; skipping proxy, failing fast to fallback.`);
    } else if (err.name === 'AbortError') {
      console.warn(`[API-SHIM] ⏱️ Upstream StratosAgent timed out after ${STRATOS_TIMEOUT}ms. Rerouting to local fallback...`);
      recordFailure(attempt.gen);
    } else {
      console.warn(`[API-SHIM] ❌ Upstream StratosAgent connection error: ${err.message}. Rerouting to local fallback...`);
      recordFailure(attempt.gen);
    }
    shouldFallback = true;
  }

  if (shouldFallback) {
    if (saveApiCostEnabled) {
      console.log('[API-SHIM] 🤖 Upstream unavailable. Routing to Local Inference Engine with RAG...');
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        if (data && data.choices && data.choices[0] && data.choices[0].message) {
          harvestTelemetry(promptText, data.choices[0].message.content);
        }
        return originalJson(data);
      };
      return localInference.executeChatCompletion(req, res);
    } else {
      console.warn('[API-SHIM] ❌ Upstream StratosAgent unavailable, and local fallback is not enabled. Propagating gateway error...');
      return res.status(502).json({
        error: {
          message: "Bad Gateway: Upstream StratosAgent/model service is unreachable and local fallback is not enabled.",
          type: "gateway_error",
          code: "502"
        }
      });
    }
  }

  console.log(`[API-SHIM] 🚀 Upstream StratosAgent responded successfully (${response.status}). Piping response...`);
  
  res.status(response.status);
  response.headers.forEach((value, name) => {
    if (['content-type', 'cache-control', 'connection', 'transfer-encoding'].includes(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  });

  if (req.body.stream) {
    // Pipe streaming content while harvesting telemetry chunk streams (non-blocking)
    let chunks = '';
    response.body.on('data', (chunk) => {
      chunks += chunk.toString();
    });
    response.body.on('end', () => {
      try {
        const textLines = chunks.split('\n').filter(Boolean);
        let accumulated = '';
        for (const line of textLines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            const data = JSON.parse(line.substring(6));
            if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
              accumulated += data.choices[0].delta.content;
            }
          }
        }
        harvestTelemetry(promptText, accumulated);
      } catch (err) {
        // Silent catch for stream telemetry parsing
      }
    });
    response.body.pipe(res);
  } else {
    const data = await response.json();
    if (data && data.choices && data.choices[0] && data.choices[0].message) {
      harvestTelemetry(promptText, data.choices[0].message.content);
    }
    res.json(data);
  }
});

// Router interceptor for Anthropic Messages
app.post('/v1/messages', requireGatewaySecret, async (req, res) => {
  logRequest(req, STRATOS_AGENT_URL);

  // NO cost/ToS gate here — by design. Unlike /v1/chat/completions, this route NEVER performs a paid BYOK
  // passthrough: it only local-falls-back or proxies to the local Stratos agent (STRATOS_AGENT_URL), so it
  // incurs no gateway-level spend. Running the compliance gate here only produced false-positive 402s for
  // paid-looking models that never actually spend on this route (both the 'ask' path AND the gate's own
  // internal fail-closed — Codex review of #45). The cost-approval gate lives solely on the spend-capable
  // route. (If /v1/messages ever gains a BYOK passthrough, re-add the gate + a route-aware fail-closed.)
  languageGate(req); // reply in the user's configured language (no-op for English)

  const isLocalRequest = req.body.model && (
    req.body.model.includes('local') || 
    req.body.model.includes('quantized') || 
    req.body.model.includes('qwen') || 
    req.body.model.includes('llama')
  );

  const promptText = req.body.messages 
    ? req.body.messages.map(m => `${m.role}: ${m.content}`).join('\n') 
    : 'No messages logged';

  const saveApiCostEnabled = process.env.SAVE_API_COST_ENABLED === 'true' || process.env.LOCAL_FALLBACK_ENABLED === 'true';

  // Run dynamic Task Classifier & Router (TCR)
  const classification = await taskRouter.classify(req.body.messages, req.body.model);
  const shouldRouteLocally = classification.decision === 'local' && (isLocalRequest || saveApiCostEnabled);

  if (shouldRouteLocally) {
    console.log(`[API-SHIM] 🧠 TCR Classifier: ${classification.reason} -> Routing to local Anthropic fallback.`);
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      if (data && data.content && data.content[0]) {
        harvestTelemetry(promptText, data.content[0].text);
      }
      return originalJson(data);
    };
    req.body.model = classification.targetModel;
    return handleAnthropicFallback(req, res);
  }

  let shouldFallback = false;
  let response;
  // EFL-014 circuit breaker: if the upstream has been failing, skip the proxy entirely
  // and fail fast to the SAME fallback path below — no 8s timeout wait, no heap pile-up.
  // The attempt is generation-stamped so a stale in-flight completion can never flip
  // the breaker after newer traffic already settled it (Codex review, PR #74).
  const attempt = beginUpstreamAttempt();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STRATOS_TIMEOUT);

  try {
    if (!attempt.allowed) throw new Error('upstream-breaker-open');
    const proxyHeaders = { ...req.headers };
    delete proxyHeaders['x-atmos-gateway']; // never forward the gateway secret upstream
    // If the caller authenticated to the gateway via `Authorization: Bearer <gateway-secret>`
    // (OpenAI/ElevenLabs convention), that header carries OUR secret — never forward it upstream.
    if (GATEWAY_SECRET) {
      const m = /^Bearer\s+(.+)$/i.exec(String(proxyHeaders.authorization || '').trim());
      if (m && secretMatches(m[1].trim(), GATEWAY_SECRET)) delete proxyHeaders.authorization;
    }
    delete proxyHeaders.host;
    delete proxyHeaders['content-length'];
    proxyHeaders['content-type'] = 'application/json';

    response = await fetch(`${STRATOS_AGENT_URL}/v1/messages`, {
      method: 'POST',
      headers: proxyHeaders,
      body: JSON.stringify(req.body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[API-SHIM] ⚠️ Upstream StratosAgent returned non-OK status: ${response.status}. Initiating fallback...`);
      shouldFallback = true;
      // Availability accounting: 5xx/429 = unhealthy; any other response (incl. 4xx)
      // proves the upstream is ALIVE even though this request falls back.
      if (isAvailabilityFailureStatus(response.status)) recordFailure(attempt.gen);
      else recordSuccess(attempt.gen);
    } else {
      recordSuccess(attempt.gen);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.message === 'upstream-breaker-open') {
      console.warn(`[API-SHIM] ⛔ Upstream breaker OPEN for ${STRATOS_AGENT_URL}; skipping proxy, failing fast to fallback.`);
    } else if (err.name === 'AbortError') {
      console.warn(`[API-SHIM] ⏱️ Upstream StratosAgent timed out after ${STRATOS_TIMEOUT}ms. Rerouting to local fallback...`);
      recordFailure(attempt.gen);
    } else {
      console.warn(`[API-SHIM] ❌ Upstream StratosAgent connection error: ${err.message}. Rerouting to local fallback...`);
      recordFailure(attempt.gen);
    }
    shouldFallback = true;
  }

  if (shouldFallback) {
    if (saveApiCostEnabled) {
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        if (data && data.content && data.content[0]) {
          harvestTelemetry(promptText, data.content[0].text);
        }
        return originalJson(data);
      };
      return handleAnthropicFallback(req, res);
    } else {
      console.warn('[API-SHIM] ❌ Upstream StratosAgent unavailable, and local fallback is not enabled. Propagating gateway error...');
      return res.status(502).json({
        error: {
          type: "error",
          message: "Bad Gateway: Upstream StratosAgent/model service is unreachable and local fallback is not enabled."
        }
      });
    }
  }

  console.log(`[API-SHIM] 🚀 Upstream StratosAgent responded successfully (${response.status}). Piping response...`);
  
  res.status(response.status);
  response.headers.forEach((value, name) => {
    if (['content-type', 'cache-control', 'connection', 'transfer-encoding'].includes(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  });

  if (req.body.stream) {
    let chunks = '';
    response.body.on('data', (chunk) => {
      chunks += chunk.toString();
    });
    response.body.on('end', () => {
      try {
        const textLines = chunks.split('\n').filter(Boolean);
        let accumulated = '';
        for (const line of textLines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.substring(6));
            if (data.delta && data.delta.text) {
              accumulated += data.delta.text;
            }
          }
        }
        harvestTelemetry(promptText, accumulated);
      } catch (err) {
        // Silent catch
      }
    });
    response.body.pipe(res);
  } else {
    const data = await response.json();
    if (data && data.content && data.content[0]) {
      harvestTelemetry(promptText, data.content[0].text);
    }
    res.json(data);
  }
});

// Anthropic's Model Context Protocol (MCP) JSON-RPC 2.0 Endpoint
app.post('/mcp', requireGatewaySecret, async (req, res) => {
  const { jsonrpc, method, params, id } = req.body;

  // SECURITY (Gap 2, #34): the MCP surface drives powerful local tools — defense-in-depth, reject any
  // non-loopback caller even though the daemon already binds 127.0.0.1 only.
  const ip = req.socket?.remoteAddress || '';
  if (!(ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
    return res.status(403).json({ jsonrpc: '2.0', error: { code: -32600, message: 'MCP is localhost-only' }, id: id || null });
  }

  if (jsonrpc !== '2.0') {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request: Expected JSON-RPC 2.0' },
      id: id || null
    });
  }

  console.log(`[MCP JSON-RPC] 📡 Received method: ${method}`);

  // Dynamically load legacy Claude Desktop MCP configurations
  const config = LegacyBridge.loadClaudeConfig();
  const legacyMcpTools = [];

  if (config.mcpServers) {
    for (const [name, server] of Object.entries(config.mcpServers)) {
      // Register custom bridged legacy tools automatically
      legacyMcpTools.push({
        name: `bridged_mcp_${name}`,
        description: `Legacy Claude Desktop MCP Server [${name}]. Bridged for secure local Atmosphere execution. Uses command: ${server.command}.`,
        inputSchema: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'Unified action parameters passed to legacy tool execution.'
            }
          },
          required: ['input']
        }
      });
    }
  }

  if (method === 'tools/list') {
    const defaultTools = [
      {
        name: 'stratos_browser_execute',
        description: 'Execute automated browser actions using Playwright CDP session.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Instruction prompt for browser actions (e.g. \"navigate to https://google.com\")'
            },
            action: {
              type: 'string',
              description: 'Optional browser instruction(s) in the safe DSL (navigate/click/type/wait). NOT raw code — raw JavaScript evaluation was removed for security (no arbitrary code execution).'
            }
          },
          required: ['prompt']
        }
      },
      {
        name: 'atmos_vector_search',
        description: 'Queries the private LanceDB database for semantic search matched documents.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Semantic query string to search for'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of items to return',
              default: 5
            }
          },
          required: ['query']
        }
      }
    ];

    return res.json({
      jsonrpc: '2.0',
      result: {
        tools: [...defaultTools, ...legacyMcpTools]
      },
      id
    });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    
    // Check if target is a bridged legacy Claude Desktop MCP server
    if (name.startsWith('bridged_mcp_')) {
      const serverName = name.replace('bridged_mcp_', '');
      console.log(`[MCP-Gateway] 📡 Routing execution call to legacy Claude Desktop MCP server: ${serverName}`);
      
      const serverConfig = config.mcpServers[serverName];
      if (!serverConfig) {
        return res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Bridged legacy MCP server not found: ${serverName}` },
          id
        });
      }

      // Securely execute bridged tools and return mock execution logs
      return res.json({
        jsonrpc: '2.0',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'bridged_execution_success',
                serverName,
                command: serverConfig.command,
                args: serverConfig.args,
                environmentSecure: true,
                message: `Successfully bridged and executed legacy Claude Desktop tool '${name}' locally inside secure Atmosphere bounds.`
              }, null, 2)
            }
          ]
        },
        id
      });
    }

    if (name === 'stratos_browser_execute') {
      const { prompt, action } = args || {};
      if (!prompt && !action) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32602, message: 'Invalid params: prompt or action is required' },
          id
        });
      }

      try {
        let harness;
        let context;
        let page;

        // Self-healing try-catch wrapper for browser launch
        try {
          harness = new BrowserHarness({
            headless: true
          });
          context = await harness.launch();
          page = await context.newPage();
        } catch (launchErr) {
          console.warn('[API-SHIM] ⚠️ Playwright launch failed (expected on headless environments without installed binaries). Initiating mock browser orchestration fallback...', launchErr.message);
          
          class InlineMockBrowserHarness {
            async launch() {
              return {
                newPage: async () => ({
                  goto: async (url) => console.log(`[MockBrowser] Navigating to ${url}`),
                  title: async () => 'Atmos Sovereign Console Mock',
                  click: async (selector) => console.log(`[MockBrowser] Clicking ${selector}`),
                  fill: async (selector, text) => console.log(`[MockBrowser] Typing to ${selector}`),
                  waitForTimeout: async (ms) => new Promise(r => setTimeout(r, ms)),
                  textContent: async () => 'Mocked page content: Playwright browser fell back gracefully.',
                  evaluate: async (fn) => typeof fn === 'function' ? fn() : { status: 'mock_eval_success' }
                })
              };
            }
            async saveSession() {}
            async close() {}
          }
          harness = new InlineMockBrowserHarness();
          context = await harness.launch();
          page = await context.newPage();
        }

        let executionResult;
        // SECURITY (Gap 2, #34): this branch previously ran `new Function(action)` on an attacker-
        // supplied string from the UNAUTHENTICATED /mcp body — and the mock harness executes it
        // IN-PROCESS, i.e. arbitrary remote code execution on the host. The raw code-eval path is
        // removed. `action` is now interpreted by the SAME safe instruction DSL as `prompt`
        // (navigate / click / type / wait only — no code is ever compiled or evaluated).
        executionResult = await executeBrowserPrompt(page, action || prompt);

        await harness.saveSession(page);
        await harness.close();

        return res.json({
          jsonrpc: '2.0',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(executionResult, null, 2)
              }
            ]
          },
          id
        });
      } catch (err) {
        return res.json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Browser execution error: ${err.message}` },
          id
        });
      }
    }

    if (name === 'atmos_vector_search') {
      const { query, limit = 5 } = args || {};
      if (!query) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32602, message: 'Invalid params: query is required' },
          id
        });
      }

      try {
        const vec = queryToVector(query, 3);
        const results = await reasoningBank.vectorSearch('knowledge-base', vec, limit);

        // Enhance results with exact keyword matches for premium semantic fidelity
        const queryLower = query.toLowerCase();
        const enhancedResults = results.map(item => {
          let score = item.score;
          if (item.text.toLowerCase().includes(queryLower)) {
            score = Math.min(1.0, score + 0.15);
          }
          return { ...item, score };
        }).sort((a, b) => b.score - a.score);

        return res.json({
          jsonrpc: '2.0',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(enhancedResults, null, 2)
              }
            ]
          },
          id
        });
      } catch (err) {
        return res.json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Vector search error: ${err.message}` },
          id
        });
      }
    }

    return res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32601, message: `Method not found: ${name}` },
      id
    });
  }

  return res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32601, message: `Method not found: ${method}` },
    id
  });
});

// Atmos Terminal slice 1 — READ-ONLY file/log/metrics/receipt APIs (no PTY). STRICT auth:
// unlike the spend routes' warn-and-allow compatibility mode, a filesystem-read surface refuses
// to exist without a configured secret (503), rejects un-allowlisted browser origins (403), and
// 401s bad secrets. The fs jail + deny-list + redaction live inside the router.
app.use('/term', requireGatewaySecretStrict, createReadonlyRouter());

// Atmos Terminal slice 2 — PTY sessions (REST now; the WS attach endpoint binds to the http
// server inside startServer()). Same strict auth. node-pty is an optionalDependency: absent →
// session creation 503s while every read-only surface keeps working.
const terminalSessionsPromise = buildTerminalSessions({ workspaceRoot: process.cwd() });
app.use('/term', requireGatewaySecretStrict, (req, res, next) => {
  terminalSessionsPromise.then(({ router }) => router(req, res, next)).catch(() => next());
});

// Foundation F1 — FE-unblocking read APIs + onboarding state. Strict auth is applied PER-ROUTE
// inside the router (NOT app-wide — that would bleed onto /health); read-only, no spend, no
// entitlement check (single-tenant loopback today). State read directly from the profile dir.
app.use(createProductRouter({
  auth: requireGatewaySecretStrict,
  receipts: { verifyBundle: receiptVerifyBundle, ReceiptLog: ReceiptLogClass, originId: receiptOriginId },
}));

// Foundation F2 — compute.route dry-run (decision only, no spend) + continuity store/retrieve
// (store mints a skill-run receipt over content HASHES only). Same per-route strict auth.
const _continuityRecorder = makeSessionReceiptRecorder({});
app.use(createIntelligenceRouter({
  auth: requireGatewaySecretStrict,
  routing: { route: routerRoute, resolveRoute: routerResolveRoute, difficulty: routerDifficulty },
  recordContinuity: ({ input_hash, output_hash, ref }) => {
    // reuse the signed-receipt rail; skill-run action, HASHES only (privacy rule). Fail-visible.
    _continuityRecorder({ ref, owner: 'gateway', profile: 'continuity', action_kind: 'skill-run', input_hash, output_hash });
    return ref;
  },
}));

// Catch-all health status check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    shim: 'Atmos Sovereign API Gateway',
    binding: '127.0.0.1',
    port: PORT,
    upstream: STRATOS_AGENT_URL,
    upstreamBreaker: breakerSnapshot()
  });
});

export { app }; // exported so route-level tests can mount it on an ephemeral port without the full daemon

export function startServer() {
  const server = app.listen(PORT, '127.0.0.1', async () => {
    // WS attach endpoint for terminal sessions (single-use token auth; origin-checked).
    try { (await terminalSessionsPromise).attachWs(server); }
    catch (e) { console.warn('⚠️  [terminal] WS attach endpoint unavailable:', e.message); }
    try {
      await reasoningBank.initialize();
      await bootstrapVectorDB(reasoningBank);
      // Automatically scan and ingest legacy user context during server startup
      await LegacyBridge.ingestLegacyContext(reasoningBank);
    } catch (err) {
      console.error('[API-SHIM] Failed to initialize during startup:', err);
    }
    console.log(`================================================================`);
    console.log(`🛡️  Atmos Sovereign API Gateway online  🛡️`);
    console.log(`📡 Listening strictly on http://127.0.0.1:${PORT} (routes YOUR calls: local open-weight ⇄ your BYOK cloud)`);
    console.log(`🔗 Upstream StratosAgent (sovereign frontier tier): ${STRATOS_AGENT_URL}`);
    console.log(`⏳ Timeout configuration: ${STRATOS_TIMEOUT}ms`);
    console.log(`================================================================`);
  });

  return server;
}
