// UI smoke test: loads the built viewer in headless Chrome, opens an EDF,
// exercises navigation, cursor/selection mapping and keyboard controls, and
// writes screenshots.   node tests/ui_smoke.mjs <edf> <outdir>
import path from 'node:path';
import fs from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const edf = process.argv[2];
const out = process.argv[3];
fs.mkdirSync(out, { recursive: true });
const app = await launch({ width: 1600, height: 1000 });
const log = (...a) => console.log(...a);
try {
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  await sleep(300);
  await app.shot(path.join(out, '01-empty.png'));
  await app.setFile('#file-input', edf);
  await app.waitFor('window.eegApp && eegApp.lineData && eegApp.lineData.length > 0');
  await sleep(300);
  const st = await app.eval(`({montage: eegApp.montage.name, lines: eegApp.lines.length, dur: eegApp.view.dur, W: eegApp.traceView.W, fs: eegApp.src.fs, total: eegApp.src.duration, list: eegApp.montages.map(m=>m.name)})`);
  log('state', JSON.stringify(st));
  await app.shot(path.join(out, '02-open.png'));
  // navigate to a target time
  const target = parseFloat(process.argv[4] || '600');
  await app.eval(`eegApp.centerOn(${target})`);
  await app.waitFor(`eegApp.page && Math.abs(eegApp.page.t0 - eegApp.view.t0) < 0.01`);
  await sleep(200);
  // click in the middle of the trace area → cursor + map
  const r = await app.rect('.tv-overlay');
  const xc = r.x + r.width * 0.5,
    yc = r.y + r.height * 0.3;
  await app.click(xc, yc);
  await app.waitFor('eegApp.mapPanel.data && eegApp.mapPanel.g');
  await sleep(250);
  log('cursor', await app.eval('eegApp.fmtClock(eegApp.cursor, true)'));
  await app.shot(path.join(out, '03-cursor-map.png'));
  // drag a selection of ~ 0.4 s
  const pxPerS = r.width / st.dur;
  await app.drag(xc - pxPerS * 0.2, yc + 40, xc + pxPerS * 0.2, yc + 40, 10);
  await app.waitFor('eegApp.mapPanel.seqTimes && eegApp.mapPanel.seqTimes.length > 0');
  await sleep(300);
  log('selection', await app.eval('JSON.stringify(eegApp.selection)'), 'maps', await app.eval('eegApp.mapPanel.seqTimes.length'));
  await app.shot(path.join(out, '04-selection-seq.png'));
  // keyboard: page forward, sensitivity, montage switch
  const t0a = await app.eval('eegApp.view.t0');
  await app.key('ArrowRight');
  await sleep(150);
  const t0b = await app.eval('eegApp.view.t0');
  await app.key('ArrowUp');
  const sens = await app.eval('eegApp.settings.sens');
  await app.key('5');
  await sleep(300);
  const mon = await app.eval('eegApp.montage.name');
  log('page', t0a, '→', t0b, '| sens', sens, '| montage key 5 →', mon);
  // wheel scroll
  await app.wheel(xc, yc, 0, 200);
  await sleep(200);
  log('after wheel t0', await app.eval('eegApp.view.t0'));
  await app.key('Escape');
  await sleep(300);
  await app.shot(path.join(out, '05-avg-montage.png'));
  // help and settings dialogs
  await app.key('?');
  await sleep(200);
  await app.shot(path.join(out, '06-help.png'));
  await app.key('Escape');
  await app.eval('eegApp.showSettings()');
  await sleep(200);
  await app.shot(path.join(out, '07-settings.png'));
  await app.key('Escape');
} catch (e) {
  console.error('TEST ERROR', e);
} finally {
  log('--- browser logs ---');
  app.logs.forEach((l) => log(l));
  app.close();
}
