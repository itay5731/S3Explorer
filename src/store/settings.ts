// App settings: loaded once at app start (independent of the connection) and saved through
// `update_settings`. The backend owns persistence and validation.

import { create } from "zustand";
import * as api from "../lib/api";
import { applyTheme, readThemeMirror, writeThemeMirror } from "../lib/theme";
import type { AppError, AppSettings } from "../lib/types";

export type SettingsTabId = "transfers" | "appearance" | "updates";

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

/** Apply the confirmed theme and refresh the pre-render mirror. Skipped while the dialog previews one. */
function syncTheme(settings: AppSettings) {
  writeThemeMirror(settings.theme);
  if (!useSettings.getState().open) applyTheme(settings.theme);
}

export async function loadSettings(): Promise<void> {
  set({ loading: true, error: null });
  try {
    const settings = await api.getSettings();
    set({ settings, loading: false });
    syncTheme(settings);
  } catch (e) {
    set({ loading: false, error: e as AppError });
  }
}

/** Save and store the values the backend returns. Rejects with the `AppError` on failure. */
export async function saveSettings(next: AppSettings): Promise<AppSettings> {
  set({ saving: true });
  try {
    const settings = await api.updateSettings(next);
    set({ settings, saving: false, error: null });
    writeThemeMirror(settings.theme);
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
  applyTheme(useSettings.getState().settings?.theme ?? readThemeMirror());
};
