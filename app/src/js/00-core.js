/* EEG Viewer — core utilities and namespace.
 * All modules attach to the global EEG namespace so the app runs as plain
 * scripts from file:// (no server, no bundler) and the pure-logic modules can
 * also be loaded in Node for testing. */
(function (G) {
  'use strict';
  const EEG = (G.EEG = G.EEG || {});
  const U = (EEG.util = {});

  U.clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  U.pad2 = (n) => String(n).padStart(2, '0');
  U.pad3 = (n) => String(n).padStart(3, '0');

  /* Recording start is stored as a naive wall-clock time (EDF has no time
   * zone), so all clock arithmetic is done in UTC to avoid DST artefacts. */
  U.clockParts = (startMs, t) => {
    const d = new Date(startMs + Math.round(t * 1000));
    return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), date: d };
  };
  U.fmtClock = (startMs, t, withMs = false) => {
    const p = U.clockParts(startMs, t);
    const base = `${U.pad2(p.h)}:${U.pad2(p.m)}:${U.pad2(p.s)}`;
    return withMs ? `${base}.${U.pad3(p.ms)}` : base;
  };
  U.fmtDate = (startMs) => {
    const d = new Date(startMs);
    return `${U.pad2(d.getUTCDate())}.${U.pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  };
  U.fmtElapsed = (t, withMs = false) => {
    const neg = t < 0;
    t = Math.abs(t);
    let total = withMs ? Math.round(t * 1000) / 1000 : Math.floor(t + 1e-9);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    let out = `${h}:${U.pad2(m)}:${U.pad2(s)}`;
    if (withMs) out += '.' + U.pad3(Math.round((total - Math.floor(total)) * 1000) % 1000);
    return (neg ? '−' : '') + out;
  };
  U.fmtMs = (sec) => {
    const ms = sec * 1000;
    const r = Math.round(ms);
    return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r) + ' ms';
  };
  /* Time relative to an alignment point (averages): "−250 ms", "0 ms", "+1250 ms". */
  U.fmtRel = (sec) => {
    const r = Math.round(sec * 1000);
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r) + ' ms';
  };
  U.fmtNum = (v, digits = 1) => {
    if (!isFinite(v)) return '–';
    const s = Math.abs(v).toFixed(digits);
    return (v < 0 && Number(s) !== 0 ? '−' : '') + s;
  };

  /* "Nice" step for axis ticks / contour spacing. */
  U.niceStep = (range, target) => {
    if (!(range > 0)) return 1;
    const raw = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    const nf = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
    return nf * mag;
  };

  U.debounce = (fn, ms) => {
    let id = 0;
    return (...a) => {
      clearTimeout(id);
      id = setTimeout(() => fn(...a), ms);
    };
  };

  /* Small LRU map used for decoded data chunks. */
  U.LRU = class {
    constructor(max) {
      this.max = max;
      this.map = new Map();
    }
    get(k) {
      if (!this.map.has(k)) return undefined;
      const v = this.map.get(k);
      this.map.delete(k);
      this.map.set(k, v);
      return v;
    }
    set(k, v) {
      if (this.map.has(k)) this.map.delete(k);
      this.map.set(k, v);
      while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }
    has(k) {
      return this.map.has(k);
    }
    clear() {
      this.map.clear();
    }
  };

  U.Emitter = class {
    constructor() {
      this._h = {};
    }
    on(ev, fn) {
      (this._h[ev] = this._h[ev] || []).push(fn);
      return () => this.off(ev, fn);
    }
    off(ev, fn) {
      this._h[ev] = (this._h[ev] || []).filter((f) => f !== fn);
    }
    emit(ev, ...a) {
      (this._h[ev] || []).slice().forEach((f) => f(...a));
    }
  };

  /* localStorage wrapper that never throws (private windows, blocked storage). */
  U.store = {
    get(key, def) {
      try {
        const v = G.localStorage && G.localStorage.getItem('eegv:' + key);
        return v == null ? def : JSON.parse(v);
      } catch (e) {
        return def;
      }
    },
    set(key, val) {
      try {
        G.localStorage && G.localStorage.setItem('eegv:' + key, JSON.stringify(val));
      } catch (e) {
        /* storage full or unavailable: settings simply won't persist */
      }
    },
    del(key) {
      try {
        G.localStorage && G.localStorage.removeItem('eegv:' + key);
      } catch (e) {}
    },
  };

  U.download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  U.el = (tag, attrs, ...children) => {
    const e = document.createElement(tag);
    if (attrs)
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'html') e.innerHTML = v;
        else e.setAttribute(k, v === true ? '' : v);
      }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  };

  U.escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* Binary search: largest i with arr[i] <= x (arr ascending), or -1. */
  U.bisectRight = (arr, x) => {
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };

  /* Size a canvas for crisp HiDPI rendering; returns the 2D context in CSS px units. */
  U.fitCanvas = (canvas, cssW, cssH) => {
    const dpr = G.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  };
})(typeof window !== 'undefined' ? window : globalThis);
