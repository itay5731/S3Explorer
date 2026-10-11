import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyAccent, applyTheme, readAccentMirror, readThemeMirror } from "./lib/theme";
import { isAlwaysPrevented } from "./lib/keys";
import "@fontsource-variable/rubik";
import "@fontsource-variable/gabarito";
import "./styles.css";

// Apply the last saved theme before the first render so there is no flash of the wrong theme.
// The backend value replaces it once `get_settings` resolves.
applyTheme(readThemeMirror());
applyAccent(readAccentMirror());

// The webview's reload, print, find, view-source and history keys never act, whatever is focused
// and whether or not a binding uses them (see "Keyboard" in docs/CONTRACT.md). Registered first, in
// the capture phase, so no handler can stop it; the explorer's dispatcher still sees these keys.
window.addEventListener(
  "keydown",
  (e) => {
    if (isAlwaysPrevented(e)) e.preventDefault();
  },
  true,
);

// The extra mouse buttons (3 Back, 4 Forward) never navigate the webview, bound or not, and never
// reach the page as clicks (a dialog's backdrop would close on them). Listeners on the window itself
// still see them: the explorer's mouse chords and the recorder in Settings → Keyboard.
for (const type of ["mousedown", "mouseup", "auxclick"] as const) {
  window.addEventListener(
    type,
    (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
