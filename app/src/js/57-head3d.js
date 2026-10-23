/* 3D head voltage map (WebGL2, no libraries).
 *
 * The head is an ellipsoid (narrower left–right, slightly flattened) with a
 * nose and ears for orientation. Each vertex direction is a point on the unit
 * sphere, so the colour of the surface is the same spherical-spline field as
 * in the 2D map (identical model, electrode set and reference) — the 3D view
 * changes only the projection, not the values. Isopotential lines are drawn
 * in the fragment shader (negative dashed, zero line bold); the dashed ring
 * is the 10-20 equator. Areas beyond the mapped region (below the lowest
 * electrode row + 10°, nose, ears) stay neutral. Electrodes, labels and
 * extrema are drawn on a 2D overlay. Drag to rotate; presets give the
 * standard views, including views from below for the basal temporal chain. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const U = EEG.util;
  const el = (...a) => U.el(...a);
  const D2R = Math.PI / 180;

  const VIEWS = {
    top: { az: 270, el: 90, label: 'Top' },
    front: { az: 90, el: 8, label: 'Front' },
    back: { az: 270, el: 8, label: 'Back' },
    left: { az: 180, el: 8, label: 'Left' },
    right: { az: 0, el: 8, label: 'Right' },
    leftLow: { az: 190, el: -30, label: 'L basal' },
    rightLow: { az: -10, el: -30, label: 'R basal' },
  };

  /* ---------- head geometry ---------- */
  const sph = (th, ph) => [Math.sin(th * D2R) * Math.cos(ph * D2R), Math.sin(th * D2R) * Math.sin(ph * D2R), Math.cos(th * D2R)];
  const NOSE = sph(119, 90),
    EAR_L = sph(127, 186),
    EAR_R = sph(127, -6);
  function shape(d) {
    const [x, y, z] = d;
    const a = 0.87,
      b = 1.0,
      c = z >= 0 ? 0.97 : 0.92;
    let r = 1 / Math.sqrt((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2);
    const bump = (v, w) => Math.exp(-((Math.acos(U.clamp(x * v[0] + y * v[1] + z * v[2], -1, 1)) / w) ** 2));
    const nose = bump(NOSE, 0.15),
      ear = Math.max(bump(EAR_L, 0.1), bump(EAR_R, 0.1));
    r += 0.24 * nose + 0.06 * ear;
    return { p: [x * r, y * r, z * r], skin: Math.min(1, Math.max(nose, ear) * 2.5) };
  }
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  /* Surface point and outward normal for a unit direction. */
  function surf(d) {
    const s = shape(d);
    const t1 = norm(Math.abs(d[2]) < 0.99 ? cross([0, 0, 1], d) : [1, 0, 0]);
    const t2 = cross(d, t1);
    const h = 0.01;
    const pa = shape(norm([d[0] + h * t1[0], d[1] + h * t1[1], d[2] + h * t1[2]])).p,
      pb = shape(norm([d[0] - h * t1[0], d[1] - h * t1[1], d[2] - h * t1[2]])).p,
      pc = shape(norm([d[0] + h * t2[0], d[1] + h * t2[1], d[2] + h * t2[2]])).p,
      pd = shape(norm([d[0] - h * t2[0], d[1] - h * t2[1], d[2] - h * t2[2]])).p;
    let n = norm(cross(sub(pa, pb), sub(pc, pd)));
    if (dot(n, d) < 0) n = [-n[0], -n[1], -n[2]];
    return { p: s.p, n, skin: s.skin };
  }

  let MESH = null;
  function mesh() {
    if (MESH) return MESH;
    const TH = 90, // θ 0…180° in 2° steps (closed surface)
      PH = 120; // φ in 3° steps (+ seam column)
    const cols = PH + 1,
      nV = (TH + 1) * cols;
    const pos = new Float32Array(nV * 3),
      nrm = new Float32Array(nV * 3),
      theta = new Float32Array(nV),
      skin = new Float32Array(nV);
    const dirs = [];
    for (let i = 0; i <= TH; i++) {
      for (let j = 0; j <= PH; j++) {
        const th = i * 2,
          ph = j * 3;
        const d = sph(th, ph);
        const v = i * cols + j;
        const s = i === 0 ? { ...shape(d), n: [0, 0, 1] } : i === TH ? { ...shape(d), n: [0, 0, -1] } : surf(d);
        pos.set(s.p, v * 3);
        nrm.set(s.n, v * 3);
        theta[v] = th;
        skin[v] = s.skin;
        dirs.push(d);
      }
    }
    const idx = new Uint16Array(TH * PH * 6);
    let q = 0;
    for (let i = 0; i < TH; i++)
      for (let j = 0; j < PH; j++) {
        const v0 = i * cols + j,
          v1 = v0 + 1,
          v2 = v0 + cols,
          v3 = v2 + 1;
        idx.set([v0, v2, v1, v1, v2, v3], q);
        q += 6;
      }
    MESH = { nV, pos, nrm, theta, skin, dirs, idx };
    return MESH;
  }

  /* ---------- matrices (column-major) ---------- */
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2),
      nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function lookAt(eye, up) {
    const f = norm(sub([0, 0, 0], eye)),
      s = norm(cross(f, up)),
      u = cross(s, f);
    return new Float32Array([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1]);
  }
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }

  const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; in float aVal; in float aTheta; in float aSkin;
uniform mat4 uMVP;
out float vVal; out float vTheta; out float vSkin; out vec3 vNrm;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); vVal = aVal; vTheta = aTheta; vSkin = aSkin; vNrm = aNrm; }`;
  const FS = `#version 300 es
precision highp float;
in float vVal; in float vTheta; in float vSkin; in vec3 vNrm;
uniform sampler2D uLut; uniform float uVmax, uStep, uEdge, uContours, uEquator, uDpr; uniform vec3 uLight;
out vec4 outColor;
float stip() { return mod(floor((gl_FragCoord.x + gl_FragCoord.y) / (4.0 * uDpr)), 2.0); }
void main() {
  vec3 skinC = vec3(0.86, 0.845, 0.83);
  float inMap = step(vTheta, uEdge) * (1.0 - smoothstep(0.15, 0.4, vSkin));
  float f = clamp(vVal / uVmax * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(skinC, texture(uLut, vec2((f * 255.0 + 0.5) / 256.0, 0.5)).rgb, inMap);
  if (inMap > 0.5 && uContours > 0.5) {
    float q = vVal / uStep;
    float k = floor(q + 0.5);
    float d = abs(q - k) / max(fwidth(q), 1e-6);
    float a = 1.0 - smoothstep(0.55 * uDpr, 1.35 * uDpr, d);
    if (k < -0.5 && stip() < 0.5) a = 0.0;
    c = mix(c, vec3(0.0), a * (abs(k) < 0.5 ? 0.62 : 0.32));
  }
  if (uEquator > 0.5 && inMap > 0.5) {
    float de = abs(vTheta - 90.0) / max(fwidth(vTheta), 1e-6);
    float ae = (1.0 - smoothstep(0.5 * uDpr, 1.2 * uDpr, de)) * stip();
    c = mix(c, vec3(0.0), ae * 0.3);
  }
  float db = abs(vTheta - uEdge) / max(fwidth(vTheta), 1e-6);
  c = mix(c, vec3(0.0), (1.0 - smoothstep(0.6 * uDpr, 1.4 * uDpr, db)) * 0.35 * (1.0 - vSkin));
  float lam = max(dot(normalize(vNrm), uLight), 0.0);
  c *= 0.68 + 0.32 * lam;
  if (!gl_FrontFacing) c = vec3(0.22);
  outColor = vec4(c, 1.0);
}`;

  class Head3D {
    static supported() {
      try {
        return !!document.createElement('canvas').getContext('webgl2');
      } catch (e) {
        return false;
      }
    }
    constructor() {
      this.cv = el('canvas', { class: 'mp-gl' });
      this.ov = el('canvas', { class: 'mp-gl-ov' });
      this.root = el('div', { class: 'mp-3d' }, this.cv, this.ov);
      this.az = VIEWS.top.az;
      this.el = VIEWS.top.el;
      this.size = 300;
      this.sc = null;
      this.onHover = null;
      this.onView = null;
      const gl = (this.gl = this.cv.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: true }));
      if (!gl) return;
      const prog = (this.prog = this._program(VS, FS));
      const M = mesh();
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const attr = (name, data, size) => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, name === 'aVal' ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
        return b;
      };
      attr('aPos', M.pos, 3);
      attr('aNrm', M.nrm, 3);
      attr('aTheta', M.theta, 1);
      attr('aSkin', M.skin, 1);
      this.vals = new Float32Array(M.nV);
      this.valBuf = attr('aVal', this.vals, 1);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, M.idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.lutTex = gl.createTexture();
      this.U = {};
      for (const n of ['uMVP', 'uLut', 'uVmax', 'uStep', 'uEdge', 'uContours', 'uEquator', 'uDpr', 'uLight']) this.U[n] = gl.getUniformLocation(prog, n);
      this._bind();
    }
    get ok() {
      return !!(this.gl && this.prog);
    }
    _program(vs, fs) {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    }
    setView(name) {
      const v = VIEWS[name];
      if (!v) return;
      this.az = v.az;
      this.el = v.el;
      this.render();
      if (this.onView) this.onView(this.az, this.el);
    }
    viewName() {
      for (const k in VIEWS) if (Math.abs(VIEWS[k].az - this.az) < 0.5 && Math.abs(VIEWS[k].el - this.el) < 0.5) return VIEWS[k].label;
      return '';
    }
    camera() {
      const a = this.az * D2R,
        e = this.el * D2R,
        D = 5.7;
      const eye = [D * Math.cos(e) * Math.cos(a), D * Math.cos(e) * Math.sin(a), D * Math.sin(e)];
      const up = [-Math.sin(e) * Math.cos(a), -Math.sin(e) * Math.sin(a), Math.cos(e)];
      const mvp = mul(perspective(28 * D2R, 1, 0.5, 20), lookAt(eye, up));
      const right = norm(cross(norm(sub([0, 0, 0], eye)), up));
      const light = norm([eye[0] + 2.2 * up[0] - 1.2 * right[0], eye[1] + 2.2 * up[1] - 1.2 * right[1], eye[2] + 2.2 * up[2] - 1.2 * right[2]]);
      return { eye, mvp, light };
    }
    resize(size) {
      this.size = size;
      this.root.style.width = this.root.style.height = size + 'px';
      U.fitCanvas(this.ov, size, size);
      const dpr = G.devicePixelRatio || 1;
      const w = Math.round(size * dpr);
      if (this.cv.width !== w) this.cv.width = this.cv.height = w;
      this.cv.style.width = this.cv.style.height = size + 'px';
    }
    /* sc: {plan, values (electrode values in plan order), evals (displayed electrode
     * values), vmax, step, cmap, invert, contours, labels, showValues, equator,
     * excluded:[{label,pos}], highlight:[plan index], unit} */
    setScene(sc) {
      this.sc = sc;
      if (!this.ok) return;
      const pl = sc.plan;
      if (!pl._w3) pl._w3 = EEG.topo.pointWeights(pl, mesh().dirs);
      EEG.spline.apply(pl._w3, pl.n, sc.values, this.vals);
      const lk = sc.cmap + (sc.invert ? ':i' : '');
      if (this._lutKey !== lk) {
        const L = EEG.topo.lut(sc.cmap, sc.invert),
          px = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) px.set([L[i * 3], L[i * 3 + 1], L[i * 3 + 2], 255], i * 4);
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this._lutKey = lk;
      }
      this.render();
    }
    _drawGL(W) {
      const gl = this.gl,
        sc = this.sc,
        cam = this.camera();
      gl.viewport(0, 0, W, W);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.valBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vals);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      const u = this.U;
      gl.uniformMatrix4fv(u.uMVP, false, cam.mvp);
      gl.uniform1i(u.uLut, 0);
      gl.uniform1f(u.uVmax, sc.vmax > 0 ? sc.vmax : 1);
      gl.uniform1f(u.uStep, sc.step > 0 ? sc.step : U.niceStep(sc.vmax, 5));
      gl.uniform1f(u.uEdge, sc.plan.edge);
      gl.uniform1f(u.uContours, sc.contours ? 1 : 0);
      gl.uniform1f(u.uEquator, sc.equator ? 1 : 0);
      gl.uniform1f(u.uDpr, W / this.size > 0 ? W / this.size : 1);
      gl.uniform3fv(u.uLight, cam.light);
      gl.drawElements(gl.TRIANGLES, mesh().idx.length, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
      return cam;
    }
    /* Screen position of a unit-sphere direction, or null when on the far side. */
    _proj(cam, d, S) {
      const s = surf(d);
      const p = [s.p[0] * 1.004, s.p[1] * 1.004, s.p[2] * 1.004];
      const toEye = norm(sub(cam.eye, p));
      if (dot(s.n, toEye) < 0.02) return null;
      const m = cam.mvp;
      const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      return [(x / w * 0.5 + 0.5) * S, (1 - (y / w * 0.5 + 0.5)) * S, dot(s.n, toEye)];
    }
    _overlay(ctx, cam, S, scale = 1) {
      const sc = this.sc,
        pl = sc.plan;
      const ev = sc.evals;
      let iMax = 0,
        iMin = 0;
      for (let e = 0; e < pl.n; e++) {
        if (ev[e] > ev[iMax]) iMax = e;
        if (ev[e] < ev[iMin]) iMin = e;
      }
      this._pts = [];
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${10 * scale}px system-ui, sans-serif`;
      const hl = new Set(sc.highlight || []);
      const halo = (t, x, y, col) => {
        ctx.lineWidth = 2.6 * scale;
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.strokeText(t, x, y);
        ctx.fillStyle = col;
        ctx.fillText(t, x, y);
      };
      for (let e = 0; e < pl.n; e++) {
        const q = this._proj(cam, sc.plan.model.pos[e], S);
        if (!q) continue;
        const [x, y, facing] = q;
        this._pts.push({ e, x: x / scale, y: y / scale });
        ctx.globalAlpha = U.clamp(facing * 4, 0.3, 1);
        const ext = e === iMax || e === iMin;
        ctx.beginPath();
        ctx.arc(x, y, (ext ? 3.2 : 2.1) * scale, 0, 2 * Math.PI);
        ctx.fillStyle = '#111';
        ctx.fill();
        if (ext) {
          ctx.beginPath();
          ctx.arc(x, y, 6.5 * scale, 0, 2 * Math.PI);
          ctx.lineWidth = 1.6 * scale;
          ctx.strokeStyle = EEG.topo.cssColor(sc.cmap, sc.invert, e === iMax ? 0.9 : -0.9);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, 8 * scale, 0, 2 * Math.PI);
          ctx.lineWidth = 0.8 * scale;
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.stroke();
        }
        if (hl.has(e)) {
          ctx.beginPath();
          ctx.arc(x, y, 5.5 * scale, 0, 2 * Math.PI);
          ctx.lineWidth = 3.4 * scale;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.stroke();
          ctx.lineWidth = 1.5 * scale;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        }
        if (sc.labels) halo(pl.labels[e], x, y - 9 * scale, '#111');
        if (sc.showValues) halo(U.fmtNum(ev[e], Math.abs(ev[e]) < 10 ? 1 : 0), x, y + 10 * scale, '#333');
        ctx.globalAlpha = 1;
      }
      for (const ex of sc.excluded || []) {
        const q = this._proj(cam, ex.pos, S);
        if (!q) continue;
        ctx.beginPath();
        ctx.arc(q[0], q[1], 2.6 * scale, 0, 2 * Math.PI);
        ctx.lineWidth = 1 * scale;
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.stroke();
        if (sc.labels) {
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.fillText(ex.label, q[0], q[1] - 9 * scale);
        }
      }
    }
    render() {
      if (!this.ok || !this.sc) return;
      const cam = this._drawGL(this.cv.width);
      const ctx = U.fitCanvas(this.ov, this.size, this.size);
      ctx.clearRect(0, 0, this.size, this.size);
      this._overlay(ctx, cam, this.size);
      const vn = this.viewName();
      ctx.fillStyle = 'rgba(100,110,120,0.9)';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(vn || 'drag to rotate', 4, this.size - 6);
    }
    /* Draw the head from `view` (or the current camera) into a 2D context at S×S. */
    drawInto(ctx, x, y, S, view) {
      if (!this.ok || !this.sc) return;
      const keep = [this.az, this.el, this.size];
      if (view && VIEWS[view]) {
        this.az = VIEWS[view].az;
        this.el = VIEWS[view].el;
      }
      this.size = S;
      this.cv.width = this.cv.height = S;
      const cam = this._drawGL(S);
      ctx.drawImage(this.cv, x, y, S, S);
      ctx.save();
      ctx.translate(x, y);
      this._overlay(ctx, cam, S, S / 360);
      ctx.restore();
      [this.az, this.el] = keep;
      this.resize(keep[2]);
      this.render();
    }
    _bind() {
      const ov = this.ov;
      let drag = null;
      ov.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        ov.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, y: e.clientY, az: this.az, el: this.el };
        ov.style.cursor = 'grabbing';
      });
      ov.addEventListener('pointermove', (e) => {
        const r = ov.getBoundingClientRect();
        const x = e.clientX - r.left,
          y = e.clientY - r.top;
        if (drag) {
          this.az = drag.az - (e.clientX - drag.x) * 0.6;
          this.el = U.clamp(drag.el + (e.clientY - drag.y) * 0.6, -60, 90);
          this.render();
          if (this.onHover) this.onHover(null);
          return;
        }
        let best = null,
          bd = 9;
        for (const p of this._pts || []) {
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        ov.style.cursor = best ? 'context-menu' : 'grab';
        if (this.onHover) this.onHover(best ? best.e : null, x, y);
      });
      const end = () => {
        if (!drag) return;
        drag = null;
        ov.style.cursor = 'grab';
        if (this.onView) this.onView(this.az, this.el);
      };
      ov.addEventListener('pointerup', end);
      ov.addEventListener('pointercancel', end);
      ov.addEventListener('pointerleave', () => !drag && this.onHover && this.onHover(null));
      ov.addEventListener('dblclick', () => this.setView('top'));
    }
  }

  EEG.Head3D = Head3D;
  EEG.Head3D.VIEWS = VIEWS;
  EEG.Head3D.mesh = mesh;
})(typeof window !== 'undefined' ? window : globalThis);
