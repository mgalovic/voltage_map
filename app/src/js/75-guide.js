/* Voltage map guide shown in Help → "Voltage maps: guide" (and the Guide
 * button of the map section). Written for clinical EEG readers who have not
 * used maps before. Every cited work was checked against PubMed. */
(function (G) {
  'use strict';
  const doi = (d) => `<a href="https://doi.org/${d}" target="_blank" rel="noopener">doi:${d}</a>`;

  G.EEG.GUIDE_HTML = `
<h3 id="g-start">Quick start</h3>
<ol>
  <li><b>Click</b> on the EEG at the moment you want to see, for example the peak of a spike. The red line is the <i>map cursor</i>; the map shows the scalp field at exactly that instant. The trace you clicked on is highlighted and its electrodes are ringed in blue on the map.</li>
  <li><b>Drag</b> across the whole discharge (typically 100–300 ms). You then also get the butterfly plot, the global field power (GFP) and a <i>map sequence</i>, and the cursor jumps to the moment of strongest field (GFP maximum).</li>
  <li><b>Fine-tune</b> the time point with <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> (one sample, 3.9 ms at 256 Hz), by dragging the cursor line, or with <kbd>Alt</kbd>+click on a trace, which snaps to that trace's nearest peak.</li>
  <li>For several similar potentials, <b>average</b> them (see <a href="#g-avg" data-jump>Averaging a group</a>): the average shows the consistent field much more clearly than any single event.</li>
</ol>
<p class="note">The map is always computed from all referential recordings (each electrode against the recording reference), filtered with the global filters. The montage on screen and any per-trace gain or filter changes do not alter the map.</p>

<h3 id="g-controls">The controls</h3>
<dl class="ctl">
  <dt>Time and ‹ ›</dt><dd>Time of the map. The arrows move the cursor by one sample. Inside an average, times are given relative to the alignment point (0 ms).</dd>
  <dt>Map: Potential | CSD</dt><dd><b>Potential</b> shows the voltage at each point of the scalp (µV). <b>CSD</b> (current source density) shows where current enters or leaves the scalp; it sharpens focal activity and does not depend on the reference (see <a href="#g-csd" data-jump>CSD</a>).</dd>
  <dt>Average / Recording reference</dt><dd>Which reference the potential map uses. <b>Average reference</b> (default) subtracts the mean of all mapped electrodes at each instant. <b>Recording reference</b> shows the values as recorded against the amplifier reference (see <a href="#g-ref" data-jump>Reference</a>).</dd>
  <dt>Scale</dt><dd><b>Whole window</b>: one colour scale for the butterfly window or the selection, so maps at different moments can be compared. <b>Each map</b>: every map uses its own full colour range, which shows the pattern of weak fields but exaggerates noise. <b>Fixed ±</b>: a value you type in, useful when comparing different events.</dd>
  <dt>+ / − colour chip</dt><dd>Swaps which colour shows positive and which shows negative. Default: red positive, blue negative.</dd>
  <dt>Show: Isolines</dt><dd>Lines of equal voltage at even steps, like contour lines on a hiking map. Negative lines are dashed; the bold line is zero.</dd>
  <dt>Show: Labels / Values</dt><dd>Electrode names; electrode values in µV (µV/cm² for CSD).</dd>
  <dt>Show: Equator</dt><dd>Dashed ring at the level of Fpz–T7–Oz–T8 (the 10-20 “equator”). Electrodes outside it, such as F9/T9/P9 and F10/T10/P10, lie below it, over the basal temporal region.</dd>
  <dt>Colours / PNG</dt><dd>Colour map; save the map as an image. Red–blue prints well and suits most forms of colour-vision deficiency; “Jet” is familiar from other systems but its bright bands can suggest boundaries that are not in the data.</dd>
  <dt>Readout</dt><dd>Electrodes with the most negative (Min) and most positive (Max) value, GFP, and how many electrodes are mapped or excluded. On the map these two electrodes are ringed in blue and red.</dd>
  <dt>Butterfly · GFP</dt><dd>All electrodes superimposed over the analysis window, with GFP below. Click or drag in it to move the cursor. <b>GFP max</b>, <b>Neg. max</b> and <b>Pos. max</b> move the cursor to the strongest field, the most negative value and the most positive value in the window.</dd>
  <dt>Map sequence</dt><dd>Small maps at equal steps across a selected window, all on one colour scale. <b>Step</b> sets the interval; click a small map to move the cursor there.</dd>
  <dt>Excluding electrodes</dt><dd>Right-click an electrode on the map or a channel name to leave a bad electrode out of the maps and the average reference. Excluded electrodes are shown as hollow circles.</dd>
</dl>

<h3 id="g-avg">Averaging a group of potentials</h3>
<p>A single spike is always mixed with background EEG. Averaging several spikes of the same kind, each aligned on the same moment, keeps what they have in common and reduces activity that is unrelated to the spike. For uncorrelated background the reduction is roughly by the square root of the number of events: 4 events halve it, 16 events reduce it four-fold.</p>
<p>The viewer adds up the aligned epochs and divides the sum by their number. A sum and an average have exactly the same map; dividing keeps the amplitudes comparable with a single spike.</p>
<h4>How to</h4>
<ol>
  <li>Under <b>Events &amp; groups</b>, press <b>+ New group</b> (rename it by clicking its name). The new group is selected under “Mark … into”.</li>
  <li>Mark each potential with <kbd>E</kbd> (at the cursor) or a double-click. The marks go into the selected group. You can move any event to another group in the list.</li>
  <li>Choose the alignment and press <b>Average ▸</b> (or <kbd>A</kbd>). The averaged EEG replaces the recording in the trace view; montages, filters, the map, butterfly and map sequence all work on it, and 0 ms is the alignment point. Press <kbd>A</kbd> or <b>Back to recording</b> to return.</li>
</ol>
<h4>Alignment</h4>
<ul>
  <li><b>GFP peak</b> (default): each mark is moved to the strongest field within the search window (±20/50/100 ms). This removes the jitter of marking by eye and needs no choice of channel.</li>
  <li><b>Negative / positive peak of the highlighted trace</b>: the classic “trigger channel”. Click on the trace first so that it is highlighted.</li>
  <li><b>As marked</b>: no re-alignment.</li>
</ul>
<p class="note">Only average potentials that belong together: the same morphology and the same field. If two spike populations are mixed, the average shows a blurred, intermediate map that may resemble neither. Check single events first and leave artefacts out; one large artefact can dominate an average of a few events. Events whose epoch reaches beyond the recording or into a recording gap are skipped.</p>

<h3 id="g-what">What a voltage map shows</h3>
<p>A montage shows voltage <i>differences</i> between pairs of electrodes, as curves over time. A voltage map turns this around: it shows the voltage at <i>all</i> electrodes at <i>one instant</i>, as a picture of the head seen from above (nose at the top, left hemisphere on the left). Colour codes the voltage, values between electrodes are estimated by interpolation, and isolines join points of equal voltage.</p>
<p>The map contains no information that is not in the EEG; it is another way of looking at the same data. A phase reversal in a bipolar chain corresponds to a maximum or minimum of the map lying at the electrode shared by the two channels; in a referential montage it is the electrode with the largest deflection. What the map adds is the overview: where the maximum is, how far the field extends, whether there is an opposite pole, and how all of this changes from one millisecond to the next.</p>

<h3 id="g-dipole">Reading a map: fields and dipoles</h3>
<p>The scalp EEG of a spike is generated by a patch of cortex in which many pyramidal cells are active together. Electrically, such a patch behaves like a <b>dipole</b>: a negative and a positive pole, oriented perpendicular to the cortical surface. On the scalp, the orientation of the dipole matters as much as its position:</p>
<ul>
  <li><b>Radial source</b> (cortex on the convexity, facing the skull): one focal negative maximum directly above the source, surrounded by a weaker, broad positivity.</li>
  <li><b>Tangential source</b> (cortex in the wall of a sulcus or fissure, or on the basal surface, lying parallel to the scalp): a negative and a positive pole side by side. The source lies beneath the zero line <i>between</i> the poles, not under the negative maximum.</li>
  <li>Most real sources are oblique, giving an asymmetric pair of poles.</li>
</ul>
<p>Example from temporal lobe epilepsy: Ebersole and Wade (1991) described two characteristic topographies of frontotemporal spikes. “Type 1” spikes had a negative field over the inferolateral temporal scalp together with a positive field over the contralateral centroparietal scalp. “Type 2” spikes showed only a broad frontotemporal negativity. In their patients, type 2 spikes correlated with temporal or frontal neocortical sources, whereas type 1 spikes involved mesial temporal structures as well as lateral cortex.</p>
<p class="note">A map describes the field on the scalp. Locating the generator in the brain requires source analysis with a head model (EEG source imaging; Michel et al. 2004), which this viewer does not perform. Use maps as a structured way of looking at the EEG, together with the clinical context, not as source localisation.</p>

<h3 id="g-ref">Why the reference matters, and what the average reference does</h3>
<p>Every EEG value is a difference between two points, so a map needs a common reference. With the <b>average reference</b> the viewer subtracts, at every instant, the mean of all mapped electrodes. This is the usual choice for maps because it does not favour any single electrode.</p>
<p>Two facts help in reading maps:</p>
<ul>
  <li>The <b>shape</b> of the map does not depend on the reference. Changing the reference adds the same number to every point; the positions of maxima and minima and the shape of the isolines stay the same. Only the zero line moves, and with it the place where red turns into blue.</li>
  <li>The average reference is only an approximation of a true zero. With 25 electrodes that cover the lower head incompletely, a large focal discharge pulls the mean towards itself, so a part of the opposite polarity elsewhere can be produced by the reference rather than by the brain. A bad electrode distorts the average for all others, which is why excluded electrodes are also left out of the average. A1/A2 are not used by default because they lie off the scalp.</li>
</ul>
<p><b>Recording reference</b> shows the values as the amplifier recorded them. This is useful for comparison with referential montages, but the map then depends on where the reference electrode was.</p>

<h3 id="g-spline">How values between electrodes are estimated</h3>
<p>Between electrodes the viewer uses <b>spherical-spline interpolation</b> (Perrin et al. 1989), a standard method in EEG mapping. It treats the head as a sphere and finds the smoothest surface that passes through all electrode values (smoothness order m = 4; a small regularisation λ = 10<sup>−5</sup> tolerates a little noise).</p>
<ul>
  <li>Details smaller than the distance between electrodes (several centimetres in a 25-electrode array) cannot be resolved. A single deviant electrode produces a “bull's-eye”, a small ring of colour around one electrode.</li>
  <li>Outside the outermost electrodes the values are extrapolated: be cautious at the edge of the map.</li>
  <li>The map includes the inferior temporal row (F9/T9/P9 and F10/T10/P10), which is part of the 25-electrode array recommended by the IFCN (Seeck et al. 2017). This row lies outside the dashed equator ring. A field whose maximum lies outside the ring points to the basal temporal region, which the 10-20 electrodes alone cover poorly.</li>
  <li>The flat picture is a projection of the curved head, like a world map, so the lower parts appear stretched.</li>
</ul>

<h3 id="g-gfp">Global field power and the butterfly plot</h3>
<p><b>Global field power (GFP)</b> is the standard deviation of all electrode values at one instant (Lehmann &amp; Skrandies 1980). It is high when the map has strong maxima and minima and low when the scalp is nearly flat: a single number for “how much field” there is at each moment, independent of the reference. GFP peaks are good moments to look at a map, because the field is strongest relative to the background there.</p>
<p>The <b>butterfly plot</b> superimposes all electrodes (average reference, negative up). The two coloured curves are the electrodes with the most positive and the most negative value at the cursor, so you can see when each pole reaches its peak.</p>

<h3 id="g-seq">Map sequence</h3>
<p>Dragging across a discharge produces maps at equal time steps on a shared colour scale. They show how the field builds up, peaks and decays. If the maximum moves steadily over tens of milliseconds, this can reflect propagation, or two sources becoming active one after the other. Early, low-amplitude maps are noisy, so interpret them with care, and compare the sequence with the GFP curve.</p>

<h3 id="g-csd">CSD: current source density</h3>
<p>The <b>current source density</b> (CSD, also called the surface Laplacian) is computed from the spline-interpolated potential map. It describes how sharply the potential curves at each point, which estimates the current flowing through the skull into or out of the scalp. Its unit is µV/cm².</p>
<ul>
  <li>It is reference-free: the result is the same whichever reference was used.</li>
  <li>It sharpens local features and suppresses broad fields spread by volume conduction, so neighbouring sources separate better. Broad fields from deep or tangential sources are attenuated, so CSD can hide what the potential map shows; look at both.</li>
  <li>Sign: a focal negative potential appears as a negative (blue) CSD area, a current “sink”; a focal positivity appears as a positive “source”.</li>
  <li>It is more sensitive to noise and to bad electrodes, and least reliable at the edge of the map. With 25 electrodes it gives a coarse estimate (Kayser &amp; Tenke 2015).</li>
  <li>The <i>Quellenableitung</i> montage (Hjorth source derivation; Hjorth 1975) is a simple local form of the same idea: each electrode minus the weighted mean of its neighbours.</li>
</ul>

<h3 id="g-pit">Pitfalls</h3>
<ul>
  <li><b>Artefacts have maps too.</b> Eye blinks: positive at Fp1/Fp2, symmetrical. Horizontal eye movements: opposite polarity at F7 and F8. Muscle: very focal, often temporal, with fast activity. Electrode pop: a single electrode, giving a bull's-eye.</li>
  <li><b>Bad electrodes</b> distort the whole map and, through the average, every value. Exclude them (right-click).</li>
  <li><b>Low amplitude</b>: when GFP is small, the map shows background and noise rather than the event.</li>
  <li><b>Filters</b> change waveforms. The default zero-phase filters keep the timing identical across channels; causal filters shift peaks.</li>
  <li><b>Edges and coverage</b>: values beyond the outermost electrodes are extrapolated, and the lower head is covered only by the inferior temporal row.</li>
  <li><b>Averages</b> are only as good as the grouping: mixed populations or artefacts produce misleading maps.</li>
</ul>

<h3 id="g-gloss">Glossary</h3>
<dl class="gl">
  <dt>AVG / CAR</dt><dd>Average reference (common average reference): each electrode minus the mean of all electrodes.</dd>
  <dt>CSD</dt><dd>Current source density, the surface Laplacian of the potential (µV/cm²); reference-free.</dd>
  <dt>Dipole</dt><dd>Pair of opposite poles that models the current of an active cortical patch.</dd>
  <dt>Radial / tangential</dt><dd>Source oriented towards the scalp (single focal pole) or parallel to it (two poles side by side).</dd>
  <dt>GFP</dt><dd>Global field power: standard deviation across electrodes at one instant.</dd>
  <dt>Butterfly plot</dt><dd>All electrodes superimposed on one time axis.</dd>
  <dt>Isoline</dt><dd>Line joining points of equal voltage (isopotential line).</dd>
  <dt>Spherical spline</dt><dd>Smooth interpolation on a sphere used to fill in values between electrodes.</dd>
  <dt>m, λ</dt><dd>Spline smoothness order and regularisation (here m = 4, λ = 10<sup>−5</sup>).</dd>
  <dt>10-20 / 10-10</dt><dd>Electrode placement systems; this viewer uses 10-10 names (T7/T8/P7/P8 for T3/T4/T5/T6).</dd>
  <dt>Inferior temporal row</dt><dd>F9/T9/P9 and F10/T10/P10, below the 10-20 equator; part of the IFCN 25-electrode array.</dd>
  <dt>Equator</dt><dd>The circle through Fpz, T7, Oz and T8; the outer border of the classical 10-20 array.</dd>
  <dt>Phase reversal</dt><dd>Opposite deflections in two adjacent bipolar channels; marks the maximum at their shared electrode.</dd>
  <dt>Hjorth</dt><dd>Source derivation: electrode minus the weighted mean of its neighbours (Quellenableitung).</dd>
  <dt>Zero-phase filter</dt><dd>Filter run forwards and backwards so that it does not shift peaks in time.</dd>
  <dt>Alignment point</dt><dd>0 ms of an average: the marked time, or the peak each mark was moved to.</dd>
</dl>

<h3 id="g-refs">Literature</h3>
<ol class="refs">
  <li>Perrin F, Pernier J, Bertrand O, Echallier JF. Spherical splines for scalp potential and current density mapping. <i>Electroencephalogr Clin Neurophysiol</i> 1989;72:184–187. ${doi('10.1016/0013-4694(89)90180-6')}</li>
  <li>Lehmann D, Skrandies W. Reference-free identification of components of checkerboard-evoked multichannel potential fields. <i>Electroencephalogr Clin Neurophysiol</i> 1980;48:609–621. ${doi('10.1016/0013-4694(80)90419-8')}</li>
  <li>Ebersole JS, Wade PB. Spike voltage topography identifies two types of frontotemporal epileptic foci. <i>Neurology</i> 1991;41:1425–1433. ${doi('10.1212/wnl.41.9.1425')}</li>
  <li>Seeck M, Koessler L, Bast T, et al. The standardized EEG electrode array of the IFCN. <i>Clin Neurophysiol</i> 2017;128:2070–2077. ${doi('10.1016/j.clinph.2017.06.254')}</li>
  <li>Michel CM, Murray MM, Lantz G, et al. EEG source imaging. <i>Clin Neurophysiol</i> 2004;115:2195–2222. ${doi('10.1016/j.clinph.2004.06.001')}</li>
  <li>Scherg M, Ille N, Bornfleth H, Berg P. Advanced tools for digital EEG review: virtual source montages, whole-head mapping, correlation, and phase analysis. <i>J Clin Neurophysiol</i> 2002;19:91–112. ${doi('10.1097/00004691-200203000-00001')}</li>
  <li>Kayser J, Tenke CE. Issues and considerations for using the scalp surface Laplacian in EEG/ERP research: a tutorial review. <i>Int J Psychophysiol</i> 2015;97:189–209. ${doi('10.1016/j.ijpsycho.2015.04.012')}</li>
  <li>Hjorth B. An on-line transformation of EEG scalp potentials into orthogonal source derivations. <i>Electroencephalogr Clin Neurophysiol</i> 1975;39:526–530. ${doi('10.1016/0013-4694(75)90056-5')}</li>
</ol>
`;
})(typeof window !== 'undefined' ? window : globalThis);
