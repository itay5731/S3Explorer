// Menu items and helpers shared by the Activity panel's Now and History tabs.

import { useCallback } from "react";
import { ClipboardCopy, Copy, FolderSearch, LocateFixed } from "lucide-react";
import * as api from "../lib/api";
import type { AppError, Transfer } from "../lib/types";
import { navigate, revealObject, useApp } from "../store/app";
import { closeSearch } from "../store/search";
import { copyText } from "../store/actions";
import { toast } from "../store/toasts";
import type { PopupMenuItem } from "./PopupMenu";

export async function reveal(t: Pick<Transfer, "localPath">) {
  try {
    await api.revealInFolder(t.localPath);
  } catch (e) {
    toast.error("Could not show file", e as AppError);
  }
}

export type KnownBucket = (bucket: string | null | undefined) => boolean;

/** Is `bucket` one of the current connection's buckets (listed or added by name)? */
export function useKnownBucket(): KnownBucket {
  const connected = useApp((s) => !!s.connection);
  const buckets = useApp((s) => s.buckets);
  const added = useApp((s) => s.addedBuckets);
  return useCallback(
    (bucket) => !!bucket && connected && (buckets.some((b) => b.name === bucket) || added.some((b) => b.name === bucket)),
    [connected, buckets, added],
  );
}

export async function openLocal(path: string, what: string) {
  try {
    await api.openLocal(path);
  } catch (e) {
    toast.error(`Could not open ${what}`, e as AppError);
  }
}

/** "Go to …": disabled, with the reason, when the bucket is not in this connection. */
export function goItem(label: string, bucket: string, known: boolean, go: () => void): PopupMenuItem {
  return known
    ? { label, icon: <LocateFixed size={14} />, action: go }
    : {
        label,
        icon: <LocateFixed size={14} />,
        action: () => {},
        disabled: true,
        hint: "Other connection",
        title: `s3://${bucket} is not one of this connection's buckets`,
      };
}

export const goObject = (bucket: string, key: string) => {
  closeSearch();
  revealObject(bucket, key, key.slice(key.lastIndexOf("/") + 1));
};
export const goFolder = (bucket: string, prefix: string) => {
  closeSearch();
  navigate(bucket, prefix);
};

export const copyKeyItem = (key: string): PopupMenuItem => ({ label: "Copy key", icon: <Copy size={14} />, action: () => void copyText(key, "Key") });
export const copyPathItem = (path: string): PopupMenuItem => ({
  label: "Copy local path",
  icon: <ClipboardCopy size={14} />,
  action: () => void copyText(path, "Local path"),
});
export const showItem = (path: string): PopupMenuItem => ({ label: "Show in folder", icon: <FolderSearch size={14} />, action: () => void reveal({ localPath: path }) });
