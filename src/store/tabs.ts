// Tabs (added after v0.7.0): several locations open at once in each pane. A pane's shown tab is
// the pane's state in `usePanes`, so everything that acts on a pane acts on its shown tab; hidden
// tabs keep their whole state in `usePaneTabs` until they are shown again. See "Tabs" in
// docs/CONTRACT.md.

import { asFolderPrefix } from "../lib/format";
import {
  activePane,
  getPane,
  isPaneShown,
  isSplitShown,
  navigate,
  onConnectionChange,
  readPref,
  refresh,
  refreshInPlace,
  setActivePane,
  stopListing,
  useApp,
  writePref,
} from "./app";
import {
  emptySearch,
  freshPane,
  newTabId,
  PANE_IDS,
  tabEntry,
  usePanes,
  usePaneTabs,
  type PaneId,
  type PaneState,
  type SortState,
  type TabEntry,
} from "./panes";
import { cancelScheduledSearch, cancelSearch } from "./search";
import { leaveVanishedFolder } from "./ops";
import { toast } from "./toasts";

export const MAX_TABS = 20;
/** A hidden tab's listing older than this is refreshed (in the background) when it is shown. */
const STALE_MS = 60_000;

interface Location {
  bucket: string;
  prefix: string;
}

const tabsOf = (pane: PaneId): TabEntry[] => usePaneTabs.getState()[pane];
const setTabs = (pane: PaneId, tabs: TabEntry[]) => usePaneTabs.setState({ [pane]: tabs } as Partial<Record<PaneId, TabEntry[]>>);

/** A hidden tab's state at a location, not listed yet (it lists when shown). */
function stateAt({ bucket, prefix }: Location, sort: SortState): PaneState {
  const p = asFolderPrefix(prefix);
  return { ...freshPane(sort), bucket, prefix: p, history: { entries: [{ bucket, prefix: p }], index: 0 } };
}

/** Where a tab is: the pane's state for the shown tab, the saved one for the others. */
function tabState(pane: PaneId, t: TabEntry): PaneState {
  return t.saved ?? getPane(pane);
}

/** The scroll position a shown tab had when it was hidden (the table applies it once). */
export function takeTabScroll(pane: PaneId, tab: number): number {
  const t = tabsOf(pane).find((x) => x.id === tab);
  if (!t || t.saved || !t.scrollTop) return 0;
  const top = t.scrollTop;
  setTabs(
    pane,
    tabsOf(pane).map((x) => (x.id === tab ? { ...x, scrollTop: 0 } : x)),
  );
  return top;
}

/**
 * Show one of a pane's tabs. What runs for the tab being hidden stops: its listing (it loads again
 * when the tab is shown) and its search (which then says it was cancelled). The shown tab is brought
 * up to date in the background when its listing is old or its folder changed meanwhile.
 */
export function showTab(pane: PaneId, id: number) {
  const cur = getPane(pane);
  if (cur.tab === id) return;
  const target = tabsOf(pane).find((t) => t.id === id);
  if (!target?.saved) return;
  cancelScheduledSearch(pane);
  if (cur.search.loading) cancelSearch(pane);
  stopListing(pane);
  const out = getPane(pane);
  const saved: PaneState = { ...out, listing: { ...out.listing, loadingMore: false }, scrollTo: null };
  const scrollTop = document.querySelector<HTMLElement>(`[data-pane="${pane}"] .object-table .tbody`)?.scrollTop ?? 0;
  setTabs(
    pane,
    tabsOf(pane).map((t) => (t.id === out.tab ? { ...t, saved, scrollTop, stale: false, vanished: false } : t.id === id ? { ...t, saved: null, stale: false, vanished: false } : t)),
  );
  usePanes.setState({ [pane]: target.saved } as Partial<Record<PaneId, PaneState>>);
  useApp.setState({ contextMenu: null });

  const s = target.saved;
  if (!s.bucket) return;
  const after = () => (target.vanished ? leaveVanishedFolder(pane) : undefined);
  if (s.listing.loading || !s.listedAt || s.listing.error) void refresh(pane).then(after);
  else if (target.stale || Date.now() - s.listedAt > STALE_MS) void refreshInPlace(pane).then(after);
}

/**
 * Open a tab right after the pane's shown tab (or at `index`): at `at`, or a copy of the shown tab's
 * location and listing (no selection, filter, results or history). False when it can't.
 */
export function openTab(pane: PaneId, at: Location | null, show: boolean, index?: number): boolean {
  const tabs = tabsOf(pane);
  if (tabs.length >= MAX_TABS) {
    toast.info(`At most ${MAX_TABS} tabs per pane`, "Close a tab to open another one.");
    return false;
  }
  const cur = getPane(pane);
  // A pane with nothing open has nothing to keep: it opens the place itself.
  if (at && !cur.bucket) {
    navigate(at.bucket, at.prefix, pane);
    return true;
  }
  let saved: PaneState;
  if (at) saved = stateAt(at, cur.sort);
  else if (cur.bucket) {
    saved = {
      ...cur,
      tab: newTabId(),
      selection: new Set(),
      anchor: null,
      focus: null,
      reveal: null,
      scrollTo: null,
      filter: "",
      search: emptySearch,
      history: { entries: [{ bucket: cur.bucket, prefix: cur.prefix }], index: 0 },
    };
  } else return false;
  const next = tabs.slice();
  const i = index ?? tabs.findIndex((t) => t.id === cur.tab) + 1;
  next.splice(Math.min(Math.max(0, i), next.length), 0, tabEntry(saved.tab, saved));
  setTabs(pane, next);
  if (show) showTab(pane, saved.tab);
  return true;
}

/** Open a folder (its prefix verbatim) in a new tab of a pane. */
export function openFolderInNewTab(bucket: string, prefix: string, pane: PaneId = activePane(), show = true): boolean {
  return openTab(pane, { bucket, prefix }, show);
}

/** Recently closed tabs (this connection), newest last. */
const closed: { pane: PaneId; index: number; at: Location }[] = [];

/** Close a tab (default: the shown one). The last tab of a pane stays: false then. */
export function closeTab(pane: PaneId, id: number = getPane(pane).tab): boolean {
  const tabs = tabsOf(pane);
  const i = tabs.findIndex((t) => t.id === id);
  if (tabs.length < 2 || i < 0) return false;
  const { bucket, prefix } = tabState(pane, tabs[i]);
  if (getPane(pane).tab === id) showTab(pane, (tabs[i + 1] ?? tabs[i - 1]).id);
  if (bucket) {
    closed.push({ pane, index: i, at: { bucket, prefix } });
    if (closed.length > MAX_TABS) closed.shift();
  }
  setTabs(
    pane,
    tabsOf(pane).filter((t) => t.id !== id),
  );
  return true;
}

/** Show the next (+1) or previous (-1) tab of a pane, wrapping around. False with one tab. */
export function cycleTab(pane: PaneId, delta: 1 | -1): boolean {
  const tabs = tabsOf(pane);
  if (tabs.length < 2) return false;
  const i = tabs.findIndex((t) => t.id === getPane(pane).tab);
  showTab(pane, tabs[(i + delta + tabs.length) % tabs.length].id);
  return true;
}

/** Bring back the last closed tab, in its pane when that is shown (else the active pane). */
export function reopenClosedTab(): boolean {
  const last = closed[closed.length - 1];
  if (!last) return false;
  const pane = isPaneShown(last.pane) ? last.pane : activePane();
  if (!openTab(pane, last.at, true, last.pane === pane ? last.index : undefined)) return true;
  closed.pop();
  return true;
}

/**
 * Move a tab into the other pane with its whole state (dragging it onto that pane's tab strip or path
 * bar), at `index` there (default: after its shown tab), and show it. Only with two panes on screen,
 * and never the last tab of a pane. False when it can't.
 */
export function moveTabToPane(from: PaneId, id: number, to: PaneId, index?: number): boolean {
  if (from === to || !isSplitShown()) return false;
  const tabs = tabsOf(from);
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0 || tabs.length < 2) return false;
  if (tabsOf(to).length >= MAX_TABS) {
    toast.info(`At most ${MAX_TABS} tabs per pane`, "Close a tab there to move this one.");
    return false;
  }
  // Hidden first: its state (listing, selection, search, history, scroll) is saved into the entry.
  if (getPane(from).tab === id) showTab(from, (tabs[i + 1] ?? tabs[i - 1]).id);
  const entry = tabsOf(from).find((t) => t.id === id);
  if (!entry?.saved) return false;
  setTabs(
    from,
    tabsOf(from).filter((t) => t.id !== id),
  );
  const dest = tabsOf(to).slice();
  const at = index ?? dest.findIndex((t) => t.id === getPane(to).tab) + 1;
  dest.splice(Math.min(Math.max(0, at), dest.length), 0, entry);
  setTabs(to, dest);
  showTab(to, id);
  setActivePane(to);
  return true;
}

/** Put a pane's tabs in this order (dragging a tab). */
export function reorderTabs(pane: PaneId, ids: number[]) {
  const byId = new Map(tabsOf(pane).map((t) => [t.id, t]));
  const next = ids.map((id) => byId.get(id)).filter((t): t is TabEntry => !!t);
  if (next.length === byId.size) setTabs(pane, next);
}

// ---- remembered per connection ---------------------------------------------------------------

const TABS_KEY = "s3x.tabs";
/** Connections remembered at most (the least recently used go first). */
const MAX_CONNECTIONS = 20;

interface StoredPane {
  tabs: Location[];
  active: number;
}
type StoredConnection = Partial<Record<PaneId, StoredPane>> & { at: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readAll(): Record<string, StoredConnection> {
  const all = readPref<unknown>(TABS_KEY, null);
  return isObject(all) ? (all as Record<string, StoredConnection>) : {};
}

/** A remembered pane, validated; null when missing or malformed. */
function parsePane(v: unknown): StoredPane | null {
  if (!isObject(v) || !Array.isArray(v.tabs)) return null;
  const tabs = v.tabs
    .filter((t): t is Location => isObject(t) && typeof t.bucket === "string" && t.bucket !== "" && typeof t.prefix === "string")
    .slice(0, MAX_TABS)
    .map((t) => ({ bucket: t.bucket, prefix: t.prefix }));
  if (!tabs.length) return null;
  const active = typeof v.active === "number" && Number.isInteger(v.active) ? Math.min(Math.max(0, v.active), tabs.length - 1) : 0;
  return { tabs, active };
}

/** The connection whose tabs are being remembered (null while restoring or disconnected). */
let persistKey: string | null = null;
let lastWritten = "";

function persist() {
  if (!persistKey) return;
  const data: Partial<Record<PaneId, StoredPane>> = {};
  // In single view the one pane shown (which may be "b" after closing the split) reopens as "a".
  const { split, activePane: only } = useApp.getState();
  for (const pane of split ? PANE_IDS : [only]) {
    const shown = getPane(pane).tab;
    const tabs: Location[] = [];
    let active = 0;
    for (const t of tabsOf(pane)) {
      const { bucket, prefix } = tabState(pane, t);
      if (!bucket) continue;
      if (t.id === shown) active = tabs.length;
      tabs.push({ bucket, prefix });
    }
    if (tabs.length) data[split ? pane : "a"] = { tabs, active };
  }
  const json = `${persistKey}\u0000${JSON.stringify(data)}`;
  if (json === lastWritten) return;
  lastWritten = json;
  const all = readAll();
  all[persistKey] = { ...data, at: Date.now() };
  const keys = Object.keys(all).sort((x, y) => (Number(all[y]?.at) || 0) - (Number(all[x]?.at) || 0));
  for (const k of keys.slice(MAX_CONNECTIONS)) delete all[k];
  writePref(TABS_KEY, all);
}

/** Open a connection's remembered tabs (the second pane's only in split view). */
function restore(key: string) {
  const stored = readAll()[key];
  if (!isObject(stored)) return;
  const panes = PANE_IDS.filter((p) => p === "a" || useApp.getState().split)
    .map((p) => ({ pane: p, saved: parsePane(stored[p]) }))
    .filter((x): x is { pane: PaneId; saved: StoredPane } => !!x.saved);
  for (const { pane, saved } of panes) {
    const at = saved.tabs[saved.active];
    // With both panes remembered, neither follows the other to its first bucket.
    navigate(at.bucket, at.prefix, pane, { alone: panes.length > 1 });
    const sort = getPane(pane).sort;
    setTabs(
      pane,
      saved.tabs.map((loc, i) => {
        if (i === saved.active) return tabEntry(getPane(pane).tab);
        const s = stateAt(loc, sort);
        return tabEntry(s.tab, s);
      }),
    );
  }
}

onConnectionChange((key) => {
  persistKey = null;
  lastWritten = "";
  closed.length = 0;
  if (!key) return;
  restore(key);
  persistKey = key;
  persist();
});

usePanes.subscribe(persist);
usePaneTabs.subscribe(persist);
useApp.subscribe((s, prev) => {
  if (s.split !== prev.split || s.activePane !== prev.activePane) persist();
});
