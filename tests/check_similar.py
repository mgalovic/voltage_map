"""Independent check of "find similar" scores exported by tests/ui_stage2.mjs:
recompute the template correlation r and amplitude ratio at each candidate time
from the EDF with scipy filtering.   python3 -I tests/check_similar.py <edf> <similar.json>"""
import sys, json
import numpy as np
from scipy import signal

edf, js = sys.argv[1], sys.argv[2]
d = json.load(open(js))
with open(edf, 'rb') as f:
    h = f.read(256); ns = int(h[252:256]); h2 = f.read(ns * 256)
F = {}; o = 0
for name, w in [('label', 16), ('trans', 80), ('dim', 8), ('pmin', 8), ('pmax', 8), ('dmin', 8), ('dmax', 8), ('pref', 80), ('ns', 8), ('res', 32)]:
    F[name] = [h2[o + i * w:o + (i + 1) * w].decode('latin-1').strip() for i in range(ns)]; o += w * ns
nsamp = [int(x) for x in F['ns']]; nrec = int(h[236:244]); hb = int(h[184:192]); fs = d['fs']
raw = np.memmap(edf, dtype='<i2', mode='r', offset=hb, shape=(nrec, sum(nsamp)))
def chan(lab, a, b):
    i = F['label'].index('EEG ' + lab); off = sum(nsamp[:i])
    pm, pM, dm, dM = (float(F[k][i]) for k in ('pmin', 'pmax', 'dmin', 'dmax'))
    r0, r1 = a // fs, b // fs + 1
    x = np.asarray(raw[r0:r1, off:off + fs]).astype(float).ravel()
    x = (x - dm) * (pM - pm) / (dM - dm) + pm
    return x[a - r0 * fs:b - r0 * fs]
def zp(fc, order, kind):
    k = (np.sqrt(2) - 1) ** (1 / (2 * order)); w = np.tan(np.pi * fc / fs)
    return signal.butter(order, fs / np.pi * np.arctan(w / k if kind == 'low' else w * k) / (fs / 2), kind, output='sos')
fl = d['filters']
sos = np.vstack([zp(fl['hp'], fl['hpOrder'], 'high'), zp(fl['lp'], fl['lpOrder'], 'low')])
L, pre = d['L'], d['pre']
E = len(d['labels'])
T = np.array(d['T']).reshape(E, L)
pad = 20 * fs
worst_r = worst_a = 0
for c in d['cands']:
    k0 = round(c['t'] * fs) - pre
    X = np.array([signal.sosfiltfilt(sos, chan(lab, k0 - pad, k0 + L + pad))[pad:pad + L] for lab in d['labels']])
    X = X - X.mean(axis=0)
    r = (T * X).sum() / np.sqrt((T * T).sum() * (X * X).sum())
    amp = np.sqrt((X * X).sum() / (T * T).sum())
    worst_r = max(worst_r, abs(r - c['r'])); worst_a = max(worst_a, abs(amp - c['amp']))
    print(f"t {c['t']:10.4f}s  r app {c['r']:.4f}  python {r:.4f}   amp app {c['amp']:.3f}  python {amp:.3f}")
print(f"max |Δr| = {worst_r:.5f}, max |Δamp| = {worst_a:.5f}")
print('RESULT:', 'PASS' if worst_r < 2e-3 and worst_a < 2e-3 else 'FAIL')
