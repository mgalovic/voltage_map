/* Electrode positions on an idealised spherical head (10-10 system incl. the
 * inferior temporal chain F9/T9/P9/F10/T10/P10 recommended by the IFCN).
 *
 * Coordinates: unit sphere, x → right ear, y → nose, z → vertex.
 * Polar angle θ is measured from the vertex (Cz = 0°); Fpz, T7, T8 and Oz lie on
 * the equator (θ = 90°) and the inferior chain (Nz–T9–Iz) on θ = 112.5°, i.e.
 * one 10 % step (22.5°) below. Along the equator 5 % of the circumference = 18°.
 * Electrodes between a midline point and a lateral point (e.g. F3 between Fz and
 * F7) are placed at equal arc fractions on the circle through the left lateral,
 * midline and right lateral points — the same construction used by BESA/EEGLAB
 * (F3 lands at θ ≈ 60°, φ ≈ 129°). */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const D2R = Math.PI / 180;

  const sph = (theta, phi) => {
    const t = theta * D2R,
      p = phi * D2R;
    return [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)];
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

  /* Point at fraction f of the arc from M to L on the circle through L, M, R. */
  function arcPoint(L, M, R, f) {
    const n = norm(cross(sub(M, L), sub(R, L)));
    const c = scale(n, dot(n, L)); // centre of the small circle
    const a = sub(M, c),
      b = sub(L, c);
    const r = Math.hypot(a[0], a[1], a[2]);
    const an = scale(a, 1 / r);
    // orthonormal basis in the circle plane: an and the component of b orthogonal to an
    let bo = sub(b, scale(an, dot(b, an)));
    bo = norm(bo);
    const total = Math.atan2(dot(b, bo), dot(b, an));
    const ang = total * f;
    return norm(add(c, add(scale(an, r * Math.cos(ang)), scale(bo, r * Math.sin(ang)))));
  }

  const P = {};
  const put = (label, v) => (P[label] = v);

  // Midline (sagittal arc, 22.5° per 10 %)
  put('Nz', sph(112.5, 90));
  put('Fpz', sph(90, 90));
  put('AFz', sph(67.5, 90));
  put('Fz', sph(45, 90));
  put('FCz', sph(22.5, 90));
  put('Cz', [0, 0, 1]);
  put('CPz', sph(22.5, 270));
  put('Pz', sph(45, 270));
  put('POz', sph(67.5, 270));
  put('Oz', sph(90, 270));
  put('Iz', sph(112.5, 270));

  // Equatorial ring (18° per 5 %) and inferior ring (θ = 112.5°)
  const ring = [
    ['Fp2', 72, 'Fp1', 108, null, null],
    ['AF8', 54, 'AF7', 126, 'AF10', 'AF9'],
    ['F8', 36, 'F7', 144, 'F10', 'F9'],
    ['FT8', 18, 'FT7', 162, 'FT10', 'FT9'],
    ['T8', 0, 'T7', 180, 'T10', 'T9'],
    ['TP8', -18, 'TP7', 198, 'TP10', 'TP9'],
    ['P8', -36, 'P7', 216, 'P10', 'P9'],
    ['PO8', -54, 'PO7', 234, 'PO10', 'PO9'],
    ['O2', -72, 'O1', 252, 'O10', 'O9'],
  ];
  for (const [r, pr, l, pl, ri, li] of ring) {
    put(r, sph(90, pr));
    put(l, sph(90, pl));
    if (ri) put(ri, sph(112.5, pr));
    if (li) put(li, sph(112.5, pl));
  }

  // Intermediate rows: midline point, lateral points, labels at arc fractions
  const rows = [
    ['AF', 'AFz', 'AF7', 'AF8'],
    ['F', 'Fz', 'F7', 'F8'],
    ['FC', 'FCz', 'FT7', 'FT8'],
    ['C', 'Cz', 'T7', 'T8'],
    ['CP', 'CPz', 'TP7', 'TP8'],
    ['P', 'Pz', 'P7', 'P8'],
    ['PO', 'POz', 'PO7', 'PO8'],
  ];
  for (const [pre, mid, lat7, lat8] of rows) {
    const L = P[lat7],
      M = P[mid],
      R = P[lat8];
    [1, 3, 5].forEach((num, i) => {
      const f = (i + 1) / 4;
      put(pre + num, arcPoint(L, M, R, f));
      put(pre + (num + 1), arcPoint(R, M, L, f));
    });
  }

  // Ear lobes and mastoids (off-scalp; excluded from maps by default)
  put('A1', sph(125, 186));
  put('A2', sph(125, -6));
  put('M1', sph(122, 200));
  put('M2', sph(122, -20));

  // Canonical spelling lookup (case-insensitive) and legacy aliases
  const canon = {};
  Object.keys(P).forEach((k) => (canon[k.toLowerCase()] = k));
  const alias = { t3: 'T7', t4: 'T8', t5: 'P7', t6: 'P8', lpa: 'T9', rpa: 'T10', nas: 'Nz', inion: 'Iz' };
  Object.assign(canon, alias);

  /* Normalise an EDF channel label: drop the signal-type prefix ("EEG Fp1"),
   * common reference suffixes ("Fp1-Ref", "FP1-LE", "Fp1-AVG") and spaces. */
  const REF_SUFFIX = /[-_ ]?(ref|reference|le|ae|lm|ar|avg|average|car|g2|cz?ref)$/i;
  function parseLabel(raw) {
    let s = String(raw || '').trim();
    let type = '';
    const m = s.match(/^(EEG|ECG|EKG|EMG|EOG|RESP|SAO2|SPO2|MISC|TRIG|POL|PHOTIC|MKR|STATUS|VALUE)\s+(.*)$/i);
    if (m) {
      type = m[1].toUpperCase();
      s = m[2].trim();
    }
    let name = s;
    let core = s.replace(REF_SUFFIX, '').replace(/\s+/g, '');
    const key = core.toLowerCase();
    const std = canon[key] || null;
    return { type, name, std };
  }

  function position(stdLabel) {
    return stdLabel && P[stdLabel] ? P[stdLabel] : null;
  }

  /* Spherical (θ, φ in degrees) for display. */
  function polar(v) {
    const theta = Math.acos(Math.max(-1, Math.min(1, v[2]))) / D2R;
    const phi = Math.atan2(v[1], v[0]) / D2R;
    return { theta, phi };
  }

  const OFF_SCALP = new Set(['A1', 'A2', 'M1', 'M2', 'Nz', 'Iz']);

  EEG.positions = { P, sph, parseLabel, position, polar, arcPoint, OFF_SCALP, canon };
})(typeof window !== 'undefined' ? window : globalThis);
