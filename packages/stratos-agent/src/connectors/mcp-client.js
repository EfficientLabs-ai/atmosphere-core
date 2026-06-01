/**
 * mcp-client.js — a minimal, read-first JSON-RPC 2.0 client for Model Context Protocol servers (Task #12).
 *
 * Scope: protocol framing only (initialize → tools/list → tools/call). It is deliberately transport-
 * agnostic — a `transport.send(request) → Promise<response>` is injected — so prod uses a pinned stdio
 * sidecar (newline-delimited JSON over the child's stdin/stdout) while tests use an in-memory mock.
 *
 * SECURITY POSTURE (enforced by the BROKER, not here):
 *  - Auth is CONNECTION-level, set when the transport connects to its pinned server — it is NOT a per-call
 *    JSON-RPC parameter, so a malicious tool result can't echo it back. This client never logs auth.
 *  - This client does NOT decide which tools are exposed or whether a call is allowed — that's the
 *    broker's job (risk-tagging, capability token, write-approval). Keep policy out of the wire layer.
 */

export function createMcpClient({ transport, name = 'mcp' } = {}) {
  if (!transport || typeof transport.send !== 'function') throw new Error('mcp-client requires a transport with send()');
  let nextId = 1;
  let initialized = false;

  async function rpc(method, params) {
    const id = nextId++;
    const res = await transport.send({ jsonrpc: '2.0', id, method, params });
    if (!res || res.jsonrpc !== '2.0') throw new Error(`${name}: malformed JSON-RPC response to ${method}`);
    if (res.id !== id) throw new Error(`${name}: JSON-RPC id mismatch (sent ${id}, got ${res.id})`); // no response confusion
    if (res.error) throw new Error(`${name}: ${method} → ${res.error.message || 'error ' + res.error.code}`);
    return res.result;
  }

  return {
    name,
    async initialize() {
      const r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stratos', version: '0' } });
      initialized = true;
      return r;
    },
    async listTools() {
      if (!initialized) await this.initialize();
      const r = await rpc('tools/list', {});
      return Array.isArray(r?.tools) ? r.tools : [];
    },
    async callTool({ name: toolName, args = {} } = {}) {
      if (!initialized) await this.initialize();
      // auth is NOT sent here — the transport authenticated at connect time to its pinned server.
      return rpc('tools/call', { name: toolName, arguments: args });
    },
  };
}
