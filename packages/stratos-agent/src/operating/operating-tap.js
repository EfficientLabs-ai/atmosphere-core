/**
 * operating-tap.js — INCREMENT 5 (final): the FLAG-GATED, DEFAULT-OFF, FAIL-OPEN observational tap
 * that wires the operating core (workspace-tree · context-capture · trace-engine · eval-engine, built
 * in increments 1-4) into the LIVE request path WITHOUT ever changing that path's behavior.
 *
 * THE CONTRACT (non-negotiable — this touches the production daemon):
 *   1. DEFAULT OFF.  isEnabled() is `process.env.STRATOS_OPERATING_CORE === '1'`. With the flag off
 *      (the default), observe() does `return await exec()` and NOTHING else — no imports executed, no
 *      fs touched, identical control flow, identical thrown errors. The disabled path is byte-identical
 *      to calling exec() directly. The guard runs FIRST, before anything is required or constructed.
 *   2. FAIL OPEN.  With the flag ON, the tap can NEVER affect exec()'s result or its thrown error. The
 *      observation is wrapped so that ANY tap-internal error (a capture that throws, a missing dir, a
 *      broken signer) is swallowed + logged to a side channel and never propagated. observe() returns
 *      EXACTLY exec()'s resolved value, or rethrows EXACTLY exec()'s error — unchanged.
 *   3. ADDITIVE ONLY.  Heavy operating-core modules are loaded LAZILY (dynamic import) the first time
 *      the tap actually runs enabled, so importing this module on the disabled path costs nothing and
 *      pulls in zero of the operating core.
 *
 * This is an OBSERVATIONAL tap: it watches the real execution (captures the request as a context event,
 * opens a trace, records the model step, ends the trace minting a tamper-evident receipt, optionally
 * evaluates). It does not, and structurally cannot, alter routing or the response.
 */

/** The single env flag. DEFAULT OFF — only the literal string "1" enables the tap. */
export function isEnabled() {
  return process.env.STRATOS_OPERATING_CORE === '1';
}

/**
 * Side channel for tap-internal failures: NEVER throws, NEVER touches the result. Operators can watch
 * it without it ever becoming load-bearing. Suppressed unless STRATOS_OPERATING_CORE_DEBUG=1 so the
 * fail-open path is silent in production by default.
 */
function tapLog(stage, err) {
  try {
    if (process.env.STRATOS_OPERATING_CORE_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.warn(`⚠️  [operating-tap] ${stage} failed (swallowed, fail-open):`, err && err.message ? err.message : err);
    }
  } catch { /* a logger that throws must never affect exec() — swallow */ }
}

/** Lazily-loaded operating-core handles (only ever populated on the ENABLED path). */
let _core = null;
async function loadCore() {
  if (_core) return _core;
  const [{ createTask }, ctx, trace] = await Promise.all([
    import('../workspace/workspace-tree.js'),
    import('../context/context-capture.js'),
    import('../trace/trace-engine.js'),
  ]);
  _core = { createTask, capture: ctx.capture, startTrace: trace.startTrace, recordStep: trace.recordStep, endTrace: trace.endTrace };
  return _core;
}

/** Derive a stable per-day task path "live/<workspace>/<workflow>/<YYYY-MM-DD>" from meta. */
function dayTaskPath(meta = {}, now = Date.now) {
  const day = new Date(now()).toISOString().slice(0, 10); // YYYY-MM-DD
  const safe = (s, d) => {
    const v = String(s == null ? '' : s).trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) ? v : d;
  };
  const ws = safe(meta.workspace, 'live');
  const project = safe(meta.project, 'requests');
  const workflow = safe(meta.workflow || meta.route, 'route');
  const task = safe(meta.day || day, day);
  return { ws, project, workflow, task, path: `${ws}/${project}/${workflow}/${task}` };
}

/**
 * observe({ meta, exec }) — run exec(), observing it through the operating core IFF the flag is on.
 *
 * DISABLED (default): returns `await exec()` and does nothing else — identical control flow + errors.
 * ENABLED: best-effort capture → startTrace → exec (recording the step) → endTrace (mints the receipt)
 *          → optional eval. The TAP NEVER changes the outcome: it returns exactly exec()'s value, or
 *          rethrows exactly exec()'s error. Tap-internal failures are swallowed + side-logged.
 *
 * @param {object} o
 *   @param {object} [o.meta]         routing/context metadata for the observation (never read by exec).
 *   @param {function} o.exec         () => Promise<any> — the REAL execution. Always called exactly once.
 *   @param {object}  [o.tap]         test/operator injection: { root, now, capture, startTrace, recordStep,
 *                                    endTrace, createTask, receiptLog, actor_id, evaluate }. Production
 *                                    leaves this empty and the lazy core is used.
 * @returns {Promise<any>} exactly exec()'s resolved value (or rethrows exec()'s error).
 */
export async function observe(o = {}) {
  // --- DISABLED PATH: guard FIRST, touch NOTHING. Byte-identical to calling exec() directly. --------
  if (!isEnabled()) {
    if (!o || typeof o.exec !== 'function') throw new Error('observe({exec}): exec must be a function');
    return await o.exec();
  }

  // From here the flag is ON. exec() is still sacred: it runs exactly once and its result/throw is
  // returned/rethrown verbatim. Everything else is wrapped so it can never leak into exec()'s outcome.
  if (!o || typeof o.exec !== 'function') throw new Error('observe({exec}): exec must be a function');
  const meta = (o && o.meta && typeof o.meta === 'object') ? o.meta : {};
  const inj = (o && o.tap && typeof o.tap === 'object') ? o.tap : {};
  const now = typeof inj.now === 'function' ? inj.now : Date.now;

  // Resolve the operating-core fns: injected (tests) or lazily loaded (production). A failure to load
  // the core must NOT stop exec() — degrade to a bare exec() (still fully observational-optional).
  let core = inj;
  if (!inj.capture || !inj.startTrace) {
    try { core = { ...(await loadCore()), ...inj }; }
    catch (e) { tapLog('load-core', e); return await o.exec(); }
  }

  // --- best-effort SETUP (capture + open trace). Any failure here degrades to a bare observed exec. --
  let handle = null;
  let tp = null;
  try {
    tp = dayTaskPath(meta, now);
    const rootOpt = inj.root ? { root: inj.root } : {};
    // Ensure the per-day task folder exists (idempotent scaffold).
    core.createTask(tp.ws, tp.project, tp.workflow, tp.task, rootOpt);
    // Capture the request as a context event (raw → data/, record → memory/, line → session.log).
    core.capture({
      task: tp.path,
      source: meta.source || 'api',
      raw: meta.raw ?? meta.prompt ?? '',
      user_intent: meta.user_intent || meta.intent || '',
      model_used: meta.model_used || meta.model || '',
      tools_used: meta.tools_used,
    }, { ...rootOpt, now });
    handle = core.startTrace({ task: tp.path, model_used: meta.model_used || meta.model || '', ...rootOpt, now });
  } catch (e) {
    tapLog('setup', e);
    handle = null; // setup failed — we still run + return exec() unaffected.
  }

  // --- RUN exec() — the ONE call. Its result/throw is the ONLY thing observe() ever returns/rethrows. -
  let result, threw = false, execErr;
  try {
    result = await o.exec();
  } catch (e) {
    threw = true; execErr = e;
  }

  // --- best-effort TEARDOWN (record step + end trace + optional eval). Cannot affect the outcome. ----
  if (handle) {
    try {
      core.recordStep(handle, {
        kind: 'model',
        summary: threw ? 'live execution errored' : 'live execution ok',
        tool: meta.tool || meta.route || 'route',
        who: meta.who || '',
        model: meta.model_used || meta.model || '',
        permission: meta.permission || '',
        input: meta.raw ?? meta.prompt ?? '',
        output: threw ? '' : safeOutputHashInput(result),
        cost_units: typeof meta.cost_units === 'number' ? meta.cost_units : 0,
      });
    } catch (e) { tapLog('record-step', e); }

    let ended = null;
    try {
      const endOpts = { result: threw ? 'error' : 'ok', now };
      if (inj.receiptLog) endOpts.receiptLog = inj.receiptLog;
      if (inj.actor_id) endOpts.actor_id = inj.actor_id;
      ended = core.endTrace(handle, endOpts);
    } catch (e) { tapLog('end-trace', e); }

    // Optional eval — only if a caller injected an evaluator (off by default; never in the hot path).
    if (ended && typeof inj.evaluate === 'function') {
      try {
        inj.evaluate({ trace: ended.trace, root: inj.root, receiptLog: inj.receiptLog, now });
      } catch (e) { tapLog('evaluate', e); }
    }
  }

  // --- return EXACTLY exec()'s outcome — unchanged. -------------------------------------------------
  if (threw) throw execErr;
  return result;
}

/** A small, never-throwing projection of the result for the step's output hash (content is hashed, not stored). */
function safeOutputHashInput(result) {
  try {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
  } catch { return ''; }
}
