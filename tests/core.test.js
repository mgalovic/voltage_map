/* Node test of the pure-logic modules against the example recordings.
 * Usage: node tests/core.test.js  (prints JSON consumed by tests/check_core.py) */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
for (const f of ['00-core.js', '10-positions.js', '20-dsp.js', '30-edf.js', '40-montage.js', '45-pipeline.js', '50-spline.js']) require(path.join(ROOT, 'app/src/js', f));
const EEG = globalThis.EEG;

async function openFile(p) {
  const blob = await fs.openAsBlob(p);
  Object.defineProperty(blob, 'name', { value: path.basename(p) });
  return EEG.formats.EdfSource.open(blob);
}

(async () => {
  const out = { files: {}, montages: {}, filters: {}, spline: {} };
  const files = fs.readdirSync(path.join(ROOT, 'example_files')).filter((f) => /\.edf$/i.test(f)).sort();
  const montageTexts = fs.readdirSync(path.join(ROOT, 'montages')).filter((f) => f.endsWith('.bqm'));
  const montages = [];
  for (const f of montageTexts) {
    const r = EEG.montage.parseBQM(fs.readFileSync(path.join(ROOT, 'montages', f), 'utf8'), f);
    if (r.warnings.length) out.montages['warn:' + f] = r.warnings;
    montages.push(...r.montages);
  }
  montages.sort((a, b) => a.order - b.order);

  for (const [fi, f] of files.entries()) {
    const src = await openFile(path.join(ROOT, 'example_files', f));
    const key = 'file' + fi;
    const info = {
      format: src.format,
      nRecords: src.nRecords,
      duration: src.duration,
      fs: src.fs,
      startMs: src.startMs,
      onset0: src.onset0,
      signals: src.signals.map((s) => [s.label, s.kind, s.std, s.fs, s.unit]),
    };
    // raw window reads at a few positions incl. a record boundary
    const sig = src.dataSignals.map((s) => s.index);
    const reads = {};
    for (const t0 of [0, 37.5, src.duration - 2]) {
      const arrs = await src.read(t0, t0 + 1.25, sig);
      reads[t0] = arrs.map((a) => Array.from(a.subarray(0, 8)).concat(Array.from(a.subarray(a.length - 3))));
    }
    info.reads = reads;
    // annotations
    await src.scanAnnotations();
    info.annotations = src.annotations.length;
    // montage resolution
    info.montages = {};
    for (const m of montages) {
      const r = EEG.montage.resolve(m, src);
      info.montages[m.name] = { missing: r.missing, lines: r.lines.map((l) => (l.kind === 'sep' ? '—' : l.label + (l.gain ? `@${l.gain}` : '') + (l.filter ? `[${l.filter.hp}-${l.filter.lp}]` : ''))) };
    }
    info.standard = EEG.montage.standardMontages(src).map((m) => m.name + ': ' + EEG.montage.resolve(m, src).lines.filter((l) => l.kind === 'line').map((l) => l.label).join(' '));
    // pipeline: filtered window + derivations
    const pipe = new EEG.pipeline.Pipeline(src);
    const spec = { hp: 0.53, lp: 70, notch: 0, mode: 'zerophase', hpOrder: 1, lpOrder: 2 };
    const t0 = 100;
    const w = await pipe.window(t0, t0 + 10, spec);
    const fp1 = src.dataSignals.find((s) => s.std === 'Fp1').index;
    const f7 = src.dataSignals.find((s) => s.std === 'F7').index;
    info.pipeline = {
      i0: w.i0,
      n: w.n,
      pad: w.pad,
      rawFp1: Array.from(w.channel(fp1, 'raw').subarray(0, 5)),
      filtFp1: Array.from(w.channel(fp1).subarray(1000, 1005)),
      bip: Array.from(w.derive({ plus: fp1, minus: f7, minusKind: 'ch' }, {}).subarray(1000, 1005)),
    };
    out.files[key] = info;
    out.files[key].name = f.slice(0, 5);
  }

  // filter responses at the nominal cut-offs
  for (const mode of ['zerophase', 'causal']) {
    const hp = EEG.dsp.design({ hp: 0.53, mode, hpOrder: 1 }, 256);
    const lp = EEG.dsp.design({ lp: 70, mode, lpOrder: 2 }, 256);
    const no = EEG.dsp.design({ notch: 50, mode }, 256);
    out.filters[mode] = {
      hp_at_fc: EEG.dsp.response(hp, 0.53, 256),
      hp_at_10: EEG.dsp.response(hp, 10, 256),
      lp_at_fc: EEG.dsp.response(lp, 70, 256),
      lp_at_10: EEG.dsp.response(lp, 10, 256),
      notch_at_50: EEG.dsp.response(no, 50, 256),
      notch_at_45: EEG.dsp.response(no, 45, 256),
    };
  }
  out.filters.butterLP2_sos = EEG.dsp.butter('lp', 30, 256, 2);
  out.filters.butterHP1_sos = EEG.dsp.butter('hp', 1, 256, 1);
  out.filters.butterLP4_sos = EEG.dsp.butter('lp', 40, 256, 4);

  // spline: interpolate a smooth field, check reproduction at electrodes and at held-out points
  const labs = ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'T7', 'C3', 'Cz', 'C4', 'T8', 'P7', 'P3', 'Pz', 'P4', 'P8', 'O1', 'O2', 'F9', 'T9', 'P9', 'F10', 'T10', 'P10'];
  const pos = labs.map((l) => EEG.positions.P[l]);
  const field = (p) => 10 * p[0] + 5 * p[1] * p[2] - 3 * p[2] + 2; // smooth test field
  const v = pos.map(field);
  const model = EEG.spline.build(pos, { m: 4, nTerms: 50, lambda: 1e-8 });
  const Wself = EEG.spline.weights(model, pos);
  const self = EEG.spline.apply(Wself, pos.length, v);
  const held = ['FC1', 'CP2', 'AF4', 'PO3', 'C5', 'FT8'].map((l) => EEG.positions.P[l]);
  const Wh = EEG.spline.weights(model, held);
  const hv = EEG.spline.apply(Wh, pos.length, v);
  out.spline = {
    maxSelfErr: Math.max(...Array.from(self).map((x, i) => Math.abs(x - v[i]))),
    held: Array.from(hv),
    heldTrue: held.map(field),
    positions: Object.fromEntries(['F3', 'C3', 'P3', 'F4', 'T9', 'F10', 'Fz', 'O1'].map((l) => [l, EEG.positions.polar(EEG.positions.P[l])])),
    rowsumW: Array.from(Wh.subarray(0, pos.length)).reduce((a, b) => a + b, 0),
  };
  // Python cross-check data for the spline: electrode positions, values and query points
  out.spline.pos = pos;
  out.spline.v = v;
  out.spline.q = held;
  fs.writeFileSync(path.join(__dirname, 'out_core.json'), JSON.stringify(out, null, 1));
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
