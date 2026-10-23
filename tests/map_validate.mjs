// Export what the app maps at time t (electrode values + interpolated pixels)
// for independent verification in Python (tests/check_map.py).
//   node tests/map_validate.mjs <edf> <t> <out.json>
import path from 'node:path';
import fs from 'node:fs';
import { launch } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [edf, t, outFile] = process.argv.slice(2);
const app = await launch({ width: 1600, height: 1000 });
try {
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  await app.setFile('#file-input', edf);
  await app.waitFor('window.eegApp && eegApp.lineData && eegApp.lineData.length > 0');
  await app.eval(`eegApp.centerOn(${t}); eegApp.setCursor(${t})`);
  await app.waitFor('eegApp.mapPanel.data && eegApp.mapPanel.g');
  const res = await app.eval(`(() => {
    const p = eegApp.mapPanel, d = p.data, k = p.kAt(eegApp.cursor), pl = d.plan, res = pl.res;
    const pix = [];
    for (const [i, j] of [[80,80],[40,60],[120,100],[30,80],[130,80],[80,20],[80,140],[60,120],[100,40],[20,90]]) {
      const u = (2*(i+0.5))/res - 1, w = 1 - (2*(j+0.5))/res;
      if (u*u + w*w > 1) continue;
      pix.push({ i, j, v: p.g[j*res + i], pos: EEG.topo.unproject(u, w, pl.edge) });
    }
    return { tCursor: eegApp.cursor, sample: Math.round(eegApp.cursor * d.fs), labels: d.used.map(u => u.label), pos: d.used.map(u => u.pos),
             vals: Array.from(d.vals.subarray(k*d.E, (k+1)*d.E)), gfp: d.gfp[k], edge: pl.edge, pix, filters: eegApp.filterSpec(), lambda: eegApp.settings.spline.lambda, m: eegApp.settings.spline.m };
  })()`);
  fs.writeFileSync(outFile, JSON.stringify(res));
  console.log('cursor', res.tCursor, 'sample', res.sample, 'electrodes', res.labels.length, 'pixels', res.pix.length);
} catch (e) {
  console.error(e);
} finally {
  app.logs.forEach((l) => console.log(l));
  app.close();
}
