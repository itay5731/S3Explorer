// App settings: loaded once at app start (independent of the connection) and saved through
// `update_settings`. The backend owns persistence and validation.

import { create } from "zustand";
import * as api from "../lib/api";
import { applyAccent, applyTheme, readAccentMirror, readThemeMirror, writeAccentMirror, writeThemeMirror } from "../lib/theme";
import type { AppError, AppSettings } from "../lib/types";
import { migrateClassicOverrides } from "../lib/keys";
import { toast } from "./toasts";

export type SettingsTabId = "transfers" | "behavior" | "appearance" | "notifications" | "keyboard" | "updates";

interface SettingsState {
  /** Last values confirmed by the backend; null until the first load succeeds. */
  settings: AppSettings | null;
  loading: boolean;
  error: AppError | null;
  saving: boolean;
  /** Whether the Settings dialog is open. */
  open: boolean;
  /** Tab the dialog opens on. */
  initialTab: SettingsTabId;
}

export const useSettings = create<SettingsState>(() => ({
  settings: null,
  loading: false,
  error: null,
  saving: false,
  open: false,
  initialTab: "transfers",
}));

const set = useSettings.setState;

/**
 * Apply the text settings: the size scales the whole interface through the webview's zoom, and the
 * weight goes to ordinary text through a CSS variable (see `body` in styles.css).
 */
export function applyTextStyle(size: number, weight: number) {
  document.documentElement.style.setProperty("--text-weight", String(weight));
  api.setZoom(size / 100).catch(() => {});
}

/** Apply the confirmed look and refresh the pre-render mirrors. Skipped while the dialog previews one. */
function syncTheme(settings: AppSettings) {
  writeThemeMirror(settings.theme);
  writeAccentMirror(settings.accent);
  if (useSettings.getState().open) return;
  applyTheme(settings.theme);
  applyAccent(settings.accent);
  applyTextStyle(settings.textSize, settings.textWeight);
}

export async function loadSettings(): Promise<void> {
  set({ loading: true, error: null });
  try {
    const settings = await api.getSettings();
    set({ settings, loading: false });
    syncTheme(settings);
    void migrateKeybindings(settings);
  } catch (e) {
    set({ loading: false, error: e as AppError });
  }
}

/**
 * v0.9.0: the one default map is Total Commander. An upgraded install (`keybindingsPreset: "classic"`)
 * keeps its shortcuts: its effective map is written as overrides against the Commander defaults and
 * saved with "commander", once, with a toast. If the save fails it is tried again at the next start
 * (meanwhile the classic map keeps applying, so nothing changes for the user).
 */
async function migrateKeybindings(s: AppSettings) {
  if (s.keybindingsPreset === "commander") return;
  try {
    await saveSettings({ ...s, keybindings: migrateClassicOverrides(s.keybindings), keybindingsPreset: "commander" });
    toast.info("Your keyboard shortcuts were kept. Reset all in Settings → Keyboard switches to the Total Commander layout.");
  } catch {
    /* kept as is; tried again next time */
  }
}

/** Save and store the values the backend returns. Rejects with the `AppError` on failure. */
export async function saveSettings(next: AppSettings): Promise<AppSettings> {
  set({ saving: true });
  try {
    const settings = await api.updateSettings(next);
    set({ settings, saving: false, error: null });
    writeThemeMirror(settings.theme);
    writeAccentMirror(settings.accent);
    return settings;
  } catch (e) {
    set({ saving: false });
    throw e as AppError;
  }
}

export const openSettings = (tab: SettingsTabId = "transfers") => {
  set({ open: true, initialTab: tab });
  const s = useSettings.getState();
  if (!s.settings && !s.loading) void loadSettings();
};

/** Close the dialog and drop any live theme preview in favor of the saved theme. */
export const closeSettings = () => {
  set({ open: false });
  const saved = useSettings.getState().settings;
  applyTheme(saved?.theme ?? readThemeMirror());
  applyAccent(saved?.accent ?? readAccentMirror());
  if (saved) applyTextStyle(saved.textSize, saved.textWeight);
};
