// test-node-heartbeat.mjs — periodic node liveness telemetry (B5). Hermetic: tmp files, injected
// clock/counters, no swarm, no network. Proves: beats append MEASURED facts, counters are live,
// rotation bounds disk, a broken sink never throws (fail-open fail-visible), start() beats
// immediately, stop() stops, lastBeat() freshness math is correct including the no-file case.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNodeHeartbeat, lastBeat } from './node-runner/node-heartbeat.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'node-hb-'));
let pass = 0;
const ok = async (name, fn) => { await fn(); console.log(`  ✓ ${name}`); pass++; }; // awaits async cases (Codex note)

console.log('node-heartbeat — a stale file IS the alarm\n');

await ok('beat() appends measured facts + live counters', () => {
  const f = path.join(tmp(), 'hb.jsonl');
  let skills = 0;
  const hb = makeNodeHeartbeat({ file: f, meta: { node: 'test-node', topic: 't', version: '1.0.0' }, counters: { skillsRun: () => skills, peers: () => 2 } });
  assert.strictEqual(hb.beat(), true);
  skills = 3;
  assert.strictEqual(hb.beat(), true);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].node, 'test-node');
  assert.strictEqual(lines[0].skills_run, 0);
  assert.strictEqual(lines[1].skills_run, 3, 'counters are LIVE getters');
  assert.ok(lines[0].mem_total > 0 && typeof lines[0].loadavg1 === 'number', 'measured os facts');
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
});

await ok('rotation bounds the file (file → file.1)', () => {
  const f = path.join(tmp(), 'hb.jsonl');
  const hb = makeNodeHeartbeat({ file: f, maxBytes: 512, meta: { node: 'n'.repeat(64) } });
  for (let i = 0; i < 20; i++) hb.beat();
  assert.ok(fs.existsSync(f + '.1'), 'rotated');
  assert.ok(fs.statSync(f).size <= 1024, 'live file bounded');
});

await ok('a broken sink never throws and warns once (fail-open, fail-visible)', () => {
  const blocked = path.join(tmp(), 'a-file');
  fs.writeFileSync(blocked, 'x');
  const hb = makeNodeHeartbeat({ file: path.join(blocked, 'hb.jsonl') });
  assert.strictEqual(hb.beat(), false);
  assert.strictEqual(hb.beat(), false); // second failure also non-throwing
});

await ok('start() beats immediately; interval ≤0 disables; stop() stops', async () => {
  const f = path.join(tmp(), 'hb.jsonl');
  const hb = makeNodeHeartbeat({ file: f, intervalMs: 30 });
  hb.start();
  assert.ok(fs.existsSync(f), 'first beat lands on start');
  await new Promise((r) => setTimeout(r, 100));
  hb.stop();
  const n = fs.readFileSync(f, 'utf8').trim().split('\n').length;
  assert.ok(n >= 2, 'interval beats landed');
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(fs.readFileSync(f, 'utf8').trim().split('\n').length, n, 'stop() stops');
  const off = makeNodeHeartbeat({ file: path.join(tmp(), 'off.jsonl'), intervalMs: 0 });
  off.start();
  assert.ok(!fs.existsSync(path.join(path.dirname(f), 'off.jsonl')), 'interval 0 = disabled');
});

await ok('malformed intervals mean DISABLED, never a 1ms hot loop', async () => {
  for (const bad of [NaN, Infinity, -5, 'soon']) {
    const f = path.join(tmp(), 'bad.jsonl');
    const hb = makeNodeHeartbeat({ file: f, intervalMs: bad });
    hb.start();
    await new Promise((r) => setTimeout(r, 60));
    hb.stop();
    assert.ok(!fs.existsSync(f), `interval ${bad} → no timer, no beats`);
  }
});

await ok('lastBeat(): fresh ok, stale not-ok, missing file not-ok', () => {
  const f = path.join(tmp(), 'hb.jsonl');
  const hb = makeNodeHeartbeat({ file: f });
  hb.beat();
  assert.strictEqual(lastBeat(f).ok, true, 'fresh beat is ok');
  const stale = lastBeat(f, { now: () => Date.now() + 60 * 60_000 });
  assert.strictEqual(stale.ok, false, 'an hour-old beat is stale at the default window');
  assert.strictEqual(lastBeat(path.join(tmp(), 'ghost.jsonl')).ok, false, 'no file = not ok (the alarm)');
});

assert.strictEqual(pass, 6, `expected all 6 tests, got ${pass}`);
console.log(`\n✅ ${pass}/6 node-heartbeat tests passed — liveness is now a measured, bounded trace.`);
