// Applies the last saved theme and accent colour before the first paint (no flash of the other one).
// A classic, render-blocking script: the bundled module script runs only after the first frame,
// and an inline script would be blocked by the CSP (script-src 'self'). Mirrors applyTheme() /
// readThemeMirror() and applyAccent() / readAccentMirror() in src/lib/theme.ts; the backend
// settings replace them once loaded.
(function () {
  try {
    var t = localStorage.getItem("s3x.theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    var a = localStorage.getItem("s3x.accent");
    if (a === "green" || a === "blue" || a === "red") document.documentElement.setAttribute("data-accent", a);
  } catch (e) {
    /* storage unavailable: System until the backend value loads */
  }
})();
