/* Application controller: state, file handling, montages, navigation,
 * keyboard/mouse bindings, events (annotations), dialogs and settings. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const U = EEG.util;
  const el = (...a) => U.el(...a);
  const $ = (s, r = document) => r.querySelector(s);

  const SENS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 5000];
  const TIMEBASES = [
    ['s:1', '1 s'], ['s:2', '2 s'], ['s:5', '5 s'], ['s:10', '10 s'], ['s:15', '15 s'], ['s:20', '20 s'], ['s:30', '30 s'], ['s:60', '1 min'], ['s:120', '2 min'], ['s:300', '5 min'],
    ['mm:15', '15 mm/s'], ['mm:30', '30 mm/s'], ['mm:60', '60 mm/s'],
  ];
  const HP = [0, 0.016, 0.03, 0.05, 0.1, 0.16, 0.3, 0.53, 1, 1.6, 2, 3, 5, 10];
  const LP = [0, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 100, 120];
  const SPEEDS = [1, 2, 5, 10, 20];
  const EVENT_TYPES = {
    spike: { label: 'Spike', color: '#e11d48' },
    sharp: { label: 'Sharp wave', color: '#ea580c' },
    seizure: { label: 'Seizure', color: '#9333ea' },
    artifact: { label: 'Artefact', color: '#64748b' },
    note: { label: 'Note', color: '#0284c7' },
    file: { label: 'Annotation', color: '#0d9488' },
  };

  const DEFAULTS = {
    theme: 'light',
    traceBg: 'theme',
    traceWidth: 'normal',
    sepGap: 0.6,
    clip: 0,
    minorGrid: true,
    timeMode: 'clock',
    pxPerCm: 37.8,
    wheelMode: 'page',
    wheelSpeed: 1,
    clickHighlight: true,
    filters: { hp: 0.53, lp: 70, notch: 0, mode: 'zerophase', hpOrder: 1, lpOrder: 2, notchHarmonics: false },
    sens: 70,
    timebase: 's:10',
    avgIncludeEars: false,
    anonymise: false,
    lastMontage: null,
    map: { kind: 'V', ref: 'avg', scale: 'window', fixed: 100, contours: true, labels: true, values: false, equator: true, cmap: 'rdbu', invert: false, step: 'auto', maxMaps: 12, halfWindow: 0.3, res: 160, includeEars: false },
    spline: { m: 4, lambda: 1e-5 },
    panelW: 400,
    panelOpen: true,
    panelSecs: { map: { open: true, w: 64 }, events: { open: true, w: 36 }, info: { open: false, w: 30 } },
    avgOpts: { align: 'gfp', search: 0.05, half: 1 },
    eventType: 'spike',
    playSpeed: 1,
  };

  const GROUP_COLORS = ['#2563eb', '#d97706', '#059669', '#db2777', '#7c3aed', '#0891b2', '#65a30d', '#b91c1c'];

  const deepMerge = (a, b) => {
    const o = Array.isArray(a) ? a.slice() : { ...a };
    for (const k in b) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], b[k]) : b[k];
    return o;
  };

  class App {
    constructor() {
      this.settings = deepMerge(DEFAULTS, U.store.get('settings', {}));
      this.src = null;
      this.view = { t0: 0, dur: 10 };
      this.lines = [];
      this.cursor = null;
      this.selection = null;
      this.hover = null;
      this.highlight = -1;
      this.bad = new Set();
      this.fileEvents = [];
      this.userEvents = [];
      this.groups = [];
      this.activeGroup = '';
      this.avg = null;
      this.lineOv = new Map();
      this.keys = { ctrl: false };
      this.selectedEvent = null;
      this.montages = [];
      this.montage = null;
      this.page = null;
      this.lineData = null;
      this._fetching = false;
      this._dirty = false;
      this._themeCache = null;
      this.playing = false;
    }

    /* ================= initialisation ================= */
    init() {
      this.applyTheme();
      this.traceView = new EEG.TraceView(this, $('#traces'));
      this.overview = new EEG.Overview(this, $('#overview'));
      this.mapPanel = new EEG.MapPanel(this, $('#tab-map'));
      this.buildToolbar();
      this.bindHeader();
      this.bindPanel();
      this.bindKeys();
      this.bindDrop();
      this.loadMontageLibrary();
      this.renderEmpty();
      this.updateChrome();
      G.addEventListener('beforeunload', () => this.saveSettings());
    }

    saveSettings() {
      // the short page used while viewing an average is not the user's preference
      U.store.set('settings', this.avg ? { ...this.settings, timebase: this.avg.stash.timebase } : this.settings);
    }

    theme() {
      if (this._themeCache) return this._themeCache;
      const cs = getComputedStyle(document.documentElement);
      const v = (n) => cs.getPropertyValue(n).trim();
      this._themeCache = {
        traceBg: v('--trace-bg'), trace: v('--trace'), grid: v('--grid'), gridMinor: v('--grid-minor'),
        text: v('--text'), text2: v('--text-2'), text3: v('--text-3'), border: v('--border'), panel: v('--panel'),
        accent: v('--accent'), accentSoft: v('--accent-soft'), accentSoft2: v('--accent-soft-2'), cursor: v('--cursor'),
        sel: v('--sel'), selEdge: v('--sel-edge'), hover: v('--hover-line'), track: v('--track'), butterfly: v('--butterfly'),
        font: v('--font'), mono: v('--mono'),
      };
      return this._themeCache;
    }
    applyTheme() {
      const s = this.settings;
      document.documentElement.dataset.theme = s.theme;
      document.documentElement.dataset.tracebg = s.traceBg;
      this._themeCache = null;
    }

    /* ================= montage library ================= */
    loadMontageLibrary() {
      const builtin = (EEG.builtinMontages || []).map((m) => ({ ...m, builtin: true }));
      const imported = U.store.get('importedMontages', []);
      this.library = [...builtin, ...imported.filter((m) => !builtin.some((b) => b.id === m.id))];
    }
    importMontageFiles(files) {
      let added = 0;
      const warn = [];
      const done = () => {
        if (added) {
          const imported = this.library.filter((m) => !m.builtin);
          U.store.set('importedMontages', imported);
          if (this.src) this.refreshMontageList();
          this.toast(`Imported ${added} montage${added > 1 ? 's' : ''}.` + (warn.length ? ' ' + warn.slice(0, 2).join('; ') : ''));
        } else this.toast(warn.length ? warn.slice(0, 3).join('; ') + '.' : 'No montages found in the selected file(s).');
      };
      let pending = files.length;
      for (const f of files) {
        f.text().then((txt) => {
          try {
            const r = EEG.montage.parseBQM(txt.replace(/^﻿/, ''), f.name);
            r.montages.forEach((m) => {
              const i = this.library.findIndex((x) => x.id === m.id);
              if (i >= 0 && this.library[i].builtin) {
                warn.push(`"${m.name}" is already built in`);
                return;
              }
              if (i >= 0) this.library[i] = m;
              else this.library.push(m);
              added++;
            });
            warn.push(...r.warnings);
          } catch (e) {
            warn.push(f.name + ': ' + e.message);
          }
          if (--pending === 0) done();
        });
      }
    }
    refreshMontageList() {
      const dept = this.library.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      const std = EEG.montage.standardMontages(this.src);
      this.montages = [...dept, ...std];
      const sel = this.ui.montage;
      sel.textContent = '';
      const groups = {};
      this.montages.forEach((m, i) => {
        const g = m.group || 'Montages';
        if (!groups[g]) {
          groups[g] = el('optgroup', { label: g });
          sel.append(groups[g]);
        }
        const r = EEG.montage.resolve(m, this.src);
        const usable = r.lines.some((l) => l.kind === 'line');
        const key = i < 10 ? ` (${(i + 1) % 10})` : '';
        groups[g].append(el('option', { value: m.id, disabled: !usable }, m.name + key));
      });
      if (this.montage) sel.value = this.montage.id;
    }
    pickDefaultMontage() {
      const ok = (m) => m && EEG.montage.resolve(m, this.src).lines.some((l) => l.kind === 'line');
      const last = this.montages.find((m) => m.id === this.settings.lastMontage);
      if (ok(last)) return last;
      const hasInf = this.src.dataSignals.some((s) => s.std === 'T9');
      const pref = this.montages.find((m) => m.group === 'USZ (BrainQuick)' && /längsreihe/i.test(m.name) && /temp/i.test(m.name) === hasInf);
      if (ok(pref)) return pref;
      return this.montages.find(ok);
    }
    setMontage(id) {
      const m = this.montages.find((x) => x.id === id);
      if (!m || !this.src) return;
      const r = EEG.montage.resolve(m, this.src);
      if (!r.lines.some((l) => l.kind === 'line')) {
        this.toast(`"${m.name}" has no channels available in this recording.`);
        return;
      }
      const hlLabel = this.highlight >= 0 && this.lines[this.highlight] ? this.lines[this.highlight].label : null;
      this.montage = m;
      r.lines.forEach((l) => {
        if (l.kind !== 'line') return;
        l.base = { gain: l.gain, filter: l.filter };
        this.applyOverride(l);
      });
      this.lines = r.lines;
      this.highlight = hlLabel ? r.lines.findIndex((l) => l.label === hlLabel) : -1;
      this.closePopover();
      this.settings.lastMontage = m.id;
      this.saveSettings();
      this.ui.montage.value = m.id;
      this._missingShown = this._missingShown || new Set();
      if (r.missing && !this._missingShown.has(m.id)) {
        this._missingShown.add(m.id);
        this.toast(`${m.name}: ${r.missing} line${r.missing > 1 ? 's' : ''} not available in this recording (skipped).`, 3500);
      }
      this.traceView.layout();
      this.requestData();
      this.updateStatus();
    }

    /* ================= file handling ================= */
    async openFile(file) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ext === 'bqm' || ext === 'xml') return this.importMontageFiles([file]);
      this.setBusy(`Opening ${file.name}…`);
      try {
        const src = await EEG.formats.open(file);
        this.closeFile();
        this.src = src;
        this.pipe = new EEG.pipeline.Pipeline(src);
        this.fingerprint = `${src.name}|${file.size}|${src.startMs}`;
        this.bad = new Set(U.store.get('bad:' + this.fingerprint, []));
        this.userEvents = U.store.get('ev:' + this.fingerprint, []);
        const gs = U.store.get('grp:' + this.fingerprint, { groups: [], active: '' });
        this.groups = gs.groups || [];
        this.activeGroup = this.groups.some((g) => g.id === gs.active) ? gs.active : '';
        this.fileEvents = [];
        this._missingShown = new Set();
        this.cursor = null;
        this.selection = null;
        this.view.t0 = 0;
        this.refreshMontageList();
        const m = this.pickDefaultMontage();
        this.renderEmpty();
        this.computeDur();
        this.updateChrome();
        this.setMontage(m.id);
        this.renderInfo();
        this.renderEvents();
        this.mapPanel.update();
        this.setBusy(null);
        // annotations in the background
        if (src.scanAnnotations && src.annotSignals && src.annotSignals.length) {
          src.scanAnnotations((p) => this.setStatusNote(`Reading annotations… ${Math.round(p * 100)} %`)).then((anns) => {
            if (this.src !== src) return;
            this.fileEvents = anns.map((a, i) => ({ id: 'f' + i, t: a.onset, dur: a.duration || 0, type: 'file', text: a.text, src: 'file' }));
            this.setStatusNote('');
            this.renderEvents();
            this.overview.draw();
            this.traceView.drawOverlay();
          });
        } else if (src.annotations && src.annotations.length) {
          this.fileEvents = src.annotations.map((a, i) => ({ id: 'f' + i, t: a.onset, dur: a.duration || 0, type: 'file', text: a.text, src: 'file' }));
          this.renderEvents();
        }
      } catch (e) {
        console.error(e);
        this.setBusy(null);
        this.toast('Could not open file: ' + e.message, 6000, 'error');
      }
    }
    closeFile() {
      this.stopPlay();
      this.closePopover();
      if (this.avg) {
        this.settings.timebase = this.avg.stash.timebase;
        this.avg = null;
        this.renderAvgBanner();
      }
      this.src = null;
      this.page = null;
      this.lineData = null;
      this.mapWin = null;
    }
    fileStem() {
      return this.src ? this.src.name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 40) : 'eeg';
    }

    /* ================= time & formatting ================= */
    /* Clock time in the current view; inside an average: time from the alignment point. */
    fmtClock(t, ms = false) {
      if (this.avg) return U.fmtRel(t - this.avg.tZero);
      return U.fmtClock(this.src ? this.src.startMs : 0, t, ms);
    }
    fmtTime(t, ms = false) {
      if (this.avg) return U.fmtRel(t - this.avg.tZero);
      return this.settings.timeMode === 'elapsed' ? U.fmtElapsed(t, ms) : this.fmtClock(t, ms);
    }
    /* Clock time of the recording (also while an average is shown). */
    fmtRecClock(t, ms = false) {
      const s = this.recSrc();
      return U.fmtClock(s ? s.startMs : 0, t, ms);
    }
    recSrc() {
      return this.avg ? this.avg.stash.src : this.src;
    }
    computeDur() {
      const tb = this.settings.timebase;
      const [kind, val] = tb.split(':');
      let d = parseFloat(val);
      if (kind === 'mm') d = this.traceView.W / (this.settings.pxPerCm * (parseFloat(val) / 10));
      this.view.dur = U.clamp(d, 0.5, 3600);
    }
    clampT0(t0) {
      if (!this.src) return 0;
      return U.clamp(t0, 0, Math.max(0, this.src.duration - this.view.dur));
    }
    goTo(t0) {
      const n = this.clampT0(t0);
      if (n === this.view.t0) return;
      this.view.t0 = n;
      this.onViewChange();
    }
    scrollBy(ds) {
      this.goTo(this.view.t0 + ds);
    }
    page_(dir) {
      this.goTo(this.view.t0 + dir * this.view.dur);
    }
    centerOn(t) {
      this.goTo(t - this.view.dur / 2);
    }
    ensureVisible(t) {
      const v = this.view;
      if (t < v.t0 || t > v.t0 + v.dur) this.centerOn(t);
    }
    onViewChange() {
      this.traceView.drawRuler();
      this.traceView.drawOverlay();
      this.overview.draw();
      this.updatePosition();
      this.requestData();
    }
    onResize() {
      this.traceView.measure();
      this.computeDur();
      this.view.t0 = this.clampT0(this.view.t0);
      this.requestData();
      this.overview.draw();
      if (this.mapPanel.data) this.mapPanel.draw();
    }

    /* ================= filters / sensitivity ================= */
    filterSpec() {
      return { ...this.settings.filters };
    }
    lineSpec(line) {
      const m = this.settings.filters;
      const f = line.filter || {};
      return { ...m, hp: f.hp != null ? f.hp : m.hp, lp: f.lp != null ? f.lp : m.lp, notch: f.notch != null ? f.notch : m.notch };
    }
    get sens() {
      return this.settings.sens;
    }
    stepSens(dir) {
      let i = SENS.indexOf(this.settings.sens);
      if (i < 0) i = SENS.findIndex((v) => v >= this.settings.sens);
      i = U.clamp(i + dir, 0, SENS.length - 1);
      this.setSens(SENS[i]);
    }
    setSens(v) {
      this.settings.sens = v;
      this.ui.sens.value = String(v);
      this.saveSettings();
      this.scheduleDraw();
      this.updateStatus();
    }
    stepTimebase(dir) {
      const opts = TIMEBASES.filter(([k]) => k.startsWith('s:'));
      let i = opts.findIndex(([k]) => k === this.settings.timebase);
      if (i < 0) i = opts.findIndex(([k]) => parseFloat(k.slice(2)) >= this.view.dur);
      i = U.clamp(i + dir, 0, opts.length - 1);
      this.setTimebase(opts[i][0]);
    }
    setTimebase(tb) {
      const c = this.cursor;
      this.settings.timebase = tb;
      this.ui.timebase.value = tb;
      this.saveSettings();
      const mid = c != null && c >= this.view.t0 && c <= this.view.t0 + this.view.dur ? c : this.view.t0 + this.view.dur / 2;
      this.computeDur();
      this.view.t0 = this.clampT0(mid - this.view.dur / 2);
      this.onViewChange();
    }
    setFilter(patch) {
      Object.assign(this.settings.filters, patch);
      this.saveSettings();
      this.syncToolbar();
      this.mapWin = null;
      this.requestData();
      this.mapPanel.update();
      this.updateStatus();
    }

    /* ================= derived data ================= */
    eegIdx() {
      return this.src.dataSignals.filter((s) => s.kind === 'eeg').map((s) => s.index);
    }
    avgIdx() {
      const ears = this.settings.avgIncludeEars;
      return this.eegIdx().filter((i) => !this.bad.has(i) && (ears || !EEG.positions.OFF_SCALP.has(this.src.signals[i].std)));
    }
    mapElectrodes() {
      const o = this.settings.map;
      const used = [],
        excluded = [];
      for (const s of this.src.dataSignals) {
        if (s.kind !== 'eeg') continue;
        const pos = EEG.positions.position(s.std);
        if (!pos) continue;
        const off = EEG.positions.OFF_SCALP.has(s.std) && !o.includeEars;
        if (this.bad.has(s.index)) excluded.push({ label: s.std, pos, why: 'excluded', idx: s.index });
        else if (off) excluded.push({ label: s.std, pos, why: 'off-scalp', idx: s.index });
        else used.push({ label: s.std, pos, idx: s.index });
      }
      return { used, excluded };
    }
    dataKey() {
      const f = this.settings.filters,
        o = this.settings.map;
      return [this.avg ? this.avg.id : 'rec', f.hp, f.lp, f.notch, f.mode, f.hpOrder, f.lpOrder, f.notchHarmonics, [...this.bad].sort().join('.'), o.includeEars, o.kind, o.ref, o.res, this.settings.spline.m, this.settings.spline.lambda].join('|');
    }
    lineIsBad(l) {
      return l.kind === 'line' && (this.bad.has(l.plus) || (l.minusKind === 'ch' && this.bad.has(l.minus)));
    }

    requestData() {
      if (!this.src) return;
      if (this._fetching) {
        this._dirty = true;
        return;
      }
      this._fetching = true;
      this._dirty = false;
      const v = { ...this.view };
      const spec = this.filterSpec();
      const extra = this.lines.filter((l) => l.filter).map((l) => this.lineSpec(l));
      const lines = this.lines;
      const key = this.dataKey();
      this.pipe
        .window(v.t0, v.t0 + v.dur, spec, extra)
        .then((win) => {
          win.key = key;
          const avgIdx = this.avgIdx();
          const cand = avgIdx;
          const lapW = EEG.montage.hjorthWeights(this.src, this.eegIdx(), cand);
          const ctx = { avgIdx, lapW, lineSpec: (l) => this.lineSpec(l) };
          const data = lines.map((l) => (l.kind === 'sep' ? null : win.derive(l, ctx)));
          if (lines === this.lines) {
            this.page = win;
            this.lineData = data;
            this.scheduleDraw();
            this.updateHoverReadout();
          }
        })
        .catch((e) => {
          console.error(e);
          this.toast('Read error: ' + e.message, 5000, 'error');
        })
        .finally(() => {
          this._fetching = false;
          if (this._dirty) this.requestData();
        });
    }
    scheduleDraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this.traceView.draw();
      });
    }
    async getMapWindow(a, b) {
      const key = this.dataKey();
      const covers = (w) => w && w.key === key && w.t0 <= a + 1e-9 && b <= w.t1 - 1 / w.fs + 1e-9;
      if (covers(this.page)) return this.page;
      if (covers(this.mapWin)) return this.mapWin;
      const w = await this.pipe.window(a - 0.5, b + 0.5, this.filterSpec());
      w.key = key;
      this.mapWin = w;
      return w;
    }

    /* ================= cursor / selection / hover ================= */
    setCursor(t, opts = {}) {
      if (!this.src || t == null) return;
      const fs = this.src.fs;
      t = U.clamp(Math.round(t * fs) / fs, 0, this.src.duration - 1 / fs);
      this.cursor = t;
      this.traceView.drawOverlay();
      this.traceView.drawRuler();
      if (!opts.live) this.overview.draw();
      this.updateStatus();
      if (this.settings.panelOpen) this._mapUpdate(opts.live);
    }
    _mapUpdate(live) {
      if (live) {
        if (this._mapRaf) return;
        this._mapRaf = requestAnimationFrame(() => {
          this._mapRaf = 0;
          this.mapPanel.update();
        });
      } else this.mapPanel.update();
    }
    stepCursor(n) {
      if (!this.src) return;
      if (this.cursor == null) this.cursor = this.view.t0 + this.view.dur / 2;
      const t = this.cursor + n / this.src.fs;
      this.ensureVisible(t);
      this.setCursor(t);
    }
    setSelection(t0, t1, opts = {}) {
      if (!this.src) return;
      t0 = U.clamp(t0, 0, this.src.duration);
      t1 = U.clamp(t1, 0, this.src.duration);
      this.selection = { t0, t1 };
      this.traceView.drawOverlay();
    }
    async finishSelection() {
      const s = this.selection;
      if (!s || s.t1 - s.t0 < 4 / this.src.fs) {
        this.selection = null;
        this.traceView.drawOverlay();
        return;
      }
      if (s.t1 - s.t0 > 10) {
        this.selection = { t0: s.t0, t1: s.t0 + 10 };
        this.toast('Map windows are limited to 10 s.');
      }
      if (this.cursor == null || this.cursor < s.t0 || this.cursor > s.t1) this.cursor = (s.t0 + s.t1) / 2;
      if (!this.settings.panelOpen) this.togglePanel(true);
      this.openSection('map');
      await this.mapPanel.update();
      this.jumpToPeak('gfp');
    }
    clearSelection() {
      if (!this.selection) return;
      this.selection = null;
      this.traceView.drawOverlay();
      this.mapPanel.update();
    }
    setHover(h) {
      this.hover = h;
      this.traceView.drawOverlay();
      if ((h ? h.line : -1) !== this._hoverLine) {
        this._hoverLine = h ? h.line : -1;
      }
      this.updateHoverReadout();
    }
    setHighlight(i) {
      if (i === this.highlight) return;
      this.highlight = i;
      this.traceView.setHighlight(i);
      this.scheduleDraw();
      if (this.mapPanel.data) this.mapPanel.drawMain();
      if (this._pop) this._pop.render();
    }
    /* Signal indices of the electrodes in the highlighted trace (ringed on the map). */
    highlightElectrodes() {
      return new Set(this.highlight >= 0 ? this.electrodesOfLine(this.highlight) : []);
    }
    snapToPeak(li, t) {
      const win = this.page,
        d = this.lineData && this.lineData[li];
      if (!win || !d) return this.setCursor(t);
      const k0 = win.index(t),
        w = Math.round(0.05 * win.fs);
      const a = U.clamp(k0 - w, 0, d.length - 1),
        b = U.clamp(k0 + w, 0, d.length - 1);
      let mean = 0;
      for (let k = a; k <= b; k++) mean += d[k];
      mean /= b - a + 1;
      let best = k0,
        bv = -1;
      for (let k = a; k <= b; k++) {
        const v = Math.abs(d[k] - mean);
        if (v > bv) {
          bv = v;
          best = k;
        }
      }
      this.setCursor(win.time(best));
    }
    jumpToPeak(kind) {
      const d = this.mapPanel.data;
      if (!d) return;
      let ka = 0,
        kb = d.n - 1;
      if (!d.sel && this.cursor != null) {
        const kc = this.mapPanel.kAt(this.cursor),
          w = Math.round(0.1 * d.fs);
        ka = Math.max(0, kc - w);
        kb = Math.min(d.n - 1, kc + w);
      }
      let best = ka,
        bv = -Infinity;
      for (let k = ka; k <= kb; k++) {
        let v;
        if (kind === 'gfp') v = d.gfp[k];
        else {
          v = -Infinity;
          for (let e = 0; e < d.E; e++) v = Math.max(v, kind === 'neg' ? -d.ev[k * d.E + e] : d.ev[k * d.E + e]);
        }
        if (v > bv) {
          bv = v;
          best = k;
        }
      }
      this.setCursor(d.t0 + best / d.fs);
    }

    /* ================= bad channels ================= */
    toggleBad(idx, on) {
      if (on == null) on = !this.bad.has(idx);
      if (on) this.bad.add(idx);
      else this.bad.delete(idx);
      U.store.set('bad:' + this.fingerprint, [...this.bad]);
      this.mapWin = null;
      this.traceView.renderLabels();
      this.requestData();
      this.mapPanel.update();
      const s = this.src.signals[idx];
      this.toast(`${s.std || s.label} ${on ? 'excluded from maps and average reference' : 'included again'}.`);
    }

    /* ================= events ================= */
    allEvents() {
      if (this.avg) return [{ id: 'avg0', t: this.avg.tZero, dur: 0, type: 'note', text: '0 ms · alignment', src: 'avg' }];
      return [...this.fileEvents, ...this.userEvents];
    }
    eventsInView() {
      const v = this.view;
      return this.allEvents().filter((e) => e.t + (e.dur || 0) >= v.t0 && e.t <= v.t0 + v.dur);
    }
    groupById(id) {
      return id ? this.groups.find((g) => g.id === id) : null;
    }
    eventColor(ev) {
      const g = this.groupById(ev.group);
      return g ? g.color : (EVENT_TYPES[ev.type] || EVENT_TYPES.note).color;
    }
    eventLabel(ev) {
      const base = ev.text || (EVENT_TYPES[ev.type] || {}).label || '';
      const g = this.groupById(ev.group);
      return g ? `${base} · ${g.name}` : base;
    }
    saveEvents() {
      U.store.set('ev:' + this.fingerprint, this.userEvents);
    }
    saveGroups() {
      U.store.set('grp:' + this.fingerprint, { groups: this.groups, active: this.activeGroup });
    }
    redrawEvents() {
      this.traceView.drawRuler();
      this.traceView.drawOverlay();
      this.overview.draw();
    }
    _notInAverage(what) {
      if (!this.avg) return false;
      this.toast(`${what} is not available in the average view. Press A or “Back to recording” first.`, 3500);
      return true;
    }
    addEvent(t, type) {
      if (!this.src || this._notInAverage('Marking events')) return;
      if (t == null) t = this.cursor != null ? this.cursor : this.hover && this.hover.t != null ? this.hover.t : this.view.t0 + this.view.dur / 2;
      type = type || this.settings.eventType;
      const ev = { id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), t: Math.round(t * this.src.fs) / this.src.fs, dur: 0, type, text: '', src: 'user', group: this.activeGroup || '' };
      this.userEvents.push(ev);
      this.userEvents.sort((a, b) => a.t - b.t);
      this.saveEvents();
      this.selectedEvent = ev.id;
      this.renderEvents();
      this.redrawEvents();
      const g = this.groupById(ev.group);
      const n = g ? this.userEvents.filter((e) => e.group === g.id).length : 0;
      this.toast(`${EVENT_TYPES[type].label} marked at ${this.fmtClock(ev.t, true)}` + (g ? ` · ${g.name} (${n} event${n > 1 ? 's' : ''})` : '') + '.');
    }
    deleteEvent(id) {
      const i = this.userEvents.findIndex((e) => e.id === id);
      if (i < 0) return;
      this.userEvents.splice(i, 1);
      this.saveEvents();
      if (this.selectedEvent === id) this.selectedEvent = null;
      this.renderEvents();
      this.redrawEvents();
    }
    gotoEvent(ev) {
      if (ev.src === 'avg') return;
      if (this.avg) this.exitAverage();
      this.selectedEvent = ev.id;
      this.centerOn(ev.t);
      this.setCursor(ev.t);
      this.renderEvents();
    }
    nextEvent(dir) {
      if (this.avg) return;
      const evs = this.allEvents().sort((a, b) => a.t - b.t);
      if (!evs.length) return;
      const ref = this.cursor != null ? this.cursor : this.view.t0 + this.view.dur / 2;
      const ev = dir > 0 ? evs.find((e) => e.t > ref + 1e-6) : evs.filter((e) => e.t < ref - 1e-6).pop();
      if (ev) this.gotoEvent(ev);
    }
    exportEventsCSV() {
      const rows = [['onset_clock', 'onset_s', 'duration_s', 'type', 'group', 'text', 'source']];
      [...this.fileEvents, ...this.userEvents]
        .sort((a, b) => a.t - b.t)
        .forEach((e) => rows.push([this.fmtRecClock(e.t, true), e.t.toFixed(4), (e.dur || 0).toFixed(3), (EVENT_TYPES[e.type] || {}).label || e.type, (this.groupById(e.group) || {}).name || '', e.text || '', e.src]));
      const csv = rows.map((r) => r.map((c) => (/[",\n;]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(',')).join('\n');
      U.download(new Blob(['﻿' + csv], { type: 'text/csv' }), `events_${this.fileStem()}.csv`);
    }

    /* ================= groups & averaging ================= */
    newGroup() {
      let k = this.groups.length + 1;
      while (this.groups.some((g) => g.name === `Group ${k}`)) k++;
      const used = new Set(this.groups.map((g) => g.color));
      const g = { id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), name: `Group ${k}`, color: GROUP_COLORS.find((c) => !used.has(c)) || GROUP_COLORS[this.groups.length % GROUP_COLORS.length] };
      this.groups.push(g);
      this.activeGroup = g.id;
      this.saveGroups();
      this.renderEvents();
      this.toast(`${g.name} created. New events (E / double-click) are now added to it.`, 3200);
      return g;
    }
    deleteGroup(id) {
      const g = this.groupById(id);
      if (!g) return;
      this.groups = this.groups.filter((x) => x.id !== id);
      this.userEvents.forEach((e) => e.group === id && (e.group = ''));
      if (this.activeGroup === id) this.activeGroup = '';
      this.saveGroups();
      this.saveEvents();
      this.renderEvents();
      this.redrawEvents();
      this.toast(`${g.name} deleted; its events were kept without a group.`);
    }
    setActiveGroup(id) {
      this.activeGroup = id;
      this.saveGroups();
      this.renderEvents();
    }
    setAvgOpt(patch) {
      Object.assign(this.settings.avgOpts, patch);
      this.saveSettings();
    }
    alignText(meta) {
      const w = `±${Math.round(meta.search * 1000)} ms`;
      if (meta.align === 'gfp') return `aligned to GFP peak (${w})`;
      if (meta.align === 'neg') return `aligned to negative peak of ${meta.lineLabel} (${w})`;
      if (meta.align === 'pos') return `aligned to positive peak of ${meta.lineLabel} (${w})`;
      return 'aligned as marked';
    }
    avgTitle() {
      const a = this.avg;
      return a ? `Average of ${a.n} event${a.n > 1 ? 's' : ''} · ${a.name}` : '';
    }
    /* Average the events of a group and show the result in place of the recording. */
    async averageGroup(gid) {
      if (this._averaging) return;
      if (this.avg) this.exitAverage();
      const g = this.groupById(gid);
      if (!g || !this.src) return;
      const evs = this.userEvents.filter((e) => e.group === gid).sort((a, b) => a.t - b.t);
      if (!evs.length) return this.toast(`${g.name} has no events yet. Mark potentials with E or a double-click while the group is selected.`, 4000);
      const ao = this.settings.avgOpts;
      let line = null;
      if (ao.align === 'neg' || ao.align === 'pos') {
        line = this.lines[this.highlight];
        if (!line || line.kind !== 'line') return this.toast('Click on the trace to align on first (it becomes highlighted), or choose another alignment.', 4500);
      }
      this._averaging = true;
      this.setBusy(`Averaging ${evs.length} event${evs.length > 1 ? 's' : ''}…`);
      try {
        const avgIdx = this.avgIdx();
        const ctx = { avgIdx, lapW: EEG.montage.hjorthWeights(this.src, this.eegIdx(), avgIdx), lineSpec: (l) => this.lineSpec(l) };
        const res = await EEG.average.computeAverage({
          src: this.src, pipe: this.pipe, spec: this.filterSpec(), times: evs.map((e) => e.t), half: ao.half, align: ao.align, search: ao.search,
          gfpIdx: this.mapElectrodes().used.map((u) => u.idx), line, ctx,
          meta: { gid, name: g.name, color: g.color, align: ao.align, search: ao.search, lineLabel: line && line.label },
        });
        if (!res.source) {
          this.toast('None of the events could be averaged (' + (res.skipped[0] ? res.skipped[0].why : 'no data') + ').', 5000, 'error');
          return;
        }
        this.enterAverage(res.source, g);
        if (res.skipped.length) this.toast(`${res.skipped.length} event${res.skipped.length > 1 ? 's' : ''} skipped (${res.skipped[0].why}).`, 4500);
      } catch (e) {
        console.error(e);
        this.toast('Averaging failed: ' + e.message, 6000, 'error');
      } finally {
        this._averaging = false;
        this.setBusy(null);
      }
    }
    enterAverage(source, g) {
      this.stopPlay();
      this.closePopover();
      const stash = { src: this.src, pipe: this.pipe, view: { ...this.view }, cursor: this.cursor, selection: this.selection, timebase: this.settings.timebase };
      this.avg = { id: 'avg' + Date.now().toString(36), gid: g.id, name: g.name, color: g.color, n: source.meta.n, meta: source.meta, tZero: source.tZero, stash };
      this.src = source;
      this.pipe = new EEG.pipeline.Pipeline(source);
      this._resetData();
      this.settings.timebase = source.meta.half >= 2 ? 's:5' : 's:2';
      this.ui.timebase.value = this.settings.timebase;
      this.computeDur();
      this.view.t0 = this.clampT0(source.tZero - this.view.dur / 2);
      this.selection = { t0: source.tZero - 0.1, t1: source.tZero + 0.1 };
      this.cursor = source.tZero;
      this._afterSourceSwitch();
      if (!this.settings.panelOpen) this.togglePanel(true);
      this.openSection('map');
    }
    exitAverage() {
      if (!this.avg) return;
      const st = this.avg.stash;
      this.avg = null;
      this.src = st.src;
      this.pipe = st.pipe;
      this._resetData();
      this.settings.timebase = st.timebase;
      this.ui.timebase.value = st.timebase;
      this.computeDur();
      this.view.t0 = this.clampT0(st.view.t0);
      this.cursor = st.cursor;
      this.selection = st.selection;
      this._afterSourceSwitch();
    }
    _resetData() {
      this.page = null;
      this.lineData = null;
      this.mapWin = null;
      this.mapPanel.data = null;
      this.mapPanel._range = null;
      this.hover = null;
    }
    _afterSourceSwitch() {
      this.renderAvgBanner();
      this.updateChrome();
      this.renderEvents();
      this.traceView.layout();
      this.onViewChange();
      this.mapPanel.update();
    }
    renderAvgBanner() {
      const b = $('#avg-banner');
      b.textContent = '';
      b.hidden = !this.avg;
      if (!this.avg) return;
      const a = this.avg,
        sk = a.meta.skipped || [];
      b.append(
        el('i', { class: 'grp-dot', style: { background: a.color } }),
        el('span', {}, el('b', {}, 'Average'), ` of ${a.n} event${a.n > 1 ? 's' : ''} · ${a.name}`),
        el('span', { class: 'muted', title: sk.map((x) => `${this.fmtRecClock(x.t, true)}: ${x.why}`).join('\n') }, `${this.alignText(a.meta)} · 0 ms = alignment point` + (sk.length ? ` · ${sk.length} skipped` : '')),
        el('button', { class: 'btn sm', title: 'Return to the recording (A)', onclick: () => this.exitAverage() }, '← Back to recording')
      );
    }

    /* Composite of label column, time ruler and traces at device resolution. */
    exportPagePNG() {
      const tv = this.traceView;
      const dpr = G.devicePixelRatio || 1;
      const th = this.theme();
      const labW = 96,
        head = 64,
        W = tv.W + labW,
        H = tv.H + 24 + head;
      const cv = document.createElement('canvas');
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      const ctx = cv.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.fillStyle = th.traceBg;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = th.text;
      ctx.font = '600 15px ' + th.font;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${this.exportIdentity()} · ${this.avg ? this.avgTitle() + ' · ' : ''}${this.fmtClock(this.view.t0)} – ${this.fmtClock(this.view.t0 + this.view.dur)}`, 12, 24);
      const f = this.settings.filters;
      ctx.font = '12px ' + th.font;
      ctx.fillStyle = th.text2;
      ctx.fillText(`${this.montage.name} · ${this.sens} µV/cm · HP ${f.hp || 'off'} Hz · LP ${f.lp || 'off'} Hz · notch ${f.notch || 'off'} · ${f.mode === 'causal' ? 'causal' : 'zero-phase'}`, 12, 46);
      ctx.drawImage(tv.ruler, labW, head, tv.W, 24);
      ctx.drawImage(tv.traces, labW, head + 24, tv.W, tv.H);
      ctx.drawImage(tv.overlay, labW, head + 24, tv.W, tv.H);
      ctx.font = '11px ' + th.mono;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      this.lines.forEach((l, i) => {
        if (l.kind === 'sep') return;
        ctx.fillStyle = l.color || th.text2;
        ctx.fillText(l.label, labW - 8, head + 24 + tv.yc[i]);
      });
      cv.toBlob((b) => U.download(b, `eeg-page_${this.fileStem()}_${this.fmtClock(this.view.t0).replace(/:/g, '-')}.png`));
    }

    /* ================= playback ================= */
    togglePlay() {
      this.playing ? this.stopPlay() : this.startPlay();
    }
    startPlay() {
      if (!this.src || this._notInAverage('Playback')) return;
      this.playing = true;
      this.ui.play.classList.add('on');
      this.ui.play.innerHTML = ICONS.pause;
      let last = performance.now();
      const step = (now) => {
        if (!this.playing) return;
        const dt = (now - last) / 1000;
        last = now;
        const t0 = this.view.t0 + dt * this.settings.playSpeed;
        if (t0 >= this.src.duration - this.view.dur) {
          this.goTo(t0);
          return this.stopPlay();
        }
        this.view.t0 = t0;
        this.onViewChange();
        this._playRaf = requestAnimationFrame(step);
      };
      this._playRaf = requestAnimationFrame(step);
    }
    stopPlay() {
      this.playing = false;
      cancelAnimationFrame(this._playRaf);
      if (this.ui) {
        this.ui.play.classList.remove('on');
        this.ui.play.innerHTML = ICONS.play;
      }
    }

    /* ================= UI: toolbar ================= */
    buildToolbar() {
      const ui = (this.ui = {});
      const opt = (v, l) => el('option', { value: String(v) }, l);
      ui.montage = $('#sel-montage');
      ui.montage.addEventListener('change', (e) => {
        this.setMontage(e.target.value);
        e.target.blur();
      });
      ui.sens = $('#sel-sens');
      SENS.forEach((v) => ui.sens.append(opt(v, `${v} µV/cm`)));
      ui.sens.addEventListener('change', (e) => {
        this.setSens(parseFloat(e.target.value));
        e.target.blur();
      });
      $('#btn-sens-up').addEventListener('click', () => this.stepSens(-1));
      $('#btn-sens-down').addEventListener('click', () => this.stepSens(1));
      ui.timebase = $('#sel-timebase');
      const g1 = el('optgroup', { label: 'Page duration' }),
        g2 = el('optgroup', { label: 'Paper speed (calibrated)' });
      TIMEBASES.forEach(([k, l]) => (k.startsWith('s:') ? g1 : g2).append(opt(k, l)));
      ui.timebase.append(g1, g2);
      ui.timebase.addEventListener('change', (e) => {
        this.setTimebase(e.target.value);
        e.target.blur();
      });
      ui.hp = $('#sel-hp');
      HP.forEach((v) => ui.hp.append(opt(v, v ? `${v} Hz` + (v === 0.53 ? ' (TC 0.3 s)' : v === 0.16 ? ' (TC 1 s)' : '') : 'Off')));
      ui.hp.addEventListener('change', (e) => {
        this.setFilter({ hp: parseFloat(e.target.value) });
        e.target.blur();
      });
      ui.lp = $('#sel-lp');
      LP.forEach((v) => ui.lp.append(opt(v, v ? `${v} Hz` : 'Off')));
      ui.lp.addEventListener('change', (e) => {
        this.setFilter({ lp: parseFloat(e.target.value) });
        e.target.blur();
      });
      ui.notch = $('#sel-notch');
      [0, 50, 60].forEach((v) => ui.notch.append(opt(v, v ? `${v} Hz` : 'Off')));
      ui.notch.addEventListener('change', (e) => {
        this.setFilter({ notch: parseFloat(e.target.value) });
        e.target.blur();
      });
      ui.play = $('#btn-play');
      ui.play.innerHTML = ICONS.play;
      ui.play.addEventListener('click', () => this.togglePlay());
      ui.speed = $('#sel-speed');
      SPEEDS.forEach((v) => ui.speed.append(opt(v, `${v}×`)));
      ui.speed.addEventListener('change', (e) => {
        this.settings.playSpeed = parseFloat(e.target.value);
        this.saveSettings();
        e.target.blur();
      });
      ui.mapBtn = $('#btn-map');
      ui.mapBtn.addEventListener('click', () => this.togglePanel());
      this.syncToolbar();
    }
    syncToolbar() {
      const s = this.settings,
        ui = this.ui;
      const setSel = (sel, v, list) => {
        if (![...sel.options].some((o) => o.value === String(v))) {
          sel.append(el('option', { value: String(v) }, String(v)));
        }
        sel.value = String(v);
      };
      setSel(ui.sens, s.sens);
      ui.timebase.value = s.timebase;
      setSel(ui.hp, s.filters.hp);
      setSel(ui.lp, s.filters.lp);
      ui.notch.value = String(s.filters.notch);
      ui.speed.value = String(s.playSpeed);
      ui.mapBtn.classList.toggle('on', s.panelOpen);
    }

    bindHeader() {
      const fileIn = $('#file-input');
      $('#btn-open').addEventListener('click', () => fileIn.click());
      fileIn.addEventListener('change', () => {
        if (fileIn.files[0]) this.openFile(fileIn.files[0]);
        fileIn.value = '';
      });
      const monIn = $('#montage-input');
      monIn.addEventListener('change', () => {
        if (monIn.files.length) this.importMontageFiles([...monIn.files]);
        monIn.value = '';
      });
      $('#btn-import-montage').addEventListener('click', () => monIn.click());
      $('#btn-help').addEventListener('click', () => this.showHelp());
      $('#btn-settings').addEventListener('click', () => this.showSettings());
      $('#btn-theme').addEventListener('click', () => {
        this.settings.theme = this.settings.theme === 'dark' ? 'light' : 'dark';
        this.saveSettings();
        this.applyTheme();
        this.redrawAll();
      });
      $('#btn-anon').addEventListener('click', () => {
        this.settings.anonymise = !this.settings.anonymise;
        this.saveSettings();
        this.updateChrome();
      });
      $('#empty-open').addEventListener('click', () => fileIn.click());
    }
    redrawAll() {
      this._themeCache = null;
      this.traceView.renderLabels();
      this.traceView.draw();
      this.overview.draw();
      if (this.mapPanel.data) this.mapPanel.draw();
    }

    /* ================= side panel ================= */
    /* The panel stacks three collapsible sections (voltage map, events & groups,
     * recording); open sections share the height by weight, adjustable with the
     * splitters between them. */
    bindPanel() {
      const panel = $('#panel');
      panel.style.width = this.settings.panelW + 'px';
      panel.hidden = !this.settings.panelOpen;
      $('#panel-resize').hidden = !this.settings.panelOpen;
      this.secs = {};
      document.querySelectorAll('.psec').forEach((sec) => {
        const name = sec.dataset.sec;
        this.secs[name] = sec;
        sec.querySelector('.psec-toggle').addEventListener('click', () => this.toggleSection(name));
      });
      document.querySelectorAll('.psec-split').forEach((sp) => {
        const [a, b] = sp.dataset.between.split(',');
        sp.addEventListener('pointerdown', (e) => {
          const S = this.settings.panelSecs;
          if (!S[a].open || !S[b].open) return;
          sp.setPointerCapture(e.pointerId);
          sp.classList.add('drag');
          const y0 = e.clientY,
            ha = this.secs[a].getBoundingClientRect().height,
            hb = this.secs[b].getBoundingClientRect().height,
            wsum = S[a].w + S[b].w;
          const mv = (ev) => {
            const na = U.clamp(ha + ev.clientY - y0, 70, ha + hb - 70);
            S[a].w = (wsum * na) / (ha + hb);
            S[b].w = wsum - S[a].w;
            this.layoutSections();
          };
          const up = () => {
            sp.classList.remove('drag');
            sp.removeEventListener('pointermove', mv);
            sp.removeEventListener('pointerup', up);
            this.saveSettings();
          };
          sp.addEventListener('pointermove', mv);
          sp.addEventListener('pointerup', up);
        });
        sp.addEventListener('dblclick', () => {
          const S = this.settings.panelSecs;
          S[a].w = DEFAULTS.panelSecs[a].w;
          S[b].w = DEFAULTS.panelSecs[b].w;
          this.layoutSections();
          this.saveSettings();
        });
      });
      this.layoutSections();
      const rz = $('#panel-resize');
      rz.addEventListener('pointerdown', (e) => {
        rz.setPointerCapture(e.pointerId);
        const x0 = e.clientX,
          w0 = panel.getBoundingClientRect().width;
        const mv = (ev) => {
          const w = U.clamp(w0 - (ev.clientX - x0), 300, Math.min(760, G.innerWidth - 420));
          panel.style.width = w + 'px';
          this.settings.panelW = w;
        };
        const up = () => {
          rz.removeEventListener('pointermove', mv);
          rz.removeEventListener('pointerup', up);
          this.saveSettings();
          if (this.mapPanel.data) this.mapPanel.draw();
        };
        rz.addEventListener('pointermove', mv);
        rz.addEventListener('pointerup', up);
      });
    }
    layoutSections() {
      const S = this.settings.panelSecs;
      for (const n in this.secs) {
        const o = S[n] || { open: true, w: 30 };
        this.secs[n].classList.toggle('closed', !o.open);
        this.secs[n].style.flex = o.open ? `${o.w} 1 0px` : '';
      }
      document.querySelectorAll('.psec-split').forEach((sp) => {
        const [a, b] = sp.dataset.between.split(',');
        sp.hidden = !(S[a].open && S[b].open);
      });
    }
    toggleSection(name, on) {
      const o = this.settings.panelSecs[name];
      o.open = on == null ? !o.open : on;
      this.layoutSections();
      this.saveSettings();
      if (name === 'map' && o.open) requestAnimationFrame(() => this.mapPanel.update());
      if (name === 'info' && o.open) this.renderInfo();
    }
    openSection(name) {
      if (!this.settings.panelSecs[name].open) this.toggleSection(name, true);
    }
    /* kept for scripts written against the earlier tabbed panel */
    setTab(name) {
      if (!this.settings.panelOpen) this.togglePanel(true);
      this.openSection(name);
    }
    togglePanel(on) {
      const s = this.settings;
      s.panelOpen = on == null ? !s.panelOpen : on;
      $('#panel').hidden = !s.panelOpen;
      $('#panel-resize').hidden = !s.panelOpen;
      this.ui.mapBtn.classList.toggle('on', s.panelOpen);
      this.saveSettings();
      if (s.panelOpen) requestAnimationFrame(() => this.mapPanel.update());
    }

    groupSelect(val, on, size, title) {
      const x = el('select', { class: 'sel ' + size, title, onchange: (e) => {
        const v = e.target.value;
        if (v === '+new') on(this.newGroup().id);
        else on(v);
        e.target.blur();
      } }, el('option', { value: '' }, 'no group'), ...this.groups.map((g) => el('option', { value: g.id }, g.name)), el('option', { value: '+new' }, '+ new group…'));
      x.value = val || '';
      const g = this.groupById(val);
      if (g) x.style.borderLeft = `4px solid ${g.color}`;
      return x;
    }
    renderEvents() {
      const root = $('#tab-events');
      root.textContent = '';
      const cnt = $('#ev-count');
      if (!this.src) {
        cnt.textContent = '';
        return;
      }
      const evs = [...this.fileEvents, ...this.userEvents].sort((a, b) => a.t - b.t);
      cnt.textContent = evs.length ? `· ${evs.length}` : '';
      const tools = $('#ev-tools');
      tools.textContent = '';
      tools.append(el('button', { class: 'btn xs ghost', onclick: () => this.exportEventsCSV(), title: 'Export all events as CSV (with groups)' }, 'CSV'));
      const typeOpts = () => Object.entries(EVENT_TYPES).filter(([k]) => k !== 'file').map(([k, v]) => el('option', { value: k }, v.label));
      const typeSel = el('select', { class: 'sel sm', title: 'Type of new events (E key / double-click)', onchange: (e) => {
        this.settings.eventType = e.target.value;
        this.saveSettings();
        e.target.blur();
      } }, ...typeOpts());
      typeSel.value = this.settings.eventType;
      root.append(el('div', { class: 'ev-head' }, el('span', { class: 'muted' }, 'Mark'), typeSel, el('span', { class: 'muted' }, 'into'), this.groupSelect(this.activeGroup, (v) => this.setActiveGroup(v), 'sm', 'Group that new events (E / double-click) are added to'),
        el('button', { class: 'btn sm', title: 'Mark an event at the cursor (E)', onclick: () => this.addEvent() }, '+ At cursor')));
      // groups & averaging
      const box = el('div', { class: 'grp-box' }, el('div', { class: 'grp-title' }, el('span', { title: 'Average similar potentials and map the average' }, 'Groups · averaging'), el('button', { class: 'btn xs ghost', onclick: () => this.newGroup() }, '+ New group')));
      if (!this.groups.length) {
        box.append(el('p', { class: 'grp-hint' }, 'To average similar potentials: create a group, mark each potential into it (E or double-click while the group is selected above), then press ', el('b', {}, 'Average'), '. The averaged EEG opens in the trace view and can be mapped like any time point.'));
      }
      this.groups.forEach((g) => {
        const n = this.userEvents.filter((e) => e.group === g.id).length;
        const showing = this.avg && this.avg.gid === g.id;
        const name = el('input', { class: 'grp-name', value: g.name, title: 'Click to rename', onchange: (e) => {
          g.name = e.target.value.trim() || g.name;
          this.saveGroups();
          this.renderEvents();
          this.redrawEvents();
        }, onkeydown: (e) => e.key === 'Enter' && e.target.blur() });
        const avgBtn = el('button', { class: 'btn xs accent', disabled: !n, title: n ? `Average the ${n} event${n > 1 ? 's' : ''} of this group and show the averaged EEG and its voltage map` : 'No events in this group yet', onclick: () => (showing ? this.exitAverage() : this.averageGroup(g.id)) }, showing ? '← Back' : 'Average ▸');
        box.append(el('div', { class: 'grp-row' + (this.activeGroup === g.id ? ' active' : ''), title: this.activeGroup === g.id ? 'New events are added to this group' : '' },
          el('i', { class: 'grp-dot', style: { background: g.color } }), name, el('span', { class: 'grp-n' }, `${n} event${n === 1 ? '' : 's'}`), avgBtn,
          el('button', { class: 'icon-btn xs', title: 'Delete group (its events are kept, without a group)', html: ICONS.trash, onclick: () => this.deleteGroup(g.id) })));
      });
      if (this.groups.length) {
        const ao = this.settings.avgOpts;
        const sel = (val, opts, on, title) => {
          const x = el('select', { class: 'sel xs', title, onchange: (e) => on(e.target.value) }, ...opts.map(([v, l]) => el('option', { value: String(v) }, l)));
          x.value = String(val);
          return x;
        };
        box.append(el('div', { class: 'grp-opts' }, 'Align',
          sel(ao.align, [['gfp', 'GFP peak'], ['neg', 'neg. peak of highlighted trace'], ['pos', 'pos. peak of highlighted trace'], ['mark', 'as marked']], (v) => this.setAvgOpt({ align: v }), 'Each mark is moved to this feature before averaging, which removes the timing jitter of marking by eye'),
          sel(ao.search, [[0.02, '±20 ms'], [0.05, '±50 ms'], [0.1, '±100 ms']], (v) => this.setAvgOpt({ search: parseFloat(v) }), 'Search window around each mark'),
          'epoch', sel(ao.half, [[0.5, '±0.5 s'], [1, '±1 s'], [2, '±2 s']], (v) => this.setAvgOpt({ half: parseFloat(v) }), 'Displayed length of the average around the alignment point')));
      }
      root.append(box);
      if (!evs.length) {
        root.append(el('div', { class: 'ev-empty' }, 'No events yet. Press ', el('kbd', {}, 'E'), ' or double-click the EEG to mark a time point. Events are kept in this browser for this recording.'));
        return;
      }
      const list = el('div', { class: 'ev-list' });
      for (const ev of evs) {
        const on = this.selectedEvent === ev.id;
        const row = el('div', { class: 'ev-row' + (on ? ' on' : ''), 'data-id': ev.id, onclick: (e) => {
          if (e.target.closest('input,select,button')) return;
          this.gotoEvent(ev);
        } });
        row.append(el('i', { class: 'ev-dot', style: { background: this.eventColor(ev) } }), el('span', { class: 'ev-time', title: U.fmtElapsed(ev.t, true) + ' elapsed' }, this.fmtRecClock(ev.t, true)));
        if (ev.src === 'user') {
          const ts = el('select', { class: 'sel xs', title: 'Event type', onchange: (e) => {
            ev.type = e.target.value;
            this.saveEvents();
            this.renderEvents();
            this.redrawEvents();
          } }, ...typeOpts());
          ts.value = ev.type;
          const gs = this.groupSelect(ev.group, (v) => {
            ev.group = v;
            this.saveEvents();
            this.renderEvents();
            this.redrawEvents();
          }, 'xs', 'Group of this event');
          row.append(ts, gs, el('button', { class: 'icon-btn xs', title: 'Delete event (Del)', onclick: () => this.deleteEvent(ev.id), html: ICONS.trash }));
          if (on || ev.text) {
            row.append(el('input', { class: 'txt xs ev-comment', placeholder: 'Comment…', value: ev.text || '', onchange: (e) => {
              ev.text = e.target.value;
              this.saveEvents();
              this.redrawEvents();
            }, onkeydown: (e) => e.key === 'Enter' && e.target.blur() }));
          }
        } else {
          row.append(el('span', { class: 'ev-file' }, ev.text));
        }
        list.append(row);
      }
      root.append(list, el('div', { class: 'ev-foot muted' }, 'N / Shift+N: next / previous · Del: delete selected · A: average the selected group'));
      const cur = list.querySelector('.ev-row.on');
      if (cur) requestAnimationFrame(() => cur.scrollIntoView({ block: 'nearest' }));
    }

    renderInfo() {
      const root = $('#tab-info');
      root.textContent = '';
      const s = this.recSrc();
      if (!s) return;
      const anon = this.settings.anonymise;
      const kv = (k, v) => el('div', { class: 'kv' }, el('span', {}, k), el('b', {}, v || '–'));
      const p = s.patient || {};
      root.append(
        el('h4', {}, 'Recording'),
        kv('File', s.name),
        kv('Format', s.format),
        kv('Start', `${U.fmtDate(s.startMs)} ${this.fmtRecClock(0)}`),
        kv('Duration', U.fmtElapsed(s.duration)),
        kv('Sampling rate', `${s.fs} Hz`),
        kv('Channels', `${s.dataSignals.length} (${s.dataSignals.filter((x) => x.kind === 'eeg').length} EEG)`),
        el('h4', {}, 'Patient'),
        kv('Name', anon ? '•••' : p.name),
        kv('ID', anon ? '•••' : p.code),
        kv('Sex / birth date', anon ? '•••' : [p.sex, p.birthdate].filter(Boolean).join(' · ')),
        el('h4', {}, 'Channels')
      );
      const tbl = el('table', { class: 'ch-table' }, el('tr', {}, ...['#', 'Label', 'Type', 'Position', 'fs', 'Range', 'Excl.'].map((h) => el('th', {}, h))));
      s.dataSignals.forEach((c) => {
        const cb = el('input', { type: 'checkbox', title: 'Exclude from maps & average reference' });
        cb.checked = this.bad.has(c.index);
        cb.disabled = c.kind !== 'eeg';
        cb.addEventListener('change', () => this.toggleBad(c.index, cb.checked));
        tbl.append(el('tr', {}, el('td', {}, c.index + 1), el('td', {}, c.label), el('td', {}, c.kind), el('td', {}, c.std && EEG.positions.position(c.std) ? c.std : '–'), el('td', {}, c.fs), el('td', {}, `±${Math.round(Math.max(Math.abs(c.physMin), Math.abs(c.physMax)))} ${c.dim}`), el('td', {}, cb)));
      });
      root.append(el('div', { class: 'tbl-wrap' }, tbl));
    }

    /* ================= chrome: header & status ================= */
    updateChrome() {
      const s = this.recSrc();
      const fileChip = $('#file-chip');
      const anonBtn = $('#btn-anon');
      anonBtn.innerHTML = this.settings.anonymise ? ICONS.eyeOff : ICONS.eye;
      anonBtn.title = this.settings.anonymise ? 'Show patient details' : 'Hide patient details (anonymise screen and exports)';
      anonBtn.hidden = !s;
      document.body.classList.toggle('has-file', !!s);
      if (!s) {
        fileChip.innerHTML = '<span class="muted">No recording open</span>';
        return;
      }
      const p = s.patient || {};
      const who = this.settings.anonymise ? 'Anonymised' : p.name || s.name;
      const meta = [`${U.fmtDate(s.startMs)} ${this.fmtRecClock(0)}`, U.fmtElapsed(s.duration), `${s.fs} Hz`, s.format].join(' · ');
      fileChip.innerHTML = '';
      fileChip.append(el('b', {}, who), el('span', { class: 'muted' }, meta));
      fileChip.title = this.settings.anonymise ? s.format : s.name;
      document.title = (this.settings.anonymise ? 'EEG' : who) + ' · EEG Viewer';
      if ($('#tab-info').childElementCount) this.renderInfo();
      this.updateStatus();
    }
    exportIdentity() {
      const s = this.src,
        p = s.patient || {};
      const date = `${U.fmtDate(s.startMs)}`;
      return this.settings.anonymise ? `Recording of ${date}` : `${p.name || s.name}${p.birthdate ? ' (' + p.birthdate + ')' : ''} · recording ${date}`;
    }
    updatePosition() {
      if (!this.src) return;
      const v = this.view;
      const n = Math.max(1, Math.ceil(this.src.duration / v.dur));
      const pg = Math.min(n, Math.floor(v.t0 / v.dur + 1e-6) + 1);
      $('#st-pos').textContent = `${this.fmtTime(v.t0)} – ${this.fmtTime(v.t0 + v.dur)} · page ${pg}/${n}`;
    }
    updateStatus() {
      if (!this.src) return;
      const f = this.settings.filters;
      $('#st-cursor').textContent = this.cursor != null ? `Cursor ${this.fmtClock(this.cursor, true)}` : '';
      $('#st-info').textContent = `${this.montage ? this.montage.name : ''} · ${this.sens} µV/cm · ${f.mode === 'causal' ? 'causal' : 'zero-phase'} filters · ${this.bad.size ? this.bad.size + ' excluded' : 'all electrodes'}`;
      this.updatePosition();
    }
    updateHoverReadout() {
      const h = this.hover,
        out = $('#st-hover');
      if (!h || !this.page || !this.lineData) {
        out.textContent = '';
        return;
      }
      let txt = this.fmtTime(h.t, true);
      if (h.line >= 0 && this.lineData[h.line]) {
        const k = this.page.index(h.t);
        const v = this.lineData[h.line][k];
        const l = this.lines[h.line];
        if (v === v && v != null) txt = `${l.label}  ${(v > 0 ? '+' : '') + U.fmtNum(v, 1)} ${l.unit || 'µV'}  ·  ${txt}`;
      }
      if (this.cursor != null) txt += `  ·  Δ ${U.fmtMs(h.t - this.cursor)}`;
      out.textContent = txt;
    }
    setStatusNote(t) {
      $('#st-note').textContent = t;
    }
    setBusy(msg) {
      const b = $('#busy');
      b.hidden = !msg;
      if (msg) b.querySelector('span').textContent = msg;
    }
    renderEmpty() {
      $('#empty').hidden = !!this.src;
    }

    /* ================= toasts & menus & dialogs ================= */
    toast(msg, ms = 2600, kind = '') {
      const host = $('#toasts');
      const t = el('div', { class: 'toast ' + kind }, msg);
      host.append(t);
      while (host.childElementCount > 3) host.firstElementChild.remove();
      requestAnimationFrame(() => t.classList.add('in'));
      setTimeout(() => {
        t.classList.remove('in');
        setTimeout(() => t.remove(), 300);
      }, ms);
    }
    menu(x, y, items) {
      this.closeMenu();
      const m = el('div', { class: 'menu' });
      items.forEach((it) => {
        if (it === '-') return m.append(el('div', { class: 'menu-sep' }));
        if (it.header) return m.append(el('div', { class: 'menu-h' }, it.header));
        m.append(el('button', { class: 'menu-i' + (it.checked ? ' checked' : ''), disabled: it.disabled, onclick: () => {
          this.closeMenu();
          it.action();
        } }, el('span', {}, it.label), it.kbd ? el('kbd', {}, it.kbd) : null));
      });
      document.body.append(m);
      const r = m.getBoundingClientRect();
      m.style.left = Math.min(x, G.innerWidth - r.width - 8) + 'px';
      m.style.top = Math.min(y, G.innerHeight - r.height - 8) + 'px';
      this._menu = m;
      setTimeout(() => document.addEventListener('pointerdown', this._menuAway = (e) => !m.contains(e.target) && this.closeMenu()), 0);
    }
    closeMenu() {
      if (this._menu) {
        this._menu.remove();
        this._menu = null;
        document.removeEventListener('pointerdown', this._menuAway);
      }
    }
    electrodesOfLine(li) {
      const l = this.lines[li];
      if (!l || l.kind !== 'line') return [];
      const out = [l.plus];
      if (l.minusKind === 'ch') out.push(l.minus);
      return out.filter((i) => this.src.signals[i].kind === 'eeg');
    }
    labelContextMenu(x, y, li) {
      this.closePopover();
      const items = [{ header: this.lines[li].label }, { label: 'Gain & filters of this trace…', kbd: 'click', action: () => this.showTracePopover(li) }];
      this.electrodesOfLine(li).forEach((i) => {
        const s = this.src.signals[i];
        const on = this.bad.has(i);
        items.push({ label: `${on ? 'Include' : 'Exclude'} ${s.std} ${on ? 'again' : '(bad electrode)'}`, action: () => this.toggleBad(i, !on) });
      });
      items.push('-', { label: this.highlight === li ? 'Remove highlight' : 'Highlight trace', action: () => this.setHighlight(this.highlight === li ? -1 : li) });
      if (this.lineOv.size) items.push({ label: 'Reset all per-trace adjustments', action: () => this.resetLineOverrides() });
      this.menu(x, y, items);
    }

    /* ---------- per-trace gain & filters ---------- */
    lineKey(l) {
      return `${this.montage ? this.montage.id : ''}|${l.label}`;
    }
    /* Effective gain/filter of a line = montage defaults overlaid with the user's
     * per-trace adjustments (undefined = keep the montage default; null filter
     * value = linked to the global filter; 0 = off). */
    applyOverride(l) {
      const ov = this.lineOv.get(this.lineKey(l)) || {};
      const b = l.base || { gain: l.gain, filter: l.filter };
      const bf = b.filter || {};
      const pick = (k) => (ov[k] !== undefined ? ov[k] : bf[k] != null ? bf[k] : null);
      const f = { hp: pick('hp'), lp: pick('lp'), notch: pick('notch') };
      l.gain = ov.gain !== undefined ? ov.gain : b.gain;
      l.filter = f.hp == null && f.lp == null && f.notch == null ? null : f;
      l.mod = Object.keys(ov).length > 0;
    }
    setLineOverride(li, patch) {
      const l = this.lines[li];
      if (!l || l.kind !== 'line') return;
      const key = this.lineKey(l);
      if (patch === null) this.lineOv.delete(key);
      else {
        const ov = { ...(this.lineOv.get(key) || {}) };
        for (const k in patch) patch[k] === undefined ? delete ov[k] : (ov[k] = patch[k]);
        Object.keys(ov).length ? this.lineOv.set(key, ov) : this.lineOv.delete(key);
      }
      this.applyOverride(l);
      this.traceView.renderLabels();
      this.requestData();
      if (this._pop) this._pop.render();
    }
    resetLineOverrides() {
      this.lineOv.clear();
      this.lines.forEach((l) => l.kind === 'line' && this.applyOverride(l));
      this.traceView.renderLabels();
      this.requestData();
      if (this._pop) this._pop.render();
      this.toast('All per-trace adjustments removed.');
    }
    describeLine(l) {
      const name = (i) => {
        const s = this.src.signals[i];
        return s.std || s.parsed.name || s.label;
      };
      if (l.minusKind === 'ch') return `${name(l.plus)} minus ${name(l.minus)} (bipolar)`;
      if (l.minusKind === 'avg') return `${name(l.plus)} minus the common average`;
      if (l.minusKind === 'lap') return `${name(l.plus)} minus its 4 nearest neighbours (Hjorth)`;
      return `${name(l.plus)} against the recording reference`;
    }
    showTracePopover(li) {
      const l = this.lines[li];
      if (!l || l.kind !== 'line' || !this.src) return;
      if (this._pop && this._pop.li === li) return this.closePopover();
      this.closePopover();
      this.closeMenu();
      const pop = el('div', { class: 'pop', role: 'dialog' });
      const fmtHz = (v) => (v ? `${v} Hz` : 'off');
      const render = () => {
        const ov = this.lineOv.get(this.lineKey(l)) || {};
        const b = l.base || {},
          bf = b.filter || {},
          m = this.settings.filters;
        const dflt = (k) => (bf[k] != null ? `Montage default (${fmtHz(bf[k])})` : `Global (${fmtHz(m[k])})`);
        const sel = (k, list, lab) => {
          const x = el('select', { class: 'sel sm', onchange: (e) => this.setLineOverride(li, { [k]: e.target.value === '' ? undefined : parseFloat(e.target.value) }) },
            el('option', { value: '' }, dflt(k)), ...list.map((v) => el('option', { value: String(v) }, lab(v))));
          x.value = ov[k] !== undefined ? String(ov[k]) : '';
          return x;
        };
        const gainSel = el('select', { class: 'sel sm', onchange: (e) => this.setLineOverride(li, { gain: e.target.value === '' ? undefined : parseFloat(e.target.value) }) },
          el('option', { value: '' }, b.gain ? `Montage default (${b.gain} µV/cm)` : `Global (${this.sens} µV/cm)`), ...SENS.map((v) => el('option', { value: String(v) }, `${v} µV/cm`)));
        gainSel.value = ov.gain !== undefined ? String(ov.gain) : '';
        const stepGain = (dir) => {
          const g = l.gain || this.sens;
          let i = SENS.findIndex((v) => v >= g);
          if (i < 0) i = SENS.length - 1;
          this.setLineOverride(li, { gain: SENS[U.clamp(i + dir, 0, SENS.length - 1)] });
        };
        const row = (label, ctrl) => el('div', { class: 'pop-row' }, el('span', {}, label), ctrl);
        const hl = el('input', { type: 'checkbox', onchange: (e) => this.setHighlight(e.target.checked ? li : -1) });
        hl.checked = this.highlight === li;
        const btns = this.electrodesOfLine(li).map((i) => {
          const on = this.bad.has(i);
          return el('button', { class: 'btn xs', title: on ? 'Use this electrode again in maps and the average reference' : 'Leave this electrode out of maps and the average reference (bad electrode)', onclick: () => {
            this.toggleBad(i, !on);
            render();
          } }, `${on ? 'Include' : 'Exclude'} ${this.src.signals[i].std}`);
        });
        pop.textContent = '';
        pop.append(
          el('div', { class: 'pop-head' }, el('h4', {}, l.label), el('button', { class: 'icon-btn sm', title: 'Close (Esc)', html: ICONS.x, onclick: () => this.closePopover() })),
          el('div', { class: 'pop-sub' }, this.describeLine(l)),
          row('Gain', el('div', { class: 'stepper' }, el('button', { class: 'icon-btn sm', title: 'Smaller', onclick: () => stepGain(1) }, '−'), gainSel, el('button', { class: 'icon-btn sm', title: 'Larger', onclick: () => stepGain(-1) }, '+'))),
          row('High-pass', sel('hp', HP, (v) => (v ? `${v} Hz` : 'Off'))),
          row('Low-pass', sel('lp', LP, (v) => (v ? `${v} Hz` : 'Off'))),
          row('Notch', sel('notch', [0, 50, 60], (v) => (v ? `${v} Hz` : 'Off'))),
          el('label', { class: 'pop-check' }, hl, 'Highlight this trace (thicker line)'),
          el('div', { class: 'pop-btns' }, ...btns, el('span', { style: { flex: 1 } }), el('button', { class: 'btn xs ghost', disabled: !l.mod, onclick: () => this.setLineOverride(li, null) }, 'Reset this trace')),
          el('p', { class: 'pop-note' }, 'Changes apply to this trace only (in this montage, until the viewer is closed) and are marked with a dot next to its name. Voltage maps are not affected: they always use the global filters.')
        );
      };
      render();
      document.body.append(pop);
      const anchor = this.traceView.labelEl(li);
      const r = anchor ? anchor.getBoundingClientRect() : { right: 100, top: 120 };
      const h = pop.getBoundingClientRect().height;
      pop.style.left = Math.min(r.right + 8, G.innerWidth - 310) + 'px';
      pop.style.top = U.clamp(r.top - 24, 8, G.innerHeight - h - 8) + 'px';
      this._pop = { el: pop, li, render };
      this.traceView.renderLabels();
      setTimeout(() => document.addEventListener('pointerdown', (this._popAway = (e) => !pop.contains(e.target) && !e.target.closest('.tv-label') && !e.target.closest('.menu') && this.closePopover())), 0);
    }
    closePopover() {
      if (!this._pop) return false;
      this._pop.el.remove();
      this._pop = null;
      document.removeEventListener('pointerdown', this._popAway);
      if (this.traceView) this.traceView.labelList.querySelectorAll('.tv-label.open').forEach((d) => d.classList.remove('open'));
      return true;
    }
    traceContextMenu(x, y, t, li) {
      const g = this.groupById(this.activeGroup);
      const items = [
        { label: 'Map this time point', kbd: 'click', action: () => this.setCursor(t) },
        { label: `Add ${EVENT_TYPES[this.settings.eventType].label.toLowerCase()} marker here` + (g ? ` (${g.name})` : ''), kbd: 'E', disabled: !!this.avg, action: () => this.addEvent(t) },
      ];
      if (this.avg) items.push({ label: '← Back to recording', kbd: 'A', action: () => this.exitAverage() });
      else if (g) items.push({ label: `Average ${g.name}`, kbd: 'A', action: () => this.averageGroup(g.id) });
      if (li >= 0) {
        items.push({ label: `Snap to peak on ${this.lines[li].label}`, kbd: 'Alt+click', action: () => this.snapToPeak(li, t) });
        const el2 = this.electrodesOfLine(li);
        if (el2.length) {
          items.push('-');
          el2.forEach((i) => {
            const on = this.bad.has(i);
            items.push({ label: `${on ? 'Include' : 'Exclude'} ${this.src.signals[i].std}`, action: () => this.toggleBad(i, !on) });
          });
        }
      }
      if (this.selection) items.push('-', { label: 'Clear selection', kbd: 'Esc', action: () => this.clearSelection() });
      items.push('-', { label: 'Export this page as PNG', action: () => this.exportPagePNG() });
      this.menu(x, y, items);
    }

    dialog(title, body, { wide = false, onClose } = {}) {
      this.closeDialog();
      const close = el('button', { class: 'icon-btn', title: 'Close (Esc)', html: ICONS.x, onclick: () => this.closeDialog() });
      const d = el('div', { class: 'dlg' + (wide ? ' wide' : '') }, el('div', { class: 'dlg-head' }, el('h3', {}, title), close), el('div', { class: 'dlg-body' }, body));
      const back = el('div', { class: 'dlg-back', onpointerdown: (e) => e.target === back && this.closeDialog() }, d);
      document.body.append(back);
      this._dlg = { back, onClose };
      return d;
    }
    closeDialog() {
      if (this._dlg) {
        this._dlg.back.remove();
        if (this._dlg.onClose) this._dlg.onClose();
        this._dlg = null;
        return true;
      }
      return false;
    }

    showHelp(tab = 'keys') {
      const rows = (list) => el('table', { class: 'keys' }, ...list.map(([k, d]) => el('tr', {}, el('td', {}, ...k.split(' / ').flatMap((x, i) => [i ? ' / ' : null, el('kbd', {}, x)]).filter(Boolean)), el('td', {}, d))));
      const keys = el('div', { class: 'help' },
        el('div', { class: 'help-col' },
          el('h4', {}, 'Navigation'),
          rows([['Wheel / → / PgDn', 'Next page (one page per wheel step)'], ['← / PgUp', 'Previous page'], ['Ctrl+wheel / ⌘+wheel', 'Scroll 1 s per wheel step'], ['Ctrl+→ / ⌘+→ / Shift+→', 'Scroll 1 s forward (← back)'], ['Home / End', 'Start / end of recording'], ['Space', 'Play / pause (auto-scroll)'], ['G', 'Go to time…'], ['C', 'Centre page on cursor']]),
          el('p', { class: 'muted small' }, 'On a Mac, Ctrl+←/→ is usually taken by macOS for switching desktops (Mission Control); use ⌘+←/→ or Shift+←/→ instead.'),
          el('h4', {}, 'Display'),
          rows([['↑ / ↓ / + / −', 'Sensitivity (larger / smaller traces)'], ['Alt+wheel / pinch', 'Sensitivity'], ['[ / ]', 'Shorter / longer page'], ['1 … 9 / 0', 'Montage 1–10'], ['Click a trace', 'Highlight it (thicker line) and map that instant'], ['Click a channel name', 'Gain & filters of that trace only'], ['Right-click', 'Channel options (exclude bad electrode)'], ['M', 'Show / hide side panel'], ['?', 'This help']])),
        el('div', { class: 'help-col' },
          el('h4', {}, 'Voltage map'),
          rows([['Click', 'Map that instant (cursor)'], ['Drag', 'Select window → map sequence + butterfly'], ['Drag cursor line', 'Scrub, map updates live'], ['Alt+click', 'Snap cursor to nearest peak of that trace'], ['Shift+click', 'Select from cursor to here'], ['Alt+← / Alt+→', 'Move cursor by 1 sample (Shift: 10)'], [', / .', 'Move cursor by 1 sample'], ['P', 'Cursor to GFP maximum'], ['Esc', 'Clear selection, then highlight']]),
          el('h4', {}, 'Events & averaging'),
          rows([['Double-click / E', 'Mark event (into the selected group)'], ['N / Shift+N', 'Next / previous event'], ['A', 'Average the selected group / back to recording'], ['Del', 'Delete selected event']])));
      const tabs = el('div', { class: 'dlg-tabs' });
      const holder = el('div');
      const guide = this.buildGuide();
      const show = (t) => {
        tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
        holder.textContent = '';
        holder.append(t === 'guide' ? guide : keys);
        const body = holder.closest('.dlg-body');
        if (body) body.scrollTop = 0;
      };
      tabs.append(el('button', { 'data-t': 'keys', onclick: () => show('keys') }, 'Keyboard & mouse'), el('button', { 'data-t': 'guide', onclick: () => show('guide') }, 'Voltage maps: guide'));
      this.dialog('Help', el('div', {}, tabs, holder), { wide: true });
      show(tab);
    }

    buildGuide() {
      const toc = [
        ['Using the viewer', [['g-start', 'Quick start'], ['g-controls', 'The controls'], ['g-avg', 'Averaging a group']]],
        ['Understanding maps', [['g-what', 'What a map shows'], ['g-dipole', 'Fields and dipoles'], ['g-ref', 'Reference'], ['g-spline', 'Interpolation'], ['g-gfp', 'GFP and butterfly'], ['g-seq', 'Map sequence'], ['g-csd', 'CSD'], ['g-pit', 'Pitfalls']]],
        ['Reference', [['g-gloss', 'Glossary'], ['g-refs', 'Literature']]],
      ];
      const nav = el('nav', { class: 'guide-toc' });
      toc.forEach(([h, items]) => {
        nav.append(el('div', { class: 'toc-h' }, h));
        items.forEach(([id, t]) => nav.append(el('a', { href: '#' + id, onclick: (e) => {
          e.preventDefault();
          const tgt = nav.parentElement.querySelector('#' + id);
          if (tgt) tgt.scrollIntoView({ block: 'start', behavior: 'smooth' });
        } }, t)));
      });
      const body = el('div', { class: 'guide-body', html: EEG.GUIDE_HTML });
      body.addEventListener('click', (e) => {
        const a = e.target.closest('a[data-jump]');
        if (!a) return;
        e.preventDefault();
        const tgt = body.querySelector(a.getAttribute('href'));
        if (tgt) tgt.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
      return el('div', { class: 'guide' }, nav, body);
    }

    showGoto() {
      if (!this.src || this._notInAverage('Go to time')) return;
      const inp = el('input', { class: 'txt', placeholder: 'hh:mm:ss (clock) or +h:mm:ss (elapsed)', value: this.fmtClock(this.view.t0 + this.view.dur / 2) });
      const go = () => {
        const t = this.parseTime(inp.value);
        if (t == null) return this.toast('Could not read that time.');
        this.closeDialog();
        this.centerOn(t);
      };
      inp.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      const d = this.dialog('Go to time', el('div', { class: 'goto' }, inp, el('button', { class: 'btn primary', onclick: go }, 'Go'), el('p', { class: 'muted' }, `Recording runs ${this.fmtClock(0)} – ${this.fmtClock(this.src.duration)}. Use +0:12:30 for elapsed time.`)));
      setTimeout(() => {
        inp.focus();
        inp.select();
      }, 0);
    }
    parseTime(s) {
      s = s.trim();
      const elapsed = s.startsWith('+');
      const parts = s.replace(/^\+/, '').split(':').map(Number);
      if (parts.some((x) => !isFinite(x))) return null;
      let sec = 0;
      parts.forEach((p) => (sec = sec * 60 + p));
      if (parts.length === 1 && !elapsed) return sec;
      if (elapsed) return sec;
      const start = U.clockParts(this.src.startMs, 0);
      let t = sec - (start.h * 3600 + start.m * 60 + start.s + start.ms / 1000);
      while (t < 0) t += 86400;
      return t;
    }

    showSettings() {
      const s = this.settings;
      const row = (label, ctrl, hint) => el('label', { class: 'set-row' }, el('span', { class: 'set-l' }, label, hint ? el('small', {}, hint) : null), ctrl);
      const select = (val, opts, on) => {
        const x = el('select', { class: 'sel', onchange: (e) => on(e.target.value) }, ...opts.map(([v, l]) => el('option', { value: String(v) }, l)));
        x.value = String(val);
        return x;
      };
      const check = (val, on) => {
        const c = el('input', { type: 'checkbox', onchange: (e) => on(e.target.checked) });
        c.checked = !!val;
        return c;
      };
      const apply = () => {
        this.saveSettings();
        this.applyTheme();
        this.computeDur();
        this.traceView.layout();
        this.mapWin = null;
        this.requestData();
        this.redrawAll();
        this.mapPanel.data = null;
        this.mapPanel.update();
      };
      // calibration widget
      const bar = el('div', { class: 'cal-bar' });
      const calLbl = el('span', { class: 'mono' });
      const syncCal = () => {
        bar.style.width = s.pxPerCm * 5 + 'px';
        calLbl.textContent = `${s.pxPerCm.toFixed(1)} px/cm`;
      };
      const slider = el('input', { type: 'range', min: '20', max: '90', step: '0.1', value: String(s.pxPerCm), oninput: (e) => {
        s.pxPerCm = parseFloat(e.target.value);
        syncCal();
      }, onchange: apply });
      syncCal();
      const body = el('div', { class: 'settings' },
        el('section', {},
          el('h4', {}, 'Display'),
          row('Theme', select(s.theme, [['light', 'Light'], ['dark', 'Dark']], (v) => ((s.theme = v), apply()))),
          row('Trace background', select(s.traceBg, [['white', 'White'], ['paper', 'Paper (cream)'], ['theme', 'Follow theme']], (v) => ((s.traceBg = v), apply()))),
          row('Trace thickness', select(s.traceWidth, [['thin', 'Thin (1 device px)'], ['normal', 'Normal'], ['bold', 'Bold']], (v) => ((s.traceWidth = v), apply()))),
          row('Gap between chains', select(s.sepGap, [[0, 'None'], [0.4, 'Small'], [0.6, 'Medium'], [1, 'One line']], (v) => ((s.sepGap = parseFloat(v)), apply()))),
          row('Clip traces at', select(s.clip, [[0, 'No clipping'], [1, '± 1 line'], [2, '± 2 lines'], [3, '± 3 lines']], (v) => ((s.clip = parseFloat(v)), apply())), 'Limits large artefacts from covering neighbouring channels'),
          row('0.2 s grid', check(s.minorGrid, (v) => ((s.minorGrid = v), apply()))),
          row('Time axis', select(s.timeMode, [['clock', 'Clock time'], ['elapsed', 'Elapsed time']], (v) => ((s.timeMode = v), apply()))),
          row('Mouse wheel', select(s.wheelMode, [['page', 'One page per step'], ['smooth', 'Smooth scrolling']], (v) => ((s.wheelMode = v), apply())), 'Ctrl/⌘+wheel always moves 1 s per step'),
          row('Smooth scroll speed', select(s.wheelSpeed, [[0.5, 'Slow'], [1, 'Normal'], [2, 'Fast']], (v) => ((s.wheelSpeed = parseFloat(v)), apply()))),
          row('Click on a trace highlights it', check(s.clickHighlight, (v) => ((s.clickHighlight = v), apply())), 'Thicker line; Esc removes the highlight')),
        el('section', {},
          el('h4', {}, 'Screen calibration'),
          el('p', { class: 'muted' }, 'Hold a ruler against the screen and move the slider until the bar is exactly 5 cm long. Sensitivity (µV/cm) and paper speed (mm/s) are then true to scale.'),
          bar, el('div', { class: 'cal-row' }, slider, calLbl)),
        el('section', {},
          el('h4', {}, 'Filters'),
          row('Filter type', select(s.filters.mode, [['zerophase', 'Zero-phase (forward–backward)'], ['causal', 'Causal (like analogue amplifiers)']], (v) => ((s.filters.mode = v), apply())), 'Zero-phase keeps peak latencies exact across channels — recommended for mapping'),
          row('High-pass order', select(s.filters.hpOrder, [[1, '1st (6 dB/oct, time-constant)'], [2, '2nd'], [4, '4th']], (v) => ((s.filters.hpOrder = parseInt(v, 10)), apply()))),
          row('Low-pass order', select(s.filters.lpOrder, [[1, '1st'], [2, '2nd (Butterworth)'], [4, '4th']], (v) => ((s.filters.lpOrder = parseInt(v, 10)), apply()))),
          row('Notch harmonics', check(s.filters.notchHarmonics, (v) => ((s.filters.notchHarmonics = v), apply())), 'Also remove 100/150 Hz')),
        el('section', {},
          el('h4', {}, 'Average reference & maps'),
          row('Include A1/A2 in average reference', check(s.avgIncludeEars, (v) => ((s.avgIncludeEars = v), apply()))),
          row('Include A1/A2 in maps', check(s.map.includeEars, (v) => ((s.map.includeEars = v), apply())), 'Ear electrodes are off-scalp; excluded by default'),
          row('Map window around cursor', select(s.map.halfWindow, [[0.1, '± 100 ms'], [0.2, '± 200 ms'], [0.3, '± 300 ms'], [0.5, '± 500 ms'], [1, '± 1 s']], (v) => ((s.map.halfWindow = parseFloat(v)), apply())), 'Butterfly/GFP window when no selection is made'),
          row('Maximum maps in a sequence', select(s.map.maxMaps, [[6, '6'], [12, '12'], [20, '20'], [30, '30']], (v) => ((s.map.maxMaps = parseInt(v, 10)), apply()))),
          row('Spline order m', select(s.spline.m, [[3, '3 (sharper)'], [4, '4 (standard)'], [5, '5 (smoother)']], (v) => ((s.spline.m = parseInt(v, 10)), apply())), 'Perrin et al. 1989'),
          row('Regularisation λ', select(s.spline.lambda, [[0, '0 (exact)'], [1e-7, '1e-7'], [1e-5, '1e-5 (standard)'], [1e-3, '1e-3 (smoothing)']], (v) => ((s.spline.lambda = parseFloat(v)), apply())))),
        el('section', {},
          el('h4', {}, 'Montages'),
          el('p', { class: 'muted' }, `${this.library.filter((m) => m.builtin).length} department montages built in, ${this.library.filter((m) => !m.builtin).length} imported. Import BrainQuick .bqm files with the button in the header or by dropping them on the window.`),
          el('button', { class: 'btn sm ghost', onclick: () => {
            U.store.del('importedMontages');
            this.loadMontageLibrary();
            if (this.src) this.refreshMontageList();
            this.toast('Imported montages removed.');
          } }, 'Remove imported montages')),
        el('section', {},
          el('h4', {}, 'Privacy'),
          el('p', { class: 'muted' }, 'Recordings are read directly from your disk inside this browser tab. Nothing is uploaded or sent anywhere. Settings, events and excluded electrodes are stored only in this browser.'),
          row('Anonymise patient details', check(s.anonymise, (v) => ((s.anonymise = v), this.saveSettings(), this.updateChrome())))),
        el('div', { class: 'set-foot' }, el('button', { class: 'btn ghost sm', onclick: () => {
          U.store.del('settings');
          this.settings = deepMerge(DEFAULTS, {});
          this.syncToolbar();
          this.mapPanel.syncControls();
          apply();
          this.closeDialog();
          this.toast('Settings reset to defaults.');
        } }, 'Reset all settings')));
      this.dialog('Settings', body, { wide: true });
    }

    /* ================= keyboard & drag-drop ================= */
    bindKeys() {
      // physical Ctrl state: trackpad pinch arrives as a wheel event with ctrlKey set
      G.addEventListener('keydown', (e) => e.key === 'Control' && (this.keys.ctrl = true), true);
      G.addEventListener('keyup', (e) => e.key === 'Control' && (this.keys.ctrl = false), true);
      G.addEventListener('blur', () => (this.keys.ctrl = false));
      G.addEventListener('keydown', (e) => {
        const tg = e.target;
        const typing = tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable);
        if (e.key === 'Escape') {
          if (this.closePopover()) return;
          if (this._menu) return this.closeMenu();
          if (this.closeDialog()) return;
          if (typing) return tg.blur();
          if (this.selection) return this.clearSelection();
          if (this.highlight >= 0) this.setHighlight(-1);
          return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
          e.preventDefault();
          $('#file-input').click();
          return;
        }
        if (typing || this._dlg) return;
        if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          e.preventDefault(); // also stops ⌘+← from navigating the browser back
          if (this.src) this.scrollBy(e.key === 'ArrowRight' ? 1 : -1);
          return;
        }
        if (e.metaKey || e.ctrlKey) return;
        const k = e.key;
        let handled = true;
        if (!this.src) {
          if (k === '?') this.showHelp();
          return;
        }
        switch (k) {
          case 'ArrowRight':
            if (e.altKey) this.stepCursor(e.shiftKey ? 10 : 1);
            else if (e.shiftKey) this.scrollBy(1);
            else this.page_(1);
            break;
          case 'ArrowLeft':
            if (e.altKey) this.stepCursor(e.shiftKey ? -10 : -1);
            else if (e.shiftKey) this.scrollBy(-1);
            else this.page_(-1);
            break;
          case 'PageDown':
            this.page_(1);
            break;
          case 'PageUp':
            this.page_(-1);
            break;
          case 'Home':
            this.goTo(0);
            break;
          case 'End':
            this.goTo(this.src.duration);
            break;
          case 'ArrowUp':
          case '+':
          case '=':
            this.stepSens(-1);
            break;
          case 'ArrowDown':
          case '-':
          case '_':
            this.stepSens(1);
            break;
          case '[':
            this.stepTimebase(-1);
            break;
          case ']':
            this.stepTimebase(1);
            break;
          case ',':
          case '<':
            this.stepCursor(e.shiftKey ? -10 : -1);
            break;
          case '.':
          case '>':
            this.stepCursor(e.shiftKey ? 10 : 1);
            break;
          case ' ':
            this.togglePlay();
            break;
          case 'm':
          case 'M':
            this.togglePanel();
            break;
          case 'e':
          case 'E':
            this.addEvent();
            break;
          case 'a':
          case 'A':
            if (this.avg) this.exitAverage();
            else if (this.groupById(this.activeGroup)) this.averageGroup(this.activeGroup);
            else if (this.groups.length === 1) this.averageGroup(this.groups[0].id);
            else this.toast(this.groups.length ? 'Select a group under “Events & groups” first.' : 'Create a group under “Events & groups” and mark potentials into it first.', 3500);
            break;
          case 'n':
            this.nextEvent(1);
            break;
          case 'N':
            this.nextEvent(-1);
            break;
          case 'g':
          case 'G':
            this.showGoto();
            break;
          case 'c':
          case 'C':
            if (this.cursor != null) this.centerOn(this.cursor);
            break;
          case 'p':
          case 'P':
            this.jumpToPeak('gfp');
            break;
          case 'Delete':
          case 'Backspace':
            if (this.selectedEvent) this.deleteEvent(this.selectedEvent);
            break;
          case '?':
            this.showHelp();
            break;
          default:
            if (/^[0-9]$/.test(k)) {
              const i = k === '0' ? 9 : parseInt(k, 10) - 1;
              const m = this.montages[i];
              if (m) this.setMontage(m.id);
            } else handled = false;
        }
        if (handled) e.preventDefault();
      });
    }
    bindDrop() {
      const drop = $('#drop');
      let depth = 0;
      G.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
        depth++;
        drop.hidden = false;
      });
      G.addEventListener('dragleave', () => {
        depth = Math.max(0, depth - 1);
        if (!depth) drop.hidden = true;
      });
      G.addEventListener('dragover', (e) => e.preventDefault());
      G.addEventListener('drop', (e) => {
        e.preventDefault();
        depth = 0;
        drop.hidden = true;
        const files = [...(e.dataTransfer.files || [])];
        const mons = files.filter((f) => /\.(bqm|xml)$/i.test(f.name));
        const data = files.filter((f) => !/\.(bqm|xml)$/i.test(f.name));
        if (mons.length) this.importMontageFiles(mons);
        if (data.length) this.openFile(data[0]);
      });
    }
  }

  const SVG = (p) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    play: SVG('<path d="M7 4v16l13-8z" fill="currentColor"/>'),
    pause: SVG('<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>'),
    x: SVG('<path d="M18 6 6 18M6 6l12 12"/>'),
    trash: SVG('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
    eye: SVG('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: SVG('<path d="M9.9 4.2A10.4 10.4 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6M3 3l18 18"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  };
  EEG.ICONS = ICONS;
  EEG.App = App;
  EEG.EVENT_TYPES = EVENT_TYPES;
})(typeof window !== 'undefined' ? window : globalThis);
