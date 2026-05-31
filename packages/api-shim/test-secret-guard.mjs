/**
 * secret-guard unit tests — detection + redaction of key-shaped strings. Pure (no fs/network).
 * Uses fabricated, non-functional key-shaped tokens only.
 */
import assert from 'node:assert';
import { scanForSecrets, redactSecrets, SECRET_REFUSAL } from './src/secret-guard.js';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

console.log('=== scanForSecrets (detect) ===');
ok(scanForSecrets('my key is sk-ant-api03-AAAABBBBCCCCDDDDEEEE here'), 'detects Anthropic sk-ant-…');
ok(scanForSecrets('OPENAI=sk-proj-AAAABBBBCCCCDDDDEEEEFFFF'), 'detects OpenAI sk-proj-…');
ok(scanForSecrets('use AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'detects Google AIza…');
ok(scanForSecrets('token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'detects GitHub PAT ghp_…');
ok(scanForSecrets('xoxb-1111111111-AAAAAAAAAAAA'), 'detects Slack xoxb-…');
ok(scanForSecrets('AKIAIOSFODNN7EXAMPLE'), 'detects AWS AKIA…');
ok(scanForSecrets('-----BEGIN RSA PRIVATE KEY-----'), 'detects PEM private key header');
ok(scanForSecrets('eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT4'), 'detects JWT');

console.log('\n=== broadened coverage (Codex: "filter narrower than the policy") ===');
ok(scanForSecrets('bot token 8213853174:AAH1bQwErTyUiOpAsDfGhJkLzXcVbNmQwEr'), 'detects Telegram bot token id:secret');
ok(scanForSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'), 'detects generic Bearer credential');
ok(scanForSecrets('sk_live_AAAABBBBCCCCDDDDEEEEFFFF'), 'detects Stripe live secret key');
ok(scanForSecrets('hf_AAAABBBBCCCCDDDDEEEEFFFFGGGG'), 'detects Hugging Face token');
ok(scanForSecrets('glpat-AAAABBBBCCCCDDDDEEEE'), 'detects GitLab PAT');
ok(scanForSecrets('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), 'detects AWS secret access key (contextual assignment)');
ok(scanForSecrets('api_key: AAAABBBBCCCCDDDDEEEEFFFF'), 'detects generic api_key assignment');
ok(!scanForSecrets('the bearer of bad news arrived at noon'), 'prose "bearer of …" → not flagged (low FP)');
ok(!scanForSecrets('my secret is that I love pizza'), 'prose "secret is that…" → not flagged (no assignment)');

console.log('\n=== scanForSecrets (no false positive on ordinary chat) ===');
ok(!scanForSecrets('call yourself Atlas and use gemma2:9b'), 'ordinary config message → not flagged');
ok(!scanForSecrets('what can you do?'), 'plain question → not flagged');
ok(!scanForSecrets(''), 'empty → not flagged');
ok(!scanForSecrets(null), 'null → not flagged (no throw)');

console.log('\n=== /g lastIndex statefulness — repeated calls stay correct ===');
const s = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEE';
ok(scanForSecrets(s) && scanForSecrets(s) && scanForSecrets(s), 'same secret detected on every repeated call (match, not test)');

console.log('\n=== redactSecrets ===');
const red = redactSecrets('here sk-ant-api03-AAAABBBBCCCCDDDDEEEE and ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA done');
ok(!scanForSecrets(red), 'redacted output no longer contains any secret');
ok(red.includes('«redacted-secret»'), 'redaction marker present');
ok(typeof SECRET_REFUSAL === 'string' && SECRET_REFUSAL.length > 20, 'SECRET_REFUSAL message exported');

console.log(`\n✅ ALL ${pass} secret-guard checks passed.`);
