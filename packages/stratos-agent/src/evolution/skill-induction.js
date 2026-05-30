/**
 * SkillInductionEngine — Tier A deterministic program synthesis.
 *
 * Given input→output examples harvested from successful agent traces, this INFERS the
 * deterministic `computation` spec (the thing a human used to supply by hand) by exact
 * fitting, then accepts it only if it reproduces EVERY observed example. No LLM, no GPU,
 * fully decidable for this class.
 *
 * Covered families (Occam order — simplest hypothesis that fits all examples wins):
 *   1. const     value
 *   2. affine     a*x + b           (incl. identity / scale / offset)
 *   3. poly2      c2*x^2 + c1*x + c0
 *
 * All three compile to REAL executing wasm via GsiCompiler. Integer coefficients are
 * required (the wasm path is i32); a non-integer or non-fitting hypothesis is rejected
 * and the engine returns null — an honest "could not synthesize", never a guess.
 *
 * This is deliberately extensible: add a synthesizer to TIER_A and a matching case to the
 * compiler's watForComputation to grow coverage (piecewise, string-template, multi-feature
 * linear, etc.). Tier B (LLM-propose + verify) plugs in above this as a fallback.
 */

const EPS = 1e-9;
const TOL = 1e-6; // example match tolerance

function isInt(n) { return Number.isFinite(n) && Math.abs(n - Math.round(n)) < EPS; }
function asScalar(input) {
  if (Array.isArray(input)) return Number(input[0]);
  if (input === undefined || input === null) return 0;
  return Number(input);
}

/** Normalize raw examples to [{x, y}] with finite scalar x and finite y. */
function normalize(rawExamples) {
  const out = [];
  for (const ex of rawExamples || []) {
    const x = asScalar(ex.input ?? ex.in ?? ex.x);
    const y = Number(ex.output ?? ex.out ?? ex.y);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}

function evalSpec(spec, x) {
  switch (spec.type) {
    case 'const': return spec.value;
    case 'affine': return spec.a * x + spec.b;
    case 'poly2': return spec.c2 * x * x + spec.c1 * x + spec.c0;
    default: return NaN;
  }
}

/** True iff `spec` reproduces every example within tolerance. */
function fitsAll(spec, examples) {
  for (const { x, y } of examples) {
    const pred = evalSpec(spec, x);
    if (!Number.isFinite(pred) || Math.abs(pred - y) > TOL) return false;
  }
  return true;
}

/** Round a spec's numeric coefficients to integers (for the i32 wasm path). */
function roundSpec(spec) {
  if (spec.type === 'const') return { type: 'const', value: Math.round(spec.value) };
  if (spec.type === 'affine') return { type: 'affine', a: Math.round(spec.a), b: Math.round(spec.b) };
  if (spec.type === 'poly2') return { type: 'poly2', c2: Math.round(spec.c2), c1: Math.round(spec.c1), c0: Math.round(spec.c0) };
  return spec;
}

/** Solve c2*x^2 + c1*x + c0 = y for three distinct points via Cramer's rule. */
function solveQuadratic(p) {
  const [[x1, y1], [x2, y2], [x3, y3]] = p;
  // Vandermonde determinant for columns [1, x, x^2]
  const det =
    (x2 - x1) * (x3 - x1) * (x3 - x2); // known closed form for the 3-point Vandermonde
  if (Math.abs(det) < EPS) return null;
  // Lagrange interpolation -> expand to standard coefficients.
  // L_i(x) = prod_{j!=i} (x - x_j)/(x_i - x_j); c = sum y_i * coeffs(L_i)
  const pts = [[x1, y1], [x2, y2], [x3, y3]];
  let c0 = 0, c1 = 0, c2 = 0;
  for (let i = 0; i < 3; i++) {
    const [xi, yi] = pts[i];
    const others = pts.filter((_, j) => j !== i).map(pp => pp[0]);
    const denom = (xi - others[0]) * (xi - others[1]);
    if (Math.abs(denom) < EPS) return null;
    // numerator polynomial (x - o0)(x - o1) = x^2 - (o0+o1)x + o0*o1
    const a2 = 1;
    const a1 = -(others[0] + others[1]);
    const a0 = others[0] * others[1];
    const w = yi / denom;
    c2 += w * a2; c1 += w * a1; c0 += w * a0;
  }
  return [c0, c1, c2];
}

const TIER_A = [
  // 1. const
  (examples) => {
    const y0 = examples[0].y;
    if (examples.every(e => Math.abs(e.y - y0) < EPS)) return { type: 'const', value: y0 };
    return null;
  },
  // 2. affine (needs >= 2 distinct x)
  (examples) => {
    const xs = [...new Set(examples.map(e => e.x))];
    if (xs.length < 2) return null;
    const y = (xv) => examples.find(e => e.x === xv).y;
    const a = (y(xs[1]) - y(xs[0])) / (xs[1] - xs[0]);
    const b = y(xs[0]) - a * xs[0];
    return { type: 'affine', a, b };
  },
  // 3. poly2 (needs >= 3 distinct x)
  (examples) => {
    const xs = [...new Set(examples.map(e => e.x))];
    if (xs.length < 3) return null;
    const y = (xv) => examples.find(e => e.x === xv).y;
    const coeffs = solveQuadratic([[xs[0], y(xs[0])], [xs[1], y(xs[1])], [xs[2], y(xs[2])]]);
    if (!coeffs) return null;
    const [c0, c1, c2] = coeffs;
    return { type: 'poly2', c0, c1, c2 };
  }
];

/**
 * Infer a deterministic computation spec from examples, or null if none fits exactly.
 * @param {Array<{input,output}>} rawExamples
 * @param {Object} [opts] - { requireInteger = true }
 * @returns {Object|null} a computation spec compatible with GsiCompiler (const/affine/poly2)
 */
export function induceComputation(rawExamples, opts = {}) {
  const requireInteger = opts.requireInteger !== false;
  const examples = normalize(rawExamples);
  if (examples.length === 0) return null;

  for (const synth of TIER_A) {
    const candidate = synth(examples);
    if (!candidate) continue;

    // Float candidate must reproduce all examples.
    if (!fitsAll(candidate, examples)) continue;

    if (requireInteger) {
      const rounded = roundSpec(candidate);
      // Rounding must NOT break the fit — only accept exact integer programs.
      if (fitsAll(rounded, examples)) return rounded;
      continue;
    }
    return candidate;
  }
  return null; // honest: no exact deterministic spec for these examples
}

export class SkillInductionEngine {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.requireInteger = options.requireInteger !== false;
  }

  /** Infer from a flat example array. Returns {spec, kind, verified, examples} or null. */
  infer(rawExamples) {
    const spec = induceComputation(rawExamples, { requireInteger: this.requireInteger });
    if (!spec) return null;
    const examples = normalize(rawExamples);
    return { spec, kind: 'computational', verified: examples.length, examples: examples.length };
  }

  /**
   * Infer a computation for a cognitive_skills record. If the record already carries an
   * explicit computation it is returned as-is; otherwise we induce one from
   * `ast_graph.examples`. Returns a spec or null.
   */
  inferFromRecord(record) {
    let ast = {};
    try { ast = record.ast_graph ? JSON.parse(record.ast_graph) : (record.astGraph || {}); }
    catch { ast = {}; }
    if (ast.computation && ast.computation.type) return ast.computation;
    if (Array.isArray(ast.examples) && ast.examples.length) {
      const spec = induceComputation(ast.examples, { requireInteger: this.requireInteger });
      if (spec && this.verbose) {
        console.log(`🔬 [SkillInduction] Synthesized ${spec.type} spec for "${record.skill_id || record.id}" from ${ast.examples.length} examples.`);
      }
      return spec;
    }
    return null;
  }
}
