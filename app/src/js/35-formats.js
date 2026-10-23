/* Format dispatcher: picks a reader by extension and file signature. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  EEG.formats = EEG.formats || {};

  EEG.formats.SUPPORTED = 'EDF, EDF+, BDF, BDF+';
  EEG.formats.ACCEPT = '.edf,.EDF,.bdf,.BDF,.rec,.REC,.bqm';

  EEG.formats.open = async function (file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const sig = String.fromCharCode(...head);
    const isEdf = sig.startsWith('0       ') || (head[0] === 0xff && sig.slice(1, 8) === 'BIOSEMI');
    if (isEdf || ext === 'edf' || ext === 'bdf' || ext === 'rec') return EEG.formats.EdfSource.open(file);
    throw new Error(`Unsupported file type ".${ext}". Supported: ${EEG.formats.SUPPORTED}.`);
  };
})(typeof window !== 'undefined' ? window : globalThis);
