// Session + UI state, and the actions on the explorer panes (their state lives in ./panes.ts).
// Transfers live in ./transfers.ts.

import { useContext } from "react";
import { create } from "zustand";
import * as api from "../lib/api";
import type { AddedBucket, AppError, BatchPreview, Bucket, ConnectionInfo, FolderEntry, JobItem, JobRequest, ObjectEntry, ObjectVersion } from "../lib/types";
import { asFolderPrefix } from "../lib/format";
import { clearClipboard } from "./clipboard";
import { selectActiveBatchCount, useBatches } from "./batches";
import { selectActiveJobCount, useJobs } from "./jobs";
import { clearRecent } from "./recent";
import { clearArchive } from "./archive";
import { clearVersioning } from "./versions";
import { clearBookmarksConnection, forgetBookmarks, setBookmarksConnection } from "./bookmarks";
import { selectActiveCount, useTransfers } from "./transfers";
import { emptyListing, emptySearch, freshPane, HISTORY_CAP, otherPane, PANE_IDS, PaneContext, SORT_KEY, tabEntry, usePanes, usePaneTabs, type PaneId, type PaneState, type SortKey, type SortState } from "./panes";
import { readPref, writePref } from "./prefs";

export type { Listing, PaneId, PaneState, SortKey, SortState } from "./panes";
export { readPref, writePref } from "./prefs";

/** The single item being renamed (exact server key/prefix plus its last segment). */
export interface RenameTarget {
  bucket: string;
  key: string;
  isPrefix: boolean;
  name: string;
  /** The folder it lives in: `key` minus its name (and trailing "/" for folders). */
  parent: string;
}

export type Modal =
  /** Create a folder in `bucket`/`prefix` (the pane's folder when the dialog was opened). */
  | { kind: "newFolder"; bucket: string; prefix: string }
  /** Confirm a delete job; `request` is exactly what will be sent. */
  | { kind: "delete"; request: JobRequest }
  | { kind: "rename"; target: RenameTarget }
  /** Confirm a paste (copy or move job). `renamed` = names got a "(copy)" suffix. */
  /** `clearCut` = empty the in-app clipboard once started (pasting cut items; a drag leaves it alone). */
  | { kind: "paste"; request: JobRequest; mode: "copy" | "cut"; srcPrefix: string; destPrefix: string; renamed: boolean; clearCut: boolean }
  /** Add a bucket by name ("Shared with me"). */
  | { kind: "addBucket" }
  /** Forget an added bucket (never touches the bucket). */
  | { kind: "removeBucket"; name: string }
  | { kind: "bucketTags"; bucket: string }
  /** The bucket's lifecycle rules (load, edit, confirm, save the whole configuration). */
  | { kind: "lifecycle"; bucket: string }
  | { kind: "objectTags"; bucket: string; key: string }
  /** Edit one object's content type and metadata (a copy onto itself, confirmed before it runs). */
  | { kind: "editMetadata"; bucket: string; key: string }
  /** Tag several objects at once (a "tag" job). `items` are exact keys/prefixes from the selection. */
  | { kind: "bulkTags"; bucket: string; prefix: string; items: JobItem[] }
  /** Upload a local folder (a batch). `localPath` came from the picker or an OS drop. */
  | { kind: "uploadFolder"; bucket: string; prefix: string; localPath: string; initialPreview?: BatchPreview; initialDest?: string }
  /** Download folders (one batch each) into `dir`. `folders` are exact prefixes from the listing. */
  | { kind: "downloadFolders"; bucket: string; folders: FolderEntry[]; dir: string }
  /** Disconnect while transfers or jobs are still running. */
  | { kind: "disconnect"; running: number }
  /** Restore one archived object (restore_object). */
  | { kind: "restore"; bucket: string; key: string; storageClass: string | null }
  /** Restore the archived objects in a selection (a "restore" job). `items` are exact keys/prefixes. */
  | { kind: "bulkRestore"; bucket: string; prefix: string; items: JobItem[]; deepArchive: boolean; allDeep: boolean }
  /** Confirm an action on one version of an object (shown from the details panel). */
  | { kind: "versionAction"; action: "restore" | "delete" | "undelete"; bucket: string; key: string; version: ObjectVersion; onlyVersion: boolean; previousIsMarker: boolean }
  /** Quick look: a large preview of the selected object; it follows the selection while open. */
  | { kind: "quickLook" }
  | null;

/** Modals that make sense without an open bucket. */
export const BUCKETLESS_MODALS: ReadonlySet<NonNullable<Modal>["kind"]> = new Set(["addBucket", "removeBucket", "bucketTags", "lifecycle", "disconnect"]);

export interface ContextMenuState {
  x: number;
  y: number;
}

interface AppState {
  connection: ConnectionInfo | null;
  buckets: Bucket[];
  bucketsLoading: boolean;
  bucketsError: AppError | null;
  /** Buckets added by name for this connection ("Shared with me"; the whole list when ListBuckets is denied). */
  addedBuckets: AddedBucket[];
  addedLoading: boolean;
  addedError: AppError | null;

  /** The pane the toolbar, details panel, sidebar, shortcuts and dialogs act on. */
  activePane: PaneId;
  /** Two panes side by side (saved as `s3x.split`). */
  split: boolean;
  /** The main area is too narrow for two panes: the other one is hidden (not closed). */
  narrow: boolean;

  detailsOpen: boolean;
  transfersOpen: boolean;
  modal: Modal;
  contextMenu: ContextMenuState | null;
}

const PAGE_SIZE = 1000;
export const SPLIT_KEY = "s3x.split";

export const useApp = create<AppState>(() => ({
  connection: null,
  buckets: [],
  bucketsLoading: false,
  bucketsError: null,
  addedBuckets: [],
  addedLoading: false,
  addedError: null,
  activePane: "a",
  split: readPref(SPLIT_KEY, false),
  narrow: false,
  detailsOpen: readPref("s3x.detailsOpen", true),
  transfersOpen: false,
  modal: null,
  contextMenu: null,
}));

const set = useApp.setState;
const get = useApp.getState;

// ---- panes ---------------------------------------------------------------------------------

/** The active pane's id. */
export const activePane = (): PaneId => get().activePane;

/** A pane's state (default: the active pane). */
export function getPane(id: PaneId = activePane()): PaneState {
  return usePanes.getState()[id];
}

/** Merge a patch into one pane. */
export function setPane(id: PaneId, patch: Partial<PaneState> | ((p: PaneState) => Partial<PaneState>)) {
  usePanes.setState((s) => {
    const cur = s[id];
    const next = typeof patch === "function" ? patch(cur) : patch;
    return { [id]: { ...cur, ...next } } as Partial<Record<PaneId, PaneState>>;
  });
}

/** Two panes are on screen (split, and wide enough for both). */
export const isSplitShown = (s: Pick<AppState, "split" | "narrow"> = get()) => s.split && !s.narrow;

/** Is this pane on screen? Without a visible split only the active pane is. */
export function isPaneShown(id: PaneId, s: Pick<AppState, "split" | "narrow" | "activePane"> = get()): boolean {
  return isSplitShown(s) || s.activePane === id;
}

/** The other pane when two are on screen; null in single view. */
export function shownOtherPane(): PaneId | null {
  return isSplitShown() ? otherPane(activePane()) : null;
}

/** Make a pane the active one (a click, focus or navigation in it). */
export function setActivePane(id: PaneId) {
  if (get().activePane !== id && isPaneShown(id)) set({ activePane: id });
}

/** The pane a component renders in, or the active pane outside one. */
export function usePaneId(): PaneId {
  const ctx = useContext(PaneContext);
  const active = useApp((s) => s.activePane);
  return ctx ?? active;
}

/** Subscribe to a slice of this component's pane (see usePaneId). */
export function usePane<T>(selector: (p: PaneState) => T): T {
  const id = usePaneId();
  return usePanes((s) => selector(s[id]));
}

const listSeq: Record<PaneId, number> = { a: 0, b: 0 };

const resetListeners = new Set<(pane: PaneId) => void>();
/** Called before a pane is reset (split closed, disconnect, new connection): its search stops here. */
export function onPaneReset(cb: (pane: PaneId) => void): () => void {
  resetListeners.add(cb);
  return () => resetListeners.delete(cb);
}

/**
 * Panes emptied by a reset (connect, disconnect, split opened) that have not been navigated since.
 * Only such a pane follows the other one to the first bucket opened; a pane emptied by "Remove from
 * list" stays empty.
 */
const freshPanes = new Set<PaneId>();

/** Forget everything a pane shows (stops its in-flight listing and search), and all its tabs but one. */
function resetPane(id: PaneId) {
  resetListeners.forEach((cb) => cb(id));
  freshPanes.add(id);
  listSeq[id]++;
  const fresh = { ...freshPane(getPane(id).sort), search: emptySearch };
  usePaneTabs.setState({ [id]: [tabEntry(fresh.tab)] } as Partial<Record<PaneId, never>>);
  setPane(id, fresh);
}

/** Stop a pane's listing in flight: its result is dropped (a tab of the pane is being hidden). */
export function stopListing(pane: PaneId) {
  listSeq[pane]++;
}

/**
 * Open or close the second pane. Opening shows the active pane's bucket and folder in the other
 * pane; closing keeps the active pane and drops the other one. The choice is saved.
 */
export function setSplit(on: boolean) {
  const { split, activePane: active } = get();
  writePref(SPLIT_KEY, on);
  if (on === split) return;
  const other = otherPane(active);
  resetPane(other);
  set({ split: on, contextMenu: null });
  if (on) {
    const { bucket, prefix } = getPane(active);
    if (bucket) navigate(bucket, prefix, other);
  }
}

/** The main area got narrower or wider than two panes need (hides, never closes, the other pane). */
export function setNarrow(narrow: boolean) {
  if (get().narrow !== narrow) set({ narrow });
}

/**
 * Fetch one page, but keep following the continuation token while the backend returns
 * empty-but-truncated pages (e.g. a page whose only key was the hidden folder marker).
 */
async function fetchPage(pane: PaneId, bucket: string, prefix: string, token: string | null, seq: number) {
  let page = await api.listObjects(bucket, prefix, token, PAGE_SIZE);
  let guard = 0;
  while (page.isTruncated && page.nextContinuationToken && !page.folders.length && !page.objects.length && guard++ < 50) {
    if (seq !== listSeq[pane]) break;
    page = await api.listObjects(bucket, prefix, page.nextContinuationToken, PAGE_SIZE);
  }
  return page;
}

// ---- connection ------------------------------------------------------------------

/** The saved connection the app is connected through (null: connected without saving, or not connected). */
let savedConnectionId: string | null = null;

const connectionListeners = new Set<(key: string | null) => void>();
/**
 * Called with a key that identifies the connection once it is set up (panes reset, connection set),
 * and with null before panes are reset for a new connection or a disconnect (remembered tabs).
 */
export function onConnectionChange(cb: (key: string | null) => void): () => void {
  connectionListeners.add(cb);
  return () => connectionListeners.delete(cb);
}
const notifyConnection = (key: string | null) => connectionListeners.forEach((cb) => cb(key));

function resetPanes() {
  for (const id of PANE_IDS) resetPane(id);
}

export function setConnected(info: ConnectionInfo, savedId: string | null = null) {
  notifyConnection(null);
  savedConnectionId = savedId;
  clearClipboard();
  clearRecent();
  clearArchive();
  clearVersioning();
  setBookmarksConnection(info, savedId);
  resetPanes();
  set({
    connection: info,
    buckets: [],
    bucketsError: null,
    addedBuckets: [],
    addedError: null,
    activePane: "a",
  });
  if (info.canListBuckets) void loadBuckets();
  void loadAddedBuckets();
  notifyConnection(savedId ? `saved:${savedId}` : `conn:${info.label}|${info.endpoint ?? ""}|${info.region}`);
}

/** `cancelActive`: cancel every queued or running transfer, folder transfer and job before disconnecting. */
export async function disconnect(cancelActive = false) {
  notifyConnection(null);
  try {
    await api.disconnect(cancelActive);
  } catch {
    /* disconnect is best effort */
  }
  savedConnectionId = null;
  clearClipboard();
  clearRecent();
  clearArchive();
  clearVersioning();
  clearBookmarksConnection();
  // Both panes go; the split preference stays.
  resetPanes();
  set({
    connection: null,
    buckets: [],
    addedBuckets: [],
    activePane: "a",
    modal: null,
    contextMenu: null,
  });
}

/** Disconnect, but ask first while transfers or file operations are still running. */
export function requestDisconnect() {
  // A folder transfer counts once (its files are not in the transfer list).
  const running =
    selectActiveCount(useTransfers.getState()) + selectActiveJobCount(useJobs.getState()) + selectActiveBatchCount(useBatches.getState());
  if (running > 0) openModal({ kind: "disconnect", running });
  else void disconnect();
}

/**
 * A saved connection was deleted. The backend also forgets the buckets added by name for it, so if
 * it is the one in use, the cached list of added buckets goes too. Its bookmarks go in any case.
 */
export function forgetSavedConnection(id: string) {
  forgetBookmarks(id, get().connection);
  if (savedConnectionId !== id) return;
  savedConnectionId = null;
  set({ addedBuckets: [], addedError: null });
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

// ---- buckets added by name ("Shared with me") ----------------------------------------------

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export async function loadAddedBuckets() {
  set({ addedLoading: true, addedError: null });
  try {
    const added = await api.listAddedBuckets();
    set({ addedBuckets: [...added].sort(byName), addedLoading: false });
  } catch (e) {
    set({ addedLoading: false, addedError: e as AppError });
  }
}

/** Add a bucket by name, `s3://` URI or ARN. Rejects with the backend's `AppError` (nothing is stored then). */
export async function addSharedBucket(input: string): Promise<AddedBucket> {
  const added = await api.addBucket(input.trim());
  set((s) => ({
    addedBuckets: [...s.addedBuckets.filter((b) => b.name !== added.name), added].sort(byName),
  }));
  return added;
}

/** Forget an added bucket. Only the local list changes; the bucket and its contents are untouched. */
export async function removeSharedBucket(name: string): Promise<void> {
  await api.removeAddedBucket(name);
  const { buckets } = get();
  set((s) => ({ addedBuckets: s.addedBuckets.filter((b) => b.name !== name) }));
  // Close it in every pane that shows it, unless it is also in the regular list.
  if (buckets.some((b) => b.name === name)) return;
  usePaneTabs.setState((s) => {
    const next = { ...s };
    for (const id of PANE_IDS) next[id] = s[id].filter((t) => t.saved?.bucket !== name);
    return next;
  });
  for (const id of PANE_IDS) {
    if (getPane(id).bucket !== name) continue;
    listSeq[id]++;
    setPane(id, { bucket: null, prefix: "", listing: emptyListing, selection: new Set(), anchor: null, focus: null, reveal: null });
  }
}

// ---- navigation / listing ------------------------------------------------------------

const navigateListeners = new Set<(pane: PaneId) => void>();
/**
 * Called at the start of every navigation of a pane (any `navigate` or `revealObject`, including to
 * the current folder), before its selection changes. The pane's search results close here.
 */
export function onNavigate(cb: (pane: PaneId) => void): () => void {
  navigateListeners.add(cb);
  return () => navigateListeners.delete(cb);
}

/** Record a navigation in a pane's history: drops the forward entries, caps the length. */
function pushHistory(pane: PaneId, bucket: string, prefix: string, replace = false) {
  setPane(pane, (s) => {
    const { entries, index } = s.history;
    const cur = entries[index];
    if (cur && cur.bucket === bucket && cur.prefix === prefix) return {};
    if (replace && cur) {
      const next = entries.slice(0, index + 1);
      next[index] = { bucket, prefix };
      return { history: { entries: next, index } };
    }
    const next = entries.slice(0, index + 1);
    next.push({ bucket, prefix });
    const drop = Math.max(0, next.length - HISTORY_CAP);
    const kept = drop ? next.slice(drop) : next;
    return { history: { entries: kept, index: kept.length - 1 } };
  });
}

/** Can a pane go back / forward in its history? */
export function canGoBack(pane: PaneId = activePane()): boolean {
  return getPane(pane).history.index > 0;
}
export function canGoForward(pane: PaneId = activePane()): boolean {
  const h = getPane(pane).history;
  return h.index >= 0 && h.index < h.entries.length - 1;
}

/** Back (-1) or Forward (+1) in a pane's history; false when there is nowhere to go. */
export function goHistory(delta: -1 | 1, pane: PaneId = activePane()): boolean {
  const h = getPane(pane).history;
  const to = h.index + delta;
  const entry = h.entries[to];
  if (to < 0 || !entry) return false;
  setPane(pane, { history: { entries: h.entries, index: to } });
  navigate(entry.bucket, entry.prefix, pane, { fromHistory: true });
  return true;
}

/**
 * Open `bucket`/`prefix` in a pane (default: the active pane). Every navigation is recorded in the
 * pane's history except Back / Forward themselves (`fromHistory`).
 */
export function navigate(
  bucket: string,
  prefix: string,
  pane: PaneId = activePane(),
  opts: { fromHistory?: boolean; replaceHistory?: boolean; alone?: boolean } = {},
) {
  navigateListeners.forEach((cb) => cb(pane));
  freshPanes.delete(pane);
  // Server-provided prefixes are used verbatim (see asFolderPrefix / normalizePrefix).
  const p = asFolderPrefix(prefix);
  if (!opts.fromHistory) pushHistory(pane, bucket, p, opts.replaceHistory);
  setPane(pane, {
    bucket,
    prefix: p,
    selection: new Set(),
    anchor: null,
    focus: null,
    filter: "",
    reveal: null,
  });
  set({ contextMenu: null });
  void loadFirstPage(pane);
  // Split view with the other pane still empty since connecting (the split was saved and this is
  // the first bucket opened): it opens at the same place, as when the split is opened.
  const other = otherPane(pane);
  // `alone`: the other pane is about to be opened somewhere itself (restoring remembered tabs).
  if (!opts.alone && isSplitShown() && freshPanes.has(other) && !getPane(other).bucket) navigate(bucket, p, other);
}

let scrollSeq = 0;

/**
 * Open the folder that holds `key` with the object selected and scrolled into view. The object may
 * be beyond the first page of a large folder, so pages are loaded until it is found.
 */
export function revealObject(bucket: string, key: string, name: string, pane: PaneId = activePane()) {
  navigate(bucket, key.slice(0, key.length - name.length), pane);
  setPane(pane, { reveal: key, selection: new Set([key]), anchor: key, focus: key });
}

/** At most this many extra pages are loaded looking for a revealed object. */
const REVEAL_MAX_PAGES = 30;

async function continueReveal(pane: PaneId) {
  for (let pages = 0; pages <= REVEAL_MAX_PAGES; ) {
    const s = getPane(pane);
    const key = s.reveal;
    if (!key) return;
    if (s.listing.objects.some((o) => o.key === key)) {
      setPane(pane, { reveal: null, selection: new Set([key]), anchor: key, focus: key, scrollTo: { id: key, seq: ++scrollSeq } });
      return;
    }
    if (s.listing.loading || s.listing.loadingMore) {
      // A page is on its way (e.g. infinite scroll asked first): wait for it.
      await new Promise((r) => setTimeout(r, 80));
      continue;
    }
    if (!s.listing.truncated || !s.listing.token || s.listing.error) break;
    pages++;
    await loadMore(pane);
  }
  // Not found (deleted meanwhile, or too far down): don't leave an invisible selection behind.
  if (getPane(pane).reveal) setPane(pane, { reveal: null, selection: new Set(), anchor: null, focus: null });
}

export function refresh(pane: PaneId = activePane()): Promise<void> {
  return loadFirstPage(pane, true);
}

async function loadFirstPage(pane: PaneId, keepSelection = false) {
  const { bucket, prefix } = getPane(pane);
  if (!bucket) return;
  const seq = ++listSeq[pane];
  setPane(pane, (s) => ({
    listing: keepSelection ? { ...s.listing, loading: true, error: null } : { ...emptyListing, loading: true },
  }));
  try {
    const page = await fetchPage(pane, bucket, prefix, null, seq);
    if (seq !== listSeq[pane]) return;
    setPane(pane, (s) => {
      // Keep only selected ids that still exist (and an object being revealed, which may be on a later page).
      const ids = new Set<string>([...page.folders.map((f) => f.prefix), ...page.objects.map((o) => o.key)]);
      const selection = new Set([...s.selection].filter((id) => ids.has(id) || id === s.reveal));
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
        listedAt: Date.now(),
      };
    });
    if (getPane(pane).reveal) void continueReveal(pane);
  } catch (e) {
    if (seq !== listSeq[pane]) return;
    setPane(pane, { listing: { ...emptyListing, error: e as AppError } });
  }
}

const inPlace: Record<PaneId, Promise<void> | null> = { a: null, b: null };
const inPlaceAgain: Record<PaneId, boolean> = { a: false, b: false };

/**
 * Re-list a pane's folder after something changed it (a job), without the loading state:
 * reloads as many entries as were loaded before so the scroll position survives, keeps the
 * selection for entries that still exist and drops the rest. Concurrent calls coalesce (per pane).
 */
export function refreshInPlace(pane: PaneId = activePane()): Promise<void> {
  const running = inPlace[pane];
  if (running) {
    inPlaceAgain[pane] = true;
    return running;
  }
  const p = (async () => {
    do {
      inPlaceAgain[pane] = false;
      await reloadKeepingPosition(pane);
    } while (inPlaceAgain[pane]);
  })().finally(() => {
    inPlace[pane] = null;
  });
  inPlace[pane] = p;
  return p;
}

async function reloadKeepingPosition(pane: PaneId) {
  const { bucket, prefix, listing } = getPane(pane);
  if (!bucket || listing.loading) return;
  const want = Math.max(1, listing.folders.length + listing.objects.length);
  const seq = ++listSeq[pane];
  const folders: FolderEntry[] = [];
  const objects: ObjectEntry[] = [];
  let token: string | null = null;
  let truncated = false;
  try {
    do {
      const page = await fetchPage(pane, bucket, prefix, token, seq);
      if (seq !== listSeq[pane]) return;
      folders.push(...page.folders);
      objects.push(...page.objects);
      token = page.nextContinuationToken;
      truncated = page.isTruncated;
    } while (truncated && token && folders.length + objects.length < want);
  } catch {
    // Keep showing what we had; the next refresh (or the user) can retry.
    return;
  }
  if (seq !== listSeq[pane]) return;
  setPane(pane, (s) => {
    const ids = new Set<string>([...folders.map((f) => f.prefix), ...objects.map((o) => o.key)]);
    const selection = new Set([...s.selection].filter((id) => ids.has(id)));
    return {
      listing: { folders, objects, token, truncated, loading: false, loadingMore: false, error: null },
      listedAt: Date.now(),
      selection: selection.size === s.selection.size ? s.selection : selection,
      anchor: s.anchor && ids.has(s.anchor) ? s.anchor : null,
      focus: s.focus && ids.has(s.focus) ? s.focus : null,
    };
  });
}

export async function loadMore(pane: PaneId = activePane()) {
  const { bucket, prefix, listing } = getPane(pane);
  if (!bucket || !listing.truncated || !listing.token || listing.loadingMore || listing.loading) return;
  const seq = listSeq[pane];
  setPane(pane, { listing: { ...listing, loadingMore: true } });
  try {
    const page = await fetchPage(pane, bucket, prefix, listing.token, seq);
    if (seq !== listSeq[pane]) return;
    const cur = getPane(pane).listing;
    // De-duplicate: entries upserted locally (finished uploads, new folders) may also arrive in a later page.
    const haveFolders = new Set(cur.folders.map((f) => f.prefix));
    const haveObjects = new Set(cur.objects.map((o) => o.key));
    setPane(pane, {
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
    if (seq !== listSeq[pane]) return;
    setPane(pane, { listing: { ...getPane(pane).listing, loadingMore: false, error: e as AppError } });
  }
}

/** Insert or update an object in a pane's listing (after an upload completes). */
export function upsertListedObject(bucket: string, obj: ObjectEntry, pane: PaneId = activePane()) {
  const s = getPane(pane);
  if (s.bucket !== bucket || s.listing.loading) return;
  const objects = s.listing.objects.slice();
  const i = objects.findIndex((o) => o.key === obj.key);
  if (i >= 0) objects[i] = obj;
  else objects.push(obj);
  setPane(pane, { listing: { ...s.listing, objects } });
}

/** Ensure a sub-folder entry exists in a pane's listing (after an upload into a new sub-path). */
export function upsertListedFolder(bucket: string, folder: FolderEntry, pane: PaneId = activePane()) {
  const s = getPane(pane);
  if (s.bucket !== bucket || s.listing.loading) return;
  if (s.listing.folders.some((f) => f.prefix === folder.prefix)) return;
  setPane(pane, { listing: { ...s.listing, folders: [...s.listing.folders, folder] } });
}

// ---- selection / view -----------------------------------------------------------------

export function setSelection(selection: Set<string>, anchor: string | null, focus: string | null, pane: PaneId = activePane()) {
  // The user chose something else: stop looking for an object that was being revealed.
  setPane(pane, { selection, anchor, focus, reveal: null });
}

export function setSort(key: SortKey, pane: PaneId = activePane()) {
  const cur = getPane(pane).sort;
  const sort: SortState = cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: key === "modified" || key === "size" ? -1 : 1 };
  setPane(pane, { sort });
  writePref(SORT_KEY, sort);
}

/** The quick filter's row predicate (shared with the derived view in ./view.ts). */
export function matchesFilter(name: string, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  return !f || name.toLowerCase().includes(f);
}

/**
 * Change a pane's quick filter. Selected rows the new filter hides are dropped from the selection
 * (and the anchor/focus if hidden), so an action never includes an item the user can't see.
 * Clearing the filter later does not bring them back.
 */
export function setFilter(filter: string, pane: PaneId = activePane()) {
  setPane(pane, (s) => {
    if (!s.selection.size && !s.anchor && !s.focus) return { filter };
    const visible = new Set<string>();
    for (const f of s.listing.folders) if (matchesFilter(f.name, filter)) visible.add(f.prefix);
    for (const o of s.listing.objects) if (matchesFilter(o.name, filter)) visible.add(o.key);
    const selection = new Set([...s.selection].filter((id) => visible.has(id)));
    return {
      filter,
      selection: selection.size === s.selection.size ? s.selection : selection,
      anchor: s.anchor && visible.has(s.anchor) ? s.anchor : null,
      focus: s.focus && visible.has(s.focus) ? s.focus : null,
    };
  });
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
