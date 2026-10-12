// Folder sizes calculated on request (see "Folder size" in docs/CONTRACT.md), cached per bucket +
// prefix for the session. Anything that changes what is under a cached folder drops its entry (and
// cancels its scan), so a stale size is never shown.

import { create } from "zustand";
import * as api from "../lib/api";
import type { AppError, FolderSize } from "../lib/types";
import { isJobActive, touchesPrefix } from "../lib/ops";
import { useApp } from "./app";
import { batchRequest, isBatchActive, onBatchUpdate } from "./batches";
import { jobRequest, onJobUpdate } from "./jobs";
import { onTransferFinished } from "./transfers";
import { useObjectRevs } from "./versions";

export interface FolderSizeEntry {
  /** The last result, kept while a recalculation runs. */
  size: FolderSize | null;
  /** When `size` was calculated (ISO). */
  at: string | null;
  /** The running scan's id, or null. */
  scan: string | null;
  error: AppError | null;
}

export const useFolderSizes = create<{ byId: Record<string, FolderSizeEntry> }>(() => ({ byId: {} }));

export const folderSizeId = (bucket: string, prefix: string) => `${bucket}\u0000${prefix}`;

export const useFolderSize = (bucket: string | null, prefix: string): FolderSizeEntry | undefined =>
  useFolderSizes((s) => (bucket ? s.byId[folderSizeId(bucket, prefix)] : undefined));

let seq = 0;

function patch(id: string, fn: (e: FolderSizeEntry | undefined) => FolderSizeEntry | undefined) {
  useFolderSizes.setState((s) => {
    const next = fn(s.byId[id]);
    const byId = { ...s.byId };
    if (next) byId[id] = next;
    else delete byId[id];
    return { byId };
  });
}

/** Start (or restart) the scan of one folder. The prefix is the server's own, sent verbatim. */
export async function calculateFolderSize(bucket: string, prefix: string): Promise<void> {
  const id = folderSizeId(bucket, prefix);
  const old = useFolderSizes.getState().byId[id]?.scan;
  if (old) return; // already running
  const scan = `folder-size-${++seq}`;
  patch(id, (e) => ({ size: e?.size ?? null, at: e?.at ?? null, scan, error: null }));
  try {
    const size = await api.folderSize(scan, bucket, prefix);
    // Dropped (something changed under it, a disconnect) or cancelled meanwhile: not ours to show.
    patch(id, (e) => (e?.scan === scan ? { size, at: new Date().toISOString(), scan: null, error: null } : e));
  } catch (err) {
    const error = err as AppError;
    patch(id, (e) => (e?.scan !== scan ? e : error.code === "Cancelled" ? { ...e, scan: null } : { ...e, scan: null, error }));
  }
}

export function calculateFolderSizes(bucket: string, prefixes: string[]) {
  for (const p of prefixes) void calculateFolderSize(bucket, p);
}

/** Stop the running scan of this folder; a previous result stays. */
export function cancelFolderSize(bucket: string, prefix: string) {
  const id = folderSizeId(bucket, prefix);
  const scan = useFolderSizes.getState().byId[id]?.scan;
  if (!scan) return;
  patch(id, (e) => (e ? { ...e, scan: null } : e));
  void api.cancelFolderSize(scan).catch(() => {});
}

export function cancelFolderSizes(bucket: string, prefixes: string[]) {
  for (const p of prefixes) cancelFolderSize(bucket, p);
}

/** Forget every cached size whose folder could hold `path` (a key or prefix) or lies inside it. */
function dropTouching(bucket: string, path: string) {
  const head = `${bucket}\u0000`;
  const { byId } = useFolderSizes.getState();
  const gone = Object.keys(byId).filter((id) => id.startsWith(head) && touchesPrefix(path, id.slice(head.length)));
  if (!gone.length) return;
  for (const id of gone) {
    const scan = byId[id].scan;
    if (scan) void api.cancelFolderSize(scan).catch(() => {});
  }
  useFolderSizes.setState((s) => {
    const next = { ...s.byId };
    for (const id of gone) delete next[id];
    return { byId: next };
  });
}

function clearFolderSizes() {
  // The backend cancels its scans on disconnect; clearing the entries makes late results land nowhere.
  useFolderSizes.setState({ byId: {} });
}

/** Install once (Explorer): uploads, jobs and version changes drop the sizes they make stale. */
export function installFolderSizeEffects(): () => void {
  const offs = [
    onTransferFinished((t) => {
      if (t.kind === "upload" && t.status === "completed") dropTouching(t.bucket, t.key);
    }),
    onBatchUpdate((b, prev) => {
      if (b.kind !== "upload") return;
      // Every file that lands, and the end (a cancelled batch may have written some).
      const finished = !isBatchActive(b) && (!prev || isBatchActive(prev));
      if (!finished && prev && prev.doneFiles === b.doneFiles) return;
      const req = batchRequest(b.id);
      dropTouching(req?.bucket ?? b.bucket, req?.prefix ?? b.prefix);
    }),
    onJobUpdate((j, prev) => {
      // Tags and archive restores change no sizes.
      if (j.kind === "tag" || j.kind === "restore") return;
      const finished = !isJobActive(j) && (!prev || isJobActive(prev));
      if (!finished && prev && prev.doneItems === j.doneItems) return;
      const req = jobRequest(j.id);
      if (!req) {
        // No request known (started before this window loaded): drop everything in its buckets.
        dropTouching(j.srcBucket, "");
        if (j.destBucket) dropTouching(j.destBucket, "");
        return;
      }
      for (const it of req.items) {
        if (j.kind !== "copy") dropTouching(req.srcBucket, it.from);
        if (req.destBucket && it.to !== null) dropTouching(req.destBucket, it.to);
      }
    }),
    // A version restored as current or deleted (the details panel bumps the object).
    useObjectRevs.subscribe((s, prev) => {
      for (const id of Object.keys(s.revs)) {
        if (s.revs[id] === prev.revs[id]) continue;
        const at = id.indexOf("\u0000");
        dropTouching(id.slice(0, at), id.slice(at + 1));
      }
    }),
    useApp.subscribe((s, prev) => {
      if (s.connection !== prev.connection) clearFolderSizes();
    }),
  ];
  return () => offs.forEach((off) => off());
}
