/**
 * test-claim-lint.mjs — hermetic test for the honesty/claim gate (#77).
 * tmpdir fixtures, no network. Each banned class is caught; clean + allow-marked text passes;
 * out-of-scope dirs are not scanned.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintClaims, BANNED } from './claim-lint.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claimlint-'));
const w = (rel, txt) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };

// Fixture surfaces
w('README.md', [
  'Atmosphere is your second brain for AI.',                      // banned (ADR-0002)
  'The bot used qwen-2.5-vlm-telegram-local under the hood.',     // banned fake id
  'Buy the AI Sovereignty Audit today!',                          // banned (not marked legacy)
  'Counts are pulled in real time from GitHub.',                  // banned unconditional real-time
  'The AI Sovereignty Audit is deprecated (legacy).',             // OK — marked legacy
  'We retired the term "second brain" — see ADR-0002. claim-lint:allow', // OK — allow marker
  'Atmosphere stores context, decisions, skills, and trust.',     // clean
].join('\n'));
w('docs/doctrine/VISION.md', 'Own your intelligence.\n');          // clean file in scoped dir
w('docs/operating/REMEDIATION.md', 'finding: "second brain" used'); // OUT of scope — must not be scanned

const v = lintClaims({ root, surfaces: ['README.md', 'docs/doctrine'] });

// Exactly the 4 violating lines, none from the legacy-marked/allowed/clean lines:
assert.equal(v.length, 4, `expected 4 violations, got ${v.length}: ${JSON.stringify(v, null, 1)}`);
assert.ok(v.some((x) => /second brain/i.test(x.text) && x.line === 1), 'second-brain caught');
assert.ok(v.some((x) => x.line === 2), 'fake model id caught');
assert.ok(v.some((x) => x.line === 3), 'non-legacy audit offer caught');
assert.ok(v.some((x) => x.line === 4), 'unconditional real-time caught');
assert.ok(!v.some((x) => x.line === 5), 'legacy-marked audit mention allowed');
assert.ok(!v.some((x) => x.line === 6), 'claim-lint:allow marker honored');
assert.ok(!v.some((x) => x.file.includes('operating')), 'out-of-scope dirs not scanned');

// Out-of-scope surface entirely ignored even if passed root has it:
const v2 = lintClaims({ root, surfaces: ['docs/doctrine'] });
assert.equal(v2.length, 0, 'doctrine fixture is clean');

// Banned list sanity: every rule has a why.
for (const b of BANNED) assert.ok(b.why && b.re instanceof RegExp);

fs.rmSync(root, { recursive: true, force: true });
console.log('  ✓ claim-lint: all banned classes caught; legacy/allow/clean pass; scope respected');
