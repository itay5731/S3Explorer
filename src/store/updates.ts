// Update checks and installation (see "Updates" and "Update popup" in docs/CONTRACT.md). Lives in
// its own store so install progress events only re-render the Updates tab.

import { create } from "zustand";
import * as api from "../lib/api";
import { releaseNotes } from "../lib/changelog";
import type { AppError, UpdateInfo, UpdatePhase } from "../lib/types";
import { readPref, writePref } from "./prefs";

/** The version the user last saw running: "What's new" shows once when it changes. */
const SEEN_KEY = "s3x.seenVersion";
/** The update the user answered "Later" to: the popup opens again only for a newer one. */
export const LATER_KEY = "s3x.updateLaterVersion";

/** Compare two versions (`0.8.0`, `v0.10.1`, `1.0.0-rc.1`): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  // A pre-release comes before its release.
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Should the popup open for this version, or did the user say Later to it (or a newer one)? */
function laterSaidFor(version: string | null): boolean {
  const later = readPref<string | null>(LATER_KEY, null);
  return typeof later === "string" && !!version && compareVersions(version, later) <= 0;
}

/** Has this window's storage any preference of an earlier version (so this is not a fresh install)? */
function hasEarlierPreferences(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("s3x.") && k !== SEEN_KEY && !k.startsWith("s3x.mock.")) return true;
    }
  } catch {
    /* storage unavailable: treat as a fresh install */
  }
  return false;
}
/**
 * Read once when the app starts, before anything of this session is written (the theme mirror is
 * written as soon as the settings load), so a fresh install is told apart from an upgrade.
 */
const EXISTING_USER_AT_START = hasEarlierPreferences();


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
  /** Whether the version dialog ("What's new" and/or the update offer) is on screen. */
  dialog: boolean;
  /** The running version's patch notes, while "What's new" is due. */
  whatsNew: string | null;
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
  dialog: false,
  whatsNew: null,
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
 * opens the update popup. Never installs anything.
 */
export async function checkForUpdates({ silent = false } = {}): Promise<void> {
  if (get().status === "checking" || get().install) return;
  if (!silent) set({ status: "checking", error: null, installError: null });
  try {
    const info = await api.checkForUpdate();
    set({ status: "done", info, error: null, checkedAt: Date.now(), version: info.currentVersion });
    if (silent && info.available) {
      // The title-bar pill always shows; the dialog opens (taking the place of "What's new" if that is
      // up) unless the user said Later to this version.
      if (laterSaidFor(info.latestVersion)) set({ notice: true });
      else set({ notice: true, dialog: true });
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

/** Reopen the version dialog (the title-bar pill). */
export const openUpdateDialog = () => set({ dialog: true });

/**
 * Close the version dialog; "What's new" is done with (the update offer stays in the title-bar pill).
 * Closing the update offer (Later, Esc, the backdrop) remembers its version: the popup opens again at
 * launch only for a newer one.
 */
export function closeUpdateDialog() {
  const { notice, info } = get();
  if (notice && info?.available && info.latestVersion) writePref(LATER_KEY, info.latestVersion);
  set({ dialog: false, whatsNew: null });
}

/**
 * Once per version: the first launch after an update shows what changed, from the changelog
 * bundled with the app. A launch without a recorded version shows it too when other preferences
 * exist (an upgrade from a version that did not record it); only a fresh install just records it.
 */
export async function checkWhatsNew(): Promise<void> {
  await loadVersion();
  const version = get().version;
  if (!version) return;
  const seen = readPref<string | null>(SEEN_KEY, null);
  if (seen === version) return;
  const existingUser = seen !== null || EXISTING_USER_AT_START;
  writePref(SEEN_KEY, version);
  if (!existingUser) return;
  const notes = releaseNotes(version);
  if (notes) set({ dialog: true, whatsNew: notes });
}

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
