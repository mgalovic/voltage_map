// Feature walk-through: CSD, dark theme, events, exclusion via context menu,
// anonymisation, go-to, playback, montage import.   node tests/ui_features.mjs <edf> <outdir> <bqm>
import path from 'node:path';
import fs from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [edf, out, bqm] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const app = await launch({ width: 1600, height: 1000 });
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
try {
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  await app.setFile('#file-input', edf);
  await app.waitFor('window.eegApp && eegApp.lineData && eegApp.lineData.length > 0');
  await app.eval('eegApp.centerOn(8841.363)');
  await app.waitFor('!eegApp._fetching && eegApp.page && Math.abs(eegApp.page.t0-eegApp.view.t0) < 0.01');
  await app.eval('eegApp.setCursor(8841.363)');
  await app.waitFor('eegApp.mapPanel.data');
  // CSD
  await app.eval('eegApp.mapPanel.set({kind: "CSD"})');
  await sleep(300);
  const csd = await app.eval('({unit: eegApp.mapPanel.data.unit, E: eegApp.mapPanel.data.E, max: eegApp.mapPanel.data.wmax})');
  ok(csd.unit === 'µV/cm²' && csd.max > 0, 'CSD map computed ' + JSON.stringify(csd));
  await app.shot(path.join(out, '10-csd.png'));
  await app.eval('eegApp.mapPanel.set({kind: "V"})');
  // exclude electrode via label context menu
  const lab = await app.eval(`(() => { const d = [...document.querySelectorAll('.tv-label')].find(x => x.textContent === 'F8–T8'); const r = d.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
  await app.click(lab.x, lab.y, { button: 'right', buttons: 2 });
  await sleep(200);
  const items = await app.eval(`[...document.querySelectorAll('.menu-i')].map(b => b.textContent)`);
  ok(items.some((t) => t.includes('Exclude F8')), 'context menu offers exclusion: ' + items.join(' | '));
  await app.eval(`[...document.querySelectorAll('.menu-i')].find(b => b.textContent.includes('Exclude F8')).click()`);
  await sleep(400);
  const ex = await app.eval('({bad: [...eegApp.bad].map(i => eegApp.src.signals[i].std), E: eegApp.mapPanel.data.E, excl: eegApp.mapPanel.data.excluded.map(x=>x.label)})');
  ok(ex.bad.includes('F8') && ex.excl.includes('F8') && ex.E === 24, 'F8 excluded from map: ' + JSON.stringify(ex));
  await app.shot(path.join(out, '11-excluded-F8.png'));
  await app.eval('eegApp.toggleBad(eegApp.src.dataSignals.find(s => s.std === "F8").index, false)');
  // events: E key and double-click
  await app.key('e');
  const r = await app.rect('.tv-overlay');
  await app.click(r.x + r.width * 0.25, r.y + 200, { clickCount: 1 });
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x + r.width * 0.25, y: r.y + 200, button: 'left', buttons: 1, clickCount: 2 });
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + r.width * 0.25, y: r.y + 200, button: 'left', buttons: 0, clickCount: 2 });
  await sleep(200);
  const nev = await app.eval('eegApp.userEvents.length');
  ok(nev === 2, 'two events added (E key + double-click): ' + nev);
  await app.eval('eegApp.setTab("events")');
  await sleep(200);
  await app.shot(path.join(out, '12-events.png'));
  // next/prev event navigation
  await app.eval('eegApp.cursor = 0');
  await app.key('n');
  await sleep(200);
  ok(Math.abs((await app.eval('eegApp.cursor')) - (await app.eval('eegApp.userEvents[0].t'))) < 1e-6, 'N jumps to first event');
  // persistence after reload
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  await app.setFile('#file-input', edf);
  await app.waitFor('window.eegApp && eegApp.lineData && eegApp.lineData.length > 0');
  ok((await app.eval('eegApp.userEvents.length')) === 2, 'events persist after reload');
  ok((await app.eval('eegApp.montage.name')) === 'Längsreihe Bipolar + Temp', 'last montage restored');
  await app.eval('eegApp.setTab("info")');
  await sleep(200);
  await app.shot(path.join(out, '13-info.png'));
  // anonymise
  await app.eval('document.querySelector("#btn-anon").click()');
  await sleep(100);
  const chip = await app.eval('document.querySelector("#file-chip").textContent');
  const pname = await app.eval('(eegApp.src.patient && eegApp.src.patient.name) || ""');
  ok((!pname || !chip.includes(pname)) && chip.includes('Anonymised'), 'anonymised header hides the patient name');
  await app.eval('document.querySelector("#btn-anon").click()');
  // go to time dialog
  await app.key('g');
  await sleep(150);
  await app.eval(`(() => { const i = document.querySelector('.goto input'); i.value = '04:30:10'; i.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'})); })()`);
  await sleep(300);
  const mid = await app.eval('eegApp.view.t0 + eegApp.view.dur / 2');
  ok(Math.abs(mid - 8841) < 1, 'go-to 04:30:10 centres page at t=8841 s: ' + mid.toFixed(2));
  // playback 1 s
  const p0 = await app.eval('eegApp.view.t0');
  await app.key(' ');
  await sleep(1000);
  await app.key(' ');
  const p1 = await app.eval('eegApp.view.t0');
  ok(p1 - p0 > 0.7 && p1 - p0 < 1.5, `playback advanced ${(p1 - p0).toFixed(2)} s in ~1 s`);
  // montage import (built-in duplicate → message)
  await app.setFile('#montage-input', bqm);
  await sleep(500);
  const toasts = await app.eval('[...document.querySelectorAll(".toast")].map(t => t.textContent)');
  ok(toasts.some((t) => t.includes('already built in')), 'duplicate import reported: ' + toasts.join(' | '));
  // dark theme
  await app.eval('document.querySelector("#btn-theme").click()');
  await app.eval('eegApp.setTab("map"); eegApp.setCursor(8841.363)');
  await sleep(400);
  await app.shot(path.join(out, '14-dark.png'));
  await app.eval('document.querySelector("#btn-theme").click()');
  // all montages render without error
  const names = await app.eval('eegApp.montages.map(m => m.id)');
  for (const id of names) {
    await app.eval(`eegApp.setMontage(${JSON.stringify(id)})`);
    await app.waitFor('!eegApp._fetching && eegApp.lineData && eegApp.lineData.length === eegApp.lines.length');
  }
  ok(true, `all ${names.length} montages rendered`);
  await app.eval(`eegApp.setMontage(eegApp.montages.find(m => m.name === 'Quellenableitung').id)`);
  await app.waitFor('!eegApp._fetching');
  await sleep(200);
  await app.shot(path.join(out, '15-quellen.png'));
} catch (e) {
  console.error('ERROR', e);
} finally {
  console.log('--- browser logs ---');
  app.logs.forEach((l) => console.log(l));
  app.close();
}
