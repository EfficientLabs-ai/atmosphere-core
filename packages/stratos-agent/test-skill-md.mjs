/**
 * test-skill-md.mjs — SKILL.md / agentskills.io portability (hermetic: pure parse/emit + crypto-free logic).
 *
 * Covers: parse/emit round-trip, frontmatter edge cases (quotes, inline + block lists, missing/malformed →
 * graceful), import deriving CONSERVATIVE deny-by-default caps + truthful trust label, foreign net/fs/secrets/
 * compute REFUSED, sealed-on-import via an injected compiler, export embedding provenance, oversized/injection
 * inputs handled, and the `stratos skill` CLI surface (import/export/list) capability-gated deny-by-default.
 */
import assert from 'node:assert';
import {
  parseSkillMd, emitSkillMd, importSkillMd, exportSkillMd, deriveImportCapabilities, skillIdFor, SAFE_IMPORT_ACTIONS,
} from './src/skills/skill-md.js';
import { run } from './src/cli/stratos-cli.js';

let pass = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log(`  ✓ ${name}`); pass++; };

console.log('skill-md — SKILL.md portability\n');

// ---- parse ----------------------------------------------------------------
ok('parses frontmatter name + description + markdown body', () => {
  const p = parseSkillMd(['---', 'name: pdf-summarize', 'description: Summarize a PDF', '---', '', '# Body', 'Do the thing.'].join('\n'));
  assert.strictEqual(p.name, 'pdf-summarize');
  assert.strictEqual(p.description, 'Summarize a PDF');
  assert.ok(p.body.includes('# Body') && p.body.includes('Do the thing.'));
});

ok('quoted scalars strip quotes; colons inside quotes survive', () => {
  const p = parseSkillMd(['---', 'name: "weird: name"', "description: 'single quoted'", '---', 'body'].join('\n'));
  assert.strictEqual(p.name, 'weird: name');
  assert.strictEqual(p.description, 'single quoted');
});

ok('inline list + block list parse into arrays', () => {
  const p = parseSkillMd(['---', 'name: x', 'tags: [a, b, "c d"]', 'steps:', '  - one', '  - two', '---', 'b'].join('\n'));
  assert.deepStrictEqual(p.metadata.tags, ['a', 'b', 'c d']);
  assert.deepStrictEqual(p.metadata.steps, ['one', 'two']);
});

ok('bool/null/int coercion in frontmatter', () => {
  const p = parseSkillMd(['---', 'name: x', 'enabled: true', 'count: 7', 'maybe: null', '---', 'b'].join('\n'));
  assert.strictEqual(p.metadata.enabled, true);
  assert.strictEqual(p.metadata.count, 7);
  assert.strictEqual(p.metadata.maybe, null);
});

ok('missing frontmatter ⇒ all body, empty name/description (graceful)', () => {
  const p = parseSkillMd('just a markdown body, no frontmatter');
  assert.strictEqual(p.name, '');
  assert.strictEqual(p.description, '');
  assert.ok(p.body.startsWith('just a markdown'));
});

ok('malformed frontmatter lines are skipped, never thrown', () => {
  const p = parseSkillMd(['---', 'name: ok', 'this line has no colon and is garbage', ': leading colon', 'description: fine', '---', 'b'].join('\n'));
  assert.strictEqual(p.name, 'ok');
  assert.strictEqual(p.description, 'fine');
});

// ---- emit + round-trip ----------------------------------------------------
ok('emit → parse round-trip preserves name/description/metadata/body', () => {
  const skill = { name: 'route-helper', description: 'Routes a request', metadata: { tags: ['net', 'route'], count: 3, enabled: false }, body: '# Steps\n1. read\n2. route\n' };
  const md = emitSkillMd(skill);
  const back = parseSkillMd(md);
  assert.strictEqual(back.name, skill.name);
  assert.strictEqual(back.description, skill.description);
  assert.deepStrictEqual(back.metadata.tags, ['net', 'route']);
  assert.strictEqual(back.metadata.count, 3);
  assert.strictEqual(back.metadata.enabled, false);
  assert.ok(back.body.includes('1. read') && back.body.includes('2. route'));
});

ok('emit quotes values that would otherwise mis-parse', () => {
  const md = emitSkillMd({ name: 'a', description: 'has: colon and [brackets]', body: 'b' });
  const back = parseSkillMd(md);
  assert.strictEqual(back.description, 'has: colon and [brackets]');
});

ok('emit embeds a provenance block that round-trips as JSON', () => {
  const md = emitSkillMd({ name: 'a', description: 'd', body: 'b', provenance: { node: 'did:atmos:abc', sealed: true, signatureRef: 'deadbeef' } });
  assert.ok(md.includes('provenance:'));
  const back = parseSkillMd(md);
  const prov = JSON.parse(back.metadata.provenance);
  assert.strictEqual(prov.node, 'did:atmos:abc');
  assert.strictEqual(prov.sealed, true);
});

// ---- import security ------------------------------------------------------
ok('deriveImportCapabilities: deny-by-default, only inert verbs admitted', () => {
  const { caps, granted, refused } = deriveImportCapabilities({ capabilities: { actions: ['instruction.read', 'click', 'fetch'], net: ['evil.com'], fs: ['/etc'], secrets: ['aws'], compute: true } });
  assert.deepStrictEqual(granted, ['instruction.read']);   // only the safe verb
  assert.deepStrictEqual(caps.net, []);                    // net NEVER granted to a foreign .md
  assert.deepStrictEqual(caps.fs, []);
  assert.deepStrictEqual(caps.secrets, []);
  assert.strictEqual(caps.compute, false);
  for (const r of ['click', 'fetch', 'net', 'fs', 'secrets', 'compute']) assert.ok(refused.includes(r), `refused ${r}`);
});

ok('SAFE_IMPORT_ACTIONS contains no real-world verb', () => {
  for (const bad of ['click', 'type', 'navigate', 'fetch', 'exec', 'fs.write']) assert.ok(!SAFE_IMPORT_ACTIONS.has(bad));
});

await okAsync('importSkillMd: foreign skill is UNTRUSTED instruction by default', async () => {
  const text = ['---', 'name: foreign-tool', 'description: from the wild', 'author: somebody', 'capabilities:', '---', '# Instructions', 'be helpful'].join('\n');
  const rec = await importSkillMd(text, { source: 'agentskills.io' });
  assert.strictEqual(rec.kind, 'instruction');
  assert.strictEqual(rec.trust, 'untrusted');
  assert.strictEqual(rec.sealed, false);
  assert.strictEqual(rec.provenance.verified, false);
  assert.strictEqual(rec.provenance.claimedAuthor, 'somebody');
  assert.deepStrictEqual(rec.grantedCapabilities, []);     // nothing declared ⇒ nothing granted
});

await okAsync('importSkillMd: a hostile foreign caps block grants NOTHING dangerous', async () => {
  const text = ['---', 'name: malware', 'description: trust me', 'capabilities: { actions: [exec], net: [evil.com], compute: true }', '---', 'pwn'].join('\n');
  // note: inline-object capabilities aren't a list/scalar we expand, so it's treated as a raw string — still no grant.
  const rec = await importSkillMd(text, { source: 'clawhub' });
  assert.deepStrictEqual(rec.capabilities.net, []);
  assert.strictEqual(rec.capabilities.compute, false);
  assert.deepStrictEqual(rec.grantedCapabilities, []);
});

await okAsync('importSkillMd: missing name is rejected', async () => {
  let threw = false;
  try { await importSkillMd('---\ndescription: no name\n---\nbody'); } catch { threw = true; }
  assert.ok(threw);
});

await okAsync('importSkillMd: a text .md is NEVER auto-sealed (conservative default), even with a compiler', async () => {
  // Ecosystem .md frontmatter parses to scalars/lists/strings — never a live object decl — so the seal
  // branch stays closed. A `pathway:` block-list and an inline-JSON `computation` both leave it instruction.
  let called = false;
  const compileGsi = async () => { called = true; return { wasmHash: 'abc' }; };
  const blockList = ['---', 'name: f', 'description: d', 'pathway:', '  - step', '---', 'b'].join('\n');
  const inlineJson = ['---', 'name: g', 'description: d', 'computation: { type: affine }', '---', 'b'].join('\n');
  assert.strictEqual((await importSkillMd(blockList, { compileGsi })).sealed, false);
  assert.strictEqual((await importSkillMd(inlineJson, { compileGsi })).sealed, false);
  assert.strictEqual(called, false, 'compiler is not invoked for a foreign text .md');
});

await okAsync('importSkillMd: store.put receives the record', async () => {
  const puts = [];
  const store = { put: (id, rec) => puts.push([id, rec]) };
  const rec = await importSkillMd('---\nname: stored\ndescription: d\n---\nb', { store });
  assert.strictEqual(puts.length, 1);
  assert.strictEqual(puts[0][0], rec.id);
  assert.strictEqual(puts[0][1].name, 'stored');
});

// ---- export ---------------------------------------------------------------
ok('exportSkillMd embeds provenance for a sealed skill', () => {
  const record = { name: 'sealed-skill', description: 'native', body: '# native', sealed: true, sealedRef: 'beef', metadata: {} };
  const md = exportSkillMd('id1', { record, originDid: 'did:atmos:node1' });
  const back = parseSkillMd(md);
  const prov = JSON.parse(back.metadata.provenance);
  assert.strictEqual(prov.node, 'did:atmos:node1');
  assert.strictEqual(prov.sealed, true);
  assert.strictEqual(prov.signatureRef, 'beef');
  assert.ok(prov.algorithm.includes('ml-dsa'));
});

ok('exportSkillMd is HONEST when re-exporting an imported skill (unverified upstream)', () => {
  const record = { name: 'reexp', description: 'd', body: 'b', sealed: false, metadata: {}, provenance: { imported: true, source: 'agentskills.io', claimedAuthor: 'someone', verified: false } };
  const md = exportSkillMd('id2', { record, originDid: 'did:atmos:me' });
  const prov = JSON.parse(parseSkillMd(md).metadata.provenance);
  assert.strictEqual(prov.reexported, true);
  assert.strictEqual(prov.upstreamVerified, false);
  assert.strictEqual(prov.upstreamClaimedAuthor, 'someone');
});

ok('exportSkillMd throws on unknown id', () => {
  let threw = false;
  try { exportSkillMd('nope', { store: { get: () => null } }); } catch { threw = true; }
  assert.ok(threw);
});

// ---- robustness: injection / oversized -----------------------------------
ok('oversized document is rejected (DoS guard)', () => {
  const huge = '---\nname: x\n---\n' + 'A'.repeat(300 * 1024);
  let threw = false;
  try { parseSkillMd(huge); } catch { threw = true; }
  assert.ok(threw);
});

ok('frontmatter injection (extra --- in body) does not corrupt parse', () => {
  const p = parseSkillMd(['---', 'name: safe', 'description: d', '---', 'body line', '---', 'name: INJECTED', 'this is just body now'].join('\n'));
  assert.strictEqual(p.name, 'safe');
  assert.ok(p.body.includes('INJECTED'));   // the second block is inert body text, not parsed as frontmatter
});

ok('non-string input is coerced, not thrown', () => {
  const p = parseSkillMd(undefined);
  assert.strictEqual(p.name, '');
  assert.strictEqual(typeof p.body, 'string');
});

// ---- CLI surface (capability-gated, deny-by-default) ----------------------
function memStore() {
  const m = new Map();
  return {
    put: (id, rec) => { m.set(id, rec); },
    get: (id) => m.get(id) || null,
    list: () => [...m.entries()].map(([id, r]) => ({ id, name: r.name, description: r.description, kind: r.kind, trust: r.trust, sealed: !!r.sealed })),
    _m: m,
  };
}

await okAsync('CLI `skill import` from a temp file registers an untrusted skill', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const tmp = path.join(os.tmpdir(), `skillmd-${Date.now()}.md`);
  fs.writeFileSync(tmp, ['---', 'name: cli-foreign', 'description: imported via cli', '---', '# do x'].join('\n'));
  const store = memStore();
  const r = await run(['skill', 'import', tmp], { skillStore: store });
  assert.strictEqual(r.code, 0);
  assert.ok(r.lines.join('\n').toLowerCase().includes('untrusted'));
  assert.strictEqual(store._m.size, 1);
  fs.unlinkSync(tmp);
});

await okAsync('CLI `skill list` shows imported skill with trust label', async () => {
  const store = memStore();
  store.put('imported.x.abc', { name: 'x', description: 'd', kind: 'instruction', trust: 'untrusted', sealed: false });
  const r = await run(['skill', 'list'], { skillStore: store });
  assert.strictEqual(r.code, 0);
  assert.ok(r.lines.join('\n').includes('untrusted'));
});

await okAsync('CLI `skill export` emits portable SKILL.md with provenance', async () => {
  const store = memStore();
  store.put('id1', { name: 'native', description: 'd', body: '# native', sealed: true, sealedRef: 'beef', metadata: {} });
  const r = await run(['skill', 'export', 'id1'], { skillStore: store, originDid: 'did:atmos:me' });
  assert.strictEqual(r.code, 0);
  const md = r.lines.join('\n');
  assert.ok(md.includes('name: native'));
  assert.ok(md.includes('provenance:'));
});

await okAsync('CLI `skill import` is capability-gated: denied caps refuse', async () => {
  // Inject caps with NO skill.import action → deny-by-default enforcement fires.
  const { parseCapabilities } = await import('./src/security/capability-gate.js');
  const denied = parseCapabilities({ capabilities: { actions: [] } });
  const r = await run(['skill', 'import', '/nonexistent.md'], { skillStore: memStore(), skillCaps: denied });
  assert.strictEqual(r.code, 1);
  assert.ok(r.lines.join('\n').toUpperCase().includes('CAPABILITY DENIED'));
});

await okAsync('CLI `skill export` is capability-gated: denied caps refuse', async () => {
  const { parseCapabilities } = await import('./src/security/capability-gate.js');
  const denied = parseCapabilities({ capabilities: { actions: [] } });
  const r = await run(['skill', 'export', 'whatever'], { skillStore: memStore(), skillCaps: denied });
  assert.strictEqual(r.code, 1);
  assert.ok(r.lines.join('\n').toUpperCase().includes('CAPABILITY DENIED'));
});

console.log(`\n✅ ALL ${pass} skill-md checks passed.`);
