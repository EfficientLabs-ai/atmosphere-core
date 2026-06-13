/**
 * test-gateway-cors.mjs — the loopback gateway CORS policy (server.js:104).
 * Locks the security-relevant behavior of the EXACT option expression used in server.js:
 *   origin = ATMOS_GATEWAY_ORIGINS ? <allowlist> : false
 * Cases:
 *   (a) env UNSET + browser Origin        → NO access-control-allow-origin header (the rebinding fix)
 *   (b) env UNSET + first-party (no Origin) → request still succeeds (server-to-server unaffected)
 *   (c) env SET + matching Origin          → ACAO reflects that origin (the console keeps working)
 *   (d) env SET + non-allowlisted Origin   → NO ACAO header
 */
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

// The exact expression from server.js — env read at construction, as in the file.
function corsAppFor(originsEnv) {
  const app = express();
  app.use(cors({ origin: originsEnv ? originsEnv.split(',').map((s) => s.trim()) : false }));
  app.get('/health', (req, res) => res.json({ ok: true }));
  return app;
}
function serve(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => s.close() }));
  });
}
const acao = (res) => res.headers.get('access-control-allow-origin');

console.log('gateway CORS policy (server.js:104)\n');

// (a) UNSET + browser Origin → no ACAO
{
  const { port, close } = await serve(corsAppFor(undefined));
  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'https://evil.example' } });
  ok(acao(res) === null, '(a) UNSET + browser Origin → no ACAO header (rebinding hole closed)');
  ok(res.status === 200, '(a) request itself still completes (CORS is a browser-enforced response header, not a server block)');
  close();
}
// (b) UNSET + first-party (no Origin) → succeeds, no ACAO needed
{
  const { port, close } = await serve(corsAppFor(undefined));
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  ok(res.status === 200 && body.ok === true, '(b) UNSET + no Origin (server-to-server) → unaffected');
  close();
}
// (c) SET + matching Origin → ACAO reflects it
{
  const allowed = 'https://app.efficientlabs.ai';
  const { port, close } = await serve(corsAppFor(allowed));
  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: allowed } });
  ok(acao(res) === allowed, '(c) SET + matching Origin → ACAO reflects the allowlisted origin');
  close();
}
// (d) SET + non-allowlisted Origin → no ACAO
{
  const { port, close } = await serve(corsAppFor('https://app.efficientlabs.ai'));
  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'https://evil.example' } });
  ok(acao(res) === null, '(d) SET + non-allowlisted Origin → no ACAO header');
  close();
}

console.log(`\n${fail ? '✖' : '✓'} gateway-cors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
