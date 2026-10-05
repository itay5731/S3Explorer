// Transfer settings: loaded once at app start (independent of the connection) and
// saved through `update_settings`. The backend owns persistence and validation.

import { create } from "zustand";
import * as api from "../lib/api";
import type { AppError, TransferSettings } from "../lib/types";

interface SettingsState {
  /** Last values confirmed by the backend; null until the first load succeeds. */
  settings: TransferSettings | null;
  loading: boolean;
  error: AppError | null;
  saving: boolean;
  /** Whether the Settings dialog is open. */
  open: boolean;
}

export const useSettings = create<SettingsState>(() => ({
  settings: null,
  loading: false,
  error: null,
  saving: false,
  open: false,
}));

const set = useSettings.setState;

export async function loadSettings(): Promise<void> {
  set({ loading: true, error: null });
  try {
    const settings = await api.getSettings();
    set({ settings, loading: false });
  } catch (e) {
    set({ loading: false, error: e as AppError });
  }
}

/** Save and store the values the backend returns. Rejects with the `AppError` on failure. */
export async function saveSettings(next: TransferSettings): Promise<TransferSettings> {
  set({ saving: true });
  try {
    const settings = await api.updateSettings(next);
    set({ settings, saving: false, error: null });
    return settings;
  } catch (e) {
    set({ saving: false });
    throw e as AppError;
  }
}

export const openSettings = () => {
  set({ open: true });
  const s = useSettings.getState();
  if (!s.settings && !s.loading) void loadSettings();
};
export const closeSettings = () => set({ open: false });
