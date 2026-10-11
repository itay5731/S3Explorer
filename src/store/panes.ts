// Explorer panes (v0.7.0): everything that belongs to one view of a bucket — the bucket and folder,
// the listing, sort, filter, selection, a pending reveal and scroll request, and the search results —
// keyed by pane id. The main area shows one pane, or two side by side (see "Split view" in
// docs/CONTRACT.md). Which pane is active, and whether the view is split, live in the app store.
//
// Components inside a pane get their id from `PaneContext`; everything outside one (the toolbar, the
// details panel, the sidebar, dialogs) acts on the active pane.

import { createContext } from "react";
import { create } from "zustand";
import type { AppError, FolderEntry, ObjectEntry, SearchResult } from "../lib/types";
import { readPref } from "./prefs";

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

export interface PaneState {
  bucket: string | null;
  prefix: string;
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

export const SORT_KEY = "s3x.sort";

/** A pane with nothing open. The sort order is the saved one (shared by both panes as a default). */
export function freshPane(sort: SortState = readPref<SortState>(SORT_KEY, { key: "name", dir: 1 })): PaneState {
  return {
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
  };
}

export type PanesState = Record<PaneId, PaneState>;

export const usePanes = create<PanesState>(() => ({ a: freshPane(), b: freshPane() }));

/** The pane a component is rendered in; null outside a pane (it then follows the active pane). */
export const PaneContext = createContext<PaneId | null>(null);
