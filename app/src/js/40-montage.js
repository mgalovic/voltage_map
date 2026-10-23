/* Montages: BrainQuick (.bqm) import, standard montages, and resolution of
 * montage lines against the channels of an open recording.
 *
 * A montage line is { kind:'sep' } or
 *   { plus, minus, label?, gain?, filter?, color? }
 * where plus is an electrode label (10-10 name) or a special token
 * ('@ECG', '@EMG', '@MKR'), and minus is an electrode label, '@AVG' (common
 * average), '@LAP' (Hjorth source derivation) or null (as recorded). */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const POS = EEG.positions;

  /* Micromed electrode codes used in BrainQuick montage files. Decoded from the
   * USZ montages and confirmed against a BrainQuick screenshot (right
   * hemisphere chains on top, 10-10 temporal names). */
  const MICROMED_CODES = {
    1: 'Fp1', 2: 'Fp2', 3: 'F3', 4: 'F4', 5: 'F7', 6: 'F8', 7: 'Fz', 8: 'C3', 9: 'C4', 10: 'Cz',
    11: 'P3', 12: 'P4', 13: 'Pz', 14: 'O1', 15: 'O2', 22: 'A2', 23: 'A1',
    40: 'T7', 44: 'T8', 45: 'P7', 49: 'P8',
    56: 'F9', 57: 'T9', 58: 'P9', 59: 'F10', 60: 'T10', 61: 'P10',
    167: '@ECG', 185: '@EMG', 174: '@MKR',
  };

  const argbToCss = (v) => {
    const n = Number(v) >>> 0;
    const r = (n >> 16) & 255,
      g = (n >> 8) & 255,
      b = n & 255;
    if (r === 0 && g === 0 && b === 0) return null; // black → theme trace colour
    return `rgb(${r},${g},${b})`;
  };

  /* Minimal tolerant XML helpers (the .bqm structure is flat and regular, and
   * this keeps the parser usable outside the browser for tests). */
  const tag = (s, name) => {
    const m = s.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'));
    return m ? m[1].trim() : null;
  };
  const attr = (s, name) => {
    const m = s.match(new RegExp('\\b' + name + '="([^"]*)"'));
    return m ? m[1] : null;
  };
  const unxml = (s) => (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

  function parseBQM(text, fileName) {
    const montages = [];
    const warnings = [];
    const blocks = text.match(/<Montage\s[\s\S]*?<\/Montage>/g) || [];
    for (const b of blocks) {
      const open = b.match(/<Montage\s[^>]*>/)[0];
      const name = unxml(attr(open, 'Name')) || fileName || 'Montage';
      const head = b.split('<MontageLines>')[0];
      const ref = tag(head, 'ReferenceType') || 'G2';
      const m = {
        id: 'bqm:' + (attr(open, 'ID') || name),
        name,
        group: 'USZ (BrainQuick)',
        order: parseInt(attr(open, 'OrderNumber') || '999', 10),
        reference: ref,
        gain: parseFloat(tag(head, 'MasterGain')) || 70,
        hp: parseFloat(tag(head, 'MasterHighPass')),
        lp: parseFloat(tag(head, 'MasterLowPass')),
        notch: tag(head, 'IsNotchEnabled') === 'true',
        pageSpeed: parseFloat(attr(head.match(/<BaseTime[^>]*>/)?.[0] || '', 'PageSpeedCmSec')) * 10 || 30,
        lines: [],
      };
      const isSource = /quelle|source|laplac|hjorth/i.test(name);
      const lines = b.match(/<MontageLine\s[\s\S]*?<\/MontageLine>/g) || [];
      for (const l of lines) {
        const lo = l.match(/<MontageLine\s[^>]*>/)[0];
        const inv = parseInt(attr(lo, 'InvID'), 10),
          non = parseInt(attr(lo, 'NotInvID'), 10);
        if (!inv && !non) {
          m.lines.push({ kind: 'sep' });
          continue;
        }
        const plus = MICROMED_CODES[inv];
        const minusCode = non ? MICROMED_CODES[non] : null;
        if (!plus || (non && !minusCode)) {
          warnings.push(`${name}: unknown electrode code ${!plus ? inv : non}`);
          m.lines.push({ kind: 'line', plus: plus || '?' + inv, minus: non ? minusCode || '?' + non : null, unknown: true });
          continue;
        }
        const line = { kind: 'line', plus, minus: minusCode };
        const special = plus.startsWith('@');
        if (!non && !special) {
          if (m.reference === 'AVG') line.minus = '@AVG';
          else if (isSource) line.minus = '@LAP';
        }
        const linkedGain = tag(l, 'IsLinkedToMasterGain') !== 'false';
        const linkedHP = tag(l, 'IsLinkedToMasterHighPass') !== 'false';
        const linkedLP = tag(l, 'IsLinkedToMasterLowPass') !== 'false';
        const linkedNotch = tag(l, 'IsLinkedToMasterNotch') !== 'false';
        if (!linkedGain) line.gain = parseFloat(tag(l, 'Gain'));
        if (!linkedHP || !linkedLP || !linkedNotch) {
          const fl = tag(l, 'Filters') || '';
          line.filter = {
            hp: linkedHP ? null : parseFloat(tag(fl, 'HighPassCutoffFrequency')) || 0,
            lp: linkedLP ? null : parseFloat(tag(fl, 'LowPassCutoffFrequency')) || 0,
            notch: linkedNotch ? null : 0,
          };
        }
        const col = argbToCss(tag(l, 'ArgbColor'));
        if (col) line.color = col;
        if (tag(l, 'Visible') === 'false') line.hidden = true;
        m.lines.push(line);
      }
      // trim leading separator lines (BrainQuick shows them as blank rows)
      while (m.lines.length && m.lines[0].kind === 'sep') m.lines.shift();
      montages.push(m);
    }
    return { montages, warnings };
  }

  /* ---------- Standard montages, generated from what the file contains ---------- */
  const chains = {
    dbR: [['Fp2', 'F8', 'T8', 'P8', 'O2'], ['Fp1', 'F7', 'T7', 'P7', 'O1'], ['Fp2', 'F4', 'C4', 'P4', 'O2'], ['Fp1', 'F3', 'C3', 'P3', 'O1'], ['Fz', 'Cz', 'Pz']],
    dbL: [['Fp1', 'F7', 'T7', 'P7', 'O1'], ['Fp1', 'F3', 'C3', 'P3', 'O1'], ['Fz', 'Cz', 'Pz'], ['Fp2', 'F4', 'C4', 'P4', 'O2'], ['Fp2', 'F8', 'T8', 'P8', 'O2']],
    infR: [['Fp2', 'F10', 'T10', 'P10', 'O2'], ['Fp1', 'F9', 'T9', 'P9', 'O1']],
    tr: [['Fp2', 'Fp1'], ['F10', 'F8', 'F4', 'Fz', 'F3', 'F7', 'F9'], ['T10', 'T8', 'C4', 'Cz', 'C3', 'T7', 'T9'], ['P10', 'P8', 'P4', 'Pz', 'P3', 'P7', 'P9'], ['O2', 'O1']],
  };
  const REF_ORDER = ['Fp2', 'F8', 'T8', 'P8', 'O2', 'Fp1', 'F7', 'T7', 'P7', 'O1', 'F4', 'C4', 'P4', 'F3', 'C3', 'P3', 'Fz', 'Cz', 'Pz', 'F10', 'T10', 'P10', 'F9', 'T9', 'P9', 'A2', 'A1'];

  function standardMontages(src) {
    const have = new Set(src.dataSignals.filter((s) => s.std).map((s) => s.std));
    const eegOrder = () => {
      // known electrodes in the department's right-first order, then any others in file order
      const out = REF_ORDER.filter((e) => have.has(e));
      src.dataSignals.forEach((s) => s.kind === 'eeg' && s.std && !out.includes(s.std) && out.push(s.std));
      src.dataSignals.forEach((s) => s.kind === 'eeg' && !s.std && out.push('#' + s.index));
      return out;
    };
    const fromChains = (cs) => {
      const lines = [];
      for (const c of cs) {
        const avail = c.filter((e) => have.has(e));
        if (avail.length < 2) continue;
        if (lines.length) lines.push({ kind: 'sep' });
        for (let i = 0; i + 1 < avail.length; i++) lines.push({ kind: 'line', plus: avail[i], minus: avail[i + 1] });
      }
      return lines;
    };
    const poly = () => {
      const p = src.dataSignals.filter((s) => s.kind === 'ecg' || s.kind === 'emg' || s.kind === 'eog' || s.kind === 'other');
      if (!p.length) return [];
      return [{ kind: 'sep' }, ...p.map((s) => ({ kind: 'line', plus: '#' + s.index, minus: null, gain: s.kind === 'ecg' ? 500 : undefined, color: s.kind === 'ecg' ? 'rgb(220,38,38)' : s.kind === 'emg' ? 'rgb(37,99,235)' : undefined }))];
    };
    const ref = (minus) => eegOrder().map((e) => ({ kind: 'line', plus: e, minus: e === minus ? null : minus }));
    const list = [];
    const add = (id, name, lines) => lines.filter((l) => l.kind === 'line').length && list.push({ id: 'std:' + id, name, group: 'Standard', order: list.length, reference: 'G2', lines });
    add('db', 'Double banana (right first)', [...fromChains(chains.dbR), ...fromChains(chains.infR).length ? [{ kind: 'sep' }, ...fromChains(chains.infR)] : [], ...poly()]);
    add('dbl', 'Double banana (ACNS, left first)', [...fromChains(chains.dbL), ...poly()]);
    add('tr', 'Transverse', [...fromChains(chains.tr), ...poly()]);
    add('avg', 'Common average', [...ref('@AVG'), ...poly()]);
    add('lap', 'Source derivation (Hjorth)', [...ref('@LAP'), ...poly()]);
    if (have.has('Cz')) add('cz', 'Referential to Cz', [...ref('Cz').filter((l) => l.plus !== 'Cz'), ...poly()]);
    add('rec', 'Referential (as recorded)', [...ref(null), ...poly()]);
    const all = src.dataSignals.map((s) => ({ kind: 'line', plus: '#' + s.index, minus: null, gain: s.kind === 'ecg' ? 500 : undefined }));
    add('raw', 'All channels (raw)', all);
    return list;
  }

  /* ---------- Resolution against a recording ---------- */
  function findSpecial(src, token, used) {
    const sigs = src.dataSignals;
    const name = (s) => (s.parsed.name || s.label).toUpperCase();
    let cands;
    if (token === '@ECG') {
      cands = sigs.filter((s) => /ECG|EKG/.test(name(s)));
      if (!cands.length) cands = sigs.filter((s) => s.kind === 'ecg');
    } else if (token === '@EMG') {
      cands = sigs.filter((s) => /EMG/.test(name(s)) && s.kind !== 'eeg');
    } else if (token === '@MKR') {
      cands = sigs.filter((s) => s.kind === 'marker');
    } else cands = [];
    return cands.find((s) => !used.has(s.index)) || null;
  }

  function resolve(montage, src) {
    const byStd = new Map();
    src.dataSignals.forEach((s) => s.std && !byStd.has(s.std) && byStd.set(s.std, s.index));
    const used = new Set();
    // first pass: specials claim channels in line order (ECG before EMG)
    const specials = new Map();
    montage.lines.forEach((l, i) => {
      if (l.kind !== 'line' || !String(l.plus).startsWith('@')) return;
      const s = findSpecial(src, l.plus, used);
      if (s) {
        used.add(s.index);
        specials.set(i, s.index);
      }
    });
    const idxOf = (lab) => {
      if (lab == null) return null;
      if (String(lab).startsWith('#')) {
        const k = parseInt(String(lab).slice(1), 10);
        return src.signals[k] && !src.signals[k].isAnnotation ? k : -1;
      }
      const c = POS.canon[String(lab).toLowerCase()];
      return byStd.has(c) ? byStd.get(c) : -1;
    };
    const out = [];
    let missing = 0;
    montage.lines.forEach((l, i) => {
      if (l.kind === 'sep') {
        if (out.length && out[out.length - 1].kind !== 'sep') out.push({ kind: 'sep' });
        return;
      }
      if (l.hidden) return;
      let plus;
      if (String(l.plus).startsWith('@')) plus = specials.has(i) ? specials.get(i) : -1;
      else plus = idxOf(l.plus);
      let minus = null,
        minusKind = 'none';
      if (l.minus === '@AVG') minusKind = 'avg';
      else if (l.minus === '@LAP') minusKind = 'lap';
      else if (l.minus != null) {
        minus = idxOf(l.minus);
        minusKind = 'ch';
      }
      if (plus < 0 || (minusKind === 'ch' && minus < 0)) {
        missing++;
        return;
      }
      const ps = src.signals[plus];
      const pl = ps.std || ps.parsed.name || ps.label;
      let label = pl;
      if (minusKind === 'ch') {
        const ms = src.signals[minus];
        label = pl + '–' + (ms.std || ms.parsed.name || ms.label);
      } else if (minusKind === 'avg') label = pl + '–Avg';
      else if (minusKind === 'lap') label = pl + '–Lap';
      out.push({
        kind: 'line',
        label,
        plus,
        minus,
        minusKind,
        sigKind: ps.kind,
        gain: l.gain || null,
        filter: l.filter || null,
        color: l.color || null,
        unit: ps.unit,
      });
    });
    while (out.length && out[out.length - 1].kind === 'sep') out.pop();
    return { lines: out, missing };
  }

  /* Hjorth source derivation: each target electrode minus the inverse-distance
   * weighted mean of its 4 nearest neighbours drawn from `candidates`. */
  function hjorthWeights(src, targets, candidates) {
    const P = (i) => POS.position(src.signals[i].std);
    const W = new Map();
    targets.forEach((i) => {
      const pa = P(i);
      if (!pa) return;
      const d = [];
      candidates.forEach((j) => {
        const pb = P(j);
        if (i === j || !pb) return;
        const c = Math.max(-1, Math.min(1, pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2]));
        d.push([j, Math.max(1e-6, Math.acos(c))]);
      });
      d.sort((x, y) => x[1] - y[1]);
      const nb = d.slice(0, 4);
      const tot = nb.reduce((s, x) => s + 1 / x[1], 0);
      W.set(i, nb.map(([j, dist]) => [j, 1 / dist / tot]));
    });
    return W;
  }

  EEG.montage = { MICROMED_CODES, parseBQM, standardMontages, resolve, hjorthWeights };
})(typeof window !== 'undefined' ? window : globalThis);
