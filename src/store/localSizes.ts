// Calculated sizes of local folders (v0.9.0), by path, for the session. Its own module so the table's
// sort (./view.ts) can read it without importing the local-pane actions (./local.ts).

import { create } from "zustand";
import { clientOS } from "../lib/api";
import type { AppError, LocalDirSize } from "../lib/types";

export interface LocalSizeEntry {
  size: LocalDirSize | null;
  running: boolean;
  error: AppError | null;
}

export const useLocalSizes = create<{ byPath: Record<string, LocalSizeEntry> }>(() => ({ byPath: {} }));

/** The cache key of a local path: case-insensitive on Windows and macOS. */
export const localSizeKey = (path: string) => (clientOS === "other" ? path : path.toLowerCase());
