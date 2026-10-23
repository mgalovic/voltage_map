/* Spherical spline interpolation (Perrin, Pernier, Bertrand & Echallier,
 * Electroencephalogr Clin Neurophysiol 1989;72:184–187; corrigendum 1990).
 *
 *   V(r) = c0 + Σ_i c_i g(cos(r, r_i)),  Σ_i c_i = 0
 *   g(x) = 1/(4π) Σ_{n≥1} (2n+1) / (n(n+1))^m · P_n(x)
 * Surface Laplacian / scalp current density (CSD):
 *   −∇²V = Σ_i c_i h(x)/R²,  h(x) = 1/(4π) Σ (2n+1) / (n(n+1))^(m−1) · P_n(x)
 *
 * The (n+1)×(n+1) system is inverted once per electrode set; interpolation
 * weights for any set of target points are then a fixed matrix, so each map is
 * a single matrix–vector product (fast enough for live scrubbing). */
(function (G) {
  'use strict';
  const EEG = G.EEG;

  function legendreSum(x, m, nTerms, power) {
    // Σ_{n=1..N} (2n+1)/(n(n+1))^power P_n(x) / 4π
    let p0 = 1,
      p1 = x,
      s = 0;
    for (let n = 1; n <= nTerms; n++) {
      if (n > 1) {
        const p2 = ((2 * n - 1) * x * p1 - (n - 1) * p0) / n;
        p0 = p1;
        p1 = p2;
      }
      s += ((2 * n + 1) / Math.pow(n * (n + 1), power)) * p1;
    }
    return s / (4 * Math.PI);
  }

  /* Tabulated kernel on cos ∈ [−1, 1] with linear interpolation. */
  function makeTable(m, nTerms, power, size = 4001) {
    const t = new Float64Array(size);
    for (let i = 0; i < size; i++) t[i] = legendreSum(-1 + (2 * i) / (size - 1), m, nTerms, power);
    const sc = (size - 1) / 2;
    return (x) => {
      const f = (x + 1) * sc;
      let i = Math.floor(f);
      if (i < 0) return t[0];
      if (i >= size - 1) return t[size - 1];
      const r = f - i;
      return t[i] * (1 - r) + t[i + 1] * r;
    };
  }

  /* Gauss–Jordan inverse with partial pivoting (n ≤ a few hundred). */
  function invert(A, n) {
    const M = new Float64Array(n * 2 * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i * 2 * n + j] = A[i * n + j];
      M[i * 2 * n + n + i] = 1;
    }
    const W = 2 * n;
    for (let c = 0; c < n; c++) {
      let piv = c,
        best = Math.abs(M[c * W + c]);
      for (let r = c + 1; r < n; r++) {
        const v = Math.abs(M[r * W + c]);
        if (v > best) {
          best = v;
          piv = r;
        }
      }
      if (best < 1e-300) throw new Error('Singular spline matrix');
      if (piv !== c)
        for (let j = 0; j < W; j++) {
          const t = M[c * W + j];
          M[c * W + j] = M[piv * W + j];
          M[piv * W + j] = t;
        }
      const d = M[c * W + c];
      for (let j = 0; j < W; j++) M[c * W + j] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r * W + c];
        if (f === 0) continue;
        for (let j = 0; j < W; j++) M[r * W + j] -= f * M[c * W + j];
      }
    }
    const out = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = M[i * W + n + j];
    return out;
  }

  const tables = new Map();
  function kernel(m, nTerms, power) {
    const key = m + ':' + nTerms + ':' + power;
    if (!tables.has(key)) tables.set(key, makeTable(m, nTerms, power));
    return tables.get(key);
  }

  /* Build the spline model for electrode unit vectors `pos`. */
  function build(pos, opts = {}) {
    const m = opts.m || 4,
      nTerms = opts.nTerms || 50,
      lambda = opts.lambda == null ? 1e-5 : opts.lambda;
    const n = pos.length;
    const N = n + 1;
    const A = new Float64Array(N * N);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const c = Math.max(-1, Math.min(1, pos[i][0] * pos[j][0] + pos[i][1] * pos[j][1] + pos[i][2] * pos[j][2]));
        A[i * N + j] = legendreSum(c, m, nTerms, m) + (i === j ? lambda : 0);
      }
      A[i * N + n] = 1;
      A[n * N + i] = 1;
    }
    A[n * N + n] = 0;
    return { n, pos, m, nTerms, lambda, Ainv: invert(A, N) };
  }

  /* Interpolation weights: Float32Array(nPts × n); value(p) = Σ_e w[p·n+e]·V_e.
   * kind 'V' (potential) or 'CSD' (scalp current density, µV/cm² for R = 9 cm). */
  function weights(model, pts, kind = 'V', radiusCm = 9) {
    const { n, pos, m, nTerms, Ainv } = model;
    const N = n + 1;
    const g = kind === 'CSD' ? kernel(m, nTerms, m - 1) : kernel(m, nTerms, m);
    const W = new Float32Array(pts.length * n);
    const row = new Float64Array(N);
    const sc = kind === 'CSD' ? 1 / (radiusCm * radiusCm) : 1;
    for (let p = 0; p < pts.length; p++) {
      const q = pts[p];
      if (!q) continue;
      for (let e = 0; e < n; e++) row[e] = g(q[0] * pos[e][0] + q[1] * pos[e][1] + q[2] * pos[e][2]);
      row[n] = kind === 'CSD' ? 0 : 1;
      for (let e = 0; e < n; e++) {
        let s = 0;
        for (let k = 0; k < N; k++) s += row[k] * Ainv[k * N + e];
        W[p * n + e] = s * sc;
      }
    }
    return W;
  }

  /* values at points: out[p] = Σ_e W[p,e] v[e] */
  function apply(W, n, v, out) {
    const P = W.length / n;
    out = out || new Float32Array(P);
    for (let p = 0, o = 0; p < P; p++, o += n) {
      let s = 0;
      for (let e = 0; e < n; e++) s += W[o + e] * v[e];
      out[p] = s;
    }
    return out;
  }

  EEG.spline = { build, weights, apply, legendreSum, invert };
})(typeof window !== 'undefined' ? window : globalThis);
