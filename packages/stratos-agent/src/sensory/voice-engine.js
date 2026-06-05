/**
 * voice-engine.js — StratosAgent's NATIVE, OPEN-SOURCE, LOCAL, ZERO-COST "talk / hear / see".
 *
 * This is the single sovereign sensory surface every install gets out of the box. No cloud, no API
 * keys, no operational cost. (ElevenLabs/Twilio phone voice is a SEPARATE optional add-on on branch
 * feat/phone-voice and is intentionally NOT referenced here.)
 *
 * Engines used, all already local on a standard install:
 *   - TALK (TTS):  Piper (~/.cache/piper/piper/piper + a .onnx voice). Open-source, offline, fast.
 *   - HEAR (STT):  gemma-class multimodal model via Ollama's OpenAI-compatible endpoint
 *                  (/v1/chat/completions with an `input_audio` content part). Reuses the model the
 *                  install already pulled — most sovereign path, no extra dependency. Optional
 *                  whisper.cpp fallback if a binary is present.
 *   - SEE (vision): the same multimodal model via Ollama (/api/chat with base64 `images`).
 *
 * HONESTY CONTRACT (matches the rest of the CLI):
 *   - Never fabricate a transcript, a reply, or a description. If an engine is missing/broken we
 *     return a clear, logged reason and `ok:false` — we do NOT invent output.
 *   - execFile/spawn-array ONLY (no shell strings — the repo had a shell-injection finding).
 *
 * Every function is pure-ish and injectable (deps argument) so it is unit-tested without real
 * binaries or a live Ollama.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.STRATOS_SENSORY_MODEL || 'gemma4:e4b';

/**
 * Resolve the local Piper install. Piper ships as a binary + bundled .so libs + a .onnx voice.
 * The binary must run with LD_LIBRARY_PATH pointing at its own dir (bundled onnxruntime/espeak-ng).
 * Returns { ok, binary, voice, libDir, reason }.
 */
export function resolvePiper(env = process.env) {
  const home = os.homedir();
  const cacheBase = env.PIPER_HOME || path.join(home, '.cache', 'piper');
  const binary = env.PIPER_BIN || path.join(cacheBase, 'piper', 'piper');
  const libDir = path.dirname(binary);
  // Voice: explicit override, else the first .onnx in the cache base.
  let voice = env.PIPER_VOICE || '';
  if (!voice) {
    try {
      const onnx = fs.readdirSync(cacheBase).find((f) => f.endsWith('.onnx'));
      if (onnx) voice = path.join(cacheBase, onnx);
    } catch { /* no cache dir */ }
  }
  if (!safeExists(binary)) return { ok: false, reason: `piper binary not found at ${binary}`, binary, voice, libDir };
  if (!voice || !safeExists(voice)) return { ok: false, reason: `no piper .onnx voice found in ${cacheBase}`, binary, voice, libDir };
  return { ok: true, binary, voice, libDir, reason: null };
}

function safeExists(p) { try { return !!p && fs.existsSync(p); } catch { return false; } }

/** Strip <think> blocks and markdown noise so only the clean answer is vocalized. */
export function cleanForSpeech(text) {
  if (!text) return '';
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/[*#`_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * TALK — synthesize REAL speech with Piper. Writes a .wav to outputPath.
 * execFile (array args, no shell). Honest degrade: returns { ok:false, reason } and writes nothing
 * if piper/voice is missing or the process fails — never a fake/silent wav pretending to be speech.
 *
 * deps.run lets tests stub the child process; deps.resolve stubs engine resolution.
 */
export async function say(text, outputPath, opts = {}) {
  const clean = cleanForSpeech(text);
  if (!clean) return { ok: false, reason: 'empty text — nothing to synthesize', path: null };

  const resolve = opts.resolve || resolvePiper;
  const piper = resolve(opts.env || process.env);
  if (!piper.ok) {
    log(opts, `[voice.say] degrade — ${piper.reason}`);
    return { ok: false, reason: piper.reason, path: null };
  }

  const dir = path.dirname(outputPath);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* */ }

  const run = opts.run || runPiper;
  try {
    await run({ binary: piper.binary, voice: piper.voice, libDir: piper.libDir, text: clean, outputPath, timeoutMs: opts.timeoutMs || 30_000 });
  } catch (err) {
    const reason = `piper synthesis failed: ${err.message}`;
    log(opts, `[voice.say] degrade — ${reason}`);
    return { ok: false, reason, path: null };
  }
  if (!safeExists(outputPath)) {
    const reason = 'piper exited without producing a wav';
    log(opts, `[voice.say] degrade — ${reason}`);
    return { ok: false, reason, path: null };
  }
  log(opts, `[voice.say] synthesized → ${outputPath}`);
  return { ok: true, reason: null, path: outputPath };
}

/** Real Piper invocation: pipe text on stdin, write wav via --output_file, LD_LIBRARY_PATH set. */
function runPiper({ binary, voice, libDir, text, outputPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      ['--model', voice, '--output_file', outputPath],
      { timeout: timeoutMs, env: { ...process.env, LD_LIBRARY_PATH: `${libDir}:${process.env.LD_LIBRARY_PATH || ''}` } },
      (err) => { if (err) reject(err); else resolve(); },
    );
    try { child.stdin.write(text); child.stdin.end(); } catch (e) { reject(e); }
  });
}

/**
 * HEAR — transcribe a local audio file (wav/ogg/mp3…) with NO cloud.
 * Primary path: the multimodal Ollama model via the OpenAI-compatible endpoint (input_audio).
 * Optional fallback: a whisper.cpp binary if one is configured/present.
 * Honest degrade: { ok:false, reason } if no local STT path works — never a fabricated transcript.
 *
 * deps.readFile / deps.fetchImpl / deps.runWhisper are injectable for hermetic tests.
 */
export async function hear(audioPath, opts = {}) {
  if (!safeExists(audioPath)) return { ok: false, reason: `audio file not found: ${audioPath}`, text: null, engine: null };

  // 1) Primary: gemma-class audio via Ollama OpenAI-compat endpoint.
  const viaModel = await hearViaOllamaAudio(audioPath, opts);
  if (viaModel.ok) return viaModel;

  // 2) Fallback: whisper.cpp if a binary is available.
  const whisper = resolveWhisper(opts.env || process.env);
  if (whisper.ok) {
    const viaWhisper = await hearViaWhisper(audioPath, whisper, opts);
    if (viaWhisper.ok) return viaWhisper;
    log(opts, `[voice.hear] whisper fallback failed — ${viaWhisper.reason}`);
  }

  const reason = `no local STT available (ollama-audio: ${viaModel.reason}; whisper: ${whisper.ok ? 'present but failed' : whisper.reason})`;
  log(opts, `[voice.hear] degrade — ${reason}`);
  return { ok: false, reason, text: null, engine: null };
}

/** Transcribe via Ollama's OpenAI-compatible /v1/chat/completions input_audio content part. */
async function hearViaOllamaAudio(audioPath, opts = {}) {
  const host = opts.ollamaHost || DEFAULT_OLLAMA;
  const model = opts.model || DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl || fetch;
  const readFile = opts.readFile || fs.promises.readFile;

  let b64;
  try { b64 = (await readFile(audioPath)).toString('base64'); }
  catch (e) { return { ok: false, reason: `could not read audio: ${e.message}`, text: null, engine: 'ollama-audio' }; }

  const fmt = (path.extname(audioPath).replace('.', '').toLowerCase()) || 'wav';
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe the speech in this audio verbatim. Output only the transcription, nothing else.' },
        { type: 'input_audio', input_audio: { data: b64, format: fmt } },
      ],
    }],
    stream: false,
    temperature: 0,
  };

  try {
    const r = await fetchImpl(`${host}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal(opts.timeoutMs || 120_000),
    });
    if (!r.ok) return { ok: false, reason: `ollama returned HTTP ${r.status}`, text: null, engine: 'ollama-audio' };
    const j = await r.json();
    const text = cleanForSpeech(j?.choices?.[0]?.message?.content || '');
    if (!text) return { ok: false, reason: 'model returned empty transcript (audio not understood)', text: null, engine: 'ollama-audio' };
    // Guard against the model asking us to "provide the audio" — a sign the input was ignored.
    if (/please provide (the |an )?audio/i.test(text)) {
      return { ok: false, reason: 'model did not receive audio input (capability mismatch)', text: null, engine: 'ollama-audio' };
    }
    return { ok: true, reason: null, text, engine: 'ollama-audio' };
  } catch (e) {
    return { ok: false, reason: `ollama unreachable: ${e.message}`, text: null, engine: 'ollama-audio' };
  }
}

/** Resolve an optional whisper.cpp binary (only used if present — never required). */
export function resolveWhisper(env = process.env) {
  const binary = env.WHISPER_BIN || '';
  const model = env.WHISPER_MODEL || '';
  if (!binary) return { ok: false, reason: 'WHISPER_BIN not set (whisper.cpp not installed)', binary, model };
  if (!safeExists(binary)) return { ok: false, reason: `whisper binary not found at ${binary}`, binary, model };
  if (!model || !safeExists(model)) return { ok: false, reason: 'WHISPER_MODEL (ggml .bin) not found', binary, model };
  return { ok: true, reason: null, binary, model };
}

async function hearViaWhisper(audioPath, whisper, opts = {}) {
  const runWhisper = opts.runWhisper || ((args) => new Promise((resolve, reject) => {
    execFile(whisper.binary, args, { timeout: opts.timeoutMs || 120_000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout || '');
    });
  }));
  try {
    const out = await runWhisper(['-m', whisper.model, '-f', audioPath, '-nt', '-otxt']);
    const text = cleanForSpeech(out);
    if (!text) return { ok: false, reason: 'whisper produced no transcript', text: null, engine: 'whisper.cpp' };
    return { ok: true, reason: null, text, engine: 'whisper.cpp' };
  } catch (e) {
    return { ok: false, reason: e.message, text: null, engine: 'whisper.cpp' };
  }
}

/**
 * SEE — describe/understand a local image with the multimodal model via Ollama (/api/chat, base64
 * `images`). Honest degrade: { ok:false, reason } if unreachable — never a fabricated description.
 */
export async function see(imagePath, prompt, opts = {}) {
  if (!safeExists(imagePath)) return { ok: false, reason: `image file not found: ${imagePath}`, text: null };
  const host = opts.ollamaHost || DEFAULT_OLLAMA;
  const model = opts.model || DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl || fetch;
  const readFile = opts.readFile || fs.promises.readFile;
  const ask = prompt || 'Describe this image in detail. What is shown, and what text (if any) is visible?';

  let b64;
  try { b64 = (await readFile(imagePath)).toString('base64'); }
  catch (e) { return { ok: false, reason: `could not read image: ${e.message}`, text: null }; }

  const body = {
    model,
    messages: [{ role: 'user', content: ask, images: [b64] }],
    stream: false,
  };
  try {
    const r = await fetchImpl(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal(opts.timeoutMs || 120_000),
    });
    if (!r.ok) return { ok: false, reason: `ollama returned HTTP ${r.status}`, text: null };
    const j = await r.json();
    const text = cleanForSpeech(j?.message?.content || '');
    if (!text) return { ok: false, reason: 'model returned empty description', text: null };
    return { ok: true, reason: null, text };
  } catch (e) {
    return { ok: false, reason: `ollama unreachable: ${e.message}`, text: null };
  }
}

/**
 * STATUS — honestly report which sensory engines are available on THIS box.
 * Probes Piper on disk + the multimodal model's advertised capabilities via Ollama + any whisper.cpp.
 * Returns a structured object (the CLI formats it). Never claims an engine works that it can't see.
 */
export async function voiceStatus(opts = {}) {
  const env = opts.env || process.env;
  const host = opts.ollamaHost || DEFAULT_OLLAMA;
  const model = opts.model || DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl || fetch;

  const piper = (opts.resolve || resolvePiper)(env);
  const whisper = resolveWhisper(env);

  let gemmaAudio = false, gemmaVision = false, modelPresent = false, ollamaReachable = false, capReason = null;
  try {
    const r = await fetchImpl(`${host}/api/show`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }), signal: timeoutSignal(opts.timeoutMs || 4000),
    });
    ollamaReachable = true;
    if (r.ok) {
      const j = await r.json();
      const caps = Array.isArray(j?.capabilities) ? j.capabilities : [];
      modelPresent = true;
      gemmaAudio = caps.includes('audio');
      gemmaVision = caps.includes('vision');
    } else {
      capReason = `model "${model}" not found (HTTP ${r.status})`;
    }
  } catch (e) {
    capReason = `ollama unreachable: ${e.message}`;
  }

  return {
    model,
    piper: { ok: piper.ok, reason: piper.reason, voice: piper.voice || null },
    gemmaAudio: { ok: gemmaAudio, reason: gemmaAudio ? null : (capReason || 'model does not advertise audio') },
    gemmaVision: { ok: gemmaVision, reason: gemmaVision ? null : (capReason || 'model does not advertise vision') },
    whisper: { ok: whisper.ok, reason: whisper.reason },
    ollamaReachable,
    // Effective capabilities (what a user can actually DO right now):
    canTalk: piper.ok,
    canHear: gemmaAudio || whisper.ok,
    canSee: gemmaVision,
  };
}

function timeoutSignal(ms) {
  try { return AbortSignal.timeout(ms); } catch { return undefined; }
}

function log(opts, msg) {
  if (opts.verbose !== false && !opts.silent) console.log(msg);
}
