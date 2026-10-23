/* EEG trace display.
 *
 * - Canvas rendering at device-pixel resolution; negative up (EEG convention).
 * - When a page holds more samples than pixels, each pixel column is drawn as
 *   its min–max envelope so short transients (spikes) are never dropped by
 *   decimation.
 * - Overlay canvas (cursor, selection, hover, events) is redrawn independently
 *   so pointer interaction never forces a full trace redraw.
 * Mouse: click = place map cursor and highlight the clicked trace · drag =
 * select window · drag cursor = scrub · Alt+click = snap to nearest peak ·
 * Shift+click = select from cursor · wheel = one page per step ·
 * Ctrl/⌘/Shift+wheel = 1 s per step · Alt+wheel or pinch = sensitivity ·
 * double-click = add event · click a channel label = per-trace gain/filters. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const U = EEG.util;
  const el = (...a) => U.el(...a);

  const TICK_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

  class TraceView {
    constructor(app, root) {
      this.app = app;
      this.root = root;
      this.labelList = el('div', { class: 'tv-label-list' });
      this.labelCol = el('div', { class: 'tv-labels' }, el('div', { class: 'tv-label-head' }), this.labelList);
      this.ruler = el('canvas', { class: 'tv-ruler' });
      this.traces = el('canvas', { class: 'tv-traces' });
      this.overlay = el('canvas', { class: 'tv-overlay', tabindex: '-1' });
      this.plot = el('div', { class: 'tv-plot' }, this.traces, this.overlay);
      this.main = el('div', { class: 'tv-main' }, this.ruler, this.plot);
      root.append(this.labelCol, this.main);
      this.W = 100;
      this.H = 100;
      this.yc = [];
      this.lineH = 20;
      this.mode = null;
      this._wg = { last: 0, dir: 0, acc: 0, prev: 0, lastStep: 0, kind: '' };
      this._gainAcc = 0;
      this._bind();
      new ResizeObserver(() => this.app.onResize()).observe(this.plot);
    }

    /* ---------- geometry ---------- */
    measure() {
      const r = this.plot.getBoundingClientRect();
      this.W = Math.max(50, Math.floor(r.width));
      this.H = Math.max(50, Math.floor(r.height));
      this.layout();
    }
    layout() {
      const lines = this.app.lines || [];
      const gap = this.app.settings.sepGap;
      let units = 0;
      lines.forEach((l) => (units += l.kind === 'sep' ? gap : 1));
      const padT = 4,
        padB = 4;
      this.lineH = units > 0 ? (this.H - padT - padB) / units : 20;
      this.yc = [];
      let y = padT;
      lines.forEach((l) => {
        if (l.kind === 'sep') {
          this.yc.push(null);
          y += gap * this.lineH;
        } else {
          this.yc.push(y + this.lineH / 2);
          y += this.lineH;
        }
      });
      this.renderLabels();
    }
    xOf(t) {
      const v = this.app.view;
      return ((t - v.t0) / v.dur) * this.W;
    }
    tOf(x) {
      const v = this.app.view;
      return v.t0 + (x / this.W) * v.dur;
    }
    lineAt(y) {
      let best = -1,
        bd = Infinity;
      this.yc.forEach((c, i) => {
        if (c == null) return;
        const d = Math.abs(c - y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return bd <= this.lineH * 0.75 ? best : -1;
    }
    pxPerUv(line) {
      const sens = line && line.gain ? line.gain : this.app.sens;
      return this.app.settings.pxPerCm / sens;
    }

    /* ---------- labels ---------- */
    renderLabels() {
      const app = this.app;
      const lines = app.lines || [];
      this.labelList.textContent = '';
      const fsz = U.clamp(this.lineH * 0.62, 8.5, 12.5);
      lines.forEach((l, i) => {
        if (l.kind === 'sep') return;
        const bad = app.lineIsBad(l);
        const d = el('div', { class: 'tv-label' + (bad ? ' bad' : '') + (app.highlight === i ? ' hl' : '') + (l.mod ? ' mod' : '') + (app._pop && app._pop.li === i ? ' open' : ''), 'data-i': i, title: this._labelTitle(l) }, l.label);
        d.style.top = this.yc[i] + 'px';
        d.style.fontSize = fsz + 'px';
        if (l.color) d.style.color = l.color;
        this.labelList.append(d);
      });
      this.labelCol.querySelector('.tv-label-head').textContent = '';
    }
    _labelTitle(l) {
      const parts = [l.label];
      if (l.gain) parts.push(`${l.gain} µV/cm`);
      if (l.filter) {
        const f = (v) => (v == null ? 'linked' : v ? v + ' Hz' : 'off');
        parts.push(`HP ${f(l.filter.hp)} · LP ${f(l.filter.lp)}` + (l.filter.notch != null ? ` · notch ${f(l.filter.notch)}` : ''));
      }
      if (l.mod) parts.push('adjusted for this trace');
      parts.push('Click: gain & filters of this trace · Right-click: more');
      return parts.join(' · ');
    }
    setHighlight(i) {
      this.labelList.querySelectorAll('.tv-label').forEach((d) => d.classList.toggle('hl', Number(d.dataset.i) === i));
    }
    labelEl(i) {
      return this.labelList.querySelector(`.tv-label[data-i="${i}"]`);
    }

    /* ---------- drawing ---------- */
    draw() {
      const app = this.app;
      const th = app.theme();
      const ctx = U.fitCanvas(this.traces, this.W, this.H);
      ctx.fillStyle = th.traceBg;
      ctx.fillRect(0, 0, this.W, this.H);
      this._drawGrid(ctx, th);
      const win = app.page;
      const data = app.lineData;
      if (win && data) {
        const fs = win.fs;
        const v = app.view;
        const x0 = ((win.t0 - v.t0) / v.dur) * this.W;
        const dx = this.W / (v.dur * fs);
        const lw = app.settings.traceWidth;
        const dpr = G.devicePixelRatio || 1;
        ctx.lineJoin = 'round';
        const clip = app.settings.clip > 0 ? app.settings.clip * this.lineH : Infinity;
        app.lines.forEach((l, i) => {
          if (l.kind === 'sep' || !data[i]) return;
          const y0 = this.yc[i];
          const k = this.pxPerUv(l);
          const bad = app.lineIsBad(l);
          const hl = app.highlight === i;
          if (hl) {
            ctx.globalAlpha = 0.07;
            ctx.fillStyle = th.accent;
            ctx.fillRect(0, y0 - this.lineH / 2, this.W, this.lineH);
          }
          ctx.strokeStyle = l.color || th.trace;
          ctx.globalAlpha = bad ? 0.35 : 1;
          ctx.lineWidth = hl ? (lw === 'bold' ? 3 : 2.4) : lw === 'thin' ? 1 / dpr : lw === 'bold' ? 1.5 : 1;
          this._drawSignal(ctx, data[i], x0, dx, y0, k, clip);
          ctx.globalAlpha = 1;
        });
      }
      this._drawScaleBar(ctx, th);
      this.drawRuler();
      this.drawOverlay();
    }

    _drawSignal(ctx, a, x0, dx, y0, k, clip) {
      const n = a.length;
      const yOf = (v) => {
        const y = v * k;
        return y0 + (y > clip ? clip : y < -clip ? -clip : y);
      };
      ctx.beginPath();
      let pen = false;
      const spp = 1 / dx;
      if (spp <= 1.6) {
        for (let i = 0; i < n; i++) {
          const v = a[i];
          if (v !== v) {
            pen = false;
            continue;
          }
          const x = x0 + i * dx;
          if (x < -2 || x > this.W + 2) {
            pen = false;
            continue;
          }
          const y = yOf(v);
          if (pen) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            pen = true;
          }
        }
      } else {
        // min/max envelope per pixel column
        const cols = Math.ceil(this.W);
        for (let c = 0; c < cols; c++) {
          const i0 = Math.max(0, Math.floor((c - x0) / dx)),
            i1 = Math.min(n, Math.floor((c + 1 - x0) / dx));
          if (i1 <= i0) continue;
          let mn = Infinity,
            mx = -Infinity,
            first = NaN,
            last = NaN;
          for (let i = i0; i < i1; i++) {
            const v = a[i];
            if (v !== v) continue;
            if (first !== first) first = v;
            last = v;
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          if (mn === Infinity) {
            pen = false;
            continue;
          }
          const x = c + 0.5;
          if (pen) ctx.lineTo(x, yOf(first));
          else {
            ctx.moveTo(x, yOf(first));
            pen = true;
          }
          ctx.lineTo(x, yOf(mn));
          ctx.lineTo(x, yOf(mx));
          ctx.lineTo(x, yOf(last));
        }
      }
      ctx.stroke();
    }

    _tickStep(minPx) {
      const pxPerS = this.W / this.app.view.dur;
      for (const s of TICK_STEPS) if (s * pxPerS >= minPx) return s;
      return 3600;
    }

    _drawGrid(ctx, th) {
      const v = this.app.view;
      const pxPerS = this.W / v.dur;
      const showMinor = this.app.settings.minorGrid && pxPerS >= 70;
      const sec = pxPerS >= 6 ? 1 : this._tickStep(14);
      if (showMinor) {
        ctx.strokeStyle = th.gridMinor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let t = Math.ceil(v.t0 / 0.2) * 0.2; t <= v.t0 + v.dur; t += 0.2) {
          const x = Math.round(this.xOf(t)) + 0.5;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, this.H);
        }
        ctx.stroke();
      }
      ctx.strokeStyle = th.grid;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      for (let t = Math.ceil(v.t0 / sec - 1e-9) * sec; t <= v.t0 + v.dur; t += sec) {
        const x = Math.round(this.xOf(t)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.H);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    _drawScaleBar(ctx, th) {
      const k = this.pxPerUv(null);
      const target = this.lineH * 1.2;
      let uv = U.niceStep(target / k, 1);
      if (uv * k > this.lineH * 2.2) uv /= 2;
      const h = uv * k;
      const pxPerS = this.W / this.app.view.dur;
      const x = this.W - 14,
        y = this.H - 12;
      ctx.strokeStyle = th.text2;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - h);
      ctx.lineTo(x, y);
      ctx.lineTo(x - pxPerS, y);
      ctx.stroke();
      ctx.fillStyle = th.text2;
      ctx.font = '10px ' + th.font;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      const lab = `${uv} µV`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = th.traceBg;
      ctx.strokeText(lab, x - 4, y - h / 2 + 5);
      ctx.fillText(lab, x - 4, y - h / 2 + 5);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.strokeText('1 s', x - pxPerS / 2, y + 1);
      ctx.fillText('1 s', x - pxPerS / 2, y + 1);
    }

    drawRuler() {
      const app = this.app;
      const th = app.theme();
      const H = 24;
      const ctx = U.fitCanvas(this.ruler, this.W, H);
      ctx.fillStyle = th.panel;
      ctx.fillRect(0, 0, this.W, H);
      ctx.strokeStyle = th.border;
      ctx.beginPath();
      ctx.moveTo(0, H - 0.5);
      ctx.lineTo(this.W, H - 0.5);
      ctx.stroke();
      if (!app.src) return;
      const v = app.view;
      const step = this._tickStep(78);
      const withMs = step < 1;
      ctx.font = '11px ' + th.mono;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = th.text2;
      ctx.strokeStyle = th.text3;
      for (let t = Math.ceil(v.t0 / step - 1e-9) * step; t <= v.t0 + v.dur; t += step) {
        const x = Math.round(this.xOf(t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, H - 7);
        ctx.lineTo(x, H);
        ctx.stroke();
        const lab = app.fmtTime(t, withMs);
        ctx.fillText(lab, x + 3, H / 2 - 1);
      }
      // events (chips)
      for (const ev of app.eventsInView()) {
        const x = this.xOf(ev.t);
        const col = app.eventColor(ev);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(x - 5, 1);
        ctx.lineTo(x + 5, 1);
        ctx.lineTo(x, 8);
        ctx.closePath();
        ctx.fill();
      }
      // cursor flag
      if (app.cursor != null) {
        const x = this.xOf(app.cursor);
        if (x >= -1 && x <= this.W + 1) {
          const lab = app.fmtTime(app.cursor, true);
          ctx.font = '600 11px ' + th.mono;
          const w = ctx.measureText(lab).width + 10;
          const bx = U.clamp(x - w / 2, 0, this.W - w);
          ctx.fillStyle = th.cursor;
          this._roundRect(ctx, bx, 3, w, H - 6, 4);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.fillText(lab, bx + w / 2, H / 2);
        }
      }
    }

    _roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    drawOverlay() {
      const app = this.app;
      const th = app.theme();
      const ctx = U.fitCanvas(this.overlay, this.W, this.H);
      ctx.clearRect(0, 0, this.W, this.H);
      if (!app.src) return;
      // events
      for (const ev of app.eventsInView()) {
        const x = this.xOf(ev.t);
        const col = app.eventColor(ev);
        if (ev.dur > 0) {
          ctx.fillStyle = col;
          ctx.globalAlpha = 0.07;
          ctx.fillRect(x, 0, this.xOf(ev.t + ev.dur) - x, this.H);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = col;
        ctx.globalAlpha = app.selectedEvent === ev.id ? 0.95 : 0.55;
        ctx.lineWidth = app.selectedEvent === ev.id ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, this.H);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const txt = app.eventLabel(ev);
        if (txt) {
          ctx.font = '600 10px ' + th.font;
          const w = Math.min(160, ctx.measureText(txt).width + 8);
          ctx.fillStyle = col;
          this._roundRect(ctx, x + 2, 2, w, 15, 3);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'left';
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 2, 2, w - 3, 15);
          ctx.clip();
          ctx.fillText(txt, x + 6, 10);
          ctx.restore();
        }
      }
      // selection
      const s = app.selection;
      if (s) {
        const xa = this.xOf(s.t0),
          xb = this.xOf(s.t1);
        ctx.fillStyle = th.sel;
        ctx.fillRect(xa, 0, xb - xa, this.H);
        ctx.strokeStyle = th.selEdge;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(xa) + 0.5, 0);
        ctx.lineTo(Math.round(xa) + 0.5, this.H);
        ctx.moveTo(Math.round(xb) + 0.5, 0);
        ctx.lineTo(Math.round(xb) + 0.5, this.H);
        ctx.stroke();
        // map-sequence ticks
        const seq = app.mapPanel && app.mapPanel.seqTimes;
        if (seq && seq.length) {
          ctx.strokeStyle = th.selEdge;
          ctx.beginPath();
          for (const t of seq) {
            const x = Math.round(this.xOf(t)) + 0.5;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, 5);
            ctx.moveTo(x, this.H - 5);
            ctx.lineTo(x, this.H);
          }
          ctx.stroke();
        }
      }
      // hover guide
      if (app.hover && app.hover.t != null && this.mode !== 'cursor') {
        const x = Math.round(this.xOf(app.hover.t)) + 0.5;
        ctx.strokeStyle = th.hover;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.H);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // map cursor
      if (app.cursor != null) {
        const x = this.xOf(app.cursor);
        if (x >= -2 && x <= this.W + 2) {
          ctx.strokeStyle = th.cursor;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, this.H);
          ctx.stroke();
          // value dots on each trace at the cursor
          const data = app.lineData,
            win = app.page;
          if (data && win && win.contains(app.cursor)) {
            const k = win.index(app.cursor);
            ctx.fillStyle = th.cursor;
            app.lines.forEach((l, i) => {
              if (l.kind === 'sep' || !data[i]) return;
              const v = data[i][k];
              if (v !== v) return;
              const clip = app.settings.clip > 0 ? app.settings.clip * this.lineH : Infinity;
              const y = this.yc[i] + U.clamp(v * this.pxPerUv(l), -clip, clip);
              ctx.beginPath();
              ctx.arc(x, y, 2, 0, 2 * Math.PI);
              ctx.fill();
            });
          }
        }
      }
    }

    /* ---------- interaction ---------- */
    _pos(e) {
      const r = this.overlay.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    _bind() {
      const ov = this.overlay;
      ov.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this.app.src) return;
        const { x, y } = this._pos(e);
        ov.setPointerCapture(e.pointerId);
        const app = this.app;
        if (app.cursor != null && Math.abs(x - this.xOf(app.cursor)) <= 5 && !e.shiftKey && !e.altKey) {
          this.mode = 'cursor';
        } else {
          this.mode = 'pending';
          this.downX = x;
          this.downT = this.tOf(x);
          this.downAlt = e.altKey;
          this.downShift = e.shiftKey;
          this.downLine = this.lineAt(y);
        }
      });
      ov.addEventListener('pointermove', (e) => {
        if (!this.app.src) return;
        const { x, y } = this._pos(e);
        const app = this.app;
        const t = this.tOf(x);
        if (this.mode === 'cursor') {
          app.setCursor(t, { live: true });
          ov.style.cursor = 'ew-resize';
        } else if (this.mode === 'pending' || this.mode === 'select') {
          if (this.mode === 'pending' && Math.abs(x - this.downX) > 4) this.mode = 'select';
          if (this.mode === 'select') app.setSelection(Math.min(this.downT, t), Math.max(this.downT, t), { live: true });
        } else {
          ov.style.cursor = app.cursor != null && Math.abs(x - this.xOf(app.cursor)) <= 5 ? 'ew-resize' : 'crosshair';
        }
        const li = this.lineAt(y);
        app.setHover({ t, line: li, x, y });
      });
      const end = (e) => {
        if (!this.mode) return;
        const app = this.app;
        const { x } = this._pos(e);
        const t = this.tOf(x);
        if (this.mode === 'pending') {
          if (this.downShift && app.cursor != null) {
            app.setSelection(Math.min(app.cursor, t), Math.max(app.cursor, t));
            app.finishSelection();
          } else if (this.downAlt && this.downLine >= 0) {
            app.snapToPeak(this.downLine, t);
          } else {
            const s = app.selection;
            if (s && (t < s.t0 || t > s.t1)) app.clearSelection();
            if (this.downLine >= 0 && app.settings.clickHighlight) app.setHighlight(this.downLine);
            app.setCursor(t);
          }
        } else if (this.mode === 'select') {
          app.finishSelection();
        } else if (this.mode === 'cursor') {
          app.setCursor(app.cursor);
        }
        this.mode = null;
      };
      ov.addEventListener('pointerup', end);
      ov.addEventListener('pointercancel', () => (this.mode = null));
      ov.addEventListener('pointerleave', () => {
        if (!this.mode) this.app.setHover(null);
      });
      ov.addEventListener('dblclick', (e) => {
        if (!this.app.src) return;
        const { x } = this._pos(e);
        this.app.addEvent(this.tOf(x));
      });
      ov.addEventListener('contextmenu', (e) => {
        if (!this.app.src) return;
        e.preventDefault();
        const { x, y } = this._pos(e);
        this.app.traceContextMenu(e.clientX, e.clientY, this.tOf(x), this.lineAt(y));
      });
      const onWheel = (e) => this.wheel(e);
      ov.addEventListener('wheel', onWheel, { passive: false });
      this.labelCol.addEventListener('wheel', onWheel, { passive: false });
      this.labelList.addEventListener('click', (e) => {
        const d = e.target.closest('.tv-label');
        if (!d) return;
        this.app.showTracePopover(Number(d.dataset.i));
      });
      this.labelList.addEventListener('contextmenu', (e) => {
        const d = e.target.closest('.tv-label');
        if (!d) return;
        e.preventDefault();
        this.app.labelContextMenu(e.clientX, e.clientY, Number(d.dataset.i));
      });
    }
  }

  /* Wheel navigation. Plain wheel: one page per wheel step; Ctrl/⌘ (or Shift):
   * one second per step; Alt or trackpad pinch: sensitivity. A step is taken at
   * the first event of a gesture; within a continuous gesture (trackpads,
   * fast-spun wheels) further steps need accumulated travel and a minimum
   * interval, and decaying trackpad inertia never triggers a page turn. */
  TraceView.prototype.wheel = function (e) {
    const app = this.app;
    if (!app.src) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1;
    const pinch = e.ctrlKey && !app.keys.ctrl && !e.metaKey;
    if (e.altKey || pinch) {
      this._gainAcc += e.deltaY * unit;
      const th = pinch ? 20 : 40;
      while (Math.abs(this._gainAcc) >= th) {
        app.stepSens(this._gainAcc < 0 ? -1 : 1);
        this._gainAcc -= Math.sign(this._gainAcc) * th;
      }
      return;
    }
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
    if (!d) return;
    const fine = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!fine && app.settings.wheelMode === 'smooth') {
      app.scrollBy((d / this.W) * app.view.dur * app.settings.wheelSpeed);
      return;
    }
    const kind = fine ? 'sec' : 'page';
    const step = (dir) => (kind === 'page' ? app.page_(dir) : app.scrollBy(dir));
    const g = this._wg;
    const now = performance.now();
    const dir = Math.sign(d),
      ad = Math.abs(d);
    const fresh = now - g.last > 160 || dir !== g.dir || kind !== g.kind;
    g.last = now;
    if (fresh) {
      Object.assign(g, { dir, kind, acc: 0, prev: ad, lastStep: now });
      step(dir);
      return;
    }
    g.acc += ad;
    const rising = ad >= g.prev; // inertia only ever decays
    g.prev = ad;
    const [th, gap] = kind === 'page' ? [120, 170] : [40, 45];
    if ((kind === 'sec' || rising) && g.acc >= th && now - g.lastStep >= gap) {
      g.acc = 0;
      g.lastStep = now;
      step(dir);
    }
  };

  EEG.TraceView = TraceView;
})(typeof window !== 'undefined' ? window : globalThis);
