import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, readThemeMirror } from "./lib/theme";
import "./styles.css";

// Apply the last saved theme before the first render so there is no flash of the wrong theme.
// The backend value replaces it once `get_settings` resolves.
applyTheme(readThemeMirror());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
