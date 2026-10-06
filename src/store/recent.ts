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
    if (seq === scanSeq) useRecent.setState({ objects: listing.objects, truncated: listing.truncated, loading: false });
  } catch (e) {
    if (seq === scanSeq) useRecent.setState({ loading: false, error: e as AppError });
  }
}

/** Forget the list (on disconnect / a new connection), and drop any scan still running. */
export function clearRecent() {
  scanSeq++;
  useRecent.setState({ bucket: null, objects: [], truncated: false, loading: false, error: null });
}
