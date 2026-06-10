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

// New rules (#88/#95): live-qwen claim shapes caught; HISTORICAL/keyword mentions pass.
w('NORTH_STAR.md', [
  'round-trip verified: "double of 8" → qwen "16"',            // banned: arrow-qwen live shape
  'qwen2.5:7b is now running on the box',                       // banned: live-claim verb shape
  'served by the then-installed qwen2.5:7b; HISTORICAL — removed in task #43', // OK: no live shape
  'routing keywords include qwen/llama for compat',             // OK: keyword mention
].join('\n'));
const v3 = lintClaims({ root, surfaces: ['NORTH_STAR.md'] });
assert.equal(v3.length, 2, `qwen live shapes: want 2, got ${v3.length}: ${JSON.stringify(v3)}`);
assert.ok(v3.every((x) => /qwen/i.test(x.why)));

// Count reconciliation (#95): stale counts flagged against the real allowlist.
import { lintCounts, actualSuiteCount } from './claim-lint.mjs';
fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(root, 'scripts/ci-test.mjs'), "const S=['test-a.mjs','test-b.mjs','test-c.js'];");
assert.equal(actualSuiteCount(root), 3);
w('MODEL_ROUTING.md', ['covered by 99 hermetic tests', 'suite: 3 hermetic tests pass', 'historic note 77/77 suites claim-lint:allow'].join('\n'));
const vc = lintCounts({ root, surfaces: ['MODEL_ROUTING.md'] });
assert.equal(vc.length, 1, `want 1 stale count, got ${vc.length}: ${JSON.stringify(vc)}`);
assert.ok(/99/.test(vc[0].text) && /actually has 3/.test(vc[0].why));

// Banned list sanity: every rule has a why.
for (const b of BANNED) assert.ok(b.why && b.re instanceof RegExp);

fs.rmSync(root, { recursive: true, force: true });
console.log('  ✓ claim-lint: all banned classes caught; legacy/allow/clean pass; scope respected');
