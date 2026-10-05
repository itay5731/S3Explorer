// Update checks and installation (see "Updates" in docs/CONTRACT.md). Lives in its own store so
// install progress events only re-render the Updates tab.

import { create } from "zustand";
import * as api from "../lib/api";
import type { AppError, UpdateInfo, UpdatePhase } from "../lib/types";
import { openSettings } from "./settings";
import { toast } from "./toasts";

export type CheckStatus = "idle" | "checking" | "done" | "error";

export interface InstallState {
  /** "starting" until the first progress event arrives. */
  phase: "starting" | UpdatePhase;
  downloadedBytes: number;
  totalBytes: number | null;
}

interface UpdatesState {
  /** Running app version: from the last check, or from the app metadata before that. */
  version: string | null;
  status: CheckStatus;
  info: UpdateInfo | null;
  error: AppError | null;
  checkedAt: number | null;
  install: InstallState | null;
  installError: AppError | null;
  /** An update found by the silent startup check that the user has not looked at yet. */
  notice: boolean;
}

export const useUpdates = create<UpdatesState>(() => ({
  version: null,
  status: "idle",
  info: null,
  error: null,
  checkedAt: null,
  install: null,
  installError: null,
  notice: false,
}));

const set = useUpdates.setState;
const get = useUpdates.getState;

export async function loadVersion(): Promise<void> {
  if (get().version) return;
  try {
    const version = await api.appVersion();
    if (!get().version) set({ version });
  } catch {
    /* the version line just stays empty */
  }
}

/**
 * Ask the backend for the latest release. With `silent`, failures are ignored and a found update
 * only raises a small, non-blocking notice. Never installs anything.
 */
export async function checkForUpdates({ silent = false } = {}): Promise<void> {
  if (get().status === "checking" || get().install) return;
  if (!silent) set({ status: "checking", error: null, installError: null });
  try {
    const info = await api.checkForUpdate();
    set({ status: "done", info, error: null, checkedAt: Date.now(), version: info.currentVersion });
    if (silent && info.available) {
      set({ notice: true });
      toast.info(
        `Update available: v${info.latestVersion ?? "?"}`,
        "Open Settings → Updates to see what's new.",
        { label: "View", run: () => openSettings("updates") },
      );
    }
  } catch (e) {
    if (!silent) set({ status: "error", error: e as AppError });
  }
}

/** Download, install and restart. Progress arrives through `update:progress`. */
export async function installUpdate(): Promise<void> {
  if (get().install) return;
  set({ install: { phase: "starting", downloadedBytes: 0, totalBytes: null }, installError: null });
  let unlisten: api.Unlisten | null = null;
  try {
    unlisten = await api.onUpdateProgress((p) => set({ install: { ...p } }));
    await api.installUpdate();
    // On success the backend restarts the app; nothing else to do here.
  } catch (e) {
    set({ install: null, installError: e as AppError });
  } finally {
    unlisten?.();
  }
}

export const dismissUpdateNotice = () => set({ notice: false });

const STARTUP_DELAY_MS = 3000;
let startupCheckScheduled = false;

/** Schedule the one silent check after launch (only once per app session). */
export function scheduleStartupCheck(): () => void {
  if (startupCheckScheduled) return () => {};
  startupCheckScheduled = true;
  const timer = setTimeout(() => void checkForUpdates({ silent: true }), STARTUP_DELAY_MS);
  return () => {
    clearTimeout(timer);
    startupCheckScheduled = false;
  };
}
