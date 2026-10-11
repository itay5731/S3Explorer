// The newest files of the open bucket, shown in the sidebar. Scanned when a bucket is opened and
// again on request (see "Newest files" in docs/CONTRACT.md).

import { create } from "zustand";
import * as api from "../lib/api";
import type { AppError, ObjectEntry } from "../lib/types";

interface RecentState {
  /** The bucket the list below belongs to; null before the first scan. */
  bucket: string | null;
  /** Newest first. */
  objects: ObjectEntry[];
  /** The scan stopped at its limit, so newer files may exist beyond what was looked at. */
  truncated: boolean;
  loading: boolean;
  error: AppError | null;
}

export const useRecent = create<RecentState>(() => ({
  bucket: null,
  objects: [],
  truncated: false,
  loading: false,
  error: null,
}));

let scanSeq = 0;

/**
 * The last scan of each bucket this session. Switching the watched bucket back (another pane became
 * active) shows it again without scanning; only a refresh, a change in that bucket or a bucket not
 * scanned yet starts a scan.
 */
const cache = new Map<string, { objects: ObjectEntry[]; truncated: boolean }>();

/** Show `bucket`'s newest files: the cached scan when there is one, else a new scan. */
export function showRecent(bucket: string): void {
  const hit = cache.get(bucket);
  if (!hit) {
    void loadRecent(bucket);
    return;
  }
  scanSeq++; // a scan of the previous bucket still running must not replace this list
  useRecent.setState({ bucket, objects: hit.objects, truncated: hit.truncated, loading: false, error: null });
}

/** Something changed in `bucket` while another one is watched: scan it again when it is shown next. */
export function forgetRecent(bucket: string) {
  cache.delete(bucket);
}

/** Scan `bucket` for its newest files. A later call wins over one that is still running. */
export async function loadRecent(bucket: string): Promise<void> {
  const seq = ++scanSeq;
  // Looking again at the same bucket keeps the current list on screen until the new one arrives.
  useRecent.setState((s) => ({
    bucket,
    loading: true,
    error: null,
    ...(s.bucket === bucket ? {} : { objects: [], truncated: false }),
  }));
  try {
    const listing = await api.listRecent(bucket, "");
    cache.set(bucket, { objects: listing.objects, truncated: listing.truncated });
    if (seq === scanSeq) useRecent.setState({ objects: listing.objects, truncated: listing.truncated, loading: false });
  } catch (e) {
    if (seq === scanSeq) useRecent.setState({ loading: false, error: e as AppError });
  }
}

/** Forget the list (on disconnect / a new connection), and drop any scan still running. */
export function clearRecent() {
  scanSeq++;
  cache.clear();
  useRecent.setState({ bucket: null, objects: [], truncated: false, loading: false, error: null });
}
