// Derived view of the current listing: filtered + sorted rows, folders first.

import { useMemo } from "react";
import { create } from "zustand";
import type { FolderEntry, ObjectEntry, SearchHit } from "../lib/types";
import { activePane, getPane, usePaneId, type PaneId, type SortState } from "./app";
import { entryIndex, folderId, isLocalPane, objectId, usePanes, type PaneState } from "./panes";
import { hitId, usePaneSearch } from "./search";
import { folderSizeId, useFolderSizes } from "./folderSizes";
import { localSizeKey, useLocalSizes } from "./localSizes";

// ---- folder sizes in the Size sort ---------------------------------------------------------------
// Folders sort by their calculated size when the table is sorted by Size. The rows depend on a
// version that changes only when a calculated byte count appears, changes or goes (never while a scan
// runs), so the sort neither re-renders on progress nor rescans the size stores per row.

/** Bumped when any calculated folder size (S3 or local) changes its bytes. */
const useSizesVersion = create<{ v: number }>(() => ({ v: 0 }));
let lastBytes = new Map<string, number>();

function sizesChanged() {
  const next = new Map<string, number>();
  for (const [id, e] of Object.entries(useFolderSizes.getState().byId)) if (e.size) next.set(`s3\u0000${id}`, e.size.bytes);
  for (const [k, e] of Object.entries(useLocalSizes.getState().byPath)) if (e.size) next.set(`local\u0000${k}`, e.size.bytes);
  let same = next.size === lastBytes.size;
  if (same) for (const [k, b] of next) if (lastBytes.get(k) !== b) { same = false; break; }
  lastBytes = next;
  if (!same) useSizesVersion.setState((s) => ({ v: s.v + 1 }));
}
useFolderSizes.subscribe(sizesChanged);
useLocalSizes.subscribe(sizesChanged);

/** The calculated bytes of a folder row of this pane, or null when it has none. */
function folderBytes(s: Pick<PaneState, "bucket" | "source" | "local">, f: FolderEntry): number | null {
  if (isLocalPane(s)) return useLocalSizes.getState().byPath[localSizeKey(f.prefix)]?.size?.bytes ?? null;
  if (!s.bucket) return null;
  return useFolderSizes.getState().byId[folderSizeId(s.bucket, f.prefix)]?.size?.bytes ?? null;
}

export type Row =
  | { kind: "folder"; id: string; name: string; folder: FolderEntry }
  | { kind: "object"; id: string; name: string; object: ObjectEntry };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// ---- rows: sorted once per listing and order, then filtered --------------------------------------
// Sorting is the expensive part (a collator compare per comparison), so a listing is sorted once per
// sort order and the sorted rows are kept with the listing (keyed by its `objects` array, so a listing
// that is replaced lets its rows go). The quick filter then only scans the sorted rows: typing in the
// search box, or showing a tab whose listing was sorted before, never sorts again.

interface SortedRows {
  folders: FolderEntry[];
  /** The sizes' version the rows were sorted with (only matters for the Size sort). */
  sizes: number;
  rows: Row[];
  /** The rows' names, lower-cased, for the filter. */
  lower: string[];
}

const sortedByListing = new WeakMap<ObjectEntry[], Map<string, SortedRows>>();

function sortRows(folders: FolderEntry[], objects: ObjectEntry[], sort: SortState, pane: PaneId): Row[] {
  const fr: Row[] = folders.map((folder) => ({ kind: "folder", id: folder.prefix, name: folder.name, folder }));
  const dir = sort.dir;
  const byName = (a: Row, b: Row) => collator.compare(a.name, b.name);
  if (sort.key === "size") {
    // Folders by their calculated size (in the column's direction); folders without one after the
    // sized ones, by name. Folders still come before files.
    const s = getPane(pane);
    const bytes = new Map<string, number | null>(fr.map((r) => [r.id, r.kind === "folder" ? folderBytes(s, r.folder) : null]));
    fr.sort((a, b) => {
      const x = bytes.get(a.id) ?? null;
      const y = bytes.get(b.id) ?? null;
      if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
      return x !== y ? dir * (x - y) : byName(a, b);
    });
  } else {
    // Folders have no date or class: they sort by name.
    fr.sort((a, b) => (sort.key === "name" ? dir : 1) * byName(a, b));
  }
  let or: Row[];
  if (sort.key === "name") {
    or = objects.map((object) => ({ kind: "object", id: object.key, name: object.name, object }));
    or.sort((a, b) => dir * byName(a, b));
  } else {
    // Each row's sort value is computed once (a date is parsed once, not in every comparison).
    const val = (o: ObjectEntry): number | string => {
      switch (sort.key) {
        case "size":
          return o.size;
        case "modified":
          return o.lastModified ? Date.parse(o.lastModified) : 0;
        case "class":
          return o.storageClass ?? "";
        default:
          return 0;
      }
    };
    const items = objects.map((object) => ({ row: { kind: "object", id: object.key, name: object.name, object } as Row, v: val(object) }));
    items.sort((a, b) => {
      const va = a.v;
      const vb = b.v;
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb));
      return c !== 0 ? dir * c : byName(a.row, b.row);
    });
    or = items.map((x) => x.row);
  }
  return fr.concat(or);
}

/** A listing's rows in a sort order, sorted on first use and kept with the listing. */
function sortedRows(folders: FolderEntry[], objects: ObjectEntry[], sort: SortState, pane: PaneId): SortedRows {
  const sizes = sort.key === "size" ? useSizesVersion.getState().v : -1;
  const order = sort.key + ":" + sort.dir;
  let byOrder = sortedByListing.get(objects);
  if (!byOrder) sortedByListing.set(objects, (byOrder = new Map()));
  const hit = byOrder.get(order);
  if (hit && hit.folders === folders && hit.sizes === sizes) return hit;
  const rows = sortRows(folders, objects, sort, pane);
  const entry: SortedRows = { folders, sizes, rows, lower: rows.map((r) => r.name.toLowerCase()) };
  byOrder.set(order, entry);
  return entry;
}

/** The filtered rows of each pane, so an unchanged view returns the same array (stable for React). */
const filtered: Record<PaneId, { base: Row[]; filter: string; rows: Row[] } | null> = { a: null, b: null };

export function computeRows(folders: FolderEntry[], objects: ObjectEntry[], filter: string, sort: SortState, pane: PaneId): Row[] {
  const base = sortedRows(folders, objects, sort, pane);
  // The same rule as matchesFilter (app.ts): a case-insensitive substring of the name.
  const f = filter.trim().toLowerCase();
  if (!f) return base.rows;
  const cache = filtered[pane];
  if (cache && cache.base === base.rows && cache.filter === f) return cache.rows;
  const rows: Row[] = [];
  for (let i = 0; i < base.rows.length; i++) if (base.lower[i].includes(f)) rows.push(base.rows[i]);
  filtered[pane] = { base: base.rows, filter: f, rows };
  return rows;
}

const rowIndexes = new WeakMap<Row[], Map<string, number>>();

/** The index of a row by id in a rows array (as returned by computeRows), or -1. Built once per array. */
export function rowIndex(rows: Row[], id: string | null | undefined): number {
  if (id === null || id === undefined) return -1;
  let m = rowIndexes.get(rows);
  if (!m) {
    m = new Map();
    for (let i = 0; i < rows.length; i++) if (!m.has(rows[i].id)) m.set(rows[i].id, i);
    rowIndexes.set(rows, m);
  }
  return m.get(id) ?? -1;
}

const rowNameLists = new WeakMap<Row[], string[]>();

/** The rows' names (for type-to-jump), built once per rows array. */
export function rowNames(rows: Row[]): string[] {
  let names = rowNameLists.get(rows);
  if (!names) rowNameLists.set(rows, (names = rows.map((r) => r.name)));
  return names;
}

/** Hook: the rows of a pane (default: this component's pane, see usePaneId). */
export function useViewRows(pane?: PaneId): Row[] {
  const fallback = usePaneId();
  const id = pane ?? fallback;
  const folders = usePanes((s) => s[id].listing.folders);
  const objects = usePanes((s) => s[id].listing.objects);
  const filter = usePanes((s) => s[id].filter);
  const sort = usePanes((s) => s[id].sort);
  // Re-sort when a calculated folder size changes, only while sorted by Size.
  useSizesVersion((s) => (sort.key === "size" ? s.v : -1));
  return computeRows(folders, objects, filter, sort, id);
}

export function getViewRows(pane: PaneId = activePane()): Row[] {
  const s = getPane(pane);
  return computeRows(s.listing.folders, s.listing.objects, s.filter, s.sort, pane);
}

/** The selected search hits, in result order (the results view is open). */
function selectedHits(selection: Set<string>, hits: SearchHit[]): { folders: FolderEntry[]; objects: ObjectEntry[] } {
  const folders: FolderEntry[] = [];
  const objects: ObjectEntry[] = [];
  if (selection.size) {
    for (const h of hits) {
      if (!selection.has(hitId(h))) continue;
      if (h.kind === "folder" && h.folder) folders.push(h.folder);
      else if (h.kind === "object" && h.entry) objects.push(h.entry);
    }
  }
  return { folders, objects };
}

/**
 * Selected entries, in listing order, limited to rows the current filter shows: an action never
 * includes an item the user can't see (setFilter also prunes hidden ones from the selection).
 * While search results are open, the selected result rows are the selection: their entries are
 * returned exactly as the search reported them (keys and prefixes byte-for-byte).
 */
export function getSelected(pane: PaneId = activePane()): { folders: FolderEntry[]; objects: ObjectEntry[] } {
  const { selection, listing, search } = getPane(pane);
  if (search.open) return selectedHits(search.selection, search.result?.hits ?? []);
  if (!selection.size) return { folders: [], objects: [] };
  // Selection-sized: each selected id is looked up (a visible row, its place in the listing), then
  // the entries are put back in listing order.
  const rows = getViewRows(pane);
  const fIdx = entryIndex(listing.folders, folderId);
  const oIdx = entryIndex(listing.objects, objectId);
  const fi: number[] = [];
  const oi: number[] = [];
  for (const id of selection) {
    if (rowIndex(rows, id) < 0) continue;
    const f = fIdx.get(id);
    if (f !== undefined) fi.push(f);
    const o = oIdx.get(id);
    if (o !== undefined) oi.push(o);
  }
  fi.sort((x, y) => x - y);
  oi.sort((x, y) => x - y);
  return { folders: fi.map((i) => listing.folders[i]), objects: oi.map((i) => listing.objects[i]) };
}

/** Hook: counts of selected visible folders/objects (same rule as getSelected, results included). */
export function useSelectionInfo() {
  const id = usePaneId();
  const selection = usePanes((s) => s[id].selection);
  const rows = useViewRows(id);
  const searchOpen = usePaneSearch((s) => s.open);
  const searchSelection = usePaneSearch((s) => s.selection);
  const hits = usePaneSearch((s) => s.result?.hits);
  return useMemo(() => {
    if (!searchOpen) return summarize(selection, rows);
    const { folders, objects } = selectedHits(searchSelection, hits ?? []);
    const asRows: Row[] = [
      ...folders.map((folder): Row => ({ kind: "folder", id: folder.prefix, name: folder.name, folder })),
      ...objects.map((object): Row => ({ kind: "object", id: object.key, name: object.name, object })),
    ];
    return summarize(new Set(asRows.map((r) => r.id)), asRows);
  }, [searchOpen, searchSelection, hits, selection, rows]);
}

/**
 * The folder the selected items are listed in: the open folder, or (search results) the folder all
 * selected hits share, else the deepest folder that contains them all.
 */
export function getSelectionPrefix(pane: PaneId = activePane()): string {
  const { prefix, search } = getPane(pane);
  if (!search.open) return prefix;
  const { folders, objects } = getSelected(pane);
  const parents = [
    ...folders.map((f) => f.prefix.slice(0, f.prefix.length - f.name.length - 1)),
    ...objects.map((o) => o.key.slice(0, o.key.length - o.name.length)),
  ];
  if (!parents.length) return prefix;
  let common = parents[0];
  for (const p of parents) {
    while (!p.startsWith(common)) {
      const cut = common.slice(0, -1).lastIndexOf("/");
      common = cut >= 0 ? common.slice(0, cut + 1) : "";
    }
  }
  return common;
}

function summarize(selection: Set<string>, rows: Row[]) {
  let folders = 0;
  let objects = 0;
  let bytes = 0;
  let singleFolder: FolderEntry | null = null;
  let singleObject: ObjectEntry | null = null;
  if (selection.size) {
    // Loop over the smaller of the two: a few selected rows of a big listing are looked up by id.
    const picked: Row[] = [];
    if (selection.size < rows.length) {
      for (const id of selection) {
        const i = rowIndex(rows, id);
        if (i >= 0) picked.push(rows[i]);
      }
    }
    for (const r of selection.size < rows.length ? picked : rows) {
      if (!selection.has(r.id)) continue;
      if (r.kind === "folder") {
        folders++;
        singleFolder = r.folder;
      } else {
        objects++;
        bytes += r.object.size;
        singleObject = r.object;
      }
    }
  }
  return {
    folders,
    objects,
    bytes,
    folder: folders === 1 && objects === 0 ? singleFolder : null,
    object: objects === 1 && folders === 0 ? singleObject : null,
  };
}
