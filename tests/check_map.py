"""Independent end-to-end check of a voltage map exported by tests/map_validate.mjs.
python3 -I tests/check_map.py <edf> <map.json>"""
import sys, json
import numpy as np
from scipy import signal
from scipy.special import eval_legendre

edf, js = sys.argv[1], sys.argv[2]
d = json.load(open(js))
with open(edf, 'rb') as f:
    h = f.read(256); ns = int(h[252:256]); h2 = f.read(ns * 256)
F = {}; o = 0
for name, w in [('label', 16), ('trans', 80), ('dim', 8), ('pmin', 8), ('pmax', 8), ('dmin', 8), ('dmax', 8), ('pref', 80), ('ns', 8), ('res', 32)]:
    F[name] = [h2[o + i * w:o + (i + 1) * w].decode('latin-1').strip() for i in range(ns)]; o += w * ns
nsamp = [int(x) for x in F['ns']]; nrec = int(h[236:244]); hb = int(h[184:192]); fs = 256
raw = np.memmap(edf, dtype='<i2', mode='r', offset=hb, shape=(nrec, sum(nsamp)))
s0 = d['sample']; pad = 20 * fs
def chan(label):
    i = F['label'].index('EEG ' + label)
    off = sum(nsamp[:i])
    r0 = (s0 - pad) // fs; r1 = (s0 + pad) // fs + 1
    x = np.asarray(raw[r0:r1, off:off + fs]).astype(float).ravel()
    pm, pM, dm, dM = (float(F[k][i]) for k in ('pmin', 'pmax', 'dmin', 'dmax'))
    return (x - dm) * (pM - pm) / (dM - dm) + pm, s0 - r0 * fs
def zp(fc, order, kind):
    k = (np.sqrt(2) - 1) ** (1 / (2 * order)); w = np.tan(np.pi * fc / fs)
    return signal.butter(order, fs / np.pi * np.arctan(w / k if kind == 'low' else w * k) / (fs / 2), kind, output='sos')
fl = d['filters']
sos = np.vstack([zp(fl['hp'], fl['hpOrder'], 'high'), zp(fl['lp'], fl['lpOrder'], 'low')])
V = []
for lab in d['labels']:
    x, k = chan(lab)
    V.append(signal.sosfiltfilt(sos, x)[k])
V = np.array(V); Vavg = V - V.mean()
err = np.max(np.abs(Vavg - np.array(d['vals'])))
gfp = np.sqrt(np.mean(Vavg ** 2))
print(f"time {d['tCursor']:.4f}s, {len(V)} electrodes")
print(f"electrode values (avg ref) max |app - python| = {err:.4f} µV   (range {Vavg.min():.1f} … {Vavg.max():.1f} µV)")
print(f"GFP app {d['gfp']:.3f} vs python {gfp:.3f} µV")
pos = np.array(d['pos']); n = len(pos); m = d['m']; lam = d['lambda']
def g(x, N=50):
    nn = np.arange(1, N + 1)
    P = np.moveaxis(np.array([eval_legendre(q, x) for q in nn]), 0, -1)
    return np.sum((2 * nn + 1) / (nn * (nn + 1)) ** m * P, axis=-1) / (4 * np.pi)
A = np.zeros((n + 1, n + 1)); A[:n, :n] = g(np.clip(pos @ pos.T, -1, 1)) + lam * np.eye(n); A[:n, n] = 1; A[n, :n] = 1
sol = np.linalg.solve(A, np.r_[Vavg, 0])
q = np.array([p['pos'] for p in d['pix']])
pred = g(np.clip(q @ pos.T, -1, 1)) @ sol[:n] + sol[n]
app = np.array([p['v'] for p in d['pix']])
perr = np.max(np.abs(pred - app))
print(f"interpolated map pixels ({len(app)}): max |app - python spline| = {perr:.4f} µV")
for p, pv in zip(d['pix'], pred):
    th = np.degrees(np.arccos(np.clip(p['pos'][2], -1, 1)))
    print(f"   pixel ({p['i']:3d},{p['j']:3d}) θ={th:6.1f}°  app {p['v']:8.2f}  python {pv:8.2f}")
ok = err < 0.05 and perr < 0.2 and abs(gfp - d['gfp']) < 0.05
print('RESULT:', 'PASS' if ok else 'FAIL')
