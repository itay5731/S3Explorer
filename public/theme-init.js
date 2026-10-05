// Applies the last saved theme before the first paint (no flash of the other theme).
// A classic, render-blocking script: the bundled module script runs only after the first frame,
// and an inline script would be blocked by the CSP (script-src 'self'). Mirrors applyTheme() /
// readThemeMirror() in src/lib/theme.ts; the backend setting replaces it once loaded.
(function () {
  try {
    var t = localStorage.getItem("s3x.theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    /* storage unavailable: System until the backend value loads */
  }
})();
