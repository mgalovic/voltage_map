// Minimal Chrome DevTools Protocol driver (no dependencies; Node ≥ 22 WebSocket).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1600, height = 1000, scale = 1, profile, scrollbars = false } = {}) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const userDir = profile || fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'eegv-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu-sandbox', ...(scrollbars ? [] : ['--hide-scrollbars']),
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {}
    await sleep(100);
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const cdp = new CDP(ws, proc);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  return cdp;
}

class CDP {
  constructor(ws, proc) {
    this.ws = ws;
    this.proc = proc;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.logs = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        if (msg.method === 'Runtime.consoleAPICalled') this.logs.push(`[console.${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
        if (msg.method === 'Runtime.exceptionThrown') this.logs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
        if (msg.method === 'Log.entryAdded' && msg.params.entry.level !== 'verbose') this.logs.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text}`);
        this.listeners.forEach((l) => l(msg));
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async goto(url) {
    const loaded = new Promise((r) => {
      const l = (m) => m.method === 'Page.loadEventFired' && (this.listeners.splice(this.listeners.indexOf(l), 1), r());
      this.listeners.push(l);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(expr, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval(expr)) return true;
      } catch {}
      await sleep(80);
    }
    throw new Error('timeout waiting for ' + expr);
  }
  async setFile(selector, file) {
    const doc = await this.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    await this.send('DOM.setFileInputFiles', { nodeId, files: (Array.isArray(file) ? file : [file]).map((f) => path.resolve(f)) });
  }
  async shot(file, clip) {
    const p = { format: 'png' };
    if (clip) p.clip = { ...clip, scale: 1 };
    const r = await this.send('Page.captureScreenshot', p);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  async mouse(type, x, y, opts = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: opts.button || 'left', buttons: type === 'mouseReleased' ? 0 : opts.buttons ?? 1, clickCount: opts.clickCount || 1, modifiers: opts.modifiers || 0 });
  }
  async click(x, y, opts = {}) {
    await this.mouse('mouseMoved', x, y, { buttons: 0 });
    await this.mouse('mousePressed', x, y, opts);
    await this.mouse('mouseReleased', x, y, opts);
  }
  async drag(x0, y0, x1, y1, steps = 8, opts = {}) {
    await this.mouse('mouseMoved', x0, y0, { buttons: 0 });
    await this.mouse('mousePressed', x0, y0, opts);
    for (let i = 1; i <= steps; i++) await this.mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, opts);
    await this.mouse('mouseReleased', x1, y1, opts);
  }
  async wheel(x, y, deltaX, deltaY, modifiers = 0) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers });
  }
  async key(key, opts = {}) {
    const codes = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, PageDown: 34, PageUp: 33, Home: 36, End: 35, Escape: 27, ' ': 32, Enter: 13, Delete: 46 };
    const base = { key, code: opts.code, windowsVirtualKeyCode: codes[key] || key.toUpperCase().charCodeAt(0), modifiers: opts.modifiers || 0 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key.length === 1 ? key : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  async rect(selector) {
    return this.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
    this.proc.kill('SIGKILL');
  }
}
export { sleep };
