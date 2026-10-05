// In-app clipboard for Copy / Cut / Paste of objects and folders. Never touches the OS
// clipboard. Survives navigation between folders and buckets; cleared on disconnect.

import { create } from "zustand";

export interface ClipItem {
  /** Exactly ObjectEntry.key or FolderEntry.prefix, never rewritten. */
  key: string;
  isPrefix: boolean;
  /** ObjectEntry.name / FolderEntry.name: the last segment, used to build the destination. */
  name: string;
}

export interface Clip {
  mode: "copy" | "cut";
  bucket: string;
  /** Folder the items were taken from (the listing prefix at the time). */
  prefix: string;
  items: ClipItem[];
  /** Keys/prefixes of the items, for the "cut" row indicator. */
  ids: Set<string>;
}

export const useClipboard = create<{ clip: Clip | null }>(() => ({ clip: null }));

export function setClipboard(mode: Clip["mode"], bucket: string, prefix: string, items: ClipItem[]) {
  useClipboard.setState({ clip: { mode, bucket, prefix, items, ids: new Set(items.map((i) => i.key)) } });
}

export function clearClipboard() {
  if (useClipboard.getState().clip) useClipboard.setState({ clip: null });
}
