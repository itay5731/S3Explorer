// Derived view of the current listing: filtered + sorted rows, folders first.

import { useMemo } from "react";
import { create } from "zustand";
import type { FolderEntry, ObjectEntry, SearchHit } from "../lib/types";
import { activePane, getPane, matchesFilter, usePaneId, type PaneId, type SortState } from "./app";
import { isLocalPane, usePanes, type PaneState } from "./panes";
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

interface RowsCache {
  folders: FolderEntry[];
  objects: ObjectEntry[];
  filter: string;
  sort: SortState;
  /** The sizes' version the rows were sorted with (only matters for the Size sort). */
  sizes: number;
  rows: Row[];
}

/** One cache per pane, so two panes never evict each other's rows. */
const caches: Record<PaneId, RowsCache | null> = { a: null, b: null };

export function computeRows(folders: FolderEntry[], objects: ObjectEntry[], filter: string, sort: SortState, pane: PaneId): Row[] {
  const cache = caches[pane];
  const sizes = sort.key === "size" ? useSizesVersion.getState().v : -1;
  if (cache && cache.folders === folders && cache.objects === objects && cache.filter === filter && cache.sort === sort && cache.sizes === sizes) {
    return cache.rows;
  }
  const match = (name: string) => matchesFilter(name, filter);
  const fr: Row[] = [];
  for (const folder of folders) if (match(folder.name)) fr.push({ kind: "folder", id: folder.prefix, name: folder.name, folder });
  const or: Row[] = [];
  for (const object of objects) if (match(object.name)) or.push({ kind: "object", id: object.key, name: object.name, object });

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
  const val = (r: Row): number | string => {
    if (r.kind !== "object") return 0;
    switch (sort.key) {
      case "size":
        return r.object.size;
      case "modified":
        return r.object.lastModified ? Date.parse(r.object.lastModified) : 0;
      case "class":
        return r.object.storageClass ?? "";
      default:
        return 0;
    }
  };
  if (sort.key === "name") {
    or.sort((a, b) => dir * byName(a, b));
  } else {
    or.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb));
      return c !== 0 ? dir * c : byName(a, b);
    });
  }
  const rows = fr.concat(or);
  caches[pane] = { folders, objects, filter, sort, sizes, rows };
  return rows;
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
  const visible = new Set(getViewRows(pane).map((r) => r.id));
  return {
    folders: listing.folders.filter((f) => selection.has(f.prefix) && visible.has(f.prefix)),
    objects: listing.objects.filter((o) => selection.has(o.key) && visible.has(o.key)),
  };
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
    for (const r of rows) {
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
