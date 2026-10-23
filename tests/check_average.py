"""Independent check of a group average exported by tests/ui_feedback.mjs:
the app's averaged raw channels must equal the mean of the EDF samples around
each aligned event.   python3 -I tests/check_average.py <edf> <average.json>"""
import sys, json
import numpy as np

edf, js = sys.argv[1], sys.argv[2]
d = json.load(open(js))
with open(edf, 'rb') as f:
    h = f.read(256); ns = int(h[252:256]); h2 = f.read(ns * 256)
F = {}; o = 0
for name, w in [('label', 16), ('trans', 80), ('dim', 8), ('pmin', 8), ('pmax', 8), ('dmin', 8), ('dmax', 8), ('pref', 80), ('ns', 8), ('res', 32)]:
    F[name] = [h2[o + i * w:o + (i + 1) * w].decode('latin-1').strip() for i in range(ns)]; o += w * ns
nsamp = [int(x) for x in F['ns']]; nrec = int(h[236:244]); hb = int(h[184:192]); fs = d['fs']
assert all(n == fs for n, l in zip(nsamp, F['label']) if l.startswith('EEG ')), 'test assumes 1 s records at fs'
raw = np.memmap(edf, dtype='<i2', mode='r', offset=hb, shape=(nrec, sum(nsamp)))
M = d['zero']
worst = 0.0
for lab, app in d['channels'].items():
    i = F['label'].index('EEG ' + lab)
    off = sum(nsamp[:i])
    pm, pM, dm, dM = (float(F[k][i]) for k in ('pmin', 'pmax', 'dmin', 'dmax'))
    sig = np.asarray(raw[:, off:off + fs]).astype(float).ravel()
    sig = (sig - dm) * (pM - pm) / (dM - dm) + pm
    epochs = np.array([sig[k - M:k + M + 1] for k in d['samples']])
    ref = epochs.mean(axis=0)
    err = np.max(np.abs(ref - np.array(app)))
    worst = max(worst, err)
    print(f"{lab:4s}: {len(d['samples'])} epochs × {2 * M + 1} samples, max |app − numpy| = {err:.5f} µV  (peak-to-peak {np.ptp(ref):.1f} µV)")
print('RESULT:', 'PASS' if worst < 1e-3 else 'FAIL')
