/* Whole-recording navigator: time ticks, event markers, current page and
 * cursor. Click or drag to jump; the page follows the pointer. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const U = EEG.util;
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600];

  class Overview {
    constructor(app, canvas) {
      this.app = app;
      this.cv = canvas;
      this.W = 100;
      this.H = 30;
      this.drag = false;
      canvas.addEventListener('pointerdown', (e) => {
        if (!app.src) return;
        canvas.setPointerCapture(e.pointerId);
        this.drag = true;
        this._jump(e);
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!app.src) return;
        if (this.drag) this._jump(e);
        const t = this._t(e);
        canvas.title = app.fmtTime(t) + '  (' + U.fmtElapsed(t) + ')';
      });
      canvas.addEventListener('pointerup', () => (this.drag = false));
      canvas.addEventListener('wheel', (e) => app.traceView.wheel(e), { passive: false });
      new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
    }
    _t(e) {
      const r = this.cv.getBoundingClientRect();
      return U.clamp((e.clientX - r.left) / r.width, 0, 1) * (this.app.src ? this.app.src.duration : 0);
    }
    _jump(e) {
      const app = this.app;
      app.goTo(this._t(e) - app.view.dur / 2);
    }
    draw() {
      const app = this.app;
      const th = app.theme();
      const r = this.cv.parentElement.getBoundingClientRect();
      this.W = Math.max(50, Math.floor(r.width));
      this.H = Math.max(20, Math.floor(r.height));
      const ctx = U.fitCanvas(this.cv, this.W, this.H);
      ctx.clearRect(0, 0, this.W, this.H);
      ctx.fillStyle = th.track;
      ctx.fillRect(0, 0, this.W, this.H);
      if (!app.src) return;
      const D = app.src.duration;
      const X = (t) => (t / D) * this.W;
      // ticks
      let step = STEPS[STEPS.length - 1];
      for (const s of STEPS) if ((s / D) * this.W >= 70) {
        step = s;
        break;
      }
      ctx.font = '10px ' + th.mono;
      ctx.textBaseline = 'top';
      ctx.fillStyle = th.text3;
      ctx.strokeStyle = th.border;
      for (let t = 0; t <= D; t += step) {
        const x = Math.round(X(t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, this.H - 6);
        ctx.lineTo(x, this.H);
        ctx.stroke();
        if (x < this.W - 40) ctx.fillText(app.fmtTime(t), x + 3, this.H - 13);
      }
      // events
      for (const ev of app.allEvents()) {
        ctx.fillStyle = app.eventColor(ev);
        const x = X(ev.t);
        ctx.fillRect(Math.round(x) - 1, 2, 2, this.H - 16);
      }
      // page window
      const xa = X(app.view.t0),
        xb = X(app.view.t0 + app.view.dur);
      ctx.fillStyle = th.accentSoft;
      ctx.fillRect(xa, 0, Math.max(2, xb - xa), this.H);
      ctx.strokeStyle = th.accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(xa + 0.5, 0.75, Math.max(2, xb - xa) - 1, this.H - 1.5);
      if (app.cursor != null) {
        ctx.strokeStyle = th.cursor;
        ctx.lineWidth = 1;
        const x = Math.round(X(app.cursor)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.H);
        ctx.stroke();
      }
    }
  }
  EEG.Overview = Overview;
})(typeof window !== 'undefined' ? window : globalThis);
