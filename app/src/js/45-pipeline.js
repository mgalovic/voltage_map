/* Signal pipeline: fetches a padded time window from the source, resamples
 * channels to the common rate, fills edges/gaps, applies the master filter and
 * derives montage lines (bipolar, average, Hjorth, as recorded).
 *
 * Montage derivations are linear, so lines linked to the master filter are
 * computed from the already-filtered referential channels; lines with their own
 * filter settings (e.g. ECG 5.3–15 Hz) are derived from raw data and filtered
 * separately. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const DSP = EEG.dsp;

  /* Linear resampling of a signal read at fsIn (first sample at index iIn0) onto
   * N samples at fsOut starting at index iOut0. */
  function resample(a, fsIn, iIn0, fsOut, iOut0, N) {
    const out = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const t = (iOut0 + k) / fsOut;
      const x = t * fsIn - iIn0;
      const j = Math.floor(x),
        f = x - j;
      if (j < 0 || j + 1 >= a.length) out[k] = j >= 0 && j < a.length ? a[j] : NaN;
      else out[k] = a[j] * (1 - f) + a[j + 1] * f;
    }
    return out;
  }

  /* Replace NaNs: odd reflection at the edges, linear interpolation in gaps. */
  function fillNaN(a) {
    const n = a.length;
    let first = -1,
      last = -1;
    for (let i = 0; i < n; i++)
      if (a[i] === a[i]) {
        first = i;
        break;
      }
    if (first < 0) {
      a.fill(0);
      return;
    }
    for (let i = n - 1; i >= 0; i--)
      if (a[i] === a[i]) {
        last = i;
        break;
      }
    // gaps
    let i = first;
    while (i < last) {
      if (a[i + 1] !== a[i + 1]) {
        let j = i + 1;
        while (a[j] !== a[j]) j++;
        const v0 = a[i],
          v1 = a[j];
        for (let k = i + 1; k < j; k++) a[k] = v0 + ((v1 - v0) * (k - i)) / (j - i);
        i = j;
      } else i++;
    }
    const span = last - first;
    for (let k = 1; k <= first; k++) a[first - k] = 2 * a[first] - a[first + Math.min(k, span)];
    for (let k = 1; k < n - last; k++) a[last + k] = 2 * a[last] - a[last - Math.min(k, span)];
  }

  class Window {
    constructor(o) {
      Object.assign(this, o);
      this._avg = new Map();
    }
    /* time of visible sample k */
    time(k) {
      return (this.i0 + k) / this.fs;
    }
    index(t) {
      return Math.round(t * this.fs) - this.i0;
    }
    contains(t) {
      const k = this.index(t);
      return k >= 0 && k < this.n;
    }
    /* mean over channels idx on base ('filt' | 'raw'), padded length */
    avg(base, idx) {
      const key = base + ':' + idx.join(',');
      if (this._avg.has(key)) return this._avg.get(key);
      const arrs = idx.map((i) => this[base][i]).filter(Boolean);
      const N = this.N,
        out = new Float32Array(N);
      if (arrs.length) {
        for (const a of arrs) for (let k = 0; k < N; k++) out[k] += a[k];
        const inv = 1 / arrs.length;
        for (let k = 0; k < N; k++) out[k] *= inv;
      }
      this._avg.set(key, out);
      return out;
    }
    /* Derive one resolved montage line. ctx: {avgIdx, lapW, spec, lineSpec(line)} */
    derive(line, ctx) {
      const own = line.filter ? ctx.lineSpec(line) : null;
      const base = own ? 'raw' : 'filt';
      const N = this.N;
      const p = this[base][line.plus];
      const y = new Float32Array(N);
      y.set(p);
      if (line.minusKind === 'ch') {
        const m = this[base][line.minus];
        for (let k = 0; k < N; k++) y[k] -= m[k];
      } else if (line.minusKind === 'avg') {
        const m = this.avg(base, ctx.avgIdx);
        for (let k = 0; k < N; k++) y[k] -= m[k];
      } else if (line.minusKind === 'lap') {
        const nb = ctx.lapW.get(line.plus) || [];
        for (const [j, w] of nb) {
          const m = this[base][j];
          for (let k = 0; k < N; k++) y[k] -= w * m[k];
        }
      }
      if (own) DSP.apply(DSP.design(own, this.fs), y);
      const vis = y.slice(this.pad, this.pad + this.n);
      if (this.mask) for (let k = 0; k < this.n; k++) if (this.mask[this.pad + k]) vis[k] = NaN;
      return vis;
    }
    /* Visible filtered referential channel (copy). */
    channel(i, base = 'filt') {
      const v = this[base][i].slice(this.pad, this.pad + this.n);
      if (this.mask) for (let k = 0; k < this.n; k++) if (this.mask[this.pad + k]) v[k] = NaN;
      return v;
    }
    isGap(k) {
      return !!(this.mask && this.mask[this.pad + k]);
    }
  }

  class Pipeline {
    constructor(src) {
      this.src = src;
      this.fs = src.fs;
      this.sigs = src.dataSignals.map((s) => s.index);
    }
    /* specs: master filter spec plus any per-line specs (only used for padding). */
    async window(t0, t1, spec, extraSpecs = []) {
      const fs = this.fs;
      const i0 = Math.round(t0 * fs),
        i1 = Math.max(i0 + 1, Math.round(t1 * fs)),
        n = i1 - i0;
      let padS = DSP.padSeconds(spec);
      for (const s of extraSpecs) padS = Math.max(padS, DSP.padSeconds(s));
      const pad = Math.ceil(padS * fs);
      const N = n + 2 * pad;
      const ta = (i0 - pad) / fs,
        tb = (i1 + pad) / fs;
      const arrs = await this.src.read(ta, tb, this.sigs);
      const raw = new Array(this.src.signals.length).fill(null);
      let mask = null;
      this.sigs.forEach((si, j) => {
        const s = this.src.signals[si];
        let a = arrs[j];
        if (s.fs !== fs) a = resample(a, s.fs, Math.round(ta * s.fs), fs, i0 - pad, N);
        else if (a.length !== N) {
          const b = new Float32Array(N).fill(NaN);
          b.set(a.subarray(0, Math.min(N, a.length)));
          a = b;
        }
        raw[si] = a;
      });
      // gap mask from the first data channel (EDF gaps affect all channels)
      const ref = raw[this.sigs[0]];
      for (let k = 0; k < N; k++)
        if (ref[k] !== ref[k]) {
          mask = mask || new Uint8Array(N);
          mask[k] = 1;
        }
      if (mask) for (const si of this.sigs) fillNaN(raw[si]);
      const chain = DSP.design(spec, fs);
      const filt = raw.map((a) => (a ? DSP.apply(chain, Float32Array.from(a)) : null));
      return new Window({ i0, n, N, pad, fs, raw, filt, mask, spec, t0: i0 / fs, t1: i1 / fs });
    }
  }

  EEG.pipeline = { Pipeline, Window, fillNaN, resample };
})(typeof window !== 'undefined' ? window : globalThis);
