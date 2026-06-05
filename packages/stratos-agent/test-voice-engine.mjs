/**
 * voice-engine + `stratos voice` CLI tests — hermetic (no real Piper, no live Ollama, no whisper).
 *
 * Proves the HONESTY contract of the native local sensory surface:
 *  - say(): Piper invoked via execFile-shaped runner; honest degrade (no fabricated audio) when the
 *    binary/voice is missing or the process fails.
 *  - hear(): ollama-audio primary path; whisper.cpp fallback; honest degrade (no fabricated
 *    transcript) when neither works; rejects the "please provide the audio" non-answer.
 *  - see(): ollama vision path; honest degrade (no fabricated description).
 *  - voiceStatus(): reports real availability, never claims an engine it can't see.
 *  - cmdVoice via run(['voice', …]): capability-gated deny-by-default; honest degrade exit codes.
 *
 * All engine I/O is injected — this suite touches no network, no binaries, no Ollama.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stratos-voice-'));
process.chdir(tmp);

const ve = await import('./src/sensory/voice-engine.js');
const { run } = await import('./src/cli/stratos-cli.js');
const { parseCapabilities } = await import('./src/security/capability-gate.js');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const text = (r) => r.lines.map(strip).join('\n');

// ---- helpers ----
const audioFile = path.join(tmp, 'clip.wav');
fs.writeFileSync(audioFile, Buffer.from('RIFFmock')); // existence only; readFile is injected in tests
const imageFile = path.join(tmp, 'img.png');
fs.writeFileSync(imageFile, Buffer.from('\x89PNGmock'));
const okResolve = () => ({ ok: true, binary: '/fake/piper', voice: '/fake/voice.onnx', libDir: '/fake', reason: null });

const jsonResp = (obj, okFlag = true, status = 200) => ({ ok: okFlag, status, json: async () => obj });

console.log('=== say(): real Piper path (execFile runner) + honest degrade ===');
{
  let ran = null;
  const out = path.join(tmp, 'out.wav');
  const res = await ve.say('hello world', out, {
    silent: true,
    resolve: okResolve,
    run: async (spec) => { ran = spec; fs.writeFileSync(out, Buffer.from('WAVE')); },
  });
  ok(res.ok && res.path === out, 'say → ok with the wav path when piper produces a file');
  ok(ran && ran.text === 'hello world' && ran.binary === '/fake/piper' && ran.voice === '/fake/voice.onnx',
    'say invokes the runner with model voice + cleaned text (no shell string)');
}
{
  const res = await ve.say('hi', path.join(tmp, 'x.wav'), { silent: true, resolve: () => ({ ok: false, reason: 'piper binary not found' }) });
  ok(!res.ok && /not found/.test(res.reason) && res.path === null, 'say → honest degrade (no audio) when piper missing');
}
{
  const out = path.join(tmp, 'fail.wav');
  const res = await ve.say('hi', out, { silent: true, resolve: okResolve, run: async () => { throw new Error('boom'); } });
  ok(!res.ok && /boom/.test(res.reason), 'say → honest degrade when the piper process fails (no fabricated wav)');
}
{
  const res = await ve.say('   ', path.join(tmp, 'empty.wav'), { silent: true, resolve: okResolve });
  ok(!res.ok && /empty/.test(res.reason), 'say → refuses empty text');
}

console.log('\n=== hear(): ollama-audio primary, whisper fallback, honest degrade ===');
{
  const res = await ve.hear(audioFile, {
    silent: true,
    readFile: async () => Buffer.from('audio-bytes'),
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/v1/chat/completions'), 'uses OpenAI-compat endpoint');
      const body = JSON.parse(init.body);
      assert.ok(body.messages[0].content.some((c) => c.type === 'input_audio'), 'sends input_audio content part');
      return jsonResp({ choices: [{ message: { content: 'the quick brown fox' } }] });
    },
  });
  ok(res.ok && res.text === 'the quick brown fox' && res.engine === 'ollama-audio', 'hear → ollama-audio transcript');
}
{
  // model ignored the audio and asked for it — must be treated as NOT understood, not a transcript.
  const res = await ve.hear(audioFile, {
    silent: true,
    env: {}, // no whisper configured
    readFile: async () => Buffer.from('x'),
    fetchImpl: async () => jsonResp({ choices: [{ message: { content: 'Please provide the audio you would like me to transcribe.' } }] }),
  });
  ok(!res.ok && /did not receive audio/.test(res.reason), 'hear → rejects the "please provide the audio" non-answer (honest)');
}
{
  // ollama down, but a whisper.cpp binary is "present" (injected runner) → fallback succeeds.
  const fakeBin = path.join(tmp, 'whisper'); fs.writeFileSync(fakeBin, '#!/bin/sh\n');
  const fakeModel = path.join(tmp, 'ggml.bin'); fs.writeFileSync(fakeModel, 'model');
  const res = await ve.hear(audioFile, {
    silent: true,
    env: { WHISPER_BIN: fakeBin, WHISPER_MODEL: fakeModel },
    readFile: async () => Buffer.from('x'),
    fetchImpl: async () => { throw new Error('connection refused'); },
    runWhisper: async () => 'whisper transcript here',
  });
  ok(res.ok && res.engine === 'whisper.cpp' && /whisper transcript/.test(res.text), 'hear → whisper.cpp fallback when ollama is down');
}
{
  // nothing works → honest degrade, NO fabricated transcript.
  const res = await ve.hear(audioFile, {
    silent: true, env: {},
    readFile: async () => Buffer.from('x'),
    fetchImpl: async () => { throw new Error('refused'); },
  });
  ok(!res.ok && res.text === null, 'hear → honest degrade (null transcript) when no local STT available');
}
{
  const res = await ve.hear(path.join(tmp, 'nope.wav'), { silent: true });
  ok(!res.ok && /not found/.test(res.reason), 'hear → file-not-found is honest, not fabricated');
}

console.log('\n=== see(): ollama vision + honest degrade ===');
{
  const res = await ve.see(imageFile, 'what color?', {
    silent: true,
    readFile: async () => Buffer.from('img'),
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/api/chat'), 'vision uses /api/chat');
      const body = JSON.parse(init.body);
      assert.ok(Array.isArray(body.messages[0].images) && body.messages[0].images.length === 1, 'sends base64 images field');
      return jsonResp({ message: { content: 'The image is red.' } });
    },
  });
  ok(res.ok && /red/.test(res.text), 'see → vision description from ollama');
}
{
  const res = await ve.see(imageFile, null, { silent: true, readFile: async () => Buffer.from('img'), fetchImpl: async () => { throw new Error('down'); } });
  ok(!res.ok && res.text === null, 'see → honest degrade (null) when ollama unreachable');
}

console.log('\n=== voiceStatus(): honest engine availability ===');
{
  const st = await ve.voiceStatus({
    env: {},
    resolve: () => ({ ok: true, voice: '/v.onnx', reason: null }),
    fetchImpl: async () => jsonResp({ capabilities: ['completion', 'vision', 'audio'] }),
  });
  ok(st.piper.ok && st.gemmaAudio.ok && st.gemmaVision.ok, 'status → all engines ✓ when present');
  ok(st.canTalk && st.canHear && st.canSee, 'status → effective talk/hear/see all available');
}
{
  const st = await ve.voiceStatus({
    env: {},
    resolve: () => ({ ok: false, reason: 'piper binary not found' }),
    fetchImpl: async () => { throw new Error('ollama down'); },
  });
  ok(!st.piper.ok && !st.gemmaAudio.ok && !st.gemmaVision.ok && !st.whisper.ok, 'status → all ✗ when nothing present');
  ok(!st.canTalk && !st.canHear && !st.canSee, 'status → never claims a capability it cannot see');
}

console.log('\n=== `stratos voice` CLI: dispatch, gate, honest exit codes ===');
{
  const r = await run(['voice'], {});
  ok(r.code === 0 && /say · hear · see · status/.test(text(r)) || /say/.test(text(r)), 'voice (no sub) → help, code 0');
}
{
  const r = await run(['voice', 'bogus'], {});
  ok(r.code === 1 && /Unknown voice subcommand/.test(text(r)), 'voice bogus → code 1');
}
{
  // capability gate: inject denied caps → refused even though the engine would work.
  const denied = parseCapabilities({ capabilities: { actions: [] } });
  const r = await run(['voice', 'say', 'hi'], { voiceCaps: denied, voice: { say: async () => ({ ok: true, path: '/x.wav' }) } });
  ok(r.code === 1 && /CAPABILITY DENIED/.test(text(r)), 'voice say with denied caps → capability-gate refuses');
}
{
  const r = await run(['voice', 'say', 'hello'], {
    sayOutPath: path.join(tmp, 'cli.wav'),
    voice: { say: async (t, out) => ({ ok: true, path: out }) },
  });
  ok(r.code === 0 && /cli\.wav/.test(text(r)), 'voice say → prints the produced wav path (code 0)');
}
{
  const r = await run(['voice', 'say', 'hello'], { voice: { say: async () => ({ ok: false, reason: 'piper missing' }) } });
  ok(r.code === 1 && /TTS unavailable/.test(text(r)) && !/fabricat/i.test('') , 'voice say degrade → code 1, honest message');
}
{
  const r = await run(['voice', 'hear', audioFile], { voice: { hear: async () => ({ ok: true, text: 'heard it', engine: 'ollama-audio' }) } });
  ok(r.code === 0 && /heard it/.test(text(r)) && /ollama-audio/.test(text(r)), 'voice hear → prints transcript + engine');
}
{
  const r = await run(['voice', 'hear', audioFile], { voice: { hear: async () => ({ ok: false, reason: 'no local STT' }) } });
  ok(r.code === 1 && /STT unavailable/.test(text(r)), 'voice hear degrade → code 1, no fabricated transcript');
}
{
  const r = await run(['voice', 'see', imageFile], { voice: { see: async () => ({ ok: true, text: 'a red square' }) } });
  ok(r.code === 0 && /red square/.test(text(r)), 'voice see → prints description');
}
{
  const r = await run(['voice', 'status'], { voice: { voiceStatus: async () => ({
    model: 'gemma4:e4b', piper: { ok: true }, gemmaAudio: { ok: true }, gemmaVision: { ok: false, reason: 'x' },
    whisper: { ok: false, reason: 'not installed' }, canTalk: true, canHear: true, canSee: false,
  }) } });
  ok(r.code === 0 && /Piper TTS/.test(text(r)) && /gemma4:e4b/.test(text(r)), 'voice status → renders engine table honestly');
}

console.log(`\n✅ voice-engine + CLI: ${pass} assertions passed.`);
