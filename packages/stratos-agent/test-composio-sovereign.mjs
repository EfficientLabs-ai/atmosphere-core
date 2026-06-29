/**
 * Sovereign Composio adapter (Path A) tests — HERMETIC. Mocks the APP API (fetch), the vault, and the
 * broker is the real one (it IS the unit under test for "raw token never returned"). Asserts:
 *   - the toolkit loader reads the MIT catalog (1000 toolkits; github/gmail/slack executable)
 *   - getAction resolves the sovereign spec; unknown toolkit/action + catalog-only actions fail honestly
 *   - execution pulls the per-entity vaulted credential, mints a brokered assertion, calls the APP API
 *     (mocked) and returns the result — the RAW TOKEN is NEVER in the returned value
 *   - capability-gate denies an undeclared action (deny-by-default)
 *   - PER-ENTITY isolation: entity A's credential is never used for entity B
 *   - ZERO outbound to composio.dev — the executor only ever hits the APP host
 *   - GitHub end-to-end proof (PAT in vault → api.github.com/user → real-shaped result)
 *   - OAuth scaffold: authorizeUrl/exchangeCode hit the PROVIDER (not composio.dev), store per entity;
 *     unconfigured app fails honestly (operator must register the OAuth app)
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'composio-vault-'));
const PDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'composio-prof-'));
process.env.STRATOS_VAULT_DIR = VDIR;
process.env.STRATOS_PROFILE_DIR = PDIR;

// Clean-worktree reproducibility (ATM-SEC-001): the full ~17 MB MIT catalog under /services/ is
// gitignored, so a fresh checkout lacks it and the fail-hard loader would make `npm test`
// non-reproducible. When no explicit path is set AND the real catalog is absent, fall back to the
// committed CI fixture (the same one .github/workflows/ci.yml injects) so the suite stays hermetic.
// A dev box that still has the real catalog is unaffected.
if (!process.env.STRATOS_COMPOSIO_DATA) {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const realCatalog = path.resolve(HERE, '../../services/composio/docs/public/data/toolkits.json');
  if (!fs.existsSync(realCatalog)) {
    process.env.STRATOS_COMPOSIO_DATA = path.resolve(HERE, 'test/fixtures/composio-catalog.ci.json');
  }
}

const tk = await import('./src/integrations/composio-toolkits.js');
const { runToolAction, vaultConnectorFor, composioCapabilities } = await import('./src/integrations/composio-exec.js');
const creds = await import('./src/integrations/composio-credentials.js');
const oauth = await import('./src/integrations/composio-oauth.js');
const { IdentityBroker } = await import('./src/identity/identity-broker.js');
const { parseCapabilities } = await import('./src/security/capability-gate.js');
const reg = await import('./src/connectors/connector-registry.js');

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

// A vault-shim resolver: (connector, kind) -> token. Drives per-entity isolation directly.
const VAULT = new Map(); // `${connector}:${kind}` -> token
const resolveSecret = (connector, kind) => VAULT.get(`${connector}:${kind}`) || null;

console.log('=== TOOLKIT LOADER reads the MIT catalog ===');
const toolkits = tk.listToolkits();
ok(toolkits.length >= 1000, `MIT catalog loaded: ${toolkits.length} toolkits`);
ok(tk.executableToolkits().join(',') === 'github,gmail,slack', 'github, gmail, slack are executable to start');
const ghAct = tk.getAction('github', 'GITHUB_GET_THE_AUTHENTICATED_USER');
ok(ghAct.host === 'api.github.com' && ghAct.method === 'GET' && ghAct.scope === 'github:user:read', 'getAction → endpoint/method/authType/scope');
let threw = false; try { tk.getAction('github', 'GITHUB_ABORT_REPOSITORY_MIGRATION'); } catch { threw = true; }
ok(threw, 'a catalog-only action (no sovereign spec) fails honestly (we never fetch schemas from composio.dev)');
threw = false; try { tk.getAction('nope', 'X'); } catch { threw = true; }
ok(threw, 'unknown toolkit fails');

console.log('\n=== GITHUB END-TO-END: PAT in vault → api.github.com, token never exposed ===');
const SENTINEL = 'ghp_SENTINEL_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaa';
VAULT.set(`${vaultConnectorFor('alice', 'github')}:token`, SENTINEL);
let hitUrls = [];
const ghFetch = async (url, init) => {
  hitUrls.push(url);
  assert.ok(init.headers.Authorization === `Bearer ${SENTINEL}`, 'token IS placed in the egress header (broker-side)');
  return { status: 200, text: async () => JSON.stringify({ login: 'octocat', id: 583231 }) };
};
const r = await runToolAction({ entity: 'alice', toolkit: 'github', action: 'GITHUB_GET_THE_AUTHENTICATED_USER' }, { fetch: ghFetch, resolveSecret });
ok(r.ok && r.status === 200 && r.data.login === 'octocat', 'GitHub action returned a real-shaped result');
ok(hitUrls.length === 1 && hitUrls[0] === 'https://api.github.com/user', 'the ONLY host contacted is api.github.com');
ok(!JSON.stringify(r).includes(SENTINEL), 'the RAW TOKEN is NEVER in the returned value');
ok(r.brokered && r.brokered.aud === 'api.github.com' && r.brokered.scope.includes('github:user:read'), 'caller gets a BROKERED handle (aud-bound, scoped), not a key');
ok(r.brokered.exp > Math.floor(Date.now() / 1000), 'brokered assertion is short-lived (exp in the future)');

console.log('\n=== ZERO composio.dev: the executor only ever hits the APP host ===');
ok(hitUrls.every((u) => !/composio\.dev/i.test(u) && !/composio/i.test(new URL(u).host)), 'no composio host was contacted');

console.log('\n=== CAPABILITY-GATE deny-by-default (undeclared action refused) ===');
const deniedCaps = parseCapabilities({ capabilities: { net: [], actions: [] } }); // declares nothing
threw = false; let msg = '';
try { await runToolAction({ entity: 'alice', toolkit: 'github', action: 'GITHUB_GET_THE_AUTHENTICATED_USER' }, { fetch: ghFetch, resolveSecret, caps: deniedCaps }); }
catch (e) { threw = true; msg = e.message; }
ok(threw && /CAPABILITY DENIED/.test(msg), 'undeclared action is refused before any vault/network access');

console.log('\n=== PER-ENTITY ISOLATION: one entity\'s creds never used for another ===');
// alice has a github token; bob does NOT. Running as bob must fail (no resolve), never reuse alice's.
threw = false; let bobHit = false;
const spyFetch = async (url, init) => { bobHit = true; return ghFetch(url, init); };
try { await runToolAction({ entity: 'bob', toolkit: 'github', action: 'GITHUB_GET_THE_AUTHENTICATED_USER' }, { fetch: spyFetch, resolveSecret }); }
catch (e) { threw = true; msg = e.message; }
ok(threw && /no sovereign credential for entity "bob"/.test(msg), 'bob has no credential → refused (alice\'s token never leaks across entities)');
ok(!bobHit, 'no APP call was made for the uncredentialed entity');
// And the vault keys ARE namespaced per entity:
ok(vaultConnectorFor('alice', 'github') !== vaultConnectorFor('bob', 'github'), 'vault connector is per-entity namespaced');

console.log('\n=== SLACK-style {ok:false} surfaces as non-ok without leaking ===');
VAULT.set(`${vaultConnectorFor('alice', 'slack')}:oauth`, 'xoxb-FAKE-SLACK');
const slackFetch = async () => ({ status: 200, text: async () => JSON.stringify({ ok: false, error: 'not_in_channel' }) });
const sr = await runToolAction({ entity: 'alice', toolkit: 'slack', action: 'SLACK_SEND_MESSAGE', params: { channel: 'C1', text: 'hi' } }, { fetch: slackFetch, resolveSecret });
ok(sr.ok === false && sr.data.error === 'not_in_channel' && !JSON.stringify(sr).includes('xoxb-FAKE-SLACK'), 'app-level error surfaced; token not leaked');

console.log('\n=== INPUT VALIDATION (per-spec) ===');
threw = false; try { await runToolAction({ entity: 'alice', toolkit: 'slack', action: 'SLACK_SEND_MESSAGE', params: {} }, { fetch: slackFetch, resolveSecret }); } catch (e) { threw = true; msg = e.message; }
ok(threw && /needs `channel` and `text`/.test(msg), 'missing required params rejected before network');
threw = false; try { await runToolAction({ entity: 'bad id!', toolkit: 'github', action: 'GITHUB_GET_THE_AUTHENTICATED_USER' }, { fetch: ghFetch, resolveSecret }); } catch { threw = true; }
ok(threw, 'invalid entity id rejected');

console.log('\n=== REAL VAULT round-trip via composio-credentials (per-entity, encrypted at rest) ===');
const { handle } = creds.addEntityCredential('carol', 'github', 'ghp_CAROL_TOKEN_xxxxxxxxxxxxxxxxxxxx', 'token');
ok(/^cvault:composio_carol_github:token:/.test(handle), 'credential stored under per-entity vault connector');
ok(!fs.readFileSync(path.join(VDIR, 'vault.json'), 'utf8').includes('ghp_CAROL_TOKEN'), 'vault.json has NO plaintext token (AES-256-GCM)');
const carolResolve = creds.makeResolver();
ok(carolResolve(vaultConnectorFor('carol', 'github'), 'token') === 'ghp_CAROL_TOKEN_xxxxxxxxxxxxxxxxxxxx', 'broker-side resolve returns carol\'s token');
ok(carolResolve(vaultConnectorFor('dave', 'github'), 'token') === null, 'dave (different entity) resolves to null — isolation holds in the real vault');
ok(!JSON.stringify(creds.listEntityCredentials()).includes('ghp_CAROL_TOKEN'), 'listing is metadata-only');

console.log('\n=== OAUTH SCAFFOLD (Gmail/Slack): provider-only, operator must register the app ===');
threw = false; try { oauth.authorizeUrl('google', 'alice'); } catch (e) { threw = true; msg = e.message; }
ok(threw && /not configured/.test(msg), 'authorizeUrl refuses until the operator configures the OAuth app (no fake creds)');
oauth.setOAuthAppConfig('google', { clientId: 'CLIENT.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret', redirectUri: 'http://127.0.0.1:4099/oauth/callback' });
const au = oauth.authorizeUrl('google', 'alice');
ok(au.startsWith('https://accounts.google.com/o/oauth2/v2/auth') && !/composio/i.test(au), 'consent URL points at GOOGLE (provider), never composio.dev');
ok(oauth.entityFromState(new URL(au).searchParams.get('state')) === 'alice', 'state is entity-bound (anti cross-entity replay)');
let tokenUrl = null;
const oauthFetch = async (url) => { tokenUrl = url; return { status: 200, text: async () => JSON.stringify({ access_token: 'ya29.GMAIL_ACCESS', refresh_token: 'r' }) }; };
const ex = await oauth.exchangeCode('google', 'alice', 'authcode123', { fetch: oauthFetch });
ok(ex.stored && new URL(tokenUrl).host === 'oauth2.googleapis.com', 'token exchange hits the GOOGLE token endpoint (sovereign, not composio.dev)');
ok(creds.makeResolver()(vaultConnectorFor('alice', 'gmail'), 'oauth') === 'ya29.GMAIL_ACCESS', 'OAuth access token stored in OUR vault per entity (kind=oauth)');

console.log('\n=== CONNECTOR REGISTRY: sovereign toolkits discoverable by the agent ===');
reg.registerSovereignToolkits(tk.executableToolkits().map((slug) => ({ slug, actions: tk.listActions(slug, { executableOnly: true }).map((a) => a.slug) })));
const regd = reg.listSovereignToolkits();
ok(regd.length === 3 && regd.find((t) => t.slug === 'github').actions.includes('GITHUB_GET_THE_AUTHENTICATED_USER'), 'github/gmail/slack registered with their executable actions');

console.log('\n=== CLI: stratos tool list / run — capability-gated, brokered, sovereign ===');
const { run } = await import('./src/cli/stratos-cli.js');
const cliText = (res) => res.lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
let cr = await run(['tool', 'list'], {});
ok(cr.code === 0 && /executable now/.test(cliText(cr)) && /github/.test(cliText(cr)), 'tool list shows executable toolkits');
cr = await run(['tool', 'list', 'github'], {});
ok(cr.code === 0 && /GITHUB_GET_THE_AUTHENTICATED_USER/.test(cliText(cr)), 'tool list <toolkit> shows executable actions');
// deny-by-default via injected denied caps:
cr = await run(['tool', 'list'], { toolCaps: parseCapabilities({ capabilities: { actions: [] } }) });
ok(cr.code === 1 && /CAPABILITY DENIED/.test(cliText(cr)), 'tool list is capability-gated (deny-by-default)');
// run with an injected runner (no live network) returns a brokered, token-free result:
const fakeRunner = async ({ entity, toolkit, action }) => ({ ok: true, status: 200, data: { login: 'octocat' }, brokered: { aud: 'api.github.com', scope: ['github:user:read'], jti: 'x', exp: 9 } });
cr = await run(['tool', 'run', 'github', 'GITHUB_GET_THE_AUTHENTICATED_USER', '--entity', 'alice'], { runToolAction: fakeRunner });
ok(cr.code === 0 && /octocat/.test(cliText(cr)) && /brokered/.test(cliText(cr)), 'tool run prints the brokered result');
cr = await run(['tool', 'run', 'github', 'GITHUB_GET_THE_AUTHENTICATED_USER'], { toolCaps: parseCapabilities({ capabilities: { actions: ['tool.read'] } }) });
ok(cr.code === 1 && /CAPABILITY DENIED/.test(cliText(cr)), 'tool run requires the tool.run capability (deny-by-default)');

// cleanup
fs.rmSync(VDIR, { recursive: true, force: true });
fs.rmSync(PDIR, { recursive: true, force: true });
console.log(`\n✅ ${pass} assertions passed (sovereign Composio adapter).`);
