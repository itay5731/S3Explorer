import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyAccent, applyTheme, readAccentMirror, readThemeMirror } from "./lib/theme";
import "@fontsource-variable/rubik";
import "@fontsource-variable/gabarito";
import "./styles.css";

// Apply the last saved theme before the first render so there is no flash of the wrong theme.
// The backend value replaces it once `get_settings` resolves.
applyTheme(readThemeMirror());
applyAccent(readAccentMirror());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
