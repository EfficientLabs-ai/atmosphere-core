/**
 * test-terminal-sessions.mjs — Atmos Terminal slice 2 (PTY sessions). Hermetic: an injected fake
 * PTY backend (node-pty never loaded), injected clock, tmp profile dirs, ephemeral ports.
 *
 * Proves: sanitized spawn (allowlist env — the gateway secret NEVER reaches a shell; jailed cwd),
 * profile validation (default/agent/tmux name), per-owner cap, SINGLE-USE short-expiry attach
 * tokens, ownership enforcement, ring-buffer replay on re-attach, flow-control pause/ack/resume
 * (laggard detach resumes), idle reaping, kill→end receipt, the WS attach endpoint end-to-end
 * (origin check, input/resize/ack/ping frames, detach on close), and SIGNED term-session receipts
 * that verify on the real chain.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createSessionManager, sanitizedEnv } from './src/terminal/session-manager.js';
import { createSessionRouter, attachTerminalWs, makeSessionReceiptRecorder } from './src/terminal/terminal-sessions.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'term-pty-'));
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`  ✓ ${name}`); pass++; });

console.log('terminal sessions — sanitized, owned, metered, receipted\n');

// ── fake PTY backend ─────────────────────────────────────────────────────────────────────────
function makeFakePtyBackend() {
  const spawned = [];
  const spawnPty = (spec) => {
    const pty = {
      spec, writes: [], resizes: [], pausedCount: 0, resumedCount: 0, killed: null,
      _data: null, _exit: null,
      onData(cb) { this._data = cb; },
      onExit(cb) { this._exit = cb; },
      write(d) { this.writes.push(d); },
      resize(c, r) { this.resizes.push([c, r]); },
      pause() { this.pausedCount++; },
      resume() { this.resumedCount++; },
      kill(sig) { this.killed = sig; this._exit?.({ exitCode: 0 }); },
      emit(d) { this._data?.(d); },
    };
    spawned.push(pty);
    return pty;
  };
  return { spawned, spawnPty };
}

const WORK = tmp();
fs.mkdirSync(path.join(WORK, 'proj'));

function makeManager(extra = {}) {
  const backend = makeFakePtyBackend();
  const events = [];
  let t = 1_000_000;
  const clock = { now: () => t, tick: (ms) => { t += ms; } };
  const mgr = createSessionManager({
    spawnPty: backend.spawnPty,
    recordEvent: (e) => events.push(e),
    workspaceRoot: WORK,
    now: clock.now,
    envSource: { PATH: '/usr/bin', HOME: '/home/x', SHELL: '/bin/bash', ATMOS_GATEWAY_SECRET: 'must-never-leak', AWS_SECRET_ACCESS_KEY: 'nope' },
    idleMs: 10_000,
    maxPerOwner: 2,
    highWater: 1000,
    ringBytes: 64,
    tokenTtlMs: 5_000,
    ...extra,
  });
  return { mgr, backend, events, clock };
}

await ok('create(default): jailed cwd, login shell, ALLOWLIST env — the secret never reaches the shell', () => {
  const { mgr, backend, events } = makeManager();
  const { id, attachToken } = mgr.create({ owner: 'gateway', cwd: 'proj' });
  assert.ok(id && attachToken);
  const spec = backend.spawned[0].spec;
  assert.strictEqual(spec.file, '/bin/bash');
  assert.deepStrictEqual(spec.args, ['-l']);
  assert.strictEqual(spec.cwd, fs.realpathSync(path.join(WORK, 'proj')));
  assert.strictEqual(spec.env.ATMOS_GATEWAY_SECRET, undefined, 'gateway secret must never be inherited');
  assert.strictEqual(spec.env.AWS_SECRET_ACCESS_KEY, undefined, 'allowlist, not blocklist');
  assert.strictEqual(spec.env.PATH, '/usr/bin');
  assert.strictEqual(events[0].event, 'term.session.start');
});

await ok('sanitizedEnv: allowlist only, TERM defaulted', () => {
  const env = sanitizedEnv({ PATH: '/p', SECRET_THING: 'x', ATMOS_GATEWAY_SECRET: 'y' });
  assert.deepStrictEqual(Object.keys(env).sort(), ['PATH', 'TERM']);
});

await ok('profiles: agent=tmux attach with validated name; junk profiles/names refused', () => {
  const { mgr, backend } = makeManager();
  mgr.create({ owner: 'gateway', profile: 'agent', tmuxSession: 'claude' });
  const spec = backend.spawned[0].spec;
  assert.strictEqual(spec.file, 'tmux');
  assert.deepStrictEqual(spec.args, ['attach-session', '-t', 'claude']);
  assert.throws(() => mgr.create({ owner: 'gateway', profile: 'agent', tmuxSession: 'x; rm -rf /' }), /valid tmuxSession/);
  assert.throws(() => mgr.create({ owner: 'gateway', profile: 'root' }), /unknown profile/);
});

await ok('cwd jail + per-owner cap', () => {
  const { mgr } = makeManager();
  assert.throws(() => mgr.create({ owner: 'gateway', cwd: '../../etc' }), (e) => e.code === 403);
  mgr.create({ owner: 'gateway' });
  mgr.create({ owner: 'gateway' });
  assert.throws(() => mgr.create({ owner: 'gateway' }), (e) => e.code === 429);
});

await ok('attach tokens: single-use, expiring, owner-bound; ring replays on re-attach', () => {
  const { mgr, backend, clock } = makeManager();
  const { id, attachToken } = mgr.create({ owner: 'gateway' });
  backend.spawned[0].emit('early output ');
  const sink = { sent: [], send(d) { this.sent.push(d); }, close() {} };
  const conn = mgr.attach(id, attachToken, sink, 'gateway');
  assert.strictEqual(sink.sent[0], 'early output ', 'ring replayed');
  assert.throws(() => mgr.attach(id, attachToken, sink, 'gateway'), (e) => e.code === 401, 'single-use');
  const t2 = mgr.reissueToken(id, 'gateway');
  assert.throws(() => mgr.attach(id, t2, sink, 'intruder'), (e) => e.code === 403, 'owner-only');
  clock.tick(6_000); // past tokenTtl
  assert.throws(() => mgr.attach(id, t2, sink, 'gateway'), (e) => e.code === 401, 'expired');
  conn.input('ls\n');
  assert.deepStrictEqual(backend.spawned[0].writes, ['ls\n']);
});

await ok('ring buffer is BOUNDED (old output evicted)', () => {
  const { mgr, backend } = makeManager(); // ringBytes 64
  const { id } = mgr.create({ owner: 'gateway' });
  for (let i = 0; i < 10; i++) backend.spawned[0].emit('0123456789abcdef'); // 160 bytes
  const t = mgr.reissueToken(id, 'gateway');
  const sink = { sent: [], send(d) { this.sent.push(d); }, close() {} };
  mgr.attach(id, t, sink, 'gateway');
  assert.ok(sink.sent.join('').length <= 64 + 16, 'replay bounded by ringBytes (+1 chunk granularity)');
});

await ok('flow control: unacked > highWater pauses the PTY; ack resumes; laggard detach resumes', () => {
  const { mgr, backend } = makeManager(); // highWater 1000
  const { id, attachToken } = mgr.create({ owner: 'gateway' });
  const sink = { sent: [], send(d) { this.sent.push(d); }, close() {} };
  const conn = mgr.attach(id, attachToken, sink, 'gateway');
  const pty = backend.spawned[0];
  pty.emit('x'.repeat(1500));
  assert.strictEqual(pty.pausedCount, 1, 'paused past high water');
  conn.ack(1500);
  assert.strictEqual(pty.resumedCount, 1, 'ack resumes');
  pty.emit('y'.repeat(1500));
  assert.strictEqual(pty.pausedCount, 2);
  conn.detach(); // the laggard leaves — PTY must not stay paused forever
  assert.strictEqual(pty.resumedCount, 2, 'laggard detach resumes');
});

await ok('idle reaper kills unattended sessions; end receipt carries exit + duration', () => {
  const { mgr, backend, events, clock } = makeManager(); // idleMs 10s
  const { id } = mgr.create({ owner: 'gateway' });
  clock.tick(11_000);
  const reaped = mgr.reapIdle();
  assert.deepStrictEqual(reaped, [id]);
  assert.strictEqual(backend.spawned[0].killed, 'SIGHUP');
  const end = events.find((e) => e.event === 'term.session.end');
  assert.ok(end && end.session_id === id && typeof end.duration_ms === 'number');
});

await ok('kill: owner-only; list reflects lifecycle', () => {
  const { mgr, events } = makeManager();
  const { id } = mgr.create({ owner: 'gateway' });
  assert.throws(() => mgr.kill(id, 'intruder'), (e) => e.code === 403);
  mgr.kill(id, 'gateway');
  const [row] = mgr.list('gateway');
  assert.strictEqual(row.exited, true);
  assert.ok(events.some((e) => e.event === 'term.session.end'));
});

await ok('WS end-to-end: token attach, frames, origin check, detach on close — and DENIALS persist safely', async () => {
  const WS_PROFILE = tmp();
  const savedProfile = process.env.STRATOS_PROFILE_DIR;
  const savedOrigins = process.env.ATMOS_GATEWAY_ORIGINS;
  process.env.STRATOS_PROFILE_DIR = WS_PROFILE; // recordDenial resolves the sink per call
  delete process.env.ATMOS_GATEWAY_ORIGINS; // hermetic: an ambient allowlist must not admit the evil origin
  const wsSink = () => {
    const f = path.join(WS_PROFILE, 'denial-audit.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.gate === 'terminal-ws') : [];
  };
  const { mgr, backend } = makeManager();
  const app = express();
  app.use('/term', createSessionRouter(mgr, { ptyAvailable: () => true }));
  const server = http.createServer(app);
  await attachTerminalWs(server, mgr);
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const fetch_ = (await import('node-fetch')).default;
  const created = await (await fetch_(`http://127.0.0.1:${port}/term/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.ok(created.sessionId && created.attachToken);

  const wsMod = await import('ws');
  const WebSocket = wsMod.WebSocket || wsMod.default;
  // disallowed browser origin → upgrade refused
  const evil = new WebSocket(`ws://127.0.0.1:${port}/term/attach?session=${created.sessionId}&token=${created.attachToken}`, { headers: { origin: 'https://evil.example' } });
  await new Promise((r) => evil.once('error', r)); // 403 surfaces as an error event

  const ws = new WebSocket(`ws://127.0.0.1:${port}/term/attach?session=${created.sessionId}&token=${created.attachToken}`);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ t: 'input', data: 'echo hi\n' }));
  ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
  ws.send(JSON.stringify({ t: 'ping' }));
  backend.spawned[0].emit('hi\n');
  await new Promise((r) => setTimeout(r, 150));
  assert.deepStrictEqual(backend.spawned[0].writes, ['echo hi\n']);
  assert.deepStrictEqual(backend.spawned[0].resizes, [[120, 40]]);
  assert.ok(frames.some((f) => f.t === 'pong'));
  assert.ok(frames.some((f) => f.t === 'data' && f.data === 'hi\n'));
  // bad token rejected at upgrade-accept time (single-use: it was redeemed by the live ws)
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/term/attach?session=${created.sessionId}&token=${created.attachToken}`);
  const closeCode = await new Promise((r) => ws2.once('close', (c) => r(c)));
  assert.strictEqual(closeCode, 4401, 'redeemed token → policy close code');
  // SWAPPED-URL attack (Codex finding): session=<64-hex attach token> must never persist as target
  const fakeToken = 'a'.repeat(64);
  const ws3 = new WebSocket(`ws://127.0.0.1:${port}/term/attach?session=${fakeToken}&token=x`);
  await new Promise((r) => ws3.once('close', r));
  const denials = wsSink();
  assert.ok(denials.some((e) => /un-allowlisted browser origin/.test(e.reason)), 'origin refusal persisted (gate terminal-ws)');
  assert.ok(denials.some((e) => e.action === 'attach' && e.target === created.sessionId), 'redeemed-token denial carries the 16-hex session id');
  const swapped = denials.filter((e) => e.action === 'attach' && /no such session/.test(e.reason));
  assert.ok(swapped.length >= 1, 'swapped-URL denial recorded');
  assert.ok(swapped.every((e) => e.target === undefined), 'a non-16-hex session param NEVER persists as target');
  assert.ok(!JSON.stringify(denials).includes(fakeToken), 'the 64-hex value never reaches the sink anywhere');
  assert.ok(!JSON.stringify(denials).includes(created.attachToken), 'real attach tokens never reach the sink');
  ws.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(mgr._sessions.get(created.sessionId).clients.size, 0, 'detach on close');
  server.close();
  if (savedProfile === undefined) delete process.env.STRATOS_PROFILE_DIR; else process.env.STRATOS_PROFILE_DIR = savedProfile;
  if (savedOrigins === undefined) delete process.env.ATMOS_GATEWAY_ORIGINS; else process.env.ATMOS_GATEWAY_ORIGINS = savedOrigins;
});

await ok('receipts: term-session events SIGN onto the real chain and verify end-to-end', async () => {
  const PROFILE = tmp();
  process.env.STRATOS_PROFILE_DIR = PROFILE; // recorder resolves keys+log from the profile
  try {
    const record = makeSessionReceiptRecorder({ profileDir: PROFILE });
    await record({ event: 'term.session.start', session_id: 'abc', owner: 'gateway', profile: 'default', cwd: '/x' });
    await record({ event: 'term.session.end', session_id: 'abc', owner: 'gateway', profile: 'default', exit_code: 0 });
    const { ReceiptLog, makeReceiptVerifier } = await import('../stratos-agent/src/ledger/capability-receipt.js');
    const raw = JSON.parse(fs.readFileSync(path.join(PROFILE, 'node-keys.json'), 'utf8'));
    const pub = Object.fromEntries(Object.entries(raw.publicKey).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
    const log = new ReceiptLog({ verifier: makeReceiptVerifier(pub) });
    log.chain = ReceiptLog.loadChainEntries(path.join(PROFILE, 'live-receipts.jsonl'));
    assert.strictEqual(log.chain.length, 2);
    assert.ok(log.chain.every((r) => r.action === 'term-session'));
    assert.strictEqual(log.chain[0].ref, 'term.session.start:abc');
    const v = log.verify();
    assert.strictEqual(v.ok, true, 'signed term-session receipts verify: ' + (v.reason || ''));
  } finally { delete process.env.STRATOS_PROFILE_DIR; }
});

await ok('HARD ring bound: one oversized chunk is tail-sliced, never retained whole', () => {
  const { mgr, backend } = makeManager(); // ringBytes 64
  const { id } = mgr.create({ owner: 'gateway' });
  backend.spawned[0].emit('A'.repeat(500) + 'TAIL-MARKER');
  const t = mgr.reissueToken(id, 'gateway');
  const sink = { sent: [], send(d) { this.sent.push(d); }, close() {} };
  mgr.attach(id, t, sink, 'gateway');
  const replay = sink.sent.join('');
  assert.ok(replay.length <= 64, `replay hard-bounded, got ${replay.length}`);
  assert.ok(replay.endsWith('TAIL-MARKER'), 'the NEWEST bytes are kept');
});

await ok('exited sessions are GC\'d after the grace window (create→kill churn cannot grow memory)', () => {
  const { mgr, clock } = makeManager();
  const { id } = mgr.create({ owner: 'gateway' });
  mgr.kill(id, 'gateway');
  assert.ok(mgr._sessions.has(id), 'fresh exit still listed (grace)');
  assert.strictEqual(mgr._sessions.get(id).ringSize, 0, 'dead session holds no replay memory');
  clock.tick(61_000);
  mgr.reapIdle();
  assert.ok(!mgr._sessions.has(id), 'GC after grace');
});

await ok('no spurious detach receipts: close-after-end and double-detach are silent', () => {
  const { mgr, backend, events } = makeManager();
  const { id, attachToken } = mgr.create({ owner: 'gateway' });
  const conn = mgr.attach(id, attachToken, { send() {}, close() {} }, 'gateway');
  backend.spawned[0].kill('SIGHUP'); // session ends while attached → clients cleared by end path
  conn.detach(); conn.detach();      // ws 'close' + 'error' both firing afterwards
  const seq = events.map((e) => e.event);
  assert.deepStrictEqual(seq, ['term.session.start', 'term.session.attach', 'term.session.end'], 'no detach after end, no doubles: ' + seq.join(','));
});

await ok('receipt recorder serializes concurrent first events — one keypair, intact chain', async () => {
  const PROFILE = tmp();
  const record = makeSessionReceiptRecorder({ profileDir: PROFILE });
  await Promise.all([
    record({ event: 'term.session.start', session_id: 'r1', owner: 'gateway', profile: 'default' }),
    record({ event: 'term.session.attach', session_id: 'r1', owner: 'gateway', profile: 'default' }),
    record({ event: 'term.session.end', session_id: 'r1', owner: 'gateway', profile: 'default' }),
  ]);
  const { ReceiptLog, makeReceiptVerifier } = await import('../stratos-agent/src/ledger/capability-receipt.js');
  const raw = JSON.parse(fs.readFileSync(path.join(PROFILE, 'node-keys.json'), 'utf8'));
  const pub = Object.fromEntries(Object.entries(raw.publicKey).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  const log = new ReceiptLog({ verifier: makeReceiptVerifier(pub) });
  log.chain = ReceiptLog.loadChainEntries(path.join(PROFILE, 'live-receipts.jsonl'));
  assert.strictEqual(log.chain.length, 3, 'all three landed');
  const v = log.verify();
  assert.strictEqual(v.ok, true, 'chain intact under concurrency: ' + (v.reason || ''));
});

await ok('unmatched WS upgrades are destroyed, not left dangling', async () => {
  const { mgr } = makeManager();
  const server = http.createServer((req, res) => res.end('ok'));
  await attachTerminalWs(server, mgr);
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const net = await import('node:net');
  const sock = net.connect(port, '127.0.0.1');
  sock.resume(); // flowing mode, or the server's FIN is never consumed and 'close' never fires
  await new Promise((r) => sock.once('connect', r));
  sock.write('GET /not-term HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  const closed = await new Promise((r) => { sock.once('close', () => r(true)); setTimeout(() => r(false), 2000); });
  assert.ok(closed, 'foreign upgrade socket destroyed');
  server.close();
});

assert.strictEqual(pass, 16, `expected all 16 tests, got ${pass}`);
console.log(`\n✅ ${pass}/16 terminal-session tests passed — sanitized, owned, metered, receipted.`);
process.exit(0); // ws/http handles may linger; assertions above are the truth
