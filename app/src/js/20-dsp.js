/* Digital filters for EEG display.
 *
 * Filters are cascades of biquads (direct form II transposed, float64 state).
 * Two modes:
 *  - 'zerophase': forward–backward (no phase distortion, peaks stay aligned —
 *    recommended for voltage mapping). The design frequency is corrected so the
 *    *combined* response is −3 dB at the nominal cut-off, i.e. "0.53 Hz" means
 *    the same thing as on a conventional system.
 *  - 'causal': single forward pass, like an analogue/classic EEG amplifier.
 * Edge transients are avoided by filtering a padded window (real data on both
 * sides, reflected only at the recording boundaries) and starting each section
 * from its steady state for the first sample. */
(function (G) {
  'use strict';
  const EEG = G.EEG;

  /* Second-order Butterworth-family sections via RBJ formulas (bilinear with prewarp). */
  function biquadLP(f0, fs, Q) {
    const w = (2 * Math.PI * f0) / fs,
      c = Math.cos(w),
      al = Math.sin(w) / (2 * Q),
      a0 = 1 + al;
    return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
  }
  function biquadHP(f0, fs, Q) {
    const w = (2 * Math.PI * f0) / fs,
      c = Math.cos(w),
      al = Math.sin(w) / (2 * Q),
      a0 = 1 + al;
    return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
  }
  function firstLP(f0, fs) {
    const K = Math.tan((Math.PI * f0) / fs);
    return { b0: K / (1 + K), b1: K / (1 + K), b2: 0, a1: (K - 1) / (K + 1), a2: 0 };
  }
  function firstHP(f0, fs) {
    const K = Math.tan((Math.PI * f0) / fs);
    return { b0: 1 / (1 + K), b1: -1 / (1 + K), b2: 0, a1: (K - 1) / (K + 1), a2: 0 };
  }
  function notch(f0, fs, Q) {
    const w = (2 * Math.PI * f0) / fs,
      c = Math.cos(w),
      al = Math.sin(w) / (2 * Q),
      a0 = 1 + al;
    return { b0: 1 / a0, b1: (-2 * c) / a0, b2: 1 / a0, a1: (-2 * c) / a0, a2: (1 - al) / a0 };
  }

  /* Butterworth of arbitrary order as cascaded sections. */
  function butter(type, fc, fs, order) {
    const secs = [];
    const nPairs = Math.floor(order / 2);
    for (let k = 0; k < nPairs; k++) {
      const theta = (Math.PI * (2 * k + 1)) / (2 * order);
      const Q = 1 / (2 * Math.sin(theta));
      secs.push(type === 'lp' ? biquadLP(fc, fs, Q) : biquadHP(fc, fs, Q));
    }
    if (order % 2) secs.push(type === 'lp' ? firstLP(fc, fs) : firstHP(fc, fs));
    return secs;
  }

  /* Design frequency so that forward–backward filtering gives −3 dB at fc.
   * The correction is applied to the bilinear-warped frequency tan(πf/fs),
   * where the digital Butterworth magnitude has its exact analogue form. */
  function zpCorrect(type, fc, order, fs) {
    const k = Math.pow(Math.SQRT2 - 1, 1 / (2 * order));
    const w = Math.tan((Math.PI * fc) / fs);
    const w0 = type === 'lp' ? w / k : w * k;
    return (fs / Math.PI) * Math.atan(w0);
  }

  /* spec: {hp, lp, notch, notchHarmonics, mode, hpOrder, lpOrder}; returns a chain or null */
  function design(spec, fs) {
    const zp = spec.mode !== 'causal';
    const secs = [];
    const nyq = fs / 2;
    if (spec.hp > 0) {
      const o = spec.hpOrder || 1;
      const f = zp ? zpCorrect('hp', spec.hp, o, fs) : spec.hp;
      if (f < nyq * 0.95) secs.push(...butter('hp', f, fs, o));
    }
    if (spec.lp > 0) {
      const o = spec.lpOrder || 2;
      const f = zp ? zpCorrect('lp', spec.lp, o, fs) : spec.lp;
      if (f < nyq * 0.95) secs.push(...butter('lp', f, fs, o));
    }
    if (spec.notch > 0) {
      for (let h = 1; h <= (spec.notchHarmonics ? 4 : 1); h++) {
        const f = spec.notch * h;
        if (f < nyq * 0.98) secs.push(notch(f, fs, spec.notchQ || 30));
      }
    }
    if (!secs.length) return null;
    return { secs, zeroPhase: zp };
  }

  /* Run sections over x in place (forward). Steady-state initial conditions for x[0]. */
  function runForward(secs, x) {
    const n = x.length;
    if (!n) return;
    for (const s of secs) {
      const { b0, b1, b2, a1, a2 } = s;
      const x0 = x[0];
      const dc = (b0 + b1 + b2) / (1 + a1 + a2);
      const y0 = isFinite(dc) ? dc * x0 : 0;
      let z2 = b2 * x0 - a2 * y0;
      let z1 = b1 * x0 - a1 * y0 + z2;
      for (let i = 0; i < n; i++) {
        const xi = x[i];
        const yi = b0 * xi + z1;
        z1 = b1 * xi - a1 * yi + z2;
        z2 = b2 * xi - a2 * yi;
        x[i] = yi;
      }
    }
  }
  function runBackward(secs, x) {
    const n = x.length;
    if (!n) return;
    for (const s of secs) {
      const { b0, b1, b2, a1, a2 } = s;
      const x0 = x[n - 1];
      const dc = (b0 + b1 + b2) / (1 + a1 + a2);
      const y0 = isFinite(dc) ? dc * x0 : 0;
      let z2 = b2 * x0 - a2 * y0;
      let z1 = b1 * x0 - a1 * y0 + z2;
      for (let i = n - 1; i >= 0; i--) {
        const xi = x[i];
        const yi = b0 * xi + z1;
        z1 = b1 * xi - a1 * yi + z2;
        z2 = b2 * xi - a2 * yi;
        x[i] = yi;
      }
    }
  }

  function apply(chain, x) {
    if (!chain) return x;
    runForward(chain.secs, x);
    if (chain.zeroPhase) runBackward(chain.secs, x);
    return x;
  }

  /* Seconds of real-data padding needed so edge transients have decayed. */
  function padSeconds(spec) {
    let p = 1;
    if (spec.hp > 0) p = Math.max(p, Math.min(30, 2.5 / spec.hp));
    if (spec.notch > 0) p = Math.max(p, 1.5);
    return p;
  }

  /* Magnitude response |H(f)| of a chain (for tests / UI). */
  function response(chain, f, fs) {
    if (!chain) return 1;
    const w = (2 * Math.PI * f) / fs;
    let mag = 1;
    for (const s of chain.secs) {
      const cr = (k) => Math.cos(k * w),
        si = (k) => -Math.sin(k * w);
      const nr = s.b0 + s.b1 * cr(1) + s.b2 * cr(2),
        ni = s.b1 * si(1) + s.b2 * si(2);
      const dr = 1 + s.a1 * cr(1) + s.a2 * cr(2),
        di = s.a1 * si(1) + s.a2 * si(2);
      mag *= Math.hypot(nr, ni) / Math.hypot(dr, di);
    }
    return chain.zeroPhase ? mag * mag : mag;
  }

  /* In-place radix-2 complex FFT (re, im Float64Array, length power of 2). */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang),
        wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1,
          ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j,
            b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci,
            ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  EEG.dsp = { design, apply, runForward, runBackward, padSeconds, response, butter, zpCorrect, notch, fft };
})(typeof window !== 'undefined' ? window : globalThis);
