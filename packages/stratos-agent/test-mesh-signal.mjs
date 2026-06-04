// test-mesh-signal.mjs — the honest, file-backed mesh-availability signal. Deny-by-default; never
// invents peers; flips true only when a real fleet.json reports nodes>0 + cores>0.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { meshAvailable, readFleetState } from './src/routing/mesh-signal.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-'));
const fleet = path.join(tmp, 'fleet.json');
const write = (o) => fs.writeFileSync(fleet, JSON.stringify(o));

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
for (const k of ['STRATOS_MESH_AVAILABLE', 'STRATOS_FLEET']) delete process.env[k];

console.log('mesh signal — deny-by-default, never invents peers\n');

ok(meshAvailable({ path: fleet }) === false, 'no fleet.json → NOT available (the honest current state)');

write({ nodes: 0, cores: 0 });
ok(meshAvailable({ path: fleet }) === false, 'fleet with zero nodes → NOT available');

write({ nodes: 2, cores: 12 });
ok(meshAvailable({ path: fleet }) === true, 'fleet with 2 nodes / 12 cores → available');
ok(readFleetState({ path: fleet }).cores === 12, 'readFleetState surfaces the real self-reported cores');

ok(meshAvailable({ path: fleet, optIn: false }) === false, 'optIn:false forces NOT available even with a fleet');

fs.writeFileSync(fleet, '{ this is not json');
ok(meshAvailable({ path: fleet }) === false, 'corrupt fleet.json → NOT available (never throws)');

process.env.STRATOS_MESH_AVAILABLE = 'true';
ok(meshAvailable({ path: fleet }) === true, 'STRATOS_MESH_AVAILABLE=true hard override');
process.env.STRATOS_MESH_AVAILABLE = 'false';
write({ nodes: 9, cores: 99 });
ok(meshAvailable({ path: fleet }) === false, 'STRATOS_MESH_AVAILABLE=false overrides even a live fleet');
delete process.env.STRATOS_MESH_AVAILABLE;

console.log(`\n✅ ${pass}/${pass} — mesh signal is honest: false until a real fleet exists.`);
