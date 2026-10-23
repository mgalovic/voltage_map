// Open a recording, visit given times (seconds), map each (cursor + ±window
// selection) and screenshot.   node tests/visit.mjs <edf> <outdir> <t1,t2,...> [montage-substring] [halfwin]
import path from 'node:path';
import fs from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [edf, out, times, montage, half] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const app = await launch({ width: 1720, height: 1060 });
try {
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  await app.setFile('#file-input', edf);
  await app.waitFor('window.eegApp && eegApp.lineData && eegApp.lineData.length > 0');
  if (montage) {
    await app.eval(`(() => { const m = eegApp.montages.find(m => m.name.toLowerCase().includes(${JSON.stringify(montage.toLowerCase())})); if (m) eegApp.setMontage(m.id); })()`);
  }
  const hw = parseFloat(half || '0.15');
  for (const ts of times.split(',')) {
    const t = parseFloat(ts);
    await app.eval(`eegApp.centerOn(${t})`);
    await app.waitFor(`eegApp.page && Math.abs(eegApp.page.t0 - eegApp.view.t0) < 0.01 && !eegApp._fetching`);
    await app.eval(`(async () => { eegApp.setSelection(${t - hw}, ${t + hw}); await eegApp.finishSelection(); eegApp.setCursor(${t}); })()`);
    await app.waitFor('eegApp.mapPanel.data && eegApp.mapPanel.seqTimes.length');
    await sleep(400);
    const info = await app.eval(`(() => { const d = eegApp.mapPanel.data, k = eegApp.mapPanel.kAt(eegApp.cursor); const v = Array.from(d.ev.subarray(k*d.E,(k+1)*d.E)); const lab = d.used.map(u=>u.label); const o = lab.map((l,i)=>[l, v[i]]).sort((a,b)=>a[1]-b[1]); return eegApp.fmtClock(eegApp.cursor,true) + ' most neg: ' + o.slice(0,4).map(x=>x[0]+' '+x[1].toFixed(0)).join(', ') + ' | most pos: ' + o.slice(-3).reverse().map(x=>x[0]+' '+x[1].toFixed(0)).join(', '); })()`);
    console.log(t, info);
    await app.shot(path.join(out, `t${t.toFixed(3)}.png`));
  }
} catch (e) {
  console.error('ERROR', e);
} finally {
  app.logs.forEach((l) => console.log(l));
  app.close();
}
