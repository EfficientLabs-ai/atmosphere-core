/**
 * StratosAgent Upstream — the "frontier reasoning tier" the api-shim routes
 * complex/cloud-classified prompts to (STRATOS_AGENT_URL, default :5001).
 *
 * Historically :5001 was an unimplemented placeholder, so cloud-routed prompts
 * hit ECONNREFUSED. This is a minimal, sovereign-consistent implementation:
 * it presents the OpenAI-compatible surface the bridge expects and serves it
 * from the LOCAL open-weights model (Ollama qwen2.5:7b) — no external cloud,
 * no API keys, no egress. Repoint UPSTREAM_MODEL_URL at a true frontier
 * endpoint later to get genuine cloud routing without touching the bridge.
 */
import express from 'express';

const PORT = parseInt(process.env.STRATOS_UPSTREAM_PORT || '5001', 10);
const HOST = process.env.STRATOS_UPSTREAM_HOST || '127.0.0.1';
const MODEL_URL = process.env.UPSTREAM_MODEL_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.UPSTREAM_MODEL || 'qwen2.5:7b';

const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', tier: 'stratos-agent-upstream', backing: MODEL });
});

app.post('/v1/chat/completions', async (req, res) => {
  const { messages = [], stream = false } = req.body || {};
  console.log(`🛰️  [StratosAgent] Frontier-tier request received (${messages.length} msgs, stream=${stream}). Backing: ${MODEL}.`);

  // Prepend a tier marker so frontier-routed replies are distinguishable from
  // the bridge's direct local route, while still served by the sovereign model.
  const augmented = [
    { role: 'system', content: 'You are the StratosAgent frontier reasoning tier. Answer with rigorous, step-by-step reasoning.' },
    ...messages
  ];

  try {
    const upstream = await fetch(`${MODEL_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: augmented, stream: false })
    });
    if (!upstream.ok) {
      const body = await upstream.text();
      console.warn(`⚠️  [StratosAgent] Backing model returned ${upstream.status}.`);
      return res.status(502).json({ error: { message: `StratosAgent backing model error: ${upstream.status} ${body.slice(0, 200)}` } });
    }
    const data = await upstream.json();
    if (data && data.model) data.model = 'stratos-agent-frontier';
    console.log('✅ [StratosAgent] Frontier completion served.');
    return res.json(data);
  } catch (err) {
    console.error('❌ [StratosAgent] Backing model unreachable:', err.message);
    return res.status(502).json({ error: { message: `StratosAgent backing model unreachable: ${err.message}` } });
  }
});

app.listen(PORT, HOST, () => {
  console.log('================================================================');
  console.log(`🛰️  StratosAgent Upstream (frontier tier) listening on http://${HOST}:${PORT}`);
  console.log(`🔗 Backing model: ${MODEL} via ${MODEL_URL}`);
  console.log('================================================================');
});
