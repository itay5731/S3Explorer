// Archived objects (Glacier Flexible Retrieval, Deep Archive): whether each one can be read now.
// The listing only carries the storage class; whether an archived object is restored comes from
// head_object (`archived`, `restore`), remembered here per bucket + key.

import { create } from "zustand";
import { useEffect } from "react";
import * as api from "../lib/api";
import { ARCHIVE_STORAGE_CLASSES, type ObjectEntry, type ObjectMeta } from "../lib/types";
import { isJobActive, plural } from "../lib/ops";
import { onJobUpdate } from "./jobs";
import { toast } from "./toasts";

export interface ArchiveInfo {
  storageClass: string | null;
  /** A restore is required before the object can be read. */
  archived: boolean;
  restore: ObjectMeta["restore"];
}

interface ArchiveState {
  byId: Record<string, ArchiveInfo>;
}

export const useArchive = create<ArchiveState>(() => ({ byId: {} }));

export const archiveId = (bucket: string, key: string) => `${bucket}\u0000${key}`;

/** Tooltip on actions that need the object's data. */
export const ARCHIVED_REASON = "Archived; restore it first";
/** Same wording as the backend's per-object failure. */
export const ARCHIVED_MESSAGE = "The object is archived; restore it first";

export const isArchiveClass = (sc: string | null | undefined): boolean =>
  !!sc && (ARCHIVE_STORAGE_CLASSES as readonly string[]).includes(sc);

export function rememberArchiveMeta(bucket: string, meta: ObjectMeta) {
  const info: ArchiveInfo = { storageClass: meta.storageClass, archived: meta.archived, restore: meta.restore };
  useArchive.setState((s) => ({ byId: { ...s.byId, [archiveId(bucket, meta.key)]: info } }));
}

/** After restore_object succeeded: the object is being restored (still unreadable). */
export function markRestoreRequested(bucket: string, key: string, storageClass: string | null) {
  const info: ArchiveInfo = { storageClass, archived: true, restore: { inProgress: true, expiresAt: null } };
  useArchive.setState((s) => ({ byId: { ...s.byId, [archiveId(bucket, key)]: info } }));
}

/**
 * Does the object need a restore before it can be downloaded, copied or moved? `false` when its
 * storage class is not an archive class, `null` when it is but its restore state isn't known yet.
 * (INTELLIGENT_TIERING's archive tiers are not visible in a listing; the backend fails those per object.)
 */
export function needsRestore(bucket: string, o: Pick<ObjectEntry, "key" | "storageClass">, byId = useArchive.getState().byId): boolean | null {
  if (!isArchiveClass(o.storageClass)) {
    const info = byId[archiveId(bucket, o.key)];
    return info ? info.archived : false;
  }
  const info = byId[archiveId(bucket, o.key)];
  return info ? info.archived : null;
}

const inflight = new Map<string, Promise<void>>();

/** Read the object's restore state (head_object) unless it is known or already being read. */
export function ensureArchiveInfo(bucket: string, key: string): Promise<void> {
  const id = archiveId(bucket, key);
  if (useArchive.getState().byId[id]) return Promise.resolve();
  let p = inflight.get(id);
  if (!p) {
    p = api
      .headObject(bucket, key)
      .then((m) => rememberArchiveMeta(bucket, m))
      .catch(() => {
        /* unknown: the backend decides when the action runs */
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

/**
 * For one selected object: "blocked" while it needs a restore (or while that is being checked for
 * an archived storage class), so buttons can be disabled with the reason.
 */
export function useArchiveBlocked(bucket: string | null, o: Pick<ObjectEntry, "key" | "storageClass"> | null): boolean {
  const state = useArchive((s) => (bucket && o ? needsRestore(bucket, o, s.byId) : false));
  const unknown = state === null;
  useEffect(() => {
    if (bucket && o && unknown) void ensureArchiveInfo(bucket, o.key);
  }, [bucket, o, unknown]);
  return state !== false;
}

/** Look up at most this many unknown restore states before acting on a selection. */
const CHECK_MAX = 200;

/**
 * Split objects into those that can be read and those that need a restore first. Archived ones
 * whose state is unknown are checked with head_object (up to CHECK_MAX; beyond that, and when a
 * check fails, the object is left in and the backend fails it per object if it is unreadable).
 */
export async function splitReadable<T extends Pick<ObjectEntry, "key" | "storageClass">>(
  bucket: string,
  objects: T[],
): Promise<{ readable: T[]; blocked: T[] }> {
  const unknown = objects.filter((o) => needsRestore(bucket, o) === null).slice(0, CHECK_MAX);
  for (let i = 0; i < unknown.length; i += 8) {
    await Promise.all(unknown.slice(i, i + 8).map((o) => ensureArchiveInfo(bucket, o.key)));
  }
  const byId = useArchive.getState().byId;
  const readable: T[] = [];
  const blocked: T[] = [];
  for (const o of objects) (needsRestore(bucket, o, byId) === true ? blocked : readable).push(o);
  return { readable, blocked };
}

/** "2 archived objects skipped": the same reason the backend gives per object. */
export function toastArchivedSkipped(blocked: number, action: string) {
  toast.warning(
    `${plural(blocked, "archived object")} skipped`,
    `${ARCHIVED_MESSAGE}. ${blocked === 1 ? "It was" : "They were"} left out of the ${action}; Restore archived… in the menu brings ${blocked === 1 ? "it" : "them"} back.`,
  );
}

export function clearArchive() {
  useArchive.setState({ byId: {} });
}

/** Install once: a finished restore, copy or move job makes the remembered states of that bucket stale. */
export function installArchiveEffects(): () => void {
  return onJobUpdate((j, prev) => {
    const finished = !isJobActive(j) && (!prev || isJobActive(prev));
    if (!finished || j.kind === "tag") return;
    const drop = [j.srcBucket, j.destBucket].filter(Boolean).map((b) => `${b}\u0000`);
    useArchive.setState((s) => ({
      byId: Object.fromEntries(Object.entries(s.byId).filter(([id]) => !drop.some((d) => id.startsWith(d)))),
    }));
  });
}
