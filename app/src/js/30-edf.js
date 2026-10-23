/* EDF / EDF+ / BDF / BDF+ reader.
 *
 * Only the header is read on open; data records are read lazily in chunks via
 * Blob.slice(), decoded to physical units (µV for voltage channels) and kept in
 * a small LRU cache. Multi-hour and multi-GB recordings therefore open
 * instantly and memory use stays bounded. EDF+ annotations (TALs) are parsed in
 * a background scan; EDF+D (discontinuous) files are supported through the
 * per-record time-keeping TALs (gaps are returned as NaN). */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const U = EEG.util;

  const latin1 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };
  const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  const decodeText = (bytes) => (utf8 ? utf8.decode(bytes) : latin1(bytes));

  const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

  function unitFactor(dim) {
    const d = dim.trim().replace('µ', 'u').replace('μ', 'u').toLowerCase();
    if (d === 'uv') return { f: 1, unit: 'µV', volt: true };
    if (d === 'mv') return { f: 1e3, unit: 'µV', volt: true };
    if (d === 'v') return { f: 1e6, unit: 'µV', volt: true };
    if (d === 'nv') return { f: 1e-3, unit: 'µV', volt: true };
    return { f: 1, unit: dim.trim(), volt: false };
  }

  function classify(sig) {
    const { type, std } = sig.parsed;
    const lab = sig.label.toUpperCase();
    if (sig.isAnnotation) return 'annotation';
    if (type === 'MKR' || type === 'VALUE' || type === 'TRIG' || /MKR|TRIG|STATUS|PHOTIC|EVENT/.test(lab) || sig.transducer.toLowerCase() === 'marker') return 'marker';
    if (type === 'ECG' || type === 'EKG' || /\bECG|\bEKG/.test(lab)) return 'ecg';
    if (type === 'EMG' || /\bEMG/.test(lab)) return 'emg';
    if (type === 'EOG' || /\bEOG/.test(lab)) return 'eog';
    if (type === 'EEG' || std) return 'eeg';
    return 'other';
  }

  class EdfSource {
    constructor() {
      this.cache = new U.LRU(24);
      this.pending = new Map();
      this.annotations = [];
      this.annotationsReady = false;
    }

    static async open(file) {
      const src = new EdfSource();
      src.file = file;
      src.name = file.name;
      await src._parseHeader();
      await src._initTiming();
      return src;
    }

    async _parseHeader() {
      const f = this.file;
      const h0 = new Uint8Array(await f.slice(0, 256).arrayBuffer());
      if (h0.length < 256) throw new Error('File too small to be EDF/BDF.');
      const isBDF = h0[0] === 0xff && latin1(h0.subarray(1, 8)).startsWith('BIOSEMI');
      const ver = latin1(h0.subarray(0, 8));
      if (!isBDF && ver.trim() !== '0') throw new Error('Not an EDF/BDF file (version field "' + ver.trim() + '").');
      const txt = (a, b) => latin1(h0.subarray(a, b)).trim();
      this.isBDF = isBDF;
      this.bps = isBDF ? 3 : 2;
      this.patientField = txt(8, 88);
      this.recordingField = txt(88, 168);
      const sd = txt(168, 176),
        st = txt(176, 184);
      this.headerBytes = parseInt(txt(184, 192), 10);
      const reserved = txt(192, 236);
      this.nRecords = parseInt(txt(236, 244), 10);
      this.recDur = parseFloat(txt(244, 252));
      const ns = parseInt(txt(252, 256), 10);
      if (!(ns > 0)) throw new Error('Header reports no signals.');
      this.isPlus = /^(EDF|BDF)\+/.test(reserved);
      this.discontinuous = /^(EDF|BDF)\+D/.test(reserved);
      this.format = (isBDF ? 'BDF' : 'EDF') + (this.isPlus ? (this.discontinuous ? '+D' : '+C') : '');

      const hb = 256 * (ns + 1);
      const h1 = new Uint8Array(await f.slice(256, hb).arrayBuffer());
      let off = 0;
      const field = (w) => {
        const out = [];
        for (let i = 0; i < ns; i++) out.push(latin1(h1.subarray(off + i * w, off + (i + 1) * w)).trim());
        off += w * ns;
        return out;
      };
      const label = field(16),
        trans = field(80),
        dim = field(8),
        pmin = field(8),
        pmax = field(8),
        dmin = field(8),
        dmax = field(8),
        pref = field(80),
        nsamp = field(8);
      this.headerBytes = hb;

      let sampOff = 0;
      this.signals = [];
      for (let i = 0; i < ns; i++) {
        const isAnnotation = /^(EDF|BDF) Annotations$/i.test(label[i]);
        const n = parseInt(nsamp[i], 10);
        const pm = parseFloat(pmin[i]),
          pM = parseFloat(pmax[i]),
          dm = parseFloat(dmin[i]),
          dM = parseFloat(dmax[i]);
        const uf = unitFactor(dim[i]);
        const gain = ((pM - pm) / (dM - dm || 1)) * uf.f;
        const offset = (pm - dm * ((pM - pm) / (dM - dm || 1))) * uf.f;
        const sig = {
          index: i,
          label: label[i],
          transducer: trans[i],
          dim: dim[i],
          unit: uf.unit,
          volt: uf.volt,
          physMin: pm,
          physMax: pM,
          digMin: dm,
          digMax: dM,
          prefilter: pref[i],
          nsamp: n,
          fs: this.recDur > 0 ? n / this.recDur : 0,
          gain,
          offset,
          sampOffset: sampOff,
          isAnnotation,
        };
        sig.parsed = EEG.positions.parseLabel(sig.label);
        sig.kind = classify(sig);
        sig.std = sig.kind === 'eeg' ? sig.parsed.std : null;
        sig.display = sig.std || sig.parsed.name || sig.label;
        this.signals.push(sig);
        sampOff += n;
      }
      this.recSamples = sampOff;
      this.recBytes = sampOff * this.bps;
      const avail = Math.floor((f.size - hb) / this.recBytes);
      if (!(this.nRecords > 0) || this.nRecords > avail) this.nRecords = avail;
      if (this.nRecords <= 0) throw new Error('File contains no complete data records.');
      this.annotSignals = this.signals.filter((s) => s.isAnnotation);
      this.dataSignals = this.signals.filter((s) => !s.isAnnotation && s.nsamp > 0);
      if (!this.dataSignals.length) throw new Error('File contains no signal channels.');

      // fsMain: most common sampling rate among EEG channels (fallback: all data channels)
      const pool = this.dataSignals.filter((s) => s.kind === 'eeg');
      const counts = new Map();
      (pool.length ? pool : this.dataSignals).forEach((s) => counts.set(s.fs, (counts.get(s.fs) || 0) + 1));
      this.fs = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

      // chunk size ≈ 2 MB of raw data, at least one record
      this.K = Math.max(1, Math.floor((2 * 1024 * 1024) / this.recBytes));

      // start time
      const [dd, mm, yy] = sd.split(/[.\-/]/).map((x) => parseInt(x, 10));
      const [HH, MI, SS] = st.split(/[.:]/).map((x) => parseInt(x, 10));
      let year = yy >= 85 ? 1900 + yy : 2000 + yy;
      let month = mm - 1,
        day = dd;
      const m = this.recordingField.match(/Startdate\s+(\d{1,2})-([A-Z]{3})-(\d{4})/i);
      if (m && MONTHS[m[2].toUpperCase()] != null) {
        day = parseInt(m[1], 10);
        month = MONTHS[m[2].toUpperCase()];
        year = parseInt(m[3], 10);
      }
      this.headerStartMs = Date.UTC(year, month, day, HH || 0, MI || 0, SS || 0);
      if (!isFinite(this.headerStartMs)) this.headerStartMs = 0;

      this.patient = this._parsePatient(this.patientField);
      this.recording = this._parseRecording(this.recordingField);
    }

    _parsePatient(s) {
      if (!this.isPlus) return { name: s, code: '', sex: '', birthdate: '', raw: s };
      const p = s.split(' ');
      const clean = (x) => (!x || x === 'X' ? '' : x.replace(/_/g, ' '));
      return { code: clean(p[0]), sex: clean(p[1]), birthdate: clean(p[2]), name: clean(p[3]), extra: clean(p.slice(4).join(' ')), raw: s };
    }
    _parseRecording(s) {
      if (!this.isPlus) return { raw: s };
      const p = s.split(' ');
      const clean = (x) => (!x || x === 'X' ? '' : x.replace(/_/g, ' '));
      return { admin: clean(p[2]), technician: clean(p[3]), equipment: clean(p[4]), extra: clean(p.slice(5).join(' ')), raw: s };
    }

    /* Record onsets (EDF+D) and the sub-second start offset (EDF+). */
    async _initTiming() {
      this.onset0 = 0;
      this.onsets = null;
      if (this.isPlus && this.annotSignals.length) {
        if (this.discontinuous) {
          await this.scanAnnotations();
        } else {
          const b = new Uint8Array(await this.file.slice(this.headerBytes, this.headerBytes + this.recBytes).arrayBuffer());
          const a = this.annotSignals[0];
          const tals = parseTALs(b.subarray(a.sampOffset * this.bps, (a.sampOffset + a.nsamp) * this.bps));
          if (tals.length && tals[0].keep) this.onset0 = tals[0].onset;
        }
      }
      this.startMs = this.headerStartMs + this.onset0 * 1000;
      if (this.onsets) {
        this.duration = this.onsets[this.nRecords - 1] + this.recDur;
      } else {
        this.duration = this.nRecords * this.recDur;
      }
    }

    async scanAnnotations(onProgress) {
      if (this.annotationsReady) return this.annotations;
      if (this._scanPromise) return this._scanPromise;
      this._scanPromise = (async () => {
        const out = [];
        const onsets = this.discontinuous ? new Float64Array(this.nRecords) : null;
        if (this.annotSignals.length) {
          const per = Math.max(1, Math.floor((8 * 1024 * 1024) / this.recBytes));
          for (let r0 = 0; r0 < this.nRecords; r0 += per) {
            const r1 = Math.min(this.nRecords, r0 + per);
            const buf = new Uint8Array(await this.file.slice(this.headerBytes + r0 * this.recBytes, this.headerBytes + r1 * this.recBytes).arrayBuffer());
            for (let r = r0; r < r1; r++) {
              const base = (r - r0) * this.recBytes;
              this.annotSignals.forEach((a, ai) => {
                const tals = parseTALs(buf.subarray(base + a.sampOffset * this.bps, base + (a.sampOffset + a.nsamp) * this.bps));
                tals.forEach((t, ti) => {
                  if (ai === 0 && ti === 0 && t.keep) {
                    if (onsets) onsets[r] = t.onset;
                    return;
                  }
                  t.texts.forEach((txt) => out.push({ onset: t.onset, duration: t.duration, text: txt }));
                });
              });
            }
            if (onProgress) onProgress(r1 / this.nRecords);
            await new Promise((res) => setTimeout(res, 0));
          }
        }
        if (onsets) {
          this.onset0 = onsets[0];
          for (let r = 0; r < onsets.length; r++) onsets[r] -= this.onset0;
          this.onsets = onsets;
        }
        out.forEach((a) => (a.onset -= this.onset0));
        out.sort((a, b) => a.onset - b.onset);
        this.annotations = out;
        this.annotationsReady = true;
        return out;
      })();
      return this._scanPromise;
    }

    async _chunk(ci) {
      const hit = this.cache.get(ci);
      if (hit) return hit;
      if (this.pending.has(ci)) return this.pending.get(ci);
      const p = (async () => {
        const r0 = ci * this.K,
          r1 = Math.min(this.nRecords, r0 + this.K),
          nr = r1 - r0;
        const buf = await this.file.slice(this.headerBytes + r0 * this.recBytes, this.headerBytes + r1 * this.recBytes).arrayBuffer();
        const data = new Array(this.signals.length).fill(null);
        const S = this.recSamples;
        if (this.bps === 2) {
          const i16 = new Int16Array(buf, 0, (buf.byteLength >> 1) << 0);
          for (const s of this.dataSignals) {
            const n = s.nsamp,
              out = new Float32Array(nr * n),
              g = s.gain,
              o = s.offset;
            for (let r = 0; r < nr; r++) {
              const src = r * S + s.sampOffset,
                dst = r * n;
              for (let k = 0; k < n; k++) out[dst + k] = i16[src + k] * g + o;
            }
            data[s.index] = out;
          }
        } else {
          const u8 = new Uint8Array(buf);
          for (const s of this.dataSignals) {
            const n = s.nsamp,
              out = new Float32Array(nr * n),
              g = s.gain,
              o = s.offset;
            for (let r = 0; r < nr; r++) {
              let p3 = (r * S + s.sampOffset) * 3;
              const dst = r * n;
              for (let k = 0; k < n; k++, p3 += 3) {
                let v = u8[p3] | (u8[p3 + 1] << 8) | (u8[p3 + 2] << 16);
                if (v & 0x800000) v -= 0x1000000;
                out[dst + k] = v * g + o;
              }
            }
            data[s.index] = out;
          }
        }
        const chunk = { r0, nr, data };
        this.cache.set(ci, chunk);
        this.pending.delete(ci);
        return chunk;
      })();
      this.pending.set(ci, p);
      return p;
    }

    recordOnset(r) {
      return this.onsets ? this.onsets[r] : r * this.recDur;
    }

    /* Read signals `sigIdx` over [t0, t1) seconds. Returns, per signal, a
     * Float32Array sampled at that signal's own rate starting at sample
     * round(t0·fs); samples outside the recording (or in EDF+D gaps) are NaN. */
    async read(t0, t1, sigIdx) {
      const outs = sigIdx.map((si) => {
        const fs = this.signals[si].fs;
        const i0 = Math.round(t0 * fs),
          i1 = Math.round(t1 * fs);
        return { i0, fs, a: new Float32Array(Math.max(0, i1 - i0)).fill(NaN) };
      });
      let rs, re;
      if (this.onsets) {
        rs = Math.max(0, U.bisectRight(this.onsets, t0));
        re = Math.min(this.nRecords, U.bisectRight(this.onsets, t1) + 1);
      } else {
        rs = Math.max(0, Math.floor(t0 / this.recDur));
        re = Math.min(this.nRecords, Math.ceil(t1 / this.recDur));
      }
      if (re <= rs) return outs.map((o) => o.a);
      const c0 = Math.floor(rs / this.K),
        c1 = Math.floor((re - 1) / this.K);
      const chunks = await Promise.all(Array.from({ length: c1 - c0 + 1 }, (_, i) => this._chunk(c0 + i)));
      for (const ch of chunks) {
        const ra = Math.max(rs, ch.r0),
          rb = Math.min(re, ch.r0 + ch.nr);
        for (let r = ra; r < rb; r++) {
          const on = this.recordOnset(r);
          sigIdx.forEach((si, j) => {
            const s = this.signals[si];
            const o = outs[j];
            const src = ch.data[si];
            if (!src) return;
            const n = s.nsamp;
            const start = Math.round(on * s.fs) - o.i0; // dest index of record's first sample
            const a = Math.max(0, -start),
              b = Math.min(n, o.a.length - start);
            if (b <= a) return;
            const so = (r - ch.r0) * n;
            o.a.set(src.subarray(so + a, so + b), start + a);
          });
        }
      }
      // opportunistic prefetch of the following chunk (sequential review)
      const next = c1 + 1;
      if (next * this.K < this.nRecords && !this.cache.has(next) && !this.pending.has(next)) this._chunk(next).catch(() => {});
      return outs.map((o) => o.a);
    }
  }

  /* Parse the Time-stamped Annotation Lists in one annotation signal block. */
  function parseTALs(bytes) {
    const out = [];
    let i = 0;
    const n = bytes.length;
    while (i < n) {
      if (bytes[i] === 0) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && bytes[j] !== 0) j++;
      const tal = bytes.subarray(i, j);
      i = j + 1;
      // split on 0x14
      const parts = [];
      let s = 0;
      for (let k = 0; k < tal.length; k++)
        if (tal[k] === 0x14) {
          parts.push(tal.subarray(s, k));
          s = k + 1;
        }
      if (s < tal.length) parts.push(tal.subarray(s));
      if (!parts.length) continue;
      const head = latin1(parts[0]);
      const [on, du] = head.split('\x15');
      const onset = parseFloat(on);
      if (!isFinite(onset)) continue;
      const texts = parts
        .slice(1)
        .map((p) => decodeText(p).trim())
        .filter((x) => x.length);
      out.push({ onset, duration: du ? parseFloat(du) || 0 : 0, texts, keep: texts.length === 0 });
    }
    return out;
  }

  EEG.formats = EEG.formats || {};
  EEG.formats.EdfSource = EdfSource;
  EEG.formats.parseTALs = parseTALs;
})(typeof window !== 'undefined' ? window : globalThis);
