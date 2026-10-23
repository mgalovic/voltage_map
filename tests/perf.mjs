// Performance probe on a long recording: open time, page-turn latency, map update latency.
//   node tests/perf.mjs <edf>
import path from 'node:path';
import { launch } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const app = await launch({ width: 1600, height: 1000 });
try {
  await app.goto('file://' + path.join(ROOT, 'EEG-Viewer.html'));
  const t0 = Date.now();
  await app.setFile('#file-input', process.argv[2]);
  await app.waitFor('window.eegApp && eegApp.lineData && eegApp.lineData.length > 0', 30000);
  console.log('open → first page drawn:', Date.now() - t0, 'ms');
  const res = await app.eval(`(async () => {
    const a = eegApp, out = {};
    const waitPage = (t) => new Promise(r => { const f = () => (a.page && Math.abs(a.page.t0 - a.view.t0) < 1.01 / a.src.fs && !a._fetching) ? r() : setTimeout(f, 1); f(); });
    // sequential page turns (cache warm after prefetch)
    let times = [];
    a.goTo(3600);
    await waitPage();
    for (let i = 0; i < 20; i++) { const s = performance.now(); a.page_(1); await waitPage(); await new Promise(r => requestAnimationFrame(r)); times.push(performance.now() - s); }
    out.pageTurnMedianMs = times.sort((x,y)=>x-y)[10].toFixed(1);
    out.pageTurnMaxMs = times[times.length-1].toFixed(1);
    // random jumps (cold cache)
    times = [];
    for (let i = 0; i < 10; i++) { const s = performance.now(); a.goTo(Math.random() * (a.src.duration - 20)); await waitPage(); times.push(performance.now() - s); }
    out.randomJumpMedianMs = times.sort((x,y)=>x-y)[5].toFixed(1);
    // trace draw only
    let s = performance.now(); for (let i = 0; i < 20; i++) a.traceView.draw(); out.drawMs = ((performance.now() - s) / 20).toFixed(2);
    // map: cursor scrubbing within window (no fetch) – full map redraw
    a.setCursor(a.view.t0 + 5); await a.mapPanel.update();
    s = performance.now(); for (let i = 0; i < 30; i++) { a.cursor += 1 / a.src.fs; a.mapPanel.drawMain(); } out.mapRedrawMs = ((performance.now() - s) / 30).toFixed(2);
    // map: spline plan build (cold)
    EEG.topo.plan(a.mapElectrodes().used, {res: 161, kind: 'V', m: 4, lambda: 1e-5});
    s = performance.now(); EEG.topo.plan(a.mapElectrodes().used.slice(1), {res: 160, kind: 'V', m: 4, lambda: 1e-5}); out.planBuildMs = (performance.now() - s).toFixed(1);
    // selection with sequence
    s = performance.now(); a.setSelection(a.cursor - 0.2, a.cursor + 0.2); await a.finishSelection(); out.selectionMs = (performance.now() - s).toFixed(1);
    // annotation scan of the whole file
    out.annotationsReady = a.src.annotationsReady;
    out.jsHeapMB = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) : 'n/a';
    return out;
  })()`);
  console.log(res);
} catch (e) {
  console.error(e);
} finally {
  app.logs.forEach((l) => console.log(l));
  app.close();
}
