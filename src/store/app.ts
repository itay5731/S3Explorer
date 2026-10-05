// Session + browsing + UI state. Transfers live in ./transfers.ts.

import { create } from "zustand";
import * as api from "../lib/api";
import type { AppError, Bucket, ConnectionInfo, FolderEntry, ObjectEntry } from "../lib/types";
import { asFolderPrefix } from "../lib/format";

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

export type Modal = { kind: "newFolder" } | { kind: "deleteFolder"; prefix: string } | null;

export interface ContextMenuState {
  x: number;
  y: number;
}

interface AppState {
  connection: ConnectionInfo | null;
  buckets: Bucket[];
  bucketsLoading: boolean;
  bucketsError: AppError | null;
  /** Buckets typed by hand when ListBuckets is denied. */
  manualBuckets: string[];

  bucket: string | null;
  prefix: string;
  listing: Listing;

  selection: Set<string>;
  anchor: string | null;
  focus: string | null;

  sort: SortState;
  filter: string;

  detailsOpen: boolean;
  transfersOpen: boolean;
  modal: Modal;
  contextMenu: ContextMenuState | null;
}

const emptyListing: Listing = {
  folders: [],
  objects: [],
  token: null,
  truncated: false,
  loading: false,
  loadingMore: false,
  error: null,
};

const PAGE_SIZE = 1000;

const readPref = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
export const writePref = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
};

export const useApp = create<AppState>(() => ({
  connection: null,
  buckets: [],
  bucketsLoading: false,
  bucketsError: null,
  manualBuckets: [],
  bucket: null,
  prefix: "",
  listing: emptyListing,
  selection: new Set(),
  anchor: null,
  focus: null,
  sort: readPref<SortState>("s3x.sort", { key: "name", dir: 1 }),
  filter: "",
  detailsOpen: readPref("s3x.detailsOpen", true),
  transfersOpen: false,
  modal: null,
  contextMenu: null,
}));

const set = useApp.setState;
const get = useApp.getState;

let listSeq = 0;

/**
 * Fetch one page, but keep following the continuation token while the backend returns
 * empty-but-truncated pages (e.g. a page whose only key was the hidden folder marker).
 */
async function fetchPage(bucket: string, prefix: string, token: string | null, seq: number) {
  let page = await api.listObjects(bucket, prefix, token, PAGE_SIZE);
  let guard = 0;
  while (page.isTruncated && page.nextContinuationToken && !page.folders.length && !page.objects.length && guard++ < 50) {
    if (seq !== listSeq) break;
    page = await api.listObjects(bucket, prefix, page.nextContinuationToken, PAGE_SIZE);
  }
  return page;
}

// ---- connection ------------------------------------------------------------------

export function setConnected(info: ConnectionInfo) {
  set({
    connection: info,
    buckets: [],
    bucketsError: null,
    manualBuckets: info.canListBuckets ? [] : readPref<string[]>(`s3x.manualBuckets.${info.label}`, []),
    bucket: null,
    prefix: "",
    listing: emptyListing,
    selection: new Set(),
    filter: "",
  });
  if (info.canListBuckets) void loadBuckets();
}

export async function disconnect() {
  try {
    await api.disconnect();
  } catch {
    /* disconnect is best effort */
  }
  listSeq++;
  set({ connection: null, buckets: [], bucket: null, prefix: "", listing: emptyListing, selection: new Set() });
}

export async function loadBuckets() {
  set({ bucketsLoading: true, bucketsError: null });
  try {
    const buckets = await api.listBuckets();
    buckets.sort((a, b) => a.name.localeCompare(b.name));
    set({ buckets, bucketsLoading: false });
  } catch (e) {
    set({ bucketsLoading: false, bucketsError: e as AppError });
  }
}

export function addManualBucket(name: string) {
  const n = name.trim();
  if (!n) return;
  const { manualBuckets, connection } = get();
  const next = manualBuckets.includes(n) ? manualBuckets : [...manualBuckets, n];
  set({ manualBuckets: next });
  if (connection) writePref(`s3x.manualBuckets.${connection.label}`, next);
  navigate(n, "");
}

export function removeManualBucket(name: string) {
  const { manualBuckets, connection, bucket } = get();
  const next = manualBuckets.filter((b) => b !== name);
  set({ manualBuckets: next });
  if (connection) writePref(`s3x.manualBuckets.${connection.label}`, next);
  if (bucket === name) set({ bucket: null, prefix: "", listing: emptyListing });
}

// ---- navigation / listing ------------------------------------------------------------

export function navigate(bucket: string, prefix: string) {
  // Server-provided prefixes are used verbatim (see asFolderPrefix / normalizePrefix).
  const p = asFolderPrefix(prefix);
  set({
    bucket,
    prefix: p,
    selection: new Set(),
    anchor: null,
    focus: null,
    filter: "",
    contextMenu: null,
  });
  void loadFirstPage();
}

export function refresh() {
  void loadFirstPage(true);
}

async function loadFirstPage(keepSelection = false) {
  const { bucket, prefix } = get();
  if (!bucket) return;
  const seq = ++listSeq;
  set((s) => ({
    listing: keepSelection
      ? { ...s.listing, loading: true, error: null }
      : { ...emptyListing, loading: true },
  }));
  try {
    const page = await fetchPage(bucket, prefix, null, seq);
    if (seq !== listSeq) return;
    set((s) => {
      // Keep only selected ids that still exist.
      const ids = new Set<string>([...page.folders.map((f) => f.prefix), ...page.objects.map((o) => o.key)]);
      const selection = new Set([...s.selection].filter((id) => ids.has(id)));
      return {
        listing: {
          folders: page.folders,
          objects: page.objects,
          token: page.nextContinuationToken,
          truncated: page.isTruncated,
          loading: false,
          loadingMore: false,
          error: null,
        },
        selection,
      };
    });
  } catch (e) {
    if (seq !== listSeq) return;
    set({ listing: { ...emptyListing, error: e as AppError } });
  }
}

export async function loadMore() {
  const { bucket, prefix, listing } = get();
  if (!bucket || !listing.truncated || !listing.token || listing.loadingMore || listing.loading) return;
  const seq = listSeq;
  set({ listing: { ...listing, loadingMore: true } });
  try {
    const page = await fetchPage(bucket, prefix, listing.token, seq);
    if (seq !== listSeq) return;
    const cur = get().listing;
    // De-duplicate: entries upserted locally (finished uploads, new folders) may also arrive in a later page.
    const haveFolders = new Set(cur.folders.map((f) => f.prefix));
    const haveObjects = new Set(cur.objects.map((o) => o.key));
    set({
      listing: {
        ...cur,
        folders: cur.folders.concat(page.folders.filter((f) => !haveFolders.has(f.prefix))),
        objects: cur.objects.concat(page.objects.filter((o) => !haveObjects.has(o.key))),
        token: page.nextContinuationToken,
        truncated: page.isTruncated,
        loadingMore: false,
      },
    });
  } catch (e) {
    if (seq !== listSeq) return;
    set({ listing: { ...get().listing, loadingMore: false, error: e as AppError } });
  }
}

/** Insert or update an object in the current listing (after an upload completes). */
export function upsertListedObject(bucket: string, obj: ObjectEntry) {
  const s = get();
  if (s.bucket !== bucket || s.listing.loading) return;
  const objects = s.listing.objects.slice();
  const i = objects.findIndex((o) => o.key === obj.key);
  if (i >= 0) objects[i] = obj;
  else objects.push(obj);
  set({ listing: { ...s.listing, objects } });
}

/** Ensure a sub-folder entry exists in the current listing (after an upload into a new sub-path). */
export function upsertListedFolder(bucket: string, folder: FolderEntry) {
  const s = get();
  if (s.bucket !== bucket || s.listing.loading) return;
  if (s.listing.folders.some((f) => f.prefix === folder.prefix)) return;
  set({ listing: { ...s.listing, folders: [...s.listing.folders, folder] } });
}

// ---- selection / view -----------------------------------------------------------------

export function setSelection(selection: Set<string>, anchor: string | null, focus: string | null) {
  set({ selection, anchor, focus });
}

export function setSort(key: SortKey) {
  const cur = get().sort;
  const sort: SortState = cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: key === "modified" || key === "size" ? -1 : 1 };
  set({ sort });
  writePref("s3x.sort", sort);
}

export function setFilter(filter: string) {
  set({ filter });
}

export function setDetailsOpen(open: boolean) {
  set({ detailsOpen: open });
  writePref("s3x.detailsOpen", open);
}

export function setTransfersOpen(open: boolean) {
  set({ transfersOpen: open });
}

export function openModal(modal: Modal) {
  set({ modal, contextMenu: null });
}

export function openContextMenu(menu: ContextMenuState | null) {
  set({ contextMenu: menu });
}
