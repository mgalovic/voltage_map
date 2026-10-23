# EEG Viewer

A browser-based EEG viewer with voltage mapping.

- **Online:** https://mgalovic.github.io/voltage_map/
- **Offline:** download `EEG-Viewer.html` and double-click it (Chrome or Edge
  recommended). It is a single self-contained file.

Recordings are read directly from disk inside the browser tab; nothing is
uploaded, also when the page is opened from the website. The page carries a
Content-Security-Policy that forbids every network connection, so the browser
itself prevents data from leaving the computer. Settings, events and groups are
stored only in the browser (localStorage).

Research and teaching tool, not a certified medical device.

## Opening data
- **Open** (⌘/Ctrl+O) or drag an EDF/EDF+/BDF/BDF+ file onto the window.
  Multi-hour recordings open instantly because data are read on demand.
- The eleven USZ BrainQuick montages from `montages/` are built in. Further
  `.bqm` files can be imported with **Import montage** or by dropping them on the
  window. Standard montages (double banana, transverse, average, Hjorth, Cz,
  as recorded) are generated for any recording.

## Voltage maps
- **Click** a trace to map that instant (the clicked trace is highlighted with a
  thicker line and its electrodes are ringed on the map); **drag the red
  cursor** to scrub; **Alt+←/→** steps one sample.
- **Drag** across a discharge to get a **map sequence** (shared colour scale),
  a **butterfly plot** and **global field power**; the cursor jumps to the GFP
  maximum. *GFP max / Neg. max / Pos. max* move the cursor to those peaks.
- **Alt+click** a trace snaps the cursor to its nearest peak.
- Maps use spherical-spline interpolation (Perrin et al. 1989; m = 4,
  λ = 1e-5), the common average reference of all mapped electrodes (or the
  recording reference), and include the inferior temporal chain
  (F9/T9/P9/F10/T10/P10). The dashed ring marks the 10-20 equator; electrodes
  outside it are basal. **CSD** shows the spherical-spline surface Laplacian.
- Right-click a channel label (or an electrode on the map) to exclude a bad
  electrode from maps and from the average reference.
- Red = positive, blue = negative by default (toggle in the panel).
- Export the map or the sequence as PNG.
- **Help → Voltage maps: guide** (or *Guide* in the map section) explains every
  control and how to read maps, for readers new to mapping.

## Groups and averaging (spike averaging)
- Under **Events & groups**, create a group, then mark potentials into it with
  **E** or a double-click. **Average ▸** (or **A**) sums the aligned epochs of
  all events in the group and divides by their number; the averaged EEG
  replaces the recording in the trace view (0 ms = alignment point) and can be
  re-montaged, filtered and mapped like any recording. **A** or *Back to
  recording* returns.
- Alignment: GFP peak (default), negative/positive peak of the highlighted
  trace, or as marked; search window ±20/50/100 ms; epoch ±0.5/1/2 s.
- Averages are computed from the unfiltered referential channels with the
  filter settling time added on both sides; epochs reaching beyond the
  recording or into a gap are skipped.

## Find similar (template matching)
Right-click a potential → **Find similar potentials**, or the magnifier next to
a group (**F**). The group's aligned average (filtered, average reference, all
mapped electrodes, ±100 ms by default) is correlated with the whole recording;
candidates are peaks of the correlation r above a threshold (default 0.80) with
an amplitude of ½–2× the template, at least 200 ms apart. Step through them
with **Next ▶** (each is mapped), add with **Y**, reject with **X**, then
average the group and search again with the improved template. A 3-hour
recording is scanned in about 5 s.

## 3D head map
**2D | 3D** in the map section shows the same spline-interpolated field on a
rotatable head (drag; presets Top, Front, Back, Left, Right and left/right
views from below for the inferior temporal chain). **All views** exports the
seven standard views as one PNG. Needs WebGL2 (current Chrome, Edge, Safari,
Firefox).

## Per-trace gain and filters
Click a channel name (e.g. *Fp2–F8*) to change gain, high-pass, low-pass and
notch of that trace only. Adjusted traces are marked with a dot; the changes
last until the viewer is closed and do not affect the maps.

## Side panel
Voltage map, events & groups and recording details are stacked sections; click
a section title to collapse it and drag the line between two sections to share
the height differently (double-click resets).

## Keyboard and mouse
| Key | Action |
|---|---|
| Wheel, → / ← (PgDn / PgUp) | next / previous page |
| Ctrl/⌘+wheel, Ctrl/⌘+→ / ←, Shift+→ / ← | scroll 1 s |
| ↑ / ↓, + / −, Alt+wheel, pinch | sensitivity |
| [ / ] | shorter / longer page |
| 1 … 9, 0 | montage 1–10 |
| Alt+→ / Alt+←, . / , | move map cursor one sample (Shift: 10) |
| P | cursor to GFP maximum |
| E / double-click | mark event (into the selected group); N / Shift+N next / previous |
| A | average the selected group / back to the recording |
| F | find similar to the selected group; Y / X add / reject a candidate |
| Space | play / pause |
| G | go to time |
| M | show / hide side panel |
| Esc | clear selection, then trace highlight |
| ? | help |

On a Mac, Ctrl+←/→ is normally taken by macOS (Mission Control, switching
desktops); use ⌘+←/→ or Shift+←/→. Settings → *Mouse wheel* switches back to
smooth scrolling if preferred.

## Calibration
Settings → *Screen calibration*: match the 5 cm bar to a ruler so that µV/cm
and mm/s are true to scale.

## Development
Source lives in `app/` (plain JavaScript, no dependencies). `node tools/build.mjs`
re-embeds the montages from `montages/*.bqm` and writes the single-file
`EEG-Viewer.html` and the identical `index.html` served by GitHub Pages.
The tests need EDF recordings in `example_files/`, which are not part of the
repository (patient data are never committed; see `.gitignore`).
Tests: `node tests/core.test.js && python3 -I tests/check_core.py .` (EDF
decoding, filters, montages and splines against numpy/scipy), the map check
(`tests/map_validate.mjs` + `tests/check_map.py`), the averaging check
(`tests/ui_feedback.mjs` + `tests/check_average.py`), the template-matching
check (`tests/ui_stage2.mjs` + `tests/check_similar.py`) and the other headless
Chrome scripts in `tests/`.
