/* Event-locked averaging ("spike averaging") of a group of marked potentials.
 *
 * Each event contributes an epoch of the unfiltered referential channels,
 * centred on its (optionally re-aligned) time point; the epochs are summed and
 * divided by their number. Because montages and display filters are linear,
 * the averaged raw data can then be shown, filtered, re-montaged and mapped
 * exactly like a recording. The epoch is extended by the filter settling time
 * on both sides so that the displayed part is free of filter edge effects.
 *
 * Re-alignment (optional) moves each mark to the global field power maximum,
 * or to the negative / positive peak of one montage line, within ±search s.
 * Epochs that reach beyond the recording or into a gap are skipped. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const DSP = EEG.dsp;

  /* In-memory recording with the EdfSource read() interface; all channels at fs. */
  class MemorySource {
    constructor(base, data, fs, zeroIdx, meta) {
      this.format = 'Average';
      this.name = base.name;
      this.patient = base.patient;
      this.recording = base.recording;
      this.startMs = base.startMs;
      this.fs = fs;
      this.data = data;
      this.len = data.find(Boolean).length;
      this.duration = this.len / fs;
      this.tZero = zeroIdx / fs;
      this.signals = base.signals.map((s) => ({ ...s, fs: s.isAnnotation ? s.fs : fs }));
      this.dataSignals = base.dataSignals.map((s) => this.signals[s.index]);
      this.annotSignals = [];
      this.annotations = [];
      this.meta = meta;
      this.isAverage = true;
    }
    async read(t0, t1, sigIdx) {
      const i0 = Math.round(t0 * this.fs),
        i1 = Math.round(t1 * this.fs);
      return sigIdx.map((si) => {
        const out = new Float32Array(Math.max(0, i1 - i0)).fill(NaN);
        const a = this.data[si];
        if (!a) return out;
        const s = Math.max(0, i0),
          e = Math.min(this.len, i1);
        if (e > s) out.set(a.subarray(s, e), s - i0);
        return out;
      });
    }
  }

  /* o: {src, pipe, spec, times[], half (s), align: 'mark'|'gfp'|'neg'|'pos',
   *     search (s), gfpIdx[] (electrodes for GFP), line + ctx (for neg/pos), meta, onProgress} */
  async function computeAverage(o) {
    const { src, pipe, spec } = o;
    const fs = src.fs;
    const ctxS = Math.max(2, Math.ceil(DSP.padSeconds(spec)));
    const M = Math.round((o.half + ctxS) * fs);
    const S = o.align === 'mark' ? 0 : Math.round(o.search * fs);
    const last = Math.floor(src.duration * fs);
    const sigs = src.dataSignals.map((s) => s.index);
    const sum = new Map(sigs.map((si) => [si, new Float64Array(2 * M + 1)]));
    const used = [],
      skipped = [];
    for (let q = 0; q < o.times.length; q++) {
      const t = o.times[q];
      const kc = Math.round(t * fs);
      const ia = kc - M - S,
        ib = kc + M + S + 1;
      if (ia < 0 || ib > last) {
        skipped.push({ t, why: 'too close to the start or end of the recording' });
        continue;
      }
      const win = await pipe.window(ia / fs, ib / fs, spec);
      if (win.mask && win.mask.subarray(win.pad, win.pad + win.n).some((x) => x)) {
        skipped.push({ t, why: 'recording gap' });
        continue;
      }
      const kv = kc - win.i0; // index of the mark among visible samples
      let shift = 0;
      if (S > 0) shift = bestShift(win, kv, S, o);
      const k0 = win.pad + kv + shift - M;
      for (const si of sigs) {
        const a = win.raw[si],
          acc = sum.get(si);
        for (let j = 0; j <= 2 * M; j++) acc[j] += a[k0 + j];
      }
      used.push({ t, tAligned: (kc + shift) / fs, shift: shift / fs });
      if (o.onProgress) o.onProgress((q + 1) / o.times.length);
    }
    if (!used.length) return { source: null, used, skipped };
    const data = new Array(src.signals.length).fill(null);
    for (const si of sigs) {
      const acc = sum.get(si),
        out = new Float32Array(2 * M + 1);
      for (let j = 0; j <= 2 * M; j++) out[j] = acc[j] / used.length;
      data[si] = out;
    }
    const source = new MemorySource(src, data, fs, M, { ...o.meta, n: used.length, used, skipped, half: o.half });
    return { source, used, skipped };
  }

  /* Sample offset (−S…S) of the alignment feature around visible index kv. */
  function bestShift(win, kv, S, o) {
    let best = 0,
      bv = -Infinity;
    if (o.align === 'gfp') {
      const idx = o.gfpIdx,
        E = idx.length;
      for (let d = -S; d <= S; d++) {
        const k = win.pad + kv + d;
        let m = 0;
        for (let e = 0; e < E; e++) m += win.filt[idx[e]][k];
        m /= E;
        let s = 0;
        for (let e = 0; e < E; e++) {
          const v = win.filt[idx[e]][k] - m;
          s += v * v;
        }
        if (s > bv) {
          bv = s;
          best = d;
        }
      }
    } else {
      const y = win.derive(o.line, o.ctx);
      const sg = o.align === 'neg' ? -1 : 1;
      for (let d = -S; d <= S; d++) {
        const v = sg * y[kv + d];
        if (v > bv) {
          bv = v;
          best = d;
        }
      }
    }
    return best;
  }

  EEG.average = { MemorySource, computeAverage };
})(typeof window !== 'undefined' ? window : globalThis);
