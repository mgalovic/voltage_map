/* "Find similar": spatio-temporal template matching over a whole recording.
 *
 * Template: the average of a group's (aligned) events, filtered with the
 * display filters and re-referenced to the common average of the mapped
 * electrodes, over a short window around the alignment point (E electrodes ×
 * L samples). Every time point t of the recording is scored with the
 * correlation between the template and the data window starting at t:
 *
 *   r(t) = Σ_e Σ_l T[e,l]·X[e,t+l] / (‖T‖·‖X_t‖)
 *
 * X is average-referenced, so each column has zero mean across electrodes and
 * r equals the Pearson correlation of the two spatio-temporal patterns: it is
 * high only when topography, polarity and time course all match, independent
 * of amplitude. The amplitude ratio ‖X_t‖/‖T‖ is reported separately. Local
 * maxima of r are kept with a refractory period (non-maximum suppression). */
(function (G) {
  'use strict';
  const EEG = G.EEG;

  /* Template from a filtered window `w` (Pipeline.Window) whose visible part
   * starts at the template start: T[e*L + l], average-referenced per sample. */
  function templateFrom(w, idx, L) {
    const E = idx.length,
      T = new Float32Array(E * L);
    for (let l = 0; l < L; l++) {
      let m = 0;
      for (let e = 0; e < E; e++) m += w.filt[idx[e]][w.pad + l];
      m /= E;
      for (let e = 0; e < E; e++) T[e * L + l] = w.filt[idx[e]][w.pad + l] - m;
    }
    return T;
  }

  /* o: {src, pipe, spec, idx[], T, L, pre (samples before the alignment point),
   *     floor (min r kept), refractory (s), chunk (s), onProgress(f), cancelled()} */
  async function scan(o) {
    const { src, pipe, spec, idx, T, L } = o;
    const fs = src.fs,
      E = idx.length;
    let TT = 0;
    for (let i = 0; i < T.length; i++) TT += T[i] * T[i];
    if (!(TT > 0)) return [];
    const nTot = Math.floor(src.duration * fs);
    const C = Math.round((o.chunk || 120) * fs);
    const X = Array.from({ length: E }, () => new Float32Array(C + L));
    const num = new Float64Array(C);
    const cum = new Float64Array(C + L + 1);
    const gaps = new Int32Array(C + L + 1);
    const r = new Float32Array(C);
    const amp = new Float32Array(C);
    const floor = o.floor == null ? 0.5 : o.floor;
    const raw = [];
    for (let s0 = 0; s0 + L < nTot; s0 += C) {
      if (o.cancelled && o.cancelled()) return null;
      const n = Math.min(C, nTot - L - s0);
      const w = await pipe.window(s0 / fs, (s0 + n + L) / fs, spec);
      const N = n + L;
      for (let k = 0; k < N; k++) {
        let m = 0;
        for (let e = 0; e < E; e++) m += w.filt[idx[e]][w.pad + k];
        m /= E;
        let s2 = 0;
        for (let e = 0; e < E; e++) {
          const v = w.filt[idx[e]][w.pad + k] - m;
          X[e][k] = v;
          s2 += v * v;
        }
        cum[k + 1] = cum[k] + s2;
        gaps[k + 1] = gaps[k] + (w.mask && w.mask[w.pad + k] ? 1 : 0);
      }
      num.fill(0, 0, n);
      for (let e = 0; e < E; e++) {
        const xe = X[e],
          o0 = e * L;
        for (let l = 0; l < L; l++) {
          const tv = T[o0 + l];
          if (tv === 0) continue;
          for (let t = 0; t < n; t++) num[t] += tv * xe[t + l];
        }
      }
      for (let t = 0; t < n; t++) {
        const en = cum[t + L] - cum[t];
        // windows touching a recording gap are not scored
        if (gaps[t + L] - gaps[t] > 0 || !(en > 0)) {
          r[t] = 0;
          amp[t] = 0;
          continue;
        }
        r[t] = num[t] / Math.sqrt(en * TT);
        amp[t] = Math.sqrt(en / TT);
      }
      for (let t = 1; t < n - 1; t++) {
        if (r[t] >= floor && r[t] >= r[t - 1] && r[t] > r[t + 1]) raw.push({ t: (s0 + t + o.pre) / fs, r: r[t], amp: amp[t] });
      }
      if (o.onProgress) o.onProgress(Math.min(1, (s0 + n + L) / nTot));
      await new Promise((res) => setTimeout(res, 0));
    }
    // non-maximum suppression: strongest first, nothing else within ±refractory
    const ref = o.refractory == null ? 0.2 : o.refractory;
    raw.sort((a, b) => b.r - a.r);
    const kept = [];
    const taken = [];
    for (const p of raw) {
      let i = lowerBound(taken, p.t - ref);
      if (i < taken.length && taken[i] <= p.t + ref) continue;
      taken.splice(i, 0, p.t);
      kept.push(p);
    }
    return kept.sort((a, b) => a.t - b.t);
  }

  function lowerBound(a, x) {
    let lo = 0,
      hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  EEG.similar = { templateFrom, scan };
})(typeof window !== 'undefined' ? window : globalThis);
