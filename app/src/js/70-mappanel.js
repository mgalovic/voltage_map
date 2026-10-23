/* Voltage map panel.
 *
 * Data: referential channels filtered with the current display filters,
 * re-referenced to the common average of the mapped electrodes (default),
 * or left as recorded; CSD = spherical-spline surface Laplacian.
 * Views: main map at the cursor (live while scrubbing), butterfly + global field
 * power (GFP) over the analysis window, and a map sequence across a selected
 * window with one shared colour scale. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const U = EEG.util;
  const el = (...a) => U.el(...a);
  const ICON = (p, w = 16) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

  class MapPanel {
    constructor(app, root) {
      this.app = app;
      this.root = root;
      this.tok = 0;
      this.data = null;
      this.seqTimes = [];
      this.build();
    }

    get o() {
      return this.app.settings.map;
    }

    build() {
      const o = this.o;
      const app = this.app;
      const btn = (title, icon, on, cls = '') => el('button', { class: 'icon-btn ' + cls, title, onclick: on, html: icon });
      this.timeEl = el('div', { class: 'mp-time' }, '—');
      this.subEl = el('div', { class: 'mp-sub' }, '');
      const stepL = btn('Previous sample (Alt+←)', ICON('<path d="m15 18-6-6 6-6"/>'), () => app.stepCursor(-1));
      const stepR = btn('Next sample (Alt+→)', ICON('<path d="m9 18 6-6-6-6"/>'), () => app.stepCursor(1));
      this.head = el('div', { class: 'mp-head' }, el('div', { class: 'mp-titles' }, this.timeEl, this.subEl), el('div', { class: 'mp-nav' }, stepL, stepR));

      this.mapCv = el('canvas', { class: 'mp-map' });
      this.cbarCv = el('canvas', { class: 'mp-cbar' });
      this.tip = el('div', { class: 'mp-tip', hidden: true });
      this.figure = el('div', { class: 'mp-figure' }, this.mapCv, this.cbarCv, this.tip);
      this.readout = el('div', { class: 'mp-readout' });

      // controls
      const seg = (name, opts, val, on) => {
        const wrap = el('div', { class: 'seg', role: 'group' });
        opts.forEach(([v, lab, title]) => {
          const b = el('button', { class: v === val ? 'on' : '', title: title || lab, onclick: () => {
            wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
            on(v);
          } }, lab);
          wrap.append(b);
        });
        return wrap;
      };
      this.modeSeg = seg('mode', [['V', 'Potential', 'Potential (voltage) map: what each scalp point measures, in µV'], ['CSD', 'CSD', 'Current source density (surface Laplacian, µV/cm²): sharpens focal activity and is independent of the reference']], o.kind, (v) => this.set({ kind: v }));
      this.refSel = el('select', { class: 'sel sm', title: 'Reference of the potential map. Average: each electrode minus the mean of all mapped electrodes (standard for maps). Recording reference: values as recorded against the amplifier reference.', onchange: (e) => this.set({ ref: e.target.value }) },
        el('option', { value: 'avg' }, 'Average reference'),
        el('option', { value: 'orig' }, 'Recording reference'));
      this.refSel.value = o.ref;
      this.scaleSel = el('select', { class: 'sel sm', title: 'Colour scale. Whole window: one scale for the butterfly window or selection, so maps are comparable over time. Each map: rescaled for every map (shows the pattern of weak fields; exaggerates noise). Fixed: a value you choose (compare events).', onchange: (e) => this.set({ scale: e.target.value }) },
        el('option', { value: 'window' }, 'Whole window'),
        el('option', { value: 'map' }, 'Each map'),
        el('option', { value: 'fixed' }, 'Fixed ±'));
      this.scaleSel.value = o.scale;
      this.fixedIn = el('input', { class: 'num sm', type: 'number', min: '0.1', step: '5', value: o.fixed, title: 'Fixed scale (± µV, or µV/cm² for CSD)', onchange: (e) => this.set({ fixed: Math.max(0.1, parseFloat(e.target.value) || 50) }) });
      const tog = (key, label, title) => {
        const b = el('button', { class: 'chip-btn tog' + (o[key] ? ' on' : ''), title, onclick: () => this.set({ [key]: !this.o[key] }) }, label);
        b.dataset.key = key;
        return b;
      };
      const lab = (t) => el('span', { class: 'lab' }, t);
      this.cmapSel = el('select', { class: 'sel sm', title: 'Colour map', onchange: (e) => this.set({ cmap: e.target.value }) },
        ...Object.entries(EEG.topo.CMAP_NAMES).map(([k, v]) => el('option', { value: k }, v)));
      this.cmapSel.value = o.cmap;
      const polBtn = el('button', { class: 'chip-btn pol', title: 'Swap colours: which colour shows positive and which negative', onclick: () => this.set({ invert: !this.o.invert }), html: this._polLabel() });
      this.controls = el('div', { class: 'mp-controls' },
        el('div', { class: 'row' }, lab('Map'), this.modeSeg, this.refSel),
        el('div', { class: 'row' }, lab('Scale'), this.scaleSel, this.fixedIn, polBtn),
        el('div', { class: 'row' }, lab('Show'),
          tog('contours', 'Isolines', 'Isopotential lines: lines of equal voltage at even steps (dashed = negative, bold = zero line)'),
          tog('labels', 'Labels', 'Electrode names'),
          tog('values', 'Values', 'Electrode values in µV (µV/cm² for CSD)'),
          tog('equator', 'Equator', 'Dashed ring at the level of Fpz–T7–Oz–T8 (10-20 equator). Electrodes outside it (F9/T9/P9, F10/T10/P10) lie below it, over the basal temporal region')),
        el('div', { class: 'row' }, lab('Colours'), this.cmapSel,
          el('button', { class: 'btn xs ghost', title: 'Save this map as a PNG image', onclick: () => this.exportPNG(), html: ICON('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>', 14) + 'PNG' })));
      this._syncFixed();

      // butterfly + GFP
      this.bfCv = el('canvas', { class: 'mp-bf' });
      const peakBtn = (lab, title, kind) => el('button', { class: 'chip-btn', title, onclick: () => app.jumpToPeak(kind) }, lab);
      this.bfSec = el('div', { class: 'mp-sec' },
        el('div', { class: 'mp-sec-head' }, el('span', { title: 'Butterfly plot: all electrodes superimposed (average reference). Global field power (GFP): the spatial standard deviation across electrodes, i.e. how strong the field is at each instant.' }, 'Butterfly · GFP'), el('div', { class: 'mp-sec-tools' }, peakBtn('GFP max', 'Move the cursor to the moment of strongest field (global field power maximum) in the window (P)', 'gfp'), peakBtn('Neg. max', 'Move the cursor to the most negative electrode value in the window', 'neg'), peakBtn('Pos. max', 'Move the cursor to the most positive electrode value in the window', 'pos'))),
        this.bfCv);

      // sequence
      this.stepSel = el('select', { class: 'sel sm', title: 'Interval between maps', onchange: (e) => this.set({ step: e.target.value }) },
        el('option', { value: 'auto' }, 'Step: auto'),
        ...['sample', '5', '10', '20', '25', '50', '100', '200'].map((v) => el('option', { value: v }, v === 'sample' ? 'Step: 1 sample' : `Step: ${v} ms`)));
      this.stepSel.value = o.step;
      this.seqGrid = el('div', { class: 'mp-seq' });
      this.seqSec = el('div', { class: 'mp-sec' },
        el('div', { class: 'mp-sec-head' }, el('span', { title: 'Maps at equal time steps across the selected window, all on one colour scale' }, 'Map sequence'), el('div', { class: 'mp-sec-tools' }, this.stepSel, btn('Export sequence as PNG', ICON('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'), () => this.exportSequencePNG()))),
        this.seqGrid);

      this.empty = el('div', { class: 'mp-empty' },
        el('div', { class: 'mp-empty-ic', html: ICON('<circle cx="12" cy="12" r="9"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2"/><circle cx="12" cy="12" r="3"/>', 28) }),
        el('div', { class: 'mp-empty-t' }, 'No time point selected'),
        el('div', { class: 'mp-empty-d', html: '<b>Click</b> on the EEG to map that instant.<br><b>Drag</b> across a discharge to see its evolution as a map sequence.<br><b>Alt-click</b> a trace to snap to its nearest peak.' }),
        el('button', { class: 'btn sm', style: { marginTop: '14px' }, onclick: () => app.showHelp('guide') }, 'New to voltage maps? Read the guide'));
      const tools = G.document.getElementById('map-tools');
      if (tools) tools.append(el('button', { class: 'btn xs ghost', title: 'What the map shows and what each control does', onclick: (e) => {
        e.stopPropagation();
        app.showHelp('guide');
      }, html: ICON('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>', 14) + 'Guide' }));
      this.body = el('div', { class: 'mp-body' }, this.head, this.figure, this.readout, this.controls, this.bfSec, this.seqSec);
      this.root.append(this.empty, this.body);
      this._bindCanvas();
      this.showEmpty(true);
      new ResizeObserver(() => {
        if (!this.data || this._roPending) return;
        this._roPending = true;
        requestAnimationFrame(() => {
          this._roPending = false;
          if (this.data) this.draw();
        });
      }).observe(this.root);
    }

    _polLabel() {
      const pos = EEG.topo.cssColor(this.o.cmap, this.o.invert, 0.85),
        neg = EEG.topo.cssColor(this.o.cmap, this.o.invert, -0.85);
      return `<span class="dot" style="background:${pos}"></span>+ <span class="dot" style="background:${neg}"></span>−`;
    }
    _syncFixed() {
      this.fixedIn.hidden = this.o.scale !== 'fixed';
      this.refSel.disabled = this.o.kind === 'CSD';
    }
    /* Reflect current settings in the controls (after programmatic changes / reset). */
    syncControls() {
      const o = this.o;
      this.modeSeg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', (i === 0 ? 'V' : 'CSD') === o.kind));
      this.refSel.value = o.ref;
      this.scaleSel.value = o.scale;
      this.fixedIn.value = o.fixed;
      this.cmapSel.value = o.cmap;
      this.stepSel.value = o.step;
      this.root.querySelectorAll('.tog').forEach((b) => {
        const key = b.dataset.key;
        if (key) b.classList.toggle('on', !!o[key]);
      });
      this.root.querySelectorAll('.chip-btn.pol').forEach((b) => (b.innerHTML = this._polLabel()));
      this._syncFixed();
    }
    set(patch) {
      Object.assign(this.app.settings.map, patch);
      this.app.saveSettings();
      this.syncControls();
      if ('ref' in patch || 'kind' in patch) this.data = null;
      this.update();
    }
    showEmpty(on) {
      this.empty.hidden = !on;
      this.body.hidden = on;
    }

    /* Analysis window: the selection, or a window around the cursor. */
    range() {
      const app = this.app;
      if (app.selection) return { a: app.selection.t0, b: app.selection.t1, sel: true };
      const half = this.o.halfWindow || 0.3;
      const c = app.cursor;
      if (this._range && !this._range.sel && c >= this._range.a + half * 0.25 && c <= this._range.b - half * 0.25) return this._range;
      return { a: c - half, b: c + half, sel: false };
    }

    async update() {
      const app = this.app;
      if (!app.src || (app.cursor == null && !app.selection)) {
        this.data = null;
        this.seqTimes = [];
        this.showEmpty(true);
        return;
      }
      if (app.cursor == null && app.selection) app.cursor = (app.selection.t0 + app.selection.t1) / 2;
      this.showEmpty(false);
      const token = ++this.tok;
      const rg = this.range();
      const d = this.data;
      const reuse = d && d.a === rg.a && d.b === rg.b && d.key === app.dataKey();
      if (!reuse) {
        const win = await app.getMapWindow(rg.a, rg.b);
        if (token !== this.tok || !win) return;
        this._range = rg;
        this.data = this.compute(win, rg);
      }
      this.draw();
    }

    /* Build the electrode × time matrix for the analysis window. */
    compute(win, rg) {
      const app = this.app;
      const { used, excluded } = app.mapElectrodes();
      const E = used.length;
      const ka = U.clamp(win.index(rg.a), 0, win.n - 1),
        kb = U.clamp(win.index(rg.b), 0, win.n - 1);
      const n = Math.max(1, kb - ka + 1);
      const vals = new Float32Array(n * E);
      const gfp = new Float32Array(n);
      const o = this.o;
      for (let k = 0; k < n; k++) {
        let m = 0;
        for (let e = 0; e < E; e++) {
          const v = win.filt[used[e].idx][win.pad + ka + k];
          vals[k * E + e] = v;
          m += v;
        }
        m /= E || 1;
        let s = 0;
        for (let e = 0; e < E; e++) {
          const dv = vals[k * E + e] - m;
          s += dv * dv;
          if (o.ref === 'avg' || o.kind === 'CSD') vals[k * E + e] = dv;
        }
        gfp[k] = Math.sqrt(s / (E || 1));
        if (win.isGap(ka + k)) gfp[k] = NaN;
      }
      // electrode-level values in the active mode (for scaling and readouts)
      let ev = vals;
      let planV = null;
      if (E >= 4) {
        const opts = { res: o.res || 160, kind: o.kind, m: app.settings.spline.m, lambda: app.settings.spline.lambda };
        planV = EEG.topo.plan(used, opts);
        if (o.kind === 'CSD') {
          const We = EEG.topo.pointWeights(planV, used.map((u) => u.pos), 'CSD');
          ev = new Float32Array(n * E);
          for (let k = 0; k < n; k++) {
            const row = vals.subarray(k * E, (k + 1) * E);
            EEG.spline.apply(We, E, row, ev.subarray(k * E, (k + 1) * E));
          }
        }
      }
      let wmax = 0;
      for (let i = 0; i < ev.length; i++) if (Math.abs(ev[i]) > wmax) wmax = Math.abs(ev[i]);
      return { a: rg.a, b: rg.b, sel: rg.sel, t0: win.time(ka), fs: win.fs, n, E, used, excluded, vals, ev, gfp, wmax, plan: planV, key: app.dataKey(), unit: o.kind === 'CSD' ? 'µV/cm²' : 'µV' };
    }

    kAt(t) {
      const d = this.data;
      return U.clamp(Math.round((t - d.t0) * d.fs), 0, d.n - 1);
    }
    vmaxFor(k) {
      const d = this.data,
        o = this.o;
      if (o.scale === 'fixed') return o.fixed;
      if (o.scale === 'map') {
        let m = 0;
        for (let e = 0; e < d.E; e++) m = Math.max(m, Math.abs(d.ev[k * d.E + e]));
        return m || 1;
      }
      return d.wmax || 1;
    }

    draw() {
      const d = this.data;
      if (!d) return;
      this.drawMain();
      this.drawButterfly();
      this.drawSequence();
    }

    drawMain() {
      const app = this.app,
        d = this.data,
        o = this.o;
      const th = app.theme();
      const t = app.cursor;
      const k = this.kAt(t);
      const tAct = d.t0 + k / d.fs;
      this.timeEl.textContent = app.fmtClock(tAct, true);
      const rel = d.sel ? ` · ${U.fmtMs(tAct - d.a)} from selection start` : '';
      this.subEl.textContent = app.avg ? app.avgTitle() : `${U.fmtElapsed(tAct, true)} elapsed${rel}`;
      const W = Math.max(200, Math.floor(this.figure.clientWidth));
      const avail = this.root.clientHeight > 0 ? this.root.clientHeight - 120 : 420;
      const size = Math.floor(Math.max(180, Math.min(W - 64, 420, avail)));
      const ctx = U.fitCanvas(this.mapCv, size, size);
      ctx.clearRect(0, 0, size, size);
      if (d.E < 4 || !d.plan) {
        ctx.fillStyle = th.text2;
        ctx.font = '13px ' + th.font;
        ctx.textAlign = 'center';
        ctx.fillText('At least 4 electrodes with known', size / 2, size / 2 - 8);
        ctx.fillText('10-10 positions are needed.', size / 2, size / 2 + 10);
        this.readout.textContent = '';
        return;
      }
      const values = d.vals.subarray(k * d.E, (k + 1) * d.E);
      this.g = EEG.topo.grid(d.plan, values, this.g);
      const vmax = this.vmaxFor(k);
      this.vmax = vmax;
      const R = size / 2 - Math.max(18, size * 0.085);
      this.geom = { cx: size / 2, cy: size / 2 + 4, R, size };
      const evals = d.ev.subarray(k * d.E, (k + 1) * d.E);
      const hl = app.highlightElectrodes();
      const ex = EEG.topo.draw(ctx, d.plan, this.g, evals, {
        cx: size / 2, cy: size / 2 + 4, R, vmax, cmap: o.cmap, invert: o.invert, contours: o.contours,
        labels: o.labels, values: o.values, equator: o.equator, theme: { line: th.text, muted: th.text3 }, excluded: d.excluded.filter((x) => x.why === 'excluded'), font: th.font,
        highlight: d.used.map((u, i) => (hl.has(u.idx) ? i : -1)).filter((i) => i >= 0), hlColor: th.accent,
      });
      const cctx = U.fitCanvas(this.cbarCv, 52, size);
      cctx.clearRect(0, 0, 52, size);
      EEG.topo.drawColorbar(cctx, 6, 20, 12, size - 56, { cmap: o.cmap, invert: o.invert, vmax, theme: { line: th.text2, text: th.text2 }, unit: d.unit, font: th.font });
      // readouts
      const unit = d.unit;
      const fmt = (v) => (v > 0 ? '+' : '') + U.fmtNum(v, Math.abs(v) < 10 ? 1 : 0) + ' ' + unit;
      const mx = ex.iMax,
        mn = ex.iMin;
      const posC = EEG.topo.cssColor(o.cmap, o.invert, 0.8),
        negC = EEG.topo.cssColor(o.cmap, o.invert, -0.8);
      const gfp = d.gfp[k];
      this.readout.innerHTML = '';
      this.readout.append(
        el('span', { class: 'ro' }, el('i', { style: { background: negC } }), 'Min ', el('b', {}, d.used[mn].label), ' ', fmt(evals[mn])),
        el('span', { class: 'ro' }, el('i', { style: { background: posC } }), 'Max ', el('b', {}, d.used[mx].label), ' ', fmt(evals[mx])),
        el('span', { class: 'ro' }, 'GFP ', el('b', {}, U.fmtNum(gfp, 1)), ' µV'),
        el('span', { class: 'ro muted', title: d.excluded.map((x) => x.label + (x.why ? ` (${x.why})` : '')).join(', ') }, `${d.E} electrodes` + (d.excluded.length ? ` · ${d.excluded.length} excluded` : ''))
      );
    }

    drawButterfly() {
      const app = this.app,
        d = this.data,
        o = this.o;
      const th = app.theme();
      const W = Math.max(200, Math.floor(this.bfSec.clientWidth));
      const H = 168,
        gH = 38,
        top = 8,
        bH = H - gH - top - 22;
      const ctx = U.fitCanvas(this.bfCv, W, H);
      ctx.clearRect(0, 0, W, H);
      const left = 44,
        right = 8,
        pw = W - left - right;
      this.bfGeom = { left, pw, W };
      const X = (k) => left + (d.n > 1 ? (k / (d.n - 1)) * pw : pw / 2);
      // amplitude scale
      let amax = 0;
      for (let i = 0; i < d.ev.length; i++) amax = Math.max(amax, Math.abs(d.ev[i]));
      amax = amax || 1;
      const yc = top + bH / 2;
      const Y = (v) => yc + (v / amax) * (bH / 2); // negative up
      ctx.strokeStyle = th.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, yc + 0.5);
      ctx.lineTo(left + pw, yc + 0.5);
      ctx.stroke();
      ctx.fillStyle = th.text3;
      ctx.font = '10px ' + th.mono;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('−' + U.fmtNum(amax, 0), left - 4, top + 4);
      ctx.fillText('+' + U.fmtNum(amax, 0), left - 4, top + bH - 4);
      ctx.fillText('0', left - 4, yc);
      ctx.save();
      ctx.translate(10, yc);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText(d.unit + ' (neg ↑)', 0, 0);
      ctx.restore();
      const k = this.kAt(app.cursor);
      // traces
      const vals = d.ev,
        E = d.E;
      let iMax = 0,
        iMin = 0;
      for (let e = 0; e < E; e++) {
        if (vals[k * E + e] > vals[k * E + iMax]) iMax = e;
        if (vals[k * E + e] < vals[k * E + iMin]) iMin = e;
      }
      ctx.lineWidth = 1;
      for (let e = 0; e < E; e++) {
        if (e === iMax || e === iMin) continue;
        ctx.strokeStyle = th.butterfly;
        ctx.beginPath();
        for (let i = 0; i < d.n; i++) {
          const y = Y(vals[i * E + e]);
          i ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y);
        }
        ctx.stroke();
      }
      for (const [e, x] of [[iMax, 0.85], [iMin, -0.85]]) {
        ctx.strokeStyle = EEG.topo.cssColor(o.cmap, o.invert, x);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < d.n; i++) {
          const y = Y(vals[i * E + e]);
          i ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y);
        }
        ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.textAlign = 'left';
        ctx.font = '600 10px ' + th.font;
        ctx.fillText(d.used[e].label, X(k) + 5, Y(vals[k * E + e]));
      }
      // GFP
      const gy0 = top + bH + 6,
        gy1 = gy0 + gH;
      let gmax = 0;
      for (let i = 0; i < d.n; i++) if (d.gfp[i] > gmax) gmax = d.gfp[i];
      gmax = gmax || 1;
      ctx.beginPath();
      ctx.moveTo(X(0), gy1);
      for (let i = 0; i < d.n; i++) ctx.lineTo(X(i), gy1 - ((d.gfp[i] || 0) / gmax) * gH);
      ctx.lineTo(X(d.n - 1), gy1);
      ctx.closePath();
      ctx.fillStyle = th.accentSoft2;
      ctx.fill();
      ctx.strokeStyle = th.accent;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < d.n; i++) {
        const y = gy1 - ((d.gfp[i] || 0) / gmax) * gH;
        i ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y);
      }
      ctx.stroke();
      ctx.fillStyle = th.text3;
      ctx.textAlign = 'right';
      ctx.font = '10px ' + th.mono;
      ctx.fillText('GFP', left - 4, gy0 + gH / 2);
      // sequence ticks
      ctx.strokeStyle = th.text3;
      ctx.lineWidth = 1;
      for (const t of this.seqTimes) {
        const x = X(this.kAt(t));
        ctx.beginPath();
        ctx.moveTo(x, gy1);
        ctx.lineTo(x, gy1 + 4);
        ctx.stroke();
      }
      // time axis (ms relative to window start, or to the alignment point of an average)
      const dur = (d.n - 1) / d.fs;
      const step = U.niceStep(dur * 1000, 5);
      const off = this.msOffset();
      ctx.fillStyle = th.text3;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let ms = Math.ceil(off / step - 1e-9) * step; ms <= off + dur * 1000 + 1e-6; ms += step) {
        const x = left + ((ms - off) / 1000 / (dur || 1)) * pw;
        if (x > left + pw - 14) continue;
        ctx.fillText(Math.round(ms) + '', x, gy1 + 6);
      }
      ctx.textAlign = 'right';
      ctx.fillText('ms', left + pw, gy1 + 6);
      // cursor
      const xc = X(k);
      ctx.strokeStyle = th.cursor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xc, top);
      ctx.lineTo(xc, gy1);
      ctx.stroke();
    }

    /* ms value of the first sample of the analysis window on the displayed axis. */
    msOffset() {
      const app = this.app;
      return app.avg ? Math.round((this.data.t0 - app.avg.tZero) * 1000) : 0;
    }

    seqStep() {
      const d = this.data,
        o = this.o;
      if (o.step === 'sample') return 1 / d.fs;
      if (o.step !== 'auto') return parseFloat(o.step) / 1000;
      const dur = (d.n - 1) / d.fs;
      const cands = [1 / d.fs, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1];
      for (const c of cands) if (c >= 1 / d.fs - 1e-9 && dur / c + 1 <= (o.maxMaps || 12)) return c;
      return dur / ((o.maxMaps || 12) - 1);
    }

    drawSequence() {
      const d = this.data,
        o = this.o,
        app = this.app;
      const th = app.theme();
      this.seqGrid.textContent = '';
      this.seqTimes = [];
      this.seqSec.hidden = !d.sel || d.E < 4;
      if (this.seqSec.hidden) {
        app.traceView.drawOverlay();
        return;
      }
      const step = this.seqStep();
      const times = [];
      for (let t = d.t0; t <= d.t0 + (d.n - 1) / d.fs + 1e-9; t += step) times.push(t);
      this.seqTimes = times;
      const vmax = o.scale === 'fixed' ? o.fixed : d.wmax || 1;
      const plan = EEG.topo.plan(d.used, { res: 72, kind: o.kind, m: app.settings.spline.m, lambda: app.settings.spline.lambda });
      const kc = this.kAt(app.cursor);
      const W = this.seqGrid.clientWidth || 300;
      const cols = Math.max(3, Math.floor(W / 86));
      const S = Math.floor((W - (cols - 1) * 6) / cols);
      const g = new Float32Array(plan.res * plan.res);
      times.forEach((t) => {
        const k = this.kAt(t);
        const cv = el('canvas');
        const ctx = U.fitCanvas(cv, S, S);
        EEG.topo.grid(plan, d.vals.subarray(k * d.E, (k + 1) * d.E), g);
        EEG.topo.draw(ctx, plan, g, null, { cx: S / 2, cy: S / 2 + 2, R: S / 2 - 7, vmax, cmap: o.cmap, invert: o.invert, contours: o.contours, small: true, theme: { line: th.text } });
        const ms = Math.round((t - d.t0) * 1000) + this.msOffset();
        const cell = el('div', { class: 'mp-seq-cell' + (k === kc ? ' on' : ''), title: app.fmtClock(t, true), onclick: () => app.setCursor(t) }, cv, el('div', { class: 'mp-seq-t' }, (app.avg && ms > 0 ? '+' : '') + ms + ' ms'));
        this.seqGrid.append(cell);
      });
      const foot = el('div', { class: 'mp-seq-foot' }, `${times.length} maps · ${Math.round(step * 1000 * 10) / 10} ms apart · shared scale ±${U.fmtNum(vmax, vmax < 10 ? 1 : 0)} ${d.unit}`);
      this.seqGrid.append(foot);
      app.traceView.drawOverlay();
    }

    /* ---------- interaction on map & butterfly ---------- */
    _bindCanvas() {
      this.mapCv.addEventListener('pointermove', (e) => {
        const d = this.data,
          g = this.geom;
        if (!d || !g || !d.plan) return;
        const r = this.mapCv.getBoundingClientRect();
        const x = e.clientX - r.left,
          y = e.clientY - r.top;
        const u = (x - g.cx) / g.R,
          w = -(y - g.cy) / g.R;
        let txt = '';
        // nearest electrode
        let best = -1,
          bd = 9;
        d.plan.e2d.forEach((p, i) => {
          const dd = Math.hypot(g.cx + p[0] * g.R - x, g.cy - p[1] * g.R - y);
          if (dd < bd) {
            bd = dd;
            best = i;
          }
        });
        const k = this.kAt(this.app.cursor);
        if (best >= 0) {
          const v = d.ev[k * d.E + best];
          txt = `${d.used[best].label}: ${(v > 0 ? '+' : '') + U.fmtNum(v, 1)} ${d.unit}`;
        } else if (u * u + w * w <= 1 && this.g) {
          const res = d.plan.res;
          const i = Math.floor(((u + 1) / 2) * res),
            j = Math.floor(((1 - w) / 2) * res);
          const v = this.g[j * res + i];
          if (v === v) txt = `${(v > 0 ? '+' : '') + U.fmtNum(v, 1)} ${d.unit} (interpolated)`;
        }
        this.tip.hidden = !txt;
        if (txt) {
          this.tip.textContent = txt;
          this.tip.style.left = x + 14 + 'px';
          this.tip.style.top = y + 10 + 'px';
        }
        this.mapCv.style.cursor = best >= 0 ? 'context-menu' : 'default';
        this._hoverElectrode = best >= 0 ? d.used[best] : null;
      });
      this.mapCv.addEventListener('pointerleave', () => (this.tip.hidden = true));
      this.mapCv.addEventListener('contextmenu', (e) => {
        const h = this._hoverElectrode;
        if (!h) return;
        e.preventDefault();
        this.app.menu(e.clientX, e.clientY, [{ label: `Exclude ${h.label} from maps & average`, action: () => this.app.toggleBad(h.idx, true) }]);
      });
      const scrub = (e) => {
        const d = this.data,
          b = this.bfGeom;
        if (!d || !b) return;
        const r = this.bfCv.getBoundingClientRect();
        const f = U.clamp((e.clientX - r.left - b.left) / b.pw, 0, 1);
        this.app.setCursor(d.t0 + (f * (d.n - 1)) / d.fs, { live: true });
      };
      this.bfCv.addEventListener('pointerdown', (e) => {
        this.bfCv.setPointerCapture(e.pointerId);
        this._scrub = true;
        scrub(e);
      });
      this.bfCv.addEventListener('pointermove', (e) => this._scrub && scrub(e));
      this.bfCv.addEventListener('pointerup', () => {
        this._scrub = false;
        this.app.setCursor(this.app.cursor);
      });
    }

    /* ---------- export ---------- */
    _exportHeader(ctx, W, title) {
      const app = this.app;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.fillStyle = '#111';
      ctx.font = '600 22px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(title, 28, 40);
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillStyle = '#555';
      const o = this.o;
      const f = app.filterSpec();
      const lines = [
        app.exportIdentity() + (app.avg ? ' · ' + app.avgTitle() : ''),
        `${o.kind === 'CSD' ? 'Current source density (spherical-spline Laplacian)' : 'Potential, ' + (o.ref === 'avg' ? 'common average reference' : 'as recorded')} · spherical splines (m = ${app.settings.spline.m}, λ = ${app.settings.spline.lambda})`,
        `Filters: HP ${f.hp || 'off'} Hz · LP ${f.lp || 'off'} Hz · notch ${f.notch ? f.notch + ' Hz' : 'off'} · ${f.mode === 'causal' ? 'causal' : 'zero-phase'} · ${this.data.E} electrodes`,
      ];
      lines.forEach((l, i) => ctx.fillText(l, 28, 66 + i * 20));
      return 66 + lines.length * 20 + 10;
    }
    exportPNG() {
      const d = this.data;
      if (!d || !d.plan) return;
      const app = this.app,
        o = this.o;
      const S = 720,
        W = 980,
        Hh = 140;
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = S + Hh + 60;
      const ctx = cv.getContext('2d');
      const k = this.kAt(app.cursor);
      const y0 = this._exportHeader(ctx, W, `Voltage map · ${app.fmtClock(d.t0 + k / d.fs, true)}`);
      const plan = EEG.topo.plan(d.used, { res: 320, kind: o.kind, m: app.settings.spline.m, lambda: app.settings.spline.lambda });
      const g = EEG.topo.grid(plan, d.vals.subarray(k * d.E, (k + 1) * d.E));
      const vmax = this.vmaxFor(k);
      EEG.topo.draw(ctx, plan, g, d.ev.subarray(k * d.E, (k + 1) * d.E), { cx: 40 + S / 2, cy: y0 + S / 2, R: S / 2 - 50, vmax, cmap: o.cmap, invert: o.invert, contours: o.contours, labels: true, values: o.values, equator: o.equator, theme: { line: '#222', muted: '#888' }, excluded: d.excluded.filter((x) => x.why === 'excluded'), fontSize: 15 });
      EEG.topo.drawColorbar(ctx, S + 90, y0 + 60, 26, S - 160, { cmap: o.cmap, invert: o.invert, vmax, theme: { line: '#333', text: '#333' }, unit: d.unit });
      cv.toBlob((b) => U.download(b, `voltage-map_${app.fileStem()}_${app.fmtClock(d.t0 + k / d.fs, true).replace(/[:.]/g, '-')}.png`));
    }
    exportSequencePNG() {
      const d = this.data;
      if (!d || !d.sel || !this.seqTimes.length) {
        this.app.toast('Select a time window first (drag across the EEG).');
        return;
      }
      const app = this.app,
        o = this.o;
      const times = this.seqTimes;
      const cols = Math.min(6, times.length),
        rows = Math.ceil(times.length / cols);
      const S = 200,
        gap = 18,
        W = 40 + cols * (S + gap) + 120;
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = 170 + rows * (S + 34) + 20;
      const ctx = cv.getContext('2d');
      const y0 = this._exportHeader(ctx, W, `Map sequence · ${app.fmtClock(times[0], true)} → ${app.fmtClock(times[times.length - 1], true)}`);
      const plan = EEG.topo.plan(d.used, { res: 128, kind: o.kind, m: app.settings.spline.m, lambda: app.settings.spline.lambda });
      const vmax = o.scale === 'fixed' ? o.fixed : d.wmax || 1;
      const g = new Float32Array(plan.res * plan.res);
      times.forEach((t, i) => {
        const k = this.kAt(t);
        const cx = 40 + (i % cols) * (S + gap) + S / 2,
          cy = y0 + Math.floor(i / cols) * (S + 34) + S / 2;
        EEG.topo.grid(plan, d.vals.subarray(k * d.E, (k + 1) * d.E), g);
        EEG.topo.draw(ctx, plan, g, null, { cx, cy, R: S / 2 - 16, vmax, cmap: o.cmap, invert: o.invert, contours: o.contours, small: true, theme: { line: '#222' } });
        ctx.fillStyle = '#333';
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(Math.round((t - times[0]) * 1000) + ' ms', cx, cy + S / 2 + 12);
      });
      EEG.topo.drawColorbar(ctx, W - 90, y0 + 20, 18, Math.min(360, rows * (S + 34) - 40), { cmap: o.cmap, invert: o.invert, vmax, theme: { line: '#333', text: '#333' }, unit: d.unit });
      cv.toBlob((b) => U.download(b, `map-sequence_${app.fileStem()}_${app.fmtClock(times[0], true).replace(/[:.]/g, '-')}.png`));
    }
  }

  EEG.MapPanel = MapPanel;
})(typeof window !== 'undefined' ? window : globalThis);
