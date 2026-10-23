// Feedback round 1: wheel/keyboard paging, trace highlight, per-trace gain &
// filters, stacked map + events panel, groups and averaging, help guide.
//   node tests/ui_feedback.mjs <edf> <outdir>
// Writes <outdir>/average.json for tests/check_average.py.
import path from 'node:path';
import fs from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [edf, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const app = await launch({ width: 1600, height: 1000 });
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log((c ? 'PASS ' : 'FAIL ') + m);
};
const t0 = () => app.eval('eegApp.view.t0');
const settle = () => app.waitFor('!eegApp._fetching && eegApp.page && Math.abs(eegApp.page.t0 - eegApp.view.t0) < 0.01');
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
try {
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  await app.eval('localStorage.clear()');
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  await app.setFile('#file-input', edf);
  await app.waitFor('window.eegApp && eegApp.lineData && eegApp.lineData.length > 0');
  await app.eval('eegApp.centerOn(8841.363)');
  await settle();
  const r = await app.rect('.tv-overlay');
  const xc = r.x + r.width / 2,
    yc = r.y + r.height / 2;

  // ---- wheel ----
  let a = await t0();
  await app.wheel(xc, yc, 0, 100);
  await sleep(250);
  ok((await t0()) - a === 10, `wheel step = one page (${a} → ${await t0()})`);
  a = await t0();
  await app.wheel(xc, yc, 0, -100);
  await sleep(250);
  ok(a - (await t0()) === 10, 'wheel up = previous page');
  a = await t0();
  await app.wheel(xc, yc, 0, 100, MOD.meta);
  await sleep(250);
  ok(Math.abs((await t0()) - a - 1) < 1e-9, '⌘+wheel = 1 s');
  a = await t0();
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: MOD.ctrl });
  await app.wheel(xc, yc, 0, 100, MOD.ctrl);
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  await sleep(250);
  ok(Math.abs((await t0()) - a - 1) < 1e-9, 'Ctrl+wheel = 1 s');
  const sens0 = await app.eval('eegApp.settings.sens');
  await app.wheel(xc, yc, 0, -20, MOD.ctrl); // no physical Ctrl → trackpad pinch
  await sleep(150);
  ok((await app.eval('eegApp.settings.sens')) < sens0, `pinch → sensitivity (${sens0} → ${await app.eval('eegApp.settings.sens')} µV/cm)`);
  await app.wheel(xc, yc, 0, 40, MOD.alt);
  await sleep(150);
  ok((await app.eval('eegApp.settings.sens')) === sens0, 'Alt+wheel → sensitivity back');
  // rapid stream (trackpad-like): many small deltas within one gesture should not run away
  a = await t0();
  for (let i = 0; i < 30; i++) {
    await app.wheel(xc, yc, 0, Math.max(1, 40 - i * 1.3));
    await sleep(16);
  }
  await sleep(250);
  const pages = ((await t0()) - a) / 10;
  ok(pages >= 1 && pages <= 3, `decaying trackpad flick → ${pages} page(s)`);

  // ---- keys ----
  a = await t0();
  await app.key('ArrowRight');
  ok((await t0()) - a === 10, '→ = one page');
  a = await t0();
  await app.key('ArrowRight', { modifiers: MOD.ctrl });
  ok(Math.abs((await t0()) - a - 1) < 1e-9, 'Ctrl+→ = 1 s');
  a = await t0();
  await app.key('ArrowLeft', { modifiers: MOD.meta });
  ok(Math.abs(a - (await t0()) - 1) < 1e-9, '⌘+← = 1 s back');
  a = await t0();
  await app.key('ArrowRight', { modifiers: MOD.shift });
  ok(Math.abs((await t0()) - a - 1) < 1e-9, 'Shift+→ = 1 s');
  await app.eval('eegApp.centerOn(8841.363)');
  await settle();

  // ---- click highlights trace ----
  const lab = async (name) => app.eval(`(() => { const d = [...document.querySelectorAll('.tv-label')].find(x => x.textContent === ${JSON.stringify(name)}); const r = d.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2, i: Number(d.dataset.i)}; })()`);
  const f8 = await lab('F8–T8');
  await app.click(xc - 60, f8.y);
  await sleep(200);
  ok((await app.eval('eegApp.highlight')) === f8.i, 'click on F8–T8 highlights it');
  ok(await app.eval(`document.querySelector('.tv-label[data-i="${f8.i}"]').classList.contains('hl')`), 'label shows highlight');
  await app.eval('eegApp.setCursor(8841.363)');
  await app.waitFor('eegApp.mapPanel.data');
  await sleep(200);
  await app.shot(path.join(out, '20-highlight.png'));
  await app.key('Escape');
  ok((await app.eval('eegApp.highlight')) === -1, 'Esc removes highlight');

  // ---- per-trace gain & filters ----
  const fp = await lab('Fp2–F8');
  const before = await app.eval(`Array.from(eegApp.lineData[${fp.i}].slice(1000, 1010))`);
  const other = await app.eval(`Array.from(eegApp.lineData[${f8.i}].slice(1000, 1010))`);
  await app.click(fp.x, fp.y);
  await sleep(200);
  ok(await app.eval('!!document.querySelector(".pop")'), 'label click opens trace popover');
  await app.shot(path.join(out, '21-popover.png'));
  await app.eval(`(() => { const s = document.querySelectorAll('.pop select')[0]; s.value = '150'; s.dispatchEvent(new Event('change')); })()`);
  await app.eval(`(() => { const s = document.querySelectorAll('.pop select')[1]; s.value = '5'; s.dispatchEvent(new Event('change')); })()`);
  await settle();
  await sleep(200);
  const line = await app.eval(`({gain: eegApp.lines[${fp.i}].gain, filter: eegApp.lines[${fp.i}].filter, mod: document.querySelector('.tv-label[data-i="${fp.i}"]').classList.contains('mod')})`);
  ok(line.gain === 150 && line.filter && line.filter.hp === 5 && line.mod, 'Fp2–F8 gain 150 µV/cm, HP 5 Hz, marked ' + JSON.stringify(line));
  const after = await app.eval(`Array.from(eegApp.lineData[${fp.i}].slice(1000, 1010))`);
  const other2 = await app.eval(`Array.from(eegApp.lineData[${f8.i}].slice(1000, 1010))`);
  ok(after.some((v, i) => Math.abs(v - before[i]) > 0.5) && other2.every((v, i) => Math.abs(v - other[i]) < 1e-4), 'only Fp2–F8 is refiltered');
  ok((await app.eval('eegApp.settings.sens')) === sens0 && (await app.eval('eegApp.settings.filters.hp')) === 0.53, 'global sensitivity and filter unchanged');
  await app.shot(path.join(out, '22-trace-adjusted.png'));
  await app.eval(`[...document.querySelectorAll('.pop button')].find(b => b.textContent === 'Reset this trace').click()`);
  await settle();
  const reset = await app.eval(`({gain: eegApp.lines[${fp.i}].gain, filter: eegApp.lines[${fp.i}].filter})`);
  ok(reset.gain == null && reset.filter == null, 'reset restores montage defaults');
  await app.key('Escape');
  ok(await app.eval('!document.querySelector(".pop")'), 'Esc closes popover');

  // ---- stacked panel ----
  const rm = await app.rect('.psec[data-sec="map"]');
  const re = await app.rect('.psec[data-sec="events"]');
  ok(rm.height > 200 && re.height > 100 && re.y >= rm.y + rm.height - 8, `map (${Math.round(rm.height)} px) above events (${Math.round(re.height)} px)`);

  // ---- groups & averaging: alignment ----
  await app.eval('eegApp.newGroup()');
  const gid = await app.eval('eegApp.activeGroup');
  for (const dt of [-0.03, 0, 0.025]) await app.eval(`eegApp.addEvent(${8841.363 + dt})`);
  ok((await app.eval(`eegApp.userEvents.filter(e => e.group === '${gid}').length`)) === 3, 'three marks added to the active group');
  await app.eval(`eegApp.setAvgOpt({align: 'gfp', search: 0.05, half: 1})`);
  await app.eval(`eegApp.averageGroup('${gid}')`);
  await app.waitFor('eegApp.avg && eegApp.mapPanel.data && !eegApp._fetching');
  const used = await app.eval('eegApp.avg.meta.used.map(u => u.tAligned)');
  ok(used.length === 3 && used.every((t) => Math.abs(t - used[0]) < 1e-9), 'GFP alignment brings three jittered marks to one sample: ' + used.map((t) => t.toFixed(4)).join(', '));
  await sleep(400);
  await app.shot(path.join(out, '23-average-aligned.png'));
  await app.key('a');
  await settle();
  ok((await app.eval('!eegApp.avg && eegApp.src.format')) === 'EDF+C' && Math.abs((await t0()) - 8836.363) < 0.6, 'A returns to the recording at the same place');

  // ---- averaging: numerical check (as marked) ----
  const times = [4418.293, 8841.363, 1200.5, 6000.25, 9000.004];
  await app.eval('eegApp.newGroup()');
  const gid2 = await app.eval('eegApp.activeGroup');
  for (const t of times) await app.eval(`eegApp.addEvent(${t})`);
  await app.eval(`eegApp.setAvgOpt({align: 'mark'})`);
  await app.eval(`eegApp.averageGroup('${gid2}')`);
  await app.waitFor('eegApp.avg && eegApp.mapPanel.data && !eegApp._fetching');
  const dump = await app.eval(`(() => { const s = eegApp.src; const pick = ['Fp2','T9','Cz','O1']; const ch = {}; for (const p of pick) { const sig = s.dataSignals.find(x => x.std === p); ch[p] = Array.from(s.data[sig.index]); } return { fs: s.fs, zero: Math.round(s.tZero * s.fs), samples: s.meta.used.map(u => Math.round(u.tAligned * s.fs)), channels: ch, n: s.meta.n }; })()`);
  fs.writeFileSync(path.join(out, 'average.json'), JSON.stringify(dump));
  ok(dump.n === 5, 'five events averaged (as marked)');
  // linearity: map at 0 ms of the average equals the mean of the single-event maps
  const mean = await app.eval(`(async () => {
    const A = eegApp.avg; const st = A.stash; const used = A.meta.used; const E = eegApp.mapElectrodes().used;
    const out = new Float64Array(E.length);
    for (const u of used) {
      const w = await st.pipe.window(u.tAligned - 0.5, u.tAligned + 0.5, eegApp.filterSpec());
      const k = w.pad + w.index(u.tAligned); let m = 0; E.forEach(e => m += w.filt[e.idx][k]); m /= E.length;
      E.forEach((e, i) => out[i] += (w.filt[e.idx][k] - m) / used.length);
    }
    const d = eegApp.mapPanel.data; eegApp.setCursor(A.tZero); const kk = eegApp.mapPanel.kAt(A.tZero);
    let err = 0; for (let i = 0; i < E.length; i++) err = Math.max(err, Math.abs(d.vals[kk * d.E + i] - out[i]));
    return { err, range: Math.max(...out.map(Math.abs)) };
  })()`);
  ok(mean.err < 0.05, `map of the average = average of single-event maps (max diff ${mean.err.toFixed(4)} µV of ±${mean.range.toFixed(1)} µV)`);
  await sleep(300);
  await app.shot(path.join(out, '24-average-5.png'));
  await app.eval('eegApp.exitAverage()');
  await settle();

  // ---- help guide ----
  await app.eval('eegApp.showHelp("guide")');
  await sleep(300);
  const g = await app.eval('({h: document.querySelectorAll(".guide-body h3").length, refs: document.querySelectorAll(".guide-body .refs li").length})');
  ok(g.h >= 10 && g.refs === 8, `guide: ${g.h} sections, ${g.refs} references`);
  await app.shot(path.join(out, '25-guide.png'));
  await app.key('Escape');

  // ---- persistence of groups ----
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  await app.setFile('#file-input', edf);
  await app.waitFor('window.eegApp && eegApp.lineData && eegApp.lineData.length > 0');
  ok((await app.eval('eegApp.groups.length')) === 2 && (await app.eval('eegApp.userEvents.filter(e => e.group).length')) === 8, 'groups and grouped events persist after reload');
  await app.eval('eegApp.centerOn(8841.363); eegApp.setCursor(8841.363)');
  await settle();
  await sleep(300);
  await app.shot(path.join(out, '26-events-stacked.png'));
} catch (e) {
  fails++;
  console.error('ERROR', e);
} finally {
  console.log('--- browser logs ---');
  app.logs.forEach((l) => console.log(l));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  app.close();
}
