/* Bootstrap. */
(function (G) {
  'use strict';
  const start = () => {
    const app = new G.EEG.App();
    G.eegApp = app;
    app.init();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
