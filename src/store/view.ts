// Derived view of the current listing: filtered + sorted rows, folders first.

import { useMemo } from "react";
import type { FolderEntry, ObjectEntry } from "../lib/types";
import { useApp, type SortState } from "./app";

export type Row =
  | { kind: "folder"; id: string; name: string; folder: FolderEntry }
  | { kind: "object"; id: string; name: string; object: ObjectEntry };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

let cache: {
  folders: FolderEntry[];
  objects: ObjectEntry[];
  filter: string;
  sort: SortState;
  rows: Row[];
} | null = null;

export function computeRows(folders: FolderEntry[], objects: ObjectEntry[], filter: string, sort: SortState): Row[] {
  if (cache && cache.folders === folders && cache.objects === objects && cache.filter === filter && cache.sort === sort) {
    return cache.rows;
  }
  const f = filter.trim().toLowerCase();
  const match = (name: string) => !f || name.toLowerCase().includes(f);
  const fr: Row[] = [];
  for (const folder of folders) if (match(folder.name)) fr.push({ kind: "folder", id: folder.prefix, name: folder.name, folder });
  const or: Row[] = [];
  for (const object of objects) if (match(object.name)) or.push({ kind: "object", id: object.key, name: object.name, object });

  const dir = sort.dir;
  const byName = (a: Row, b: Row) => collator.compare(a.name, b.name);
  // Folders have no size/date/class: they always sort by name.
  fr.sort((a, b) => (sort.key === "name" ? dir : 1) * byName(a, b));
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
  cache = { folders, objects, filter, sort, rows };
  return rows;
}

export function useViewRows(): Row[] {
  const folders = useApp((s) => s.listing.folders);
  const objects = useApp((s) => s.listing.objects);
  const filter = useApp((s) => s.filter);
  const sort = useApp((s) => s.sort);
  return computeRows(folders, objects, filter, sort);
}

export function getViewRows(): Row[] {
  const s = useApp.getState();
  return computeRows(s.listing.folders, s.listing.objects, s.filter, s.sort);
}

/** Selected entries from the full listing (not just the filtered view). */
export function getSelected(): { folders: FolderEntry[]; objects: ObjectEntry[] } {
  const { selection, listing } = useApp.getState();
  if (!selection.size) return { folders: [], objects: [] };
  return {
    folders: listing.folders.filter((f) => selection.has(f.prefix)),
    objects: listing.objects.filter((o) => selection.has(o.key)),
  };
}

/** Hook: counts of selected folders/objects (cheap, re-renders only when selection/listing change). */
export function useSelectionInfo() {
  const selection = useApp((s) => s.selection);
  const listing = useApp((s) => s.listing);
  return useMemo(() => summarize(selection, listing.folders, listing.objects), [selection, listing.folders, listing.objects]);
}

function summarize(selection: Set<string>, allFolders: FolderEntry[], allObjects: ObjectEntry[]) {
  let folders = 0;
  let objects = 0;
  let bytes = 0;
  let singleFolder: FolderEntry | null = null;
  let singleObject: ObjectEntry | null = null;
  if (selection.size) {
    for (const f of allFolders) {
      if (selection.has(f.prefix)) {
        folders++;
        singleFolder = f;
      }
    }
    for (const o of allObjects) {
      if (selection.has(o.key)) {
        objects++;
        bytes += o.size;
        singleObject = o;
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
