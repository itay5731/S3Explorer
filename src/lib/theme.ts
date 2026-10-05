// Theme handling. The backend's `theme` setting is the source of truth; a copy is mirrored in
// localStorage only so the right theme can be applied before the first render (no flash).
// See "App settings" in docs/CONTRACT.md.

import { useSyncExternalStore } from "react";
import type { ThemeMode } from "./types";

const MIRROR_KEY = "s3x.theme";
const MODES: readonly ThemeMode[] = ["system", "light", "dark"];

export const isThemeMode = (v: unknown): v is ThemeMode => typeof v === "string" && MODES.includes(v as ThemeMode);

/** `data-theme="light" | "dark"` forces a theme; no attribute lets `prefers-color-scheme` decide. */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export function readThemeMirror(): ThemeMode {
  try {
    const v = localStorage.getItem(MIRROR_KEY);
    return isThemeMode(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function writeThemeMirror(mode: ThemeMode): void {
  try {
    localStorage.setItem(MIRROR_KEY, mode);
  } catch {
    /* storage unavailable: the backend value still applies after load */
  }
}

// ---- OS preference (for labels like "System (Dark)") ----------------------------------

const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

function subscribe(cb: () => void) {
  query?.addEventListener("change", cb);
  return () => query?.removeEventListener("change", cb);
}
const osTheme = (): "light" | "dark" => (query?.matches ? "light" : "dark");

/** The OS color scheme, updated live when the user changes it. */
export function useOsTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, osTheme, osTheme);
}
