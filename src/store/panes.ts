// Explorer panes (v0.7.0): everything that belongs to one view of a bucket — the bucket and folder,
// the listing, sort, filter, selection, a pending reveal and scroll request, and the search results —
// keyed by pane id. The main area shows one pane, or two side by side (see "Split view" in
// docs/CONTRACT.md). Which pane is active, and whether the view is split, live in the app store.
//
// Components inside a pane get their id from `PaneContext`; everything outside one (the toolbar, the
// details panel, the sidebar, dialogs) acts on the active pane.

import { createContext } from "react";
import { create } from "zustand";
import type { AppError, FolderEntry, LocalEntry, ObjectEntry, PaneSource, SearchResult } from "../lib/types";

export type PaneId = "a" | "b";
export const PANE_IDS: readonly PaneId[] = ["a", "b"];
export const otherPane = (id: PaneId): PaneId => (id === "a" ? "b" : "a");

export type SortKey = "name" | "size" | "modified" | "class";
export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

export interface Listing {
  folders: FolderEntry[];
  objects: ObjectEntry[];
  token: string | null;
  truncated: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: AppError | null;
}

/** What a search was asked for, captured when it started (the header shows exactly this). */
export interface SearchRequest {
  bucket: string;
  /** The prefix searched under; "" = the whole bucket. */
  scope: string;
  text: string;
}

/** One pane's search results. While `open`, the results replace the pane's table. */
export interface PaneSearch {
  open: boolean;
  request: SearchRequest | null;
  result: SearchResult | null;
  error: AppError | null;
  loading: boolean;
  /** Bumped by every run; the results list resets its focus and scroll on change. */
  runSeq: number;
  /** Selected hits by `hitId`, the anchor for Shift ranges, and the keyboard focus. */
  selection: Set<string>;
  anchor: string | null;
  focus: string | null;
}

/**
 * One place a pane was at (see "History" in docs/CONTRACT.md): a bucket and prefix, or (v0.9.0) a
 * directory of the local computer (`local` set; `bucket` and `prefix` are then "").
 */
export interface HistoryEntry {
  bucket: string;
  prefix: string;
  local?: string;
}

/** A local pane's directory (v0.9.0, see "Pane sources" in docs/CONTRACT.md). */
export interface LocalLocation {
  /** The directory, exactly as the OS returned it (or as typed, for an edited path). */
  dir: string;
  /** Its parent directory as `list_local_dir` reported it; null at a root (or before the first listing). */
  parent: string | null;
  /** The listing stopped at the 50,000-entry cap. */
  truncated: boolean;
  /** The listed entries by path: the link badge, hidden flag and kind of each row. */
  entries: ReadonlyMap<string, LocalEntry>;
}

/** A pane's back/forward history: `entries[index]` is where the pane is now. */
export interface PaneHistory {
  entries: HistoryEntry[];
  index: number;
}

export const HISTORY_CAP = 100;
export const emptyHistory: PaneHistory = { entries: [], index: -1 };

export interface PaneState {
  /** v0.9.0: S3 (bucket + prefix) or the local computer (`local`). A local pane has `bucket` null. */
  source: PaneSource;
  /** The local directory while `source` is local; null for an S3 pane. */
  local: LocalLocation | null;
  /** List hidden files in a local pane (per pane, for the session). */
  showHidden: boolean;
  bucket: string | null;
  prefix: string;
  /**
   * The rows. In a local pane, directories are `folders` (`prefix` = the full path) and files are
   * `objects` (`key` = the full path, no ETag or storage class): the table, selection, filter and
   * sort work the same on both sources.
   */
  listing: Listing;

  selection: Set<string>;
  anchor: string | null;
  focus: string | null;

  sort: SortState;
  filter: string;

  /** An object to select once the page that holds it is loaded (opening a newest file). */
  reveal: string | null;
  /** Ask the table to scroll a row into view; `seq` makes repeated requests distinct. */
  scrollTo: { id: string; seq: number } | null;

  search: PaneSearch;

  /** Back / Forward (cleared with the pane: disconnect, a new connection). */
  history: PaneHistory;

  /** The tab this state belongs to (see "Tabs" in docs/CONTRACT.md). */
  tab: number;
  /** When the listing was last fetched (ms); 0 = never. */
  listedAt: number;
}

export const emptyListing: Listing = {
  folders: [],
  objects: [],
  token: null,
  truncated: false,
  loading: false,
  loadingMore: false,
  error: null,
};

export const emptySearch: PaneSearch = {
  open: false,
  request: null,
  result: null,
  error: null,
  loading: false,
  runSeq: 0,
  selection: new Set(),
  anchor: null,
  focus: null,
};

/**
 * Every pane, tab and new source starts sorted by Name, ascending. The sort is per pane and lasts
 * only for the session (a stored `s3x.sort` from earlier versions is ignored).
 */
export const DEFAULT_SORT: SortState = { key: "name", dir: 1 };

export const S3_SOURCE: PaneSource = { kind: "s3" };
export const LOCAL_SOURCE: PaneSource = { kind: "local" };

/** Is this pane (or tab state) showing the local computer? */
export const isLocalPane = (p: Pick<PaneState, "source" | "local">): p is Pick<PaneState, "source"> & { local: LocalLocation } =>
  p.source.kind === "local" && p.local !== null;

/** Does a pane (or tab state) show anything: a bucket, or a local directory? */
export const paneHasLocation = (p: Pick<PaneState, "bucket" | "source" | "local">) => p.bucket !== null || isLocalPane(p);

let tabSeq = 0;
/** A tab id, unique for the session. */
export const newTabId = () => ++tabSeq;

/** A pane with nothing open. The sort order is the saved one (shared by both panes as a default). */
export function freshPane(sort: SortState = DEFAULT_SORT): PaneState {
  return {
    source: S3_SOURCE,
    local: null,
    showHidden: false,
    bucket: null,
    prefix: "",
    listing: emptyListing,
    selection: new Set(),
    anchor: null,
    focus: null,
    sort,
    filter: "",
    reveal: null,
    scrollTo: null,
    search: emptySearch,
    history: emptyHistory,
    tab: newTabId(),
    listedAt: 0,
  };
}

export type PanesState = Record<PaneId, PaneState>;

export const usePanes = create<PanesState>(() => ({ a: freshPane(), b: freshPane() }));

// ---- tabs ----------------------------------------------------------------------------------
// A pane's shown tab lives in `usePanes` (so everything that reads a pane reads its shown tab); the
// others wait here with their whole state until they are shown again (see store/tabs.ts).

export interface TabEntry {
  id: number;
  /** The tab's state while it is hidden; null for the shown tab (its state is the pane's). */
  saved: PaneState | null;
  /** Something changed the tab's folder while it was hidden: refresh it when it is shown. */
  stale: boolean;
  /** A move or delete may have taken the tab's folder away: check when it is shown. */
  vanished: boolean;
  /** The table's scroll position when the tab was hidden. */
  scrollTop: number;
}

export const tabEntry = (id: number, saved: PaneState | null = null): TabEntry => ({ id, saved, stale: false, vanished: false, scrollTop: 0 });

export type PaneTabs = Record<PaneId, TabEntry[]>;

export const usePaneTabs = create<PaneTabs>(() => ({
  a: [tabEntry(usePanes.getState().a.tab)],
  b: [tabEntry(usePanes.getState().b.tab)],
}));

/** A hidden tab, with its saved state. */
export type HiddenTab = TabEntry & { saved: PaneState };

/**
 * Patch hidden tabs: `fn` returns the changes for a tab, or null to leave it. Used by the effects of
 * jobs, uploads and new folders, which refresh shown panes directly.
 */
export function updateHiddenTabs(fn: (t: HiddenTab, pane: PaneId) => Partial<TabEntry> | null) {
  const cur = usePaneTabs.getState();
  let changed = false;
  const next = { ...cur };
  for (const pane of PANE_IDS) {
    const list = cur[pane].map((t) => {
      if (!t.saved) return t;
      const patch = fn(t as HiddenTab, pane);
      if (!patch || Object.entries(patch).every(([k, v]) => t[k as keyof TabEntry] === v)) return t;
      changed = true;
      return { ...t, ...patch };
    });
    next[pane] = list;
  }
  if (changed) usePaneTabs.setState(next);
}

/** Mark hidden tabs whose location passes `test` for a refresh when they are shown. */
export function markHiddenTabsStale(test: (bucket: string, prefix: string) => boolean) {
  updateHiddenTabs((t) => (t.saved.bucket !== null && test(t.saved.bucket, t.saved.prefix) ? { stale: true } : null));
}

/** The pane a component is rendered in; null outside a pane (it then follows the active pane). */
export const PaneContext = createContext<PaneId | null>(null);

// ---- listing lookups -----------------------------------------------------------------------

export const folderId = (f: FolderEntry) => f.prefix;
export const objectId = (o: ObjectEntry) => o.key;

const entryIndexes = new WeakMap<readonly unknown[], Map<string, number>>();

/**
 * Where each entry of a listing array is, by id (a folder's prefix, an object's key; the first one
 * wins). Built once per array, so selection-sized work never scans the whole listing again.
 */
export function entryIndex<T>(entries: readonly T[], id: (t: T) => string): Map<string, number> {
  let m = entryIndexes.get(entries);
  if (!m) {
    m = new Map();
    for (let i = 0; i < entries.length; i++) {
      const k = id(entries[i]);
      if (!m.has(k)) m.set(k, i);
    }
    entryIndexes.set(entries, m);
  }
  return m;
}
