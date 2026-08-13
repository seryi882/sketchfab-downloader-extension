/**
 * Isolated-world document_start.
 * Viewer capture now lives in content/viewer-inject.js (world: MAIN).
 * This file only pings the page hook after it should exist.
 */
(function () {
  try {
    window.postMessage({ source: "sf-dl-hook", type: "sf-tex-ping" }, "*");
  } catch (_) {}
})();
