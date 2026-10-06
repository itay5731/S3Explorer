// Bucket versioning state, read once per bucket per connection (it decides whether the details
// panel offers an object's versions), and which transfers download a specific version.

import { create } from "zustand";
import * as api from "../lib/api";
import type { BucketVersioning } from "../lib/types";

interface VersioningState {
  /** undefined = not asked yet; null = could not be read (the versions section stays hidden). */
  byBucket: Record<string, BucketVersioning | null>;
}

export const useVersioning = create<VersioningState>(() => ({ byBucket: {} }));

const asked = new Set<string>();
let generation = 0;

/** Read the bucket's versioning state once; later calls are no-ops until the connection changes. */
export function ensureVersioning(bucket: string) {
  if (asked.has(bucket)) return;
  asked.add(bucket);
  const gen = generation;
  api
    .getBucketVersioning(bucket)
    .then(
      (v) => v,
      () => null,
    )
    .then((v) => {
      if (gen !== generation) return;
      useVersioning.setState((s) => ({ byBucket: { ...s.byBucket, [bucket]: v } }));
    });
}

/** The bucket has (or had) versioning: its objects can have older versions. */
export const hasVersions = (v: BucketVersioning | null | undefined) => v === "Enabled" || v === "Suspended";

export function clearVersioning() {
  generation++;
  asked.clear();
  useVersioning.setState({ byBucket: {} });
}

// ---- version downloads ------------------------------------------------------------------------
// A Transfer has no label, so the Activity row learns from here that it downloads an older version.

export const useVersionDownloads = create<{ byTransfer: Record<string, string> }>(() => ({ byTransfer: {} }));

export function rememberVersionDownload(transferId: string, versionId: string) {
  useVersionDownloads.setState((s) => ({ byTransfer: { ...s.byTransfer, [transferId]: versionId } }));
}

/** "3HL4kqtJ…MLUo": long version ids shortened for display (the full id is always one click away). */
export function shortVersionId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

// ---- "this object changed" signal --------------------------------------------------------------
// After a version is restored or deleted, or a restore is requested, the details panel reads the
// object's metadata and versions again.

export const useObjectRevs = create<{ revs: Record<string, number> }>(() => ({ revs: {} }));

export const objectRevId = (bucket: string, key: string) => `${bucket}\u0000${key}`;

export function bumpObject(bucket: string, key: string) {
  const id = objectRevId(bucket, key);
  useObjectRevs.setState((s) => ({ revs: { ...s.revs, [id]: (s.revs[id] ?? 0) + 1 } }));
}

export const useObjectRev = (bucket: string, key: string) => useObjectRevs((s) => s.revs[objectRevId(bucket, key)] ?? 0);
