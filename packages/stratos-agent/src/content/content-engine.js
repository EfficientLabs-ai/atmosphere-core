/**
 * content-engine.js — a GENERIC, reusable content pipeline for a creator's personal brand + company.
 *
 * WHAT IT IS (and the design constraints that shape it):
 *   - GENERIC by construction: this module embeds NO personal data. The creator PROFILE, the ANGLE BANK,
 *     the used-angle ledger, and every generated batch live OUTSIDE the repo (a private directory the
 *     operator points to, e.g. ~/founder-content). The tool ships in atmos-core; the content never does.
 *   - SOVEREIGN BY DEFAULT: generation goes through an OpenAI-compatible gateway at 127.0.0.1:PORT — the
 *     same local daemon that powers the rest of StratosAgent — so drafting needs no cloud and no API key.
 *     The model + endpoint are configurable (CONTENT_MODEL / CONTENT_ENDPOINT) so the operator can point
 *     it at a stronger model for finished copy. Output quality tracks the model; the local fast model
 *     gives drafts, a stronger model gives finished copy.
 *   - SELF-GROWING: angles come from a seeded bank PLUS fresh angles mined from the live build log (recent
 *     git commits) — "everything we build is content" — so the pipeline keeps producing new material.
 *   - REPEATABLE: each run picks UNUSED angles, records them, and writes a dated batch. Run again → fresh
 *     pieces, no repeats, until the bank is exhausted (then add angles or let the build log feed it).
 *   - HONEST: the model is instructed NEVER to fabricate metrics/claims; we additionally pass the profile's
 *     honesty rule into the system prompt. The engine itself invents no numbers.
 *
 * Everything with side effects (model fetch, build-log read, clock) is INJECTABLE, so the whole pipeline
 * is unit-tested with a mocked model and no live daemon, no network, no git.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PLATFORMS = ['x', 'linkedin', 'short-video', 'carousel'];
export const TONES = ['raw', 'cinematic', 'hybrid'];
export const LANES = ['personal', 'labs', 'both'];

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4099/v1/chat/completions';
const DEFAULT_MODEL = 'gemma2:2b';

/** Resolve the model + endpoint, env-overridable so the operator can point at a stronger model. */
export function resolveModelConfig(env = process.env) {
  return {
    model: env.CONTENT_MODEL || DEFAULT_MODEL,
    endpoint: env.CONTENT_ENDPOINT || DEFAULT_ENDPOINT,
    gatewaySecret: env.ATMOS_GATEWAY_SECRET || null,
  };
}

/** Read the creator profile (markdown) and the angle bank (JSON) from the private content dir. */
export function loadProfile(contentDir) {
  const p = path.join(contentDir, 'profile.md');
  if (!fs.existsSync(p)) throw new Error(`profile not found at ${p} — create it before generating`);
  return fs.readFileSync(p, 'utf8');
}

export function loadAngles(contentDir) {
  const p = path.join(contentDir, 'angles.json');
  if (!fs.existsSync(p)) throw new Error(`angle bank not found at ${p}`);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(data.angles)) throw new Error('angles.json: "angles" must be an array');
  return data;
}

export function loadUsed(contentDir) {
  const p = path.join(contentDir, 'used.json');
  if (!fs.existsSync(p)) return { used: [] };
  try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); return { used: Array.isArray(d.used) ? d.used : [] }; }
  catch { return { used: [] }; }
}

export function saveUsed(contentDir, usedIds) {
  const p = path.join(contentDir, 'used.json');
  const body = { note: 'Tracks angle ids already generated, so re-runs produce FRESH pieces (no repeats).', used: [...usedIds] };
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n');
}

export function saveAngles(contentDir, data) {
  fs.writeFileSync(path.join(contentDir, 'angles.json'), JSON.stringify(data, null, 2) + '\n');
}

/**
 * Mine fresh angles from the live build log (recent commit subjects). "Everything we build is content":
 * each non-trivial commit becomes an angle whose hook is the change itself. Deterministic id from the
 * subject so the same commit doesn't spawn duplicate angles across runs. Pure: the commit list is INJECTED
 * (production passes the output of `git log`); we never shell out here.
 */
export function mineBuildLogAngles(commitSubjects = [], existingIds = new Set()) {
  const out = [];
  const skip = /^(merge|wip|chore: bump|bump version|fixup|revert|typo|formatting|lint)\b/i;
  for (const raw of commitSubjects) {
    const subject = String(raw || '').trim();
    if (!subject || subject.length < 12 || skip.test(subject)) continue;
    const id = 'bl-' + djb2(subject).toString(36);
    if (existingIds.has(id)) continue;
    existingIds.add(id);
    out.push({
      id,
      lane: 'labs',
      theme: 'build-in-public',
      hook_seed: `We just shipped: ${subject.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '')}. Here's why it matters for your sovereignty.`,
      status: 'unused',
      source: 'build-log',
    });
  }
  return out;
}

function djb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; }

/**
 * Select up to n UNUSED angles matching the requested lane, skipping anything in the used set. Returns
 * angles in bank order so selection is stable/predictable. 'both' lane selects from every lane.
 */
export function selectAngles(angles, used, { lane = 'both', n = 3 } = {}) {
  const usedSet = used instanceof Set ? used : new Set(used);
  const wantLane = (a) => lane === 'both' || a.lane === lane || a.lane === 'both';
  const pool = angles.filter((a) => a.status !== 'used' && !usedSet.has(a.id) && wantLane(a));
  return pool.slice(0, Math.max(0, n));
}

/**
 * Build the system + user prompt for one angle on one platform/tone. The profile (voice + honesty rule)
 * is the system prompt; the angle + platform spec is the user prompt. We ask the model for STRICT JSON so
 * assembly is deterministic, and we re-state the honesty moat so the model never invents numbers.
 */
export function buildPrompt({ profile, angle, platform, tone }) {
  const spec = PLATFORM_SPEC[platform] || PLATFORM_SPEC.x;
  const system = [
    'You are a ghostwriter for a founder. Write in the FOUNDER\'S OWN authentic voice — never imitate any other creator.',
    'Hard rules you must obey:',
    '- NEVER fabricate metrics, user counts, revenue, growth numbers, or benchmarks. If a number is not in the profile, do not invent one. Claims must be true or clearly framed as illustrative.',
    '- Hooks come first and must earn the scroll-stop. End with a clear CTA. Keep it human, specific, and abundance-not-bitter.',
    '- Output STRICT JSON only, matching the requested schema. No prose outside the JSON.',
    '',
    'FOUNDER PROFILE (voice + pillars + honesty rule):',
    profile,
  ].join('\n');

  const user = [
    `ANGLE: ${angle.hook_seed}`,
    `LANE: ${angle.lane}   THEME: ${angle.theme}   TONE: ${tone}`,
    `PLATFORM: ${platform}`,
    spec.instruction,
    '',
    'Return STRICT JSON with exactly these keys:',
    JSON.stringify(spec.schema),
  ].join('\n');

  return { system, user };
}

const PLATFORM_SPEC = {
  x: {
    instruction: 'Write an X (Twitter) THREAD and a standalone single post. Thread: a hook tweet, 4-7 body tweets (one idea each, punchy), and a CTA tweet. Single: one self-contained high-signal post.',
    schema: { hook: 'string', thread: ['string'], single: 'string', cta: 'string' },
  },
  linkedin: {
    instruction: 'Write a LinkedIn post: a hook line, a short skimmable line-broken story/insight body (professional but human), and a CTA. Provide shot/b-roll notes only if a visual would help.',
    schema: { hook: 'string', body: 'string', cta: 'string' },
  },
  'short-video': {
    instruction: 'Write a 60-second to-camera short-video script (~150 words in the body): a HOOK said to camera, a ~150-word body in the founder voice, a CTA, and cinematic SHOT/B-ROLL notes.',
    schema: { hook: 'string', body: 'string', cta: 'string', broll: 'string' },
  },
  carousel: {
    instruction: 'Write a carousel: a cover line, 4-6 slides (one idea each, short), and a final CTA slide.',
    schema: { hook: 'string', cover: 'string', slides: ['string'], cta: 'string' },
  },
};

/**
 * Call the OpenAI-compatible gateway for ONE generation. Returns { ok, content } or { ok:false, reason }.
 * NEVER fabricates: on any error it returns a degrade (the caller renders an honest skip, no fake copy).
 * fetchImpl is injected in tests; production uses global fetch against the local sovereign daemon.
 */
export async function generateOne({ system, user, model, endpoint, gatewaySecret, fetchImpl, timeoutMs = 120000 }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, reason: 'no fetch implementation available' };
  const headers = { 'content-type': 'application/json' };
  if (gatewaySecret) headers['x-atmos-gateway'] = gatewaySecret;
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: false,
    temperature: 0.8,
  };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await doFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    clearTimeout(t);
    return { ok: false, reason: `cannot reach the content model at ${endpoint} (${err.name === 'AbortError' ? 'timed out' : err.message})` };
  }
  clearTimeout(t);
  if (!resp.ok) return { ok: false, reason: `model endpoint returned ${resp.status}` };
  let data;
  try { data = await resp.json(); } catch (err) { return { ok: false, reason: `response was not JSON: ${err.message}` }; }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return { ok: false, reason: 'model returned no content' };
  return { ok: true, content };
}

/** Parse the model's JSON output defensively (it may wrap JSON in prose or code fences). */
export function parseModelJson(content) {
  if (typeof content !== 'string') return null;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Grab the outermost {...} if there's surrounding prose.
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

/** Render ONE assembled piece (parsed JSON) to markdown matching batch-01's format. */
export function renderPiece({ angle, platform, tone, piece }) {
  const head = `### [${platform} · ${tone}] ${angle.theme}  \`${angle.id}\``;
  const lines = [head];
  const hook = piece.hook || piece.cover || '';
  if (hook) lines.push(`**HOOK:** ${hook}`);
  if (platform === 'x') {
    if (Array.isArray(piece.thread) && piece.thread.length) {
      lines.push('**THREAD:**');
      piece.thread.forEach((t, i) => lines.push(`  ${i + 1}/ ${t}`));
    }
    if (piece.single) lines.push(`**SINGLE:** ${piece.single}`);
  } else if (platform === 'carousel') {
    if (piece.cover) lines.push(`**COVER:** ${piece.cover}`);
    if (Array.isArray(piece.slides)) piece.slides.forEach((s, i) => lines.push(`  Slide ${i + 1}: ${s}`));
  } else {
    if (piece.body) lines.push(`**BODY:** ${piece.body}`);
  }
  if (piece.cta) lines.push(`**CTA:** ${piece.cta}`);
  if (piece.broll) lines.push(`**B-ROLL:** ${piece.broll}`);
  return lines.join('\n');
}

/**
 * The orchestrator. For each selected angle × platform × tone it generates a piece, assembles it, and
 * collects results. Honest: a failed generation is recorded as a SKIP with the reason — never faked.
 * Marks every angle it ATTEMPTED as used (so re-runs are fresh) and returns the batch markdown + metadata.
 *
 * @param {object} o
 * @param {string} o.contentDir            private content dir (profile/angles/used/batches live here)
 * @param {object} o.modelConfig           { model, endpoint, gatewaySecret }
 * @param {string} o.lane                  personal | labs | both
 * @param {string[]} o.platforms           subset of PLATFORMS
 * @param {string[]} o.tones               subset of TONES
 * @param {number} o.n                     number of angles to draw
 * @param {function} o.fetchImpl           injected model fetch (tests) — undefined uses global fetch
 * @param {string[]} o.commitSubjects      injected build-log subjects to mine fresh angles from
 * @param {Date} o.now                     injected clock (tests) — undefined uses new Date()
 */
export async function generateBatch({
  contentDir, modelConfig, lane = 'both', platforms = ['x'], tones = ['raw'],
  n = 3, fetchImpl, commitSubjects = [], now,
} = {}) {
  const profile = loadProfile(contentDir);
  const bank = loadAngles(contentDir);
  const used = loadUsed(contentDir).used;
  const usedSet = new Set(used);

  // Self-grow: fold build-log angles into the bank (persisted) before selecting.
  const existingIds = new Set(bank.angles.map((a) => a.id));
  const fresh = mineBuildLogAngles(commitSubjects, existingIds);
  if (fresh.length) { bank.angles.push(...fresh); saveAngles(contentDir, bank); }

  const selected = selectAngles(bank.angles, usedSet, { lane, n });
  const validPlatforms = platforms.filter((p) => PLATFORMS.includes(p));
  const validTones = tones.filter((t) => TONES.includes(t));
  const usePlatforms = validPlatforms.length ? validPlatforms : ['x'];
  const useTones = validTones.length ? validTones : ['raw'];

  const rendered = [];
  const skipped = [];
  let produced = 0;

  for (const angle of selected) {
    let angleProduced = 0;
    for (const platform of usePlatforms) {
      for (const tone of useTones) {
        const { system, user } = buildPrompt({ profile, angle, platform, tone });
        const gen = await generateOne({ system, user, ...modelConfig, fetchImpl });
        if (!gen.ok) { skipped.push({ angle: angle.id, platform, tone, reason: gen.reason }); continue; }
        const piece = parseModelJson(gen.content);
        if (!piece || typeof piece !== 'object') { skipped.push({ angle: angle.id, platform, tone, reason: 'model output was not valid JSON' }); continue; }
        rendered.push(renderPiece({ angle, platform, tone, piece }));
        produced++; angleProduced++;
      }
    }
    // Consume an angle ONLY if it actually produced a piece. A fully-failed angle (e.g. the model was
    // unreachable) is left UNUSED so a re-run picks it up again — honoring the "re-run to retry" promise.
    if (angleProduced > 0) {
      usedSet.add(angle.id);
      const a = bank.angles.find((x) => x.id === angle.id); if (a) a.status = 'used';
    }
  }

  // Only persist the used/angle-status changes when at least one piece landed (a fully-degraded run
  // consumes nothing). The build-log mining above was already persisted and is idempotent by id.
  if (produced > 0) {
    saveUsed(contentDir, usedSet);
    saveAngles(contentDir, bank);
  }

  const stamp = (now || new Date()).toISOString();
  const date = stamp.slice(0, 10);
  const fileName = `batch-${date}-${stamp.slice(11, 19).replace(/:/g, '')}.md`;
  const md = renderBatch({ rendered, skipped, selected, lane, usePlatforms, useTones, stamp, modelConfig });

  const degraded = produced === 0;
  let batchPath = null;
  if (!degraded) {
    const dir = path.join(contentDir, 'batches');
    fs.mkdirSync(dir, { recursive: true });
    batchPath = path.join(dir, fileName);
    fs.writeFileSync(batchPath, md);
  }

  return {
    ok: !degraded,
    degraded,
    batchPath,
    produced,
    skipped,
    angleIds: selected.map((a) => a.id),
    freshAngles: fresh.length,
    markdown: md,
    model: modelConfig.model,
    endpoint: modelConfig.endpoint,
  };
}

function renderBatch({ rendered, skipped, selected, lane, usePlatforms, useTones, stamp, modelConfig }) {
  const head = [
    `# Content Batch — ${stamp} (PRIVATE)`,
    '',
    `Lane: ${lane} · Platforms: ${usePlatforms.join(', ')} · Tones: ${useTones.join(', ')} · Angles: ${selected.length}`,
    `Model: ${modelConfig.model} @ ${modelConfig.endpoint}`,
    `Quality note: output tracks the model. The local fast model gives DRAFTS; point CONTENT_MODEL/CONTENT_ENDPOINT`,
    `at a stronger model for finished copy. Hand-written batch-01.md is the bar. Never ship fabricated numbers.`,
    '',
    '---',
    '',
  ];
  const body = rendered.length ? rendered.join('\n\n---\n\n') : '_No pieces produced this run (model unreachable). Nothing was fabricated._';
  const tail = skipped.length ? ['', '---', '', '## Skipped (honest — not faked)', ...skipped.map((s) => `- ${s.angle} · ${s.platform}/${s.tone}: ${s.reason}`)] : [];
  return head.join('\n') + body + tail.join('\n') + '\n';
}
