// Tags shown outside the tag dialogs: an object's tags in the details panel, and which buckets are
// known to have tags (a small icon in the sidebar; only for buckets whose tags were loaded anyway).

import { create } from "zustand";
import * as api from "../lib/api";
import type { AppError, Tag } from "../lib/types";
import { isJobActive } from "../lib/ops";
import { onJobUpdate } from "./jobs";

interface TagsState {
  /** Object tags by bucket + key, as last read or written. */
  objects: Record<string, { tags: Tag[] | null; error: AppError | null }>;
  /** Bucket tags read or written this session (never fetched just to show the icon). */
  buckets: Record<string, Tag[]>;
}

export const useTags = create<TagsState>(() => ({ objects: {}, buckets: {} }));

export const objectTagId = (bucket: string, key: string) => `${bucket}\u0000${key}`;

let seq = 0;
const latest = new Map<string, number>();

/** Read an object's tags into the store. A later call for the same object wins. */
export async function loadObjectTags(bucket: string, key: string): Promise<void> {
  const id = objectTagId(bucket, key);
  const mine = ++seq;
  latest.set(id, mine);
  try {
    const tags = await api.getObjectTags(bucket, key);
    if (latest.get(id) === mine) setObjectTags(bucket, key, tags);
  } catch (e) {
    if (latest.get(id) === mine) useTags.setState((s) => ({ objects: { ...s.objects, [id]: { tags: null, error: e as AppError } } }));
  }
}

export function setObjectTags(bucket: string, key: string, tags: Tag[]) {
  const id = objectTagId(bucket, key);
  useTags.setState((s) => ({ objects: { ...s.objects, [id]: { tags, error: null } } }));
}

export function setBucketTags(bucket: string, tags: Tag[]) {
  useTags.setState((s) => ({ buckets: { ...s.buckets, [bucket]: tags } }));
}

/** Forget cached object tags of a bucket (after a bulk tag job there), so they are read again. */
function forgetBucketObjects(bucket: string) {
  const prefix = `${bucket}\u0000`;
  useTags.setState((s) => {
    const objects = Object.fromEntries(Object.entries(s.objects).filter(([id]) => !id.startsWith(prefix)));
    return { objects };
  });
}

export function clearTags() {
  useTags.setState({ objects: {}, buckets: {} });
}

/** Install once: a finished tag job (or a copy/move, which carries tags) makes cached object tags stale. */
export function installTagEffects(): () => void {
  return onJobUpdate((j, prev) => {
    const finished = !isJobActive(j) && (!prev || isJobActive(prev));
    if (!finished) return;
    if (j.kind === "tag" || j.kind === "move" || j.kind === "delete") forgetBucketObjects(j.srcBucket);
    if (j.destBucket) forgetBucketObjects(j.destBucket);
  });
}
