"""Independent cross-check of the JS core (tests/out_core.json) with numpy/scipy.
Run with: python3 -I tests/check_core.py <repo root>"""
import sys, os, json, glob
import numpy as np
from scipy import signal
from scipy.special import eval_legendre

root = sys.argv[1]
out = json.load(open(os.path.join(root, 'tests', 'out_core.json')))
fails = []
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)

def read_edf(path):
    with open(path, 'rb') as f:
        h = f.read(256); ns = int(h[252:256]); h2 = f.read(ns * 256)
    def fld(o, w): return [h2[o * ns + i * w:o * ns + (i + 1) * w].decode('latin-1').strip() for i in range(ns)]
    offs = {}; o = 0
    for name, w in [('label', 16), ('trans', 80), ('dim', 8), ('pmin', 8), ('pmax', 8), ('dmin', 8), ('dmax', 8), ('pref', 80), ('ns', 8), ('res', 32)]:
        offs[name] = [h2[o + i * w:o + (i + 1) * w].decode('latin-1').strip() for i in range(ns)]; o += w * ns
    nsamp = [int(x) for x in offs['ns']]; nrec = int(h[236:244]); hb = int(h[184:192])
    raw = np.memmap(path, dtype='<i2', mode='r', offset=hb, shape=(nrec, sum(nsamp)))
    sigs = []
    for c in range(ns):
        if offs['label'][c] == 'EDF Annotations': continue
        o = sum(nsamp[:c]); d = np.asarray(raw[:, o:o + nsamp[c]]).astype(np.float64).ravel()
        pm, pM, dm, dM = (float(offs[k][c]) for k in ('pmin', 'pmax', 'dmin', 'dmax'))
        sigs.append((d - dm) * (pM - pm) / (dM - dm) + pm)
    return sigs, nsamp[0]

files = sorted(glob.glob(os.path.join(root, 'example_files', '*.edf')))
for fi, path in enumerate(files):
    info = out['files']['file%d' % fi]
    sigs, fs = read_edf(path)
    print('--', info['name'], info['format'], 'records', info['nRecords'], 'dur', info['duration'], 'fs', info['fs'], 'annotations', info['annotations'])
    for t0s, arrs in info['reads'].items():
        t0 = float(t0s); i0 = round(t0 * fs); n = round((t0 + 1.25) * fs) - i0
        errs = []
        for k, a in enumerate(arrs):
            ref = sigs[k][i0:i0 + n]
            exp = list(ref[:8]) + list(ref[-3:])
            errs.append(np.max(np.abs(np.array(a) - np.array(exp))))
        check(max(errs) < 1e-3, f'raw read @ {t0:.2f}s matches numpy (max err {max(errs):.2e} µV)')
    # pipeline bipolar Fp1-F7 consistency with numpy filtered (scipy) data, away from edges
    p = info['pipeline']
    labels = [s[0] for s in info['signals'] if s[0] != 'EDF Annotations']
    ifp1 = labels.index('EEG Fp1'); if7 = labels.index('EEG F7')
    i0 = p['i0']
    check(np.allclose(p['rawFp1'], sigs[ifp1][i0:i0 + 5], atol=1e-3), 'pipeline raw window aligned to sample index')
    # zero-phase reference: same design via scipy, filtfilt on a long padded segment
    def zp_design(fc, order, kind):
        k = (np.sqrt(2) - 1) ** (1 / (2 * order))
        w = np.tan(np.pi * fc / fs); w0 = w / k if kind == 'low' else w * k
        f = fs / np.pi * np.arctan(w0)
        return signal.butter(order, f / (fs / 2), kind, output='sos')
    sos = np.vstack([zp_design(0.53, 1, 'high'), zp_design(70, 2, 'low')])
    seg = sigs[ifp1][i0 - 2560:i0 + 5120]
    y = signal.sosfiltfilt(sos, seg, padtype='odd', padlen=1000)
    ref = y[2560 + 1000:2560 + 1005]
    err = np.max(np.abs(np.array(p['filtFp1']) - ref))
    check(err < 0.05, f'zero-phase filtered Fp1 matches scipy sosfiltfilt (max err {err:.4f} µV)')
    y7 = signal.sosfiltfilt(sos, sigs[if7][i0 - 2560:i0 + 5120], padtype='odd', padlen=1000)
    err = np.max(np.abs(np.array(p['bip']) - (ref - y7[2560 + 1000:2560 + 1005])))
    check(err < 0.05, f'Fp1–F7 derivation matches (max err {err:.4f} µV)')

for mode, r in out['filters'].items():
    if not isinstance(r, dict): continue
    print('filters', mode, {k: round(v, 4) for k, v in r.items()})
    check(abs(r['hp_at_fc'] - 0.7071) < 0.01, f'{mode}: HP −3 dB at 0.53 Hz')
    check(abs(r['lp_at_fc'] - 0.7071) < 0.01, f'{mode}: LP −3 dB at 70 Hz')
    check(r['notch_at_50'] < 0.01 and r['notch_at_45'] > 0.9, f'{mode}: notch removes 50 Hz, passes 45 Hz')
for name, order, fc, kind in [('butterLP2_sos', 2, 30, 'low'), ('butterHP1_sos', 1, 1, 'high'), ('butterLP4_sos', 4, 40, 'low')]:
    sos = signal.butter(order, fc / 128, kind, output='sos')
    js = out['filters'][name]
    # compare overall frequency responses
    w = np.linspace(0.1, 127, 500)
    _, hs = signal.sosfreqz(sos, worN=w, fs=256)
    hj = np.ones_like(w, dtype=complex)
    for s in js:
        b = [s['b0'], s['b1'], s['b2']]; a = [1, s['a1'], s['a2']]
        _, h = signal.freqz(b, a, worN=w, fs=256); hj *= h
    err = np.max(np.abs(np.abs(hs) - np.abs(hj)))
    check(err < 1e-6, f'{name} matches scipy.signal.butter response (max err {err:.1e})')

# spherical spline reference
s = out['spline']
pos = np.array(s['pos']); v = np.array(s['v']); q = np.array(s['q'])
def g(x, m=4, N=50):
    n = np.arange(1, N + 1)
    P = np.moveaxis(np.array([eval_legendre(k, x) for k in n]), 0, -1)
    return np.sum((2 * n + 1) / (n * (n + 1)) ** m * P, axis=-1) / (4 * np.pi)
n = len(pos)
G = g(np.clip(pos @ pos.T, -1, 1)) + 1e-8 * np.eye(n)
A = np.zeros((n + 1, n + 1)); A[:n, :n] = G; A[:n, n] = 1; A[n, :n] = 1
sol = np.linalg.solve(A, np.r_[v, 0])
pred = g(np.clip(q @ pos.T, -1, 1)) @ sol[:n] + sol[n]
err = np.max(np.abs(pred - np.array(s['held'])))
check(err < 1e-3, f'spherical spline matches numpy reference at held-out points (max err {err:.2e})')
check(s['maxSelfErr'] < 1e-3, f'spline reproduces electrode values (max err {s["maxSelfErr"]:.2e})')
check(abs(s['rowsumW'] - 1) < 1e-4, f'interpolation weights sum to 1 (constant field reproduced): {s["rowsumW"]:.6f}')
print('electrode polar angles (theta, phi):', {k: (round(v['theta'], 1), round(v['phi'], 1)) for k, v in s['positions'].items()})
print('held-out: spline', np.round(s['held'], 3), 'true field', np.round(s['heldTrue'], 3))
print('\nFAILURES:' if fails else '\nALL CHECKS PASSED', fails if fails else '')
