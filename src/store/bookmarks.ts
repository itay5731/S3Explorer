// Bookmarked folders, per connection, in localStorage (see "Bookmarks" in docs/CONTRACT.md).
// Frontend only: nothing here reaches the backend. Prefixes are kept exactly as the pane had them.

import { create } from "zustand";
import { BOOKMARKS_MAX, type Bookmark } from "../lib/types";
import { displayName, prefixSegments } from "../lib/format";
import { readPref, writePref } from "./prefs";
import { toast } from "./toasts";

const STORE_PREFIX = "s3x.bookmarks.";
interface BookmarksState {
  /** The localStorage key of the connection in use; null while disconnected. */
  storeKey: string | null;
  items: Bookmark[];
}

export const useBookmarks = create<BookmarksState>(() => ({ storeKey: null, items: [] }));

const set = useBookmarks.setState;
const get = useBookmarks.getState;

/** The two places are the same bookmark (bucket names cannot contain "/", so this id is unique). */
export const bookmarkId = (b: Pick<Bookmark, "bucket" | "prefix">) => `${b.bucket}/${b.prefix}`;

/** The default label: the folder's name, or the bucket's at a root. */
export function defaultLabel(bucket: string, prefix: string): string {
  const segs = prefixSegments(prefix);
  return segs.length ? displayName(segs[segs.length - 1].name) : bucket;
}

/** Only well-formed, distinct entries survive a read (the stored value may be edited or corrupt). */
function readItems(storeKey: string): Bookmark[] {
  const raw = readPref<unknown>(storeKey, []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Bookmark[] = [];
  for (const b of raw as Partial<Bookmark>[]) {
    if (!b || typeof b.bucket !== "string" || !b.bucket || typeof b.prefix !== "string" || typeof b.label !== "string") continue;
    const id = bookmarkId(b as Bookmark);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ bucket: b.bucket, prefix: b.prefix, label: b.label || defaultLabel(b.bucket, b.prefix) });
    if (out.length >= BOOKMARKS_MAX) break;
  }
  return out;
}

function save(items: Bookmark[]) {
  const { storeKey } = get();
  set({ items });
  if (storeKey) writePref(storeKey, items);
}

/**
 * The list to change, read again from storage: another window on the same connection may have
 * changed it, and writing back a stale copy would drop its bookmarks.
 */
function current(): Bookmark[] {
  const { storeKey, items } = get();
  return storeKey ? readItems(storeKey) : items;
}

// Another window changed this connection's bookmarks: show its list.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    const { storeKey } = get();
    if (storeKey && e.key === storeKey) set({ items: readItems(storeKey) });
  });
}

/** A connection was made: loads its bookmarks. `key` is `connectionKey()` (store/app.ts). */
export function setBookmarksConnection(key: string) {
  const storeKey = STORE_PREFIX + key;
  set({ storeKey, items: readItems(storeKey) });
}

/** Disconnected: nothing is shown until the next connection. */
export function clearBookmarksConnection() {
  set({ storeKey: null, items: [] });
}

/**
 * A saved connection was deleted (`key` is its connection key): its bookmarks go too. If it is the one
 * in use, the list empties; new bookmarks are still kept under that key until the next connection.
 */
export function forgetBookmarks(key: string) {
  const storeKey = STORE_PREFIX + key;
  try {
    localStorage.removeItem(storeKey);
  } catch {
    /* storage unavailable */
  }
  if (get().storeKey === storeKey) set({ items: [] });
}

export function isBookmarked(items: Bookmark[], bucket: string, prefix: string): boolean {
  return items.some((b) => b.bucket === bucket && b.prefix === prefix);
}

/** Add or remove the bookmark for `bucket`/`prefix` (exactly as given). */
export function toggleBookmark(bucket: string, prefix: string) {
  if (!get().storeKey) return;
  const items = current();
  if (isBookmarked(items, bucket, prefix)) {
    const gone = items.find((b) => b.bucket === bucket && b.prefix === prefix)!;
    save(items.filter((b) => b !== gone));
    toast.info("Bookmark removed", gone.label);
    return;
  }
  if (items.length >= BOOKMARKS_MAX) {
    toast.warning(`You can keep up to ${BOOKMARKS_MAX} bookmarks`, "Remove one from the bookmarks bar to add another.");
    return;
  }
  const label = defaultLabel(bucket, prefix);
  save([...items, { bucket, prefix, label }]);
  toast.success("Bookmarked", label);
}

/**
 * Bookmark several folders of one bucket at once (the prefixes exactly as listed). Ones already
 * bookmarked are skipped; past the cap the rest are left out and the toast says so.
 */
export function addBookmarks(bucket: string, prefixes: string[]) {
  if (!get().storeKey) return;
  const items = current();
  const have = new Set(items.map(bookmarkId));
  const fresh: Bookmark[] = [];
  for (const prefix of prefixes) {
    const b = { bucket, prefix, label: defaultLabel(bucket, prefix) };
    if (have.has(bookmarkId(b))) continue;
    have.add(bookmarkId(b));
    fresh.push(b);
  }
  if (!fresh.length) return;
  const added = fresh.slice(0, Math.max(0, BOOKMARKS_MAX - items.length));
  if (added.length) save([...items, ...added]);
  if (added.length < fresh.length) {
    toast.warning(
      added.length ? `Bookmarked ${added.length} of ${fresh.length} folders` : `You can keep up to ${BOOKMARKS_MAX} bookmarks`,
      `The limit is ${BOOKMARKS_MAX} per connection. Remove some from the bookmarks bar to add more.`,
    );
  } else if (added.length === 1) {
    toast.success("Bookmarked", added[0].label);
  } else {
    toast.success(`Bookmarked ${added.length} folders`);
  }
}

export function removeBookmark(id: string) {
  save(current().filter((b) => bookmarkId(b) !== id));
}

/** Rename; an empty name restores the default label. */
export function renameBookmark(id: string, label: string) {
  const text = label.trim();
  save(current().map((b) => (bookmarkId(b) === id ? { ...b, label: text || defaultLabel(b.bucket, b.prefix) } : b)));
}

/** Put the bookmarks in this order (ids from `bookmarkId`). */
export function reorderBookmarks(ids: string[]) {
  const byId = new Map(current().map((b) => [bookmarkId(b), b]));
  const next = ids.map((id) => byId.get(id)).filter((b): b is Bookmark => !!b);
  if (next.length === byId.size) save(next);
}

