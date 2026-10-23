/* 2D voltage-map rendering.
 *
 * Projection: azimuthal equidistant around the vertex (distance from the
 * centre ∝ polar angle θ), nose up, left hemisphere on the left (view from
 * above). The disc extends 10° beyond the lowest electrode so the inferior
 * temporal chain (θ = 112.5°) is inside the map; the dashed inner ring marks the
 * 10-20 equator (Fpz–T7–Oz–T8). Values are interpolated on a pixel grid with
 * spherical splines, coloured with a diverging map, and overlaid with
 * isopotential lines (marching squares; negative lines dashed). */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const U = EEG.util;
  const D2R = Math.PI / 180;

  /* ---------- colour maps ---------- */
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const STOPS = {
    // ColorBrewer RdBu (11), ordered negative → positive
    rdbu: ['#053061', '#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b', '#67001f'],
    // Moreland cool–warm
    coolwarm: ['#3b4cc0', '#5977e3', '#7b9ff9', '#9ebeff', '#c0d4f5', '#dddcdc', '#f2cbb7', '#f7ac8e', '#ee8468', '#d65244', '#b40426'],
    // classic jet (familiar from many clinical systems)
    jet: ['#00007f', '#0000ff', '#007fff', '#00ffff', '#7fff7f', '#ffff00', '#ff7f00', '#ff0000', '#7f0000'],
  };
  const CMAP_NAMES = { rdbu: 'Red–blue (diverging)', coolwarm: 'Cool–warm', jet: 'Jet (classic)' };
  const lutCache = new Map();
  function lut(name, invert) {
    const key = name + (invert ? ':inv' : '');
    if (lutCache.has(key)) return lutCache.get(key);
    let stops = (STOPS[name] || STOPS.rdbu).map(hex);
    if (invert) stops = stops.slice().reverse();
    const out = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const f = (i / 255) * (stops.length - 1);
      const j = Math.min(stops.length - 2, Math.floor(f)),
        r = f - j;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = stops[j][c] * (1 - r) + stops[j + 1][c] * r;
    }
    lutCache.set(key, out);
    return out;
  }
  const cssColor = (name, invert, x) => {
    // x in [-1, 1]
    const L = lut(name, invert);
    const i = Math.round(U.clamp((x + 1) / 2, 0, 1) * 255) * 3;
    return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`;
  };

  /* ---------- projection ---------- */
  function project(v, edgeDeg) {
    const theta = Math.acos(U.clamp(v[2], -1, 1)) / D2R;
    const phi = Math.atan2(v[1], v[0]);
    const r = theta / edgeDeg;
    return [r * Math.cos(phi), r * Math.sin(phi)];
  }
  function unproject(u, w, edgeDeg) {
    const r = Math.hypot(u, w);
    const theta = r * edgeDeg * D2R,
      phi = Math.atan2(w, u);
    return [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
  }

  /* ---------- plans (electrode set × resolution × kind) ---------- */
  const planCache = new Map();
  /* electrodes: [{label, pos:[x,y,z]}]; opts: {res, kind:'V'|'CSD', m, lambda, nTerms} */
  function plan(electrodes, opts) {
    const res = opts.res || 160,
      kind = opts.kind || 'V';
    const key = electrodes.map((e) => e.label).join(',') + `|${res}|${kind}|${opts.m}|${opts.lambda}`;
    if (planCache.has(key)) return planCache.get(key);
    const pos = electrodes.map((e) => e.pos);
    let maxTheta = 0;
    pos.forEach((p) => (maxTheta = Math.max(maxTheta, Math.acos(U.clamp(p[2], -1, 1)) / D2R)));
    const edge = Math.max(100, maxTheta + 10);
    const model = EEG.spline.build(pos, { m: opts.m || 4, lambda: opts.lambda == null ? 1e-5 : opts.lambda, nTerms: opts.nTerms || 50 });
    const pts = new Array(res * res).fill(null);
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++) {
        const u = (2 * (i + 0.5)) / res - 1,
          w = 1 - (2 * (j + 0.5)) / res;
        if (u * u + w * w <= 1.0) pts[j * res + i] = unproject(u, w, edge);
      }
    const W = EEG.spline.weights(model, pts, kind);
    const inside = new Uint8Array(res * res);
    pts.forEach((p, k) => (inside[k] = p ? 1 : 0));
    const p = { key, res, kind, edge, n: pos.length, W, inside, model, labels: electrodes.map((e) => e.label), e2d: pos.map((v) => project(v, edge)) };
    if (planCache.size > 24) planCache.delete(planCache.keys().next().value);
    planCache.set(key, p);
    return p;
  }

  function grid(pl, values, out) {
    const N = pl.res * pl.res;
    out = out && out.length === N ? out : new Float32Array(N);
    EEG.spline.apply(pl.W, pl.n, values, out);
    for (let k = 0; k < N; k++) if (!pl.inside[k]) out[k] = NaN;
    return out;
  }

  /* Point values at arbitrary unit vectors (used by the 3D view). */
  function pointWeights(pl, pts, kind) {
    return EEG.spline.weights(pl.model, pts, kind || pl.kind);
  }

  /* ---------- marching squares ---------- */
  function contourSegments(g, res, level) {
    const segs = [];
    const lerp = (a, b) => (level - a) / (b - a);
    for (let j = 0; j < res - 1; j++) {
      for (let i = 0; i < res - 1; i++) {
        const k = j * res + i;
        const a = g[k],
          b = g[k + 1],
          c = g[k + res + 1],
          d = g[k + res];
        if (a !== a || b !== b || c !== c || d !== d) continue;
        let idx = 0;
        if (a > level) idx |= 8;
        if (b > level) idx |= 4;
        if (c > level) idx |= 2;
        if (d > level) idx |= 1;
        if (idx === 0 || idx === 15) continue;
        const top = () => [i + lerp(a, b), j];
        const right = () => [i + 1, j + lerp(b, c)];
        const bottom = () => [i + lerp(d, c), j + 1];
        const left = () => [i, j + lerp(a, d)];
        switch (idx) {
          case 1: case 14: segs.push(left(), bottom()); break;
          case 2: case 13: segs.push(bottom(), right()); break;
          case 3: case 12: segs.push(left(), right()); break;
          case 4: case 11: segs.push(top(), right()); break;
          case 6: case 9: segs.push(top(), bottom()); break;
          case 7: case 8: segs.push(left(), top()); break;
          case 5: case 10: {
            const ctr = (a + b + c + d) / 4 > level;
            if ((idx === 5) === ctr) segs.push(left(), top(), bottom(), right());
            else segs.push(left(), bottom(), top(), right());
            break;
          }
        }
      }
    }
    return segs;
  }

  /* ---------- drawing ---------- */
  const offscreen = typeof document !== 'undefined' ? document.createElement('canvas') : null;

  /* opts: {cx, cy, R, vmax, cmap, invert, contours, step, labels, values, extrema,
   *        small, theme:{line, text, muted, bg}, excluded:[{label,pos}], unit} */
  function draw(ctx, pl, g, values, opts) {
    const { cx, cy, R } = opts;
    const res = pl.res;
    const L = lut(opts.cmap || 'rdbu', !!opts.invert);
    const vmax = opts.vmax > 0 ? opts.vmax : 1;
    // colour image
    offscreen.width = res;
    offscreen.height = res;
    const octx = offscreen.getContext('2d');
    const img = octx.createImageData(res, res);
    const d = img.data;
    for (let k = 0; k < res * res; k++) {
      const v = g[k];
      if (v !== v) {
        d[k * 4 + 3] = 0;
        continue;
      }
      const i = Math.round(U.clamp((v / vmax + 1) / 2, 0, 1) * 255) * 3;
      d[k * 4] = L[i];
      d[k * 4 + 1] = L[i + 1];
      d[k * 4 + 2] = L[i + 2];
      d[k * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    const th = opts.theme || {};
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(offscreen, cx - R, cy - R, 2 * R, 2 * R);
    // isopotential lines
    if (opts.contours !== false) {
      const step = opts.step > 0 ? opts.step : U.niceStep(vmax, 5);
      const sc = (2 * R) / res;
      const ox = cx - R + sc / 2,
        oy = cy - R + sc / 2;
      for (let lv = -Math.floor(vmax / step) * step; lv <= vmax + 1e-9; lv += step) {
        const segs = contourSegments(g, res, lv);
        if (!segs.length) continue;
        ctx.beginPath();
        for (let s = 0; s < segs.length; s += 2) {
          ctx.moveTo(ox + segs[s][0] * sc, oy + segs[s][1] * sc);
          ctx.lineTo(ox + segs[s + 1][0] * sc, oy + segs[s + 1][1] * sc);
        }
        const zero = Math.abs(lv) < step / 2;
        ctx.setLineDash(lv < -step / 2 ? (opts.small ? [2, 2] : [3, 3]) : []);
        ctx.lineWidth = zero ? (opts.small ? 0.9 : 1.4) : opts.small ? 0.5 : 0.8;
        ctx.strokeStyle = zero ? 'rgba(0,0,0,0.62)' : 'rgba(0,0,0,0.32)';
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // 10-20 equator reference ring (θ = 90°)
    if (!opts.small && opts.equator !== false && pl.edge > 95) {
      ctx.beginPath();
      ctx.arc(cx, cy, (R * 90) / pl.edge, 0, 2 * Math.PI);
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // head outline, nose, ears
    const lw = opts.small ? 1 : 1.6;
    ctx.lineWidth = lw;
    ctx.strokeStyle = th.line || '#222';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.stroke();
    const nW = R * 0.11,
      nH = R * 0.1;
    ctx.beginPath();
    ctx.moveTo(cx - nW, cy - R + nH * 0.12);
    ctx.lineTo(cx, cy - R - nH);
    ctx.lineTo(cx + nW, cy - R + nH * 0.12);
    ctx.stroke();
    for (const s of [-1, 1]) {
      ctx.beginPath();
      const ex = cx + s * R;
      ctx.moveTo(ex, cy - R * 0.13);
      ctx.bezierCurveTo(ex + s * R * 0.075, cy - R * 0.17, ex + s * R * 0.085, cy + R * 0.1, ex + s * R * 0.01, cy + R * 0.15);
      ctx.stroke();
    }

    // electrodes
    const proj = (p2) => [cx + p2[0] * R, cy - p2[1] * R];
    let iMax = -1,
      iMin = -1;
    if (values) {
      for (let e = 0; e < pl.n; e++) {
        if (iMax < 0 || values[e] > values[iMax]) iMax = e;
        if (iMin < 0 || values[e] < values[iMin]) iMin = e;
      }
    }
    const fs = opts.small ? 0 : opts.fontSize || 10;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${fs}px ${opts.font || 'system-ui, sans-serif'}`;
    for (let e = 0; e < pl.n; e++) {
      const [x, y] = proj(pl.e2d[e]);
      const ext = opts.extrema !== false && !opts.small && (e === iMax || e === iMin);
      ctx.beginPath();
      ctx.arc(x, y, opts.small ? 1.1 : ext ? 3.2 : 2.1, 0, 2 * Math.PI);
      ctx.fillStyle = '#111';
      ctx.fill();
      if (ext) {
        ctx.beginPath();
        ctx.arc(x, y, 6.5, 0, 2 * Math.PI);
        ctx.lineWidth = 1.6;
        const pos = e === iMax;
        ctx.strokeStyle = cssColor(opts.cmap || 'rdbu', !!opts.invert, pos ? 0.9 : -0.9);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, 2 * Math.PI);
        ctx.stroke();
      }
      if (fs) {
        const haloText = (t, ty, col) => {
          ctx.lineWidth = 2.6;
          ctx.strokeStyle = 'rgba(255,255,255,0.78)';
          ctx.strokeText(t, x, ty);
          ctx.fillStyle = col;
          ctx.fillText(t, x, ty);
        };
        if (opts.labels !== false) haloText(pl.labels[e], y - 9, '#111');
        if (opts.values && values) haloText(U.fmtNum(values[e], Math.abs(values[e]) < 10 ? 1 : 0), y + 10, '#333');
      }
    }
    // electrodes of the highlighted trace
    // (black/white double ring: visible on both poles of any colour map)
    if (opts.highlight && opts.highlight.length && !opts.small) {
      for (const e of opts.highlight) {
        const [x, y] = proj(pl.e2d[e]);
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0, 2 * Math.PI);
        ctx.lineWidth = 3.4;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
    }
    // excluded electrodes (bad / off-scalp): hollow markers
    if (opts.excluded && !opts.small) {
      for (const ex of opts.excluded) {
        const [x, y] = proj(project(ex.pos, pl.edge));
        if (Math.hypot(x - cx, y - cy) > R + 4) continue;
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, 2 * Math.PI);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.stroke();
        if (fs) {
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.fillText(ex.label, x, y - 9);
        }
      }
    }
    if (!opts.small && opts.lr !== false) {
      // hemisphere labels in the free corners above the ears
      ctx.fillStyle = th.muted || '#888';
      ctx.font = `600 ${opts.fontSize ? opts.fontSize + 1 : 11}px ${opts.font || 'system-ui, sans-serif'}`;
      ctx.fillText('L', cx - R * 0.86, cy - R * 0.9);
      ctx.fillText('R', cx + R * 0.86, cy - R * 0.9);
    }
    return { iMax, iMin };
  }

  /* Vertical colour bar. */
  function drawColorbar(ctx, x, y, w, h, opts) {
    const L = lut(opts.cmap || 'rdbu', !!opts.invert);
    for (let i = 0; i < h; i++) {
      const f = 1 - i / (h - 1);
      const k = Math.round(f * 255) * 3;
      ctx.fillStyle = `rgb(${L[k]},${L[k + 1]},${L[k + 2]})`;
      ctx.fillRect(x, y + i, w, 1.2);
    }
    ctx.strokeStyle = opts.theme?.line || '#333';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    const vmax = opts.vmax;
    const step = opts.step > 0 ? opts.step : U.niceStep(vmax, 5);
    ctx.font = `10px ${opts.font || 'system-ui, sans-serif'}`;
    ctx.fillStyle = opts.theme?.text || '#333';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const ticks = [];
    for (let v = -Math.floor(vmax / step) * step; v <= vmax + 1e-9; v += step) ticks.push(v);
    const maxTicks = Math.max(3, Math.floor(h / 16));
    const every = Math.ceil(ticks.length / maxTicks);
    ticks.forEach((v, i) => {
      const zeroIdx = ticks.findIndex((t) => Math.abs(t) < step / 2);
      if ((i - zeroIdx) % every !== 0) return;
      const yy = y + (1 - (v / vmax + 1) / 2) * h;
      ctx.beginPath();
      ctx.moveTo(x + w, yy);
      ctx.lineTo(x + w + 3, yy);
      ctx.stroke();
      const dec = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
      ctx.fillText((v > 0 ? '+' : '') + U.fmtNum(v, dec), x + w + 5, yy);
    });
    ctx.textAlign = 'left';
    ctx.fillText(opts.unit || 'µV', x, y + h + 12);
  }

  EEG.topo = { plan, grid, draw, drawColorbar, lut, cssColor, project, unproject, contourSegments, CMAP_NAMES, pointWeights };
})(typeof window !== 'undefined' ? window : globalThis);
