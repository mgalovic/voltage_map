// Stage 2: find similar (template matching) and the 3D head map.
//   node tests/ui_stage2.mjs <edf> <outdir> [seed time s]
// Writes <outdir>/similar.json for tests/check_similar.py.
import path from 'node:path';
import fs from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [edf, out, seedArg] = process.argv.slice(2);
const seed = parseFloat(seedArg || '8841.363');
fs.mkdirSync(out, { recursive: true });
const app = await launch({ width: 1600, height: 1000 });
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log((c ? 'PASS ' : 'FAIL ') + m);
};
const settle = () => app.waitFor('!eegApp._fetching && eegApp.page && Math.abs(eegApp.page.t0 - eegApp.view.t0) < 0.01');
try {
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  await app.eval('localStorage.clear()');
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  await app.setFile('#file-input', edf);
  await app.waitFor('window.eegApp && eegApp.lineData && eegApp.lineData.length > 0');
  await app.eval(`eegApp.centerOn(${seed})`);
  await settle();

  // ---- find similar from the right-click entry ----
  const r = await app.rect('.tv-overlay');
  const x = r.x + ((seed - (await app.eval('eegApp.view.t0'))) / (await app.eval('eegApp.view.dur'))) * r.width;
  await app.click(x, r.y + 200, { button: 'right', buttons: 2 });
  await sleep(150);
  const items = await app.eval(`[...document.querySelectorAll('.menu-i')].map(b => b.textContent)`);
  ok(items.some((t) => t.startsWith('Find similar')), 'context menu offers “Find similar”');
  const t0 = Date.now();
  await app.eval(`[...document.querySelectorAll('.menu-i')].find(b => b.textContent.startsWith('Find similar')).click()`);
  await sleep(300);
  await app.shot(path.join(out, '30-find-running.png'));
  await app.waitFor('eegApp.find && eegApp.find.status === "done"', 120000);
  const secs = (Date.now() - t0) / 1000;
  const st = await app.eval(`(() => { const f = eegApp.find; const vis = eegApp.findVisible(); return { secs: f.secs, all: f.peaks.length, vis: vis.length, member: vis.filter(p => p.status === 'member').length, top: f.peaks.slice().sort((a,b) => b.r - a.r).slice(0, 12).map(p => [eegApp.fmtRecClock(p.t, true), +p.r.toFixed(3), +p.amp.toFixed(2)]) }; })()`);
  console.log('scan', JSON.stringify(st));
  ok(st.member === 1, 'the seed itself is found and recognised as group member');
  ok(st.secs < 60, `whole recording scanned in ${st.secs.toFixed(1)} s (wall ${secs.toFixed(1)} s)`);
  // export template + candidates for an independent check
  const dump = await app.eval(`(async () => {
    const f = eegApp.find, idx = eegApp.mapElectrodes().used.map(u => u.idx), fs = eegApp.src.fs;
    const fo = eegApp.settings.findOpts; const [a, b] = fo.win.split(',').map(Number);
    const pre = Math.round(-a * fs), L = pre + Math.round(b * fs) + 1;
    const g = eegApp.groupById(f.gid); const evs = eegApp.userEvents.filter(e => e.group === f.gid);
    const res = await EEG.average.computeAverage({ src: eegApp.src, pipe: eegApp.pipe, spec: eegApp.filterSpec(), times: evs.map(e => e.t), half: 0.5, align: eegApp.settings.avgOpts.align, search: eegApp.settings.avgOpts.search, gfpIdx: idx, meta: {} });
    const iz = Math.round(res.source.tZero * fs);
    const w = await new EEG.pipeline.Pipeline(res.source).window((iz - pre) / fs, (iz - pre + L) / fs, eegApp.filterSpec());
    const T = EEG.similar.templateFrom(w, idx, L);
    const peaks = f.peaks.slice().sort((p, q) => q.r - p.r);
    const pick = [...peaks.slice(0, 10), ...peaks.filter((_, i) => i % 97 === 5).slice(0, 10)];
    return { fs, L, pre, labels: idx.map(i => eegApp.src.signals[i].std), T: Array.from(T), filters: eegApp.filterSpec(), seedAligned: res.used[0].tAligned, cands: pick.map(p => ({ t: p.t, r: p.r, amp: p.amp })) };
  })()`);
  fs.writeFileSync(path.join(out, 'similar.json'), JSON.stringify(dump));

  // ---- review with the keyboard ----
  const nPend = await app.eval(`eegApp.findVisible().filter(p => p.status === 'pending').length`);
  if (nPend < 8) {
    console.log(`SKIP review steps: only ${nPend} candidates above threshold for this seed`);
    throw 'skip';
  }
  await app.eval('eegApp.findStep(1)');
  await settle();
  const c1 = await app.eval('eegApp.find.cur && eegApp.find.cur.t');
  ok(c1 != null && Math.abs((await app.eval('eegApp.cursor')) - c1) < 0.01, 'Next ▶ moves the map cursor onto the candidate');
  await sleep(300);
  await app.shot(path.join(out, '31-find-review.png'));
  const nEv0 = await app.eval('eegApp.userEvents.length');
  await app.key('y');
  ok((await app.eval('eegApp.userEvents.length')) === nEv0 + 1, 'Y adds the candidate to the group');
  const c2 = await app.eval('eegApp.find.cur.t');
  ok(c2 > c1, 'and moves on to the next candidate');
  await app.key('x');
  ok((await app.eval(`eegApp.find.peaks.find(p => Math.abs(p.t - ${c2}) < 1e-9).status`)) === 'rejected', 'X rejects a candidate');
  // accept the five most similar, then average
  await app.eval(`(() => { const top = eegApp.findVisible().filter(p => p.status === 'pending').sort((a,b) => b.r - a.r).slice(0, 5); top.forEach(p => eegApp.findAccept(p, false)); })()`);
  const gid = await app.eval('eegApp.find.gid');
  const nG = await app.eval(`eegApp.userEvents.filter(e => e.group === '${gid}').length`);
  ok(nG === 7, `group now holds seed + 6 accepted = ${nG} events`);
  await app.eval(`eegApp.averageGroup('${gid}')`);
  await app.waitFor('eegApp.avg && eegApp.mapPanel.data && !eegApp._fetching');
  await sleep(400);
  await app.shot(path.join(out, '32-average-of-found.png'));

  // ---- 3D head ----
  ok(await app.eval('EEG.Head3D.supported()'), 'WebGL2 available');
  await app.eval('eegApp.mapPanel.set({dim: "3d"})');
  await sleep(400);
  const views = await app.eval(`(() => {
    const h = eegApp.mapPanel.head3d, cv = document.createElement('canvas'); cv.width = cv.height = 240; const ctx = cv.getContext('2d');
    const out = {};
    for (const k of Object.keys(EEG.Head3D.VIEWS)) {
      ctx.clearRect(0, 0, 240, 240); h.drawInto(ctx, 0, 0, 240, k);
      const px = ctx.getImageData(0, 0, 240, 240).data; let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
      out[k] = +(n / (240 * 240)).toFixed(2);
    }
    return out;
  })()`);
  ok(Object.values(views).every((f) => f > 0.3 && f < 0.95), 'all seven 3D views render (head covers ' + JSON.stringify(views) + ' of the image)');
  // the 3D surface shows the same field as the 2D map (same model, no left/right mirroring):
  // compare head vertices with the 2D map pixel at the same scalp position
  const agree = await app.eval(`(() => {
    const p = eegApp.mapPanel, d = p.data, h = p.head3d, pl = d.plan, res = pl.res, M = EEG.Head3D.mesh();
    let err = 0, range = 0, n = 0;
    for (let v = 0; v < M.nV; v += 37) {
      if (M.theta[v] > 100 || M.skin[v] > 0.1) continue;
      const [u, w] = EEG.topo.project(M.dirs[v], pl.edge);
      const i = Math.floor(((u + 1) / 2) * res), j = Math.floor(((1 - w) / 2) * res);
      const g = p.g[j * res + i]; if (g !== g) continue;
      err = Math.max(err, Math.abs(h.vals[v] - g)); range = Math.max(range, Math.abs(g)); n++;
    }
    return { err, range, n };
  })()`);
  ok(agree.n > 100 && agree.err < 0.03 * agree.range, `3D head = 2D map at ${agree.n} scalp points (max dev ${agree.err.toFixed(2)} µV of ±${agree.range.toFixed(0)} µV, grid resolution)`);
  for (const v of ['right', 'rightLow']) {
    await app.eval(`eegApp.mapPanel.head3d.setView('${v}')`);
    await sleep(200);
    await app.shot(path.join(out, `33-3d-${v}.png`));
  }
  // drag to rotate
  const hr = await app.rect('.mp-gl-ov');
  const az0 = await app.eval('eegApp.mapPanel.head3d.az');
  await app.drag(hr.x + hr.width / 2, hr.y + hr.height / 2, hr.x + hr.width / 2 + 60, hr.y + hr.height / 2, 6);
  ok(Math.abs((await app.eval('eegApp.mapPanel.head3d.az')) - (az0 - 36)) < 1, 'dragging rotates the head');
  await app.eval('eegApp.exitAverage()');
  await app.eval('eegApp.mapPanel.set({dim: "2d"})');
} catch (e) {
  if (e !== 'skip') {
    fails++;
    console.error('ERROR', e);
  }
} finally {
  console.log('--- browser logs ---');
  app.logs.forEach((l) => console.log(l));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  app.close();
}
