// Search in a bucket (v0.6.0): the scope choice and, per pane (v0.7.0), the one search the toolbar
// runs there and — while the results are open — the selection (the result rows are the selection
// then; see getSelected in ./view.ts). Results live in the pane store, apart from the transfer
// stores, so progress events never re-render them.

import { create } from "zustand";
import * as api from "../lib/api";
import { SEARCH_LIMITS, type AppError, type SearchHit } from "../lib/types";
import { parseS3Path } from "../lib/search";
import { activePane, getPane, navigate, onNavigate, onPaneReset, setFilter, setPane, setSelection, useApp, usePaneId } from "./app";
import { jobRequest, onJobUpdate } from "./jobs";
import { emptySearch, PANE_IDS, updateHiddenTabs, usePanes, type PaneId, type PaneSearch, type SearchRequest } from "./panes";
import { toast } from "./toasts";

export type { SearchRequest } from "./panes";
export type SearchScope = "folder" | "bucket";

interface SearchState {
  /** This folder (default) or the whole bucket; per session, not saved, shared by the panes. */
  scope: SearchScope;
}

export const useSearch = create<SearchState>(() => ({ scope: "folder" }));

/** Subscribe to a slice of this component's pane's search (see usePaneId). */
export function usePaneSearch<T>(selector: (s: PaneSearch) => T): T {
  const id = usePaneId();
  return usePanes((s) => selector(s[id].search));
}

/** A pane's search state (default: the active pane). */
export const getSearch = (pane: PaneId = activePane()): PaneSearch => getPane(pane).search;

function setSearch(pane: PaneId, patch: Partial<PaneSearch>) {
  setPane(pane, (p) => ({ search: { ...p.search, ...patch } }));
}

const emptySelection = { selection: new Set<string>(), anchor: null, focus: null };

/** A hit's id in the selection: objects by key, folders by prefix (prefixed so the two never collide). */
export const hitId = (h: SearchHit): string => (h.kind === "folder" ? `f:${h.folder!.prefix}` : `o:${h.entry!.key}`);

/** The hits a pane currently shows (empty while there is no result). */
export const getHits = (pane: PaneId = activePane()): SearchHit[] => getSearch(pane).result?.hits ?? [];

export function setSearchSelection(selection: Set<string>, anchor: string | null, focus: string | null, pane: PaneId = activePane()) {
  setSearch(pane, { selection, anchor, focus });
}

/** Run counter, shared by the panes so a run id is never reused. */
let seq = 0;
/** Each pane's run in flight. */
const mine: Record<PaneId, number> = { a: 0, b: 0 };
/**
 * The id of each pane's run in flight, or null. Each run has its own id ("toolbar:<n>"), so a late
 * cancel_search for one run can never stop the next; a new run cancels the previous one itself.
 */
const runningId: Record<PaneId, string | null> = { a: null, b: null };

const CANCELLED: AppError = { code: "Cancelled", message: "Search cancelled." };

// ---- search as you type (v0.7.0) -------------------------------------------------------------

/** The toolbar box searches this long after the last keystroke. */
export const SEARCH_DEBOUNCE_MS = 500;
const timers: Record<PaneId, ReturnType<typeof setTimeout> | null> = { a: null, b: null };

/** Drop a pane's search that is waiting for the typing to stop. */
export function cancelScheduledSearch(pane: PaneId = activePane()) {
  const t = timers[pane];
  if (t) clearTimeout(t);
  timers[pane] = null;
}

/** Is a search waiting for the typing to stop in this pane? */
export const searchScheduled = (pane: PaneId = activePane()) => timers[pane] !== null;

/**
 * The box's text changed: search 500 ms after the last keystroke (non-empty text). Typing more
 * stops the search that is running and schedules a new one; clearing the box closes the results.
 * A pasted `s3://bucket/path` (which can open another bucket) waits for Enter.
 */
export function scheduleSearch(text: string, pane: PaneId = activePane()) {
  cancelScheduledSearch(pane);
  if (!text.trim()) {
    closeSearch(pane);
    return;
  }
  const s = getSearch(pane);
  if (parseS3Path(text)) {
    // Waits for Enter: stop the search for the earlier text and leave no spinner behind.
    if (s.loading) {
      cancelRunning(pane);
      mine[pane] = 0;
      setSearch(pane, { loading: false, error: s.open ? CANCELLED : null });
    }
    return;
  }
  if (s.loading || s.open) {
    // The scan for the old text stops now; the results stay until the new ones replace them.
    cancelRunning(pane);
    mine[pane] = 0;
    if (s.open && s.request) setSearch(pane, { loading: true, error: null, request: { ...s.request, text } });
  }
  timers[pane] = setTimeout(() => {
    timers[pane] = null;
    typedNext[pane] = true;
    runSearch(text, pane);
    typedNext[pane] = false;
  }, SEARCH_DEBOUNCE_MS);
}

/** Panes whose results list should take the keyboard once results arrive (Enter / ArrowDown in the box). */
const focusWanted: Record<PaneId, boolean> = { a: false, b: false };

/** Ask for the results list to take the focus when its results are shown (now, if they already are). */
export function requestResultsFocus(pane: PaneId = activePane()) {
  focusWanted[pane] = true;
  const s = getSearch(pane);
  if (s.result && !s.loading) focusResultsNow(pane);
}

/** Consume a pending focus request (the results list calls this when results arrive). */
export function takeResultsFocus(pane: PaneId): boolean {
  const want = focusWanted[pane];
  focusWanted[pane] = false;
  return want;
}

function focusResultsNow(pane: PaneId) {
  focusWanted[pane] = false;
  const s = getSearch(pane);
  const first = s.result?.hits[0];
  if (first && !s.focus) setSearch(pane, { focus: hitId(first) });
  else if (first && s.focus && !s.selection.size) setSearch(pane, { focus: hitId(first) });
  document.querySelector<HTMLElement>(`[data-pane="${pane}"] .search-results .tbody`)?.focus();
}

/** Stop the backend scan of a pane's run in flight, if any. */
function cancelRunning(pane: PaneId) {
  const id = runningId[pane];
  runningId[pane] = null;
  if (id) api.cancelSearch(id).catch(() => {
    /* nothing running any more */
  });
}

export function setSearchScope(scope: SearchScope) {
  useSearch.setState({ scope });
}

/** The next run of a pane comes from typing (the debounce), and whether each pane's current run did. */
const typedNext: Record<PaneId, boolean> = { a: false, b: false };
const typedRun: Record<PaneId, boolean> = { a: false, b: false };

/** Was the pane's current run started by typing (search as you type) rather than Enter, Refresh or a button? */
export const runWasTyped = (pane: PaneId): boolean => typedRun[pane];

async function start(request: SearchRequest, pane: PaneId) {
  typedRun[pane] = typedNext[pane];
  cancelScheduledSearch(pane);
  cancelRunning(pane);
  const run = ++seq;
  mine[pane] = run;
  const id = `toolbar:${run}`;
  runningId[pane] = id;
  // The results replace the table: drop the table's selection so no toolbar action can include
  // rows the user cannot see. The results start with nothing selected.
  const p = getPane(pane);
  if (p.selection.size || p.focus || p.anchor) setSelection(new Set(), null, null, pane);
  setSearch(pane, { open: true, request, result: null, error: null, loading: true, runSeq: run, ...emptySelection });
  try {
    const result = await api.searchObjects({ bucket: request.bucket, scope: request.scope, text: request.text, limit: SEARCH_LIMITS.uiLimit }, id);
    if (runningId[pane] === id) runningId[pane] = null;
    if (mine[pane] !== run) return;
    // The first row takes the keyboard focus (not the selection), so Enter opens it.
    const first = result.hits[0];
    setSearch(pane, { result, loading: false, ...emptySelection, focus: first ? hitId(first) : null });
  } catch (e) {
    if (runningId[pane] === id) runningId[pane] = null;
    if (mine[pane] !== run) return;
    // A cancelled run (Cancel, disconnect) keeps its header and says so; never a blank view.
    const err = e as AppError;
    setSearch(pane, { loading: false, error: err.code === "Cancelled" ? CANCELLED : err });
  }
}

/**
 * Search the pane's bucket for `text` in the chosen scope. Does nothing for a blank query. A pasted
 * `s3://bucket/path` (the whole query) searches that path in the whole bucket, opening the bucket
 * first when it is another one of this connection's buckets.
 */
export function runSearch(text: string, pane: PaneId = activePane()) {
  const { bucket, prefix } = getPane(pane);
  const { buckets, addedBuckets } = useApp.getState();
  if (!bucket || !text.trim()) return;
  const s3 = parseS3Path(text);
  if (s3) {
    if (s3.bucket !== bucket) {
      const known = buckets.some((b) => b.name === s3.bucket) || addedBuckets.some((b) => b.name === s3.bucket);
      if (!known) {
        toast.error(`Bucket ${s3.bucket} is not in this connection`, "Add it by name first, or open a bucket you can see.");
        return;
      }
      navigate(s3.bucket, "", pane);
    }
    // Nothing after the bucket: opening it is all there is to do.
    if (!s3.path) return;
    // One path term, even with spaces: `path:"<rest>"`, a quote inside escaped as `\"`.
    void start({ bucket: s3.bucket, scope: "", text: `path:"${s3.path.replace(/"/g, '\\"')}"` }, pane);
    return;
  }
  void start({ bucket, scope: useSearch.getState().scope === "folder" ? prefix : "", text }, pane);
}

/** Run the same search again (Refresh). */
export function rerunSearch(pane: PaneId = activePane()) {
  const { request, open } = getSearch(pane);
  if (open && request) void start(request, pane);
}

/** Stop the running search (the backend scan stops too). The view keeps its header and says it was cancelled. */
export function cancelSearch(pane: PaneId = activePane()) {
  cancelScheduledSearch(pane);
  if (!getSearch(pane).loading) return;
  mine[pane] = 0;
  setSearch(pane, { loading: false, error: CANCELLED });
  cancelRunning(pane);
}

/** Leave the results view (Back to folder, Esc, a different bucket, disconnect). */
export function closeSearch(pane: PaneId = activePane()) {
  cancelScheduledSearch(pane);
  focusWanted[pane] = false;
  const s = getSearch(pane);
  if (!s.open && !s.loading) return;
  cancelRunning(pane);
  mine[pane] = 0;
  setPane(pane, { search: { ...emptySearch, runSeq: s.runSeq } });
}

/**
 * Back to the folder (the Back button, Esc): close the results and clear the box, whose text
 * would otherwise go on filtering the folder's rows.
 */
export function leaveSearch(pane: PaneId = activePane()) {
  closeSearch(pane);
  setFilter("", pane);
}

/** A search without the hits (and their selection) that a finished job deleted or moved away; null when none went. */
function withoutHits(search: PaneSearch, gone: (h: SearchHit) => boolean): Partial<PaneSearch> | null {
  const { result, selection, anchor, focus } = search;
  if (!result) return null;
  const hits = result.hits.filter((h) => !gone(h));
  if (hits.length === result.hits.length) return null;
  const ids = new Set(hits.map(hitId));
  const keep = new Set([...selection].filter((id) => ids.has(id)));
  return {
    result: { ...result, hits },
    selection: keep,
    anchor: anchor && ids.has(anchor) ? anchor : null,
    focus: focus && ids.has(focus) ? focus : hits[0] ? hitId(hits[0]) : null,
  };
}

// A delete, rename or move that finished takes its sources out of the results (in every pane): they
// no longer exist at those keys. Items the job reports as failed stay; a cancelled job (unknown
// progress) or one whose failures are not all listed changes nothing.
onJobUpdate((j, prev) => {
  const finished = j.status !== "running" && j.status !== "queued" && (!prev || prev.status === "running" || prev.status === "queued");
  if (!finished || (j.kind !== "delete" && j.kind !== "move")) return;
  if (j.status === "cancelled" || (j.status === "failed" && j.error) || j.failedItems > j.errors.length) return;
  const req = jobRequest(j.id);
  if (!req) return;
  const failed = new Set(j.errors.map((e) => e.key));
  const keyOf = (h: SearchHit) => (h.kind === "folder" ? h.folder!.prefix : h.entry!.key);
  const gone = (h: SearchHit) => {
    const k = keyOf(h);
    // Keep a hit that failed, and a folder that still holds something that failed.
    for (const f of failed) if (f === k || (h.kind === "folder" && f.startsWith(k))) return false;
    return req.items.some((it) => (it.isPrefix ? k.startsWith(it.from) : !it.isPrefix && h.kind === "object" && k === it.from));
  };
  const affected = (s: PaneSearch) => !!s.request && req.srcBucket === s.request.bucket;
  for (const pane of PANE_IDS) {
    const s = getSearch(pane);
    const patch = affected(s) ? withoutHits(s, gone) : null;
    if (patch) setSearch(pane, patch);
  }
  // Hidden tabs' results too (see "Tabs" in docs/CONTRACT.md).
  updateHiddenTabs((t) => {
    const patch = affected(t.saved.search) ? withoutHits(t.saved.search, gone) : null;
    return patch ? { saved: { ...t.saved, search: { ...t.saved.search, ...patch } } } : null;
  });
});

// Every navigation of a pane closes its results, even to the current folder (a newest file, a
// breadcrumb, a bucket click): `revealObject` selects a row in the table, which must never sit behind
// the results. A pane that is reset (split closed, disconnect) stops its search too.
onNavigate((pane) => closeSearch(pane));
onPaneReset((pane) => closeSearch(pane));
// So does a change of a pane's bucket or folder (within a tab: showing another tab brings its own
// results), or of the connection.
usePanes.subscribe((s, prev) => {
  for (const pane of PANE_IDS) {
    if (s[pane].tab !== prev[pane].tab) continue;
    if (s[pane].bucket !== prev[pane].bucket || s[pane].prefix !== prev[pane].prefix) closeSearch(pane);
  }
});
useApp.subscribe((s, prev) => {
  if (s.connection !== prev.connection) for (const pane of PANE_IDS) closeSearch(pane);
});
