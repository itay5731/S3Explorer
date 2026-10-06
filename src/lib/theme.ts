// Theme handling. The backend's `theme` setting is the source of truth; a copy is mirrored in
// localStorage only so the right theme can be applied before the first render (no flash).
// See "App settings" in docs/CONTRACT.md.

import { useSyncExternalStore } from "react";
import { ACCENT_COLORS, type AccentColor, type ThemeMode } from "./types";

// Keep in sync with public/theme-init.js, which applies the mirror before the first paint.
const MIRROR_KEY = "s3x.theme";
const MODES: readonly ThemeMode[] = ["system", "light", "dark"];

export const isThemeMode = (v: unknown): v is ThemeMode => typeof v === "string" && MODES.includes(v as ThemeMode);

/** `data-theme="light" | "dark"` forces a theme; no attribute lets `prefers-color-scheme` decide. */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

/** How long the new theme takes to spread across the window (ms). */
const REVEAL_MS = 520;

/**
 * Switch theme with the new one spreading out in a circle from `origin` (window px), like ink
 * from the button that was pressed. Uses the View Transitions API: the browser snapshots the old
 * and new look, and the new snapshot is revealed through a growing clip circle. Where the API is
 * missing, or the user asked for reduced motion, the theme simply changes.
 */
export function applyThemeWithReveal(mode: ThemeMode, origin: { x: number; y: number }): void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!document.startViewTransition || reducedMotion) {
    applyTheme(mode);
    return;
  }
  // Far enough to cover the corner of the window furthest from the origin.
  const radius = Math.hypot(Math.max(origin.x, window.innerWidth - origin.x), Math.max(origin.y, window.innerHeight - origin.y));
  const transition = document.startViewTransition(() => applyTheme(mode));
  void transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`] },
      { duration: REVEAL_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
    );
  });
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

// ---- Accent colour ---------------------------------------------------------------------
// Works like the theme: an attribute on <html> picks the colour (see [data-accent] in
// styles.css), and a localStorage mirror lets it be applied before the first render.

// Keep in sync with public/theme-init.js.
const ACCENT_MIRROR_KEY = "s3x.accent";

export function applyAccent(accent: AccentColor): void {
  document.documentElement.setAttribute("data-accent", accent);
}

export function readAccentMirror(): AccentColor {
  try {
    const v = localStorage.getItem(ACCENT_MIRROR_KEY);
    return ACCENT_COLORS.find((c) => c === v) ?? "yellow";
  } catch {
    return "yellow";
  }
}

export function writeAccentMirror(accent: AccentColor): void {
  try {
    localStorage.setItem(ACCENT_MIRROR_KEY, accent);
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
