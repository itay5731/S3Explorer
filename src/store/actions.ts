// User-level operations that combine API calls, state and toasts.

import * as api from "../lib/api";
import type { AppError, ObjectEntry, Transfer } from "../lib/types";
import { basename, joinKey, sanitizeFileName, uniqueFileName } from "../lib/format";
import { activePane, getPane, openModal, refresh, setTransfersOpen, upsertListedFolder, upsertListedObject } from "./app";
import { markHiddenTabsStale, PANE_IDS, type PaneId } from "./panes";
import { isDenied, toast, toastDenied, toastFailure } from "./toasts";
import { notifyInBackground } from "./notify";
import { ARCHIVED_MESSAGE, splitReadable, toastArchivedSkipped } from "./archive";
import { scheduleTransferResync, onTransferFinished, selectMovingCount, useTransfers } from "./transfers";

/** Upload files into a pane's folder (default: the active pane). */
export async function uploadPaths(paths: string[], pane: PaneId = activePane()) {
  const { bucket, prefix } = getPane(pane);
  if (!bucket) {
    toast.info("Select a bucket first", "Uploads go into the folder you are viewing.");
    return;
  }
  if (!paths.length) return;
  let started = 0;
  for (const path of paths) {
    const key = joinKey(prefix, basename(path));
    try {
      await api.startUpload(bucket, key, path);
      started++;
    } catch (e) {
      toastFailure(`Could not upload ${basename(path)}`, e as AppError, "upload files");
    }
  }
  if (started) {
    setTransfersOpen(true);
    scheduleTransferResync();
    toast.info(started === 1 ? `Uploading ${basename(paths[0])}` : `Uploading ${started} files`, `to s3://${bucket}/${prefix}`);
  }
}

export async function pickAndUpload() {
  // The pane the upload was asked from, even if another one becomes active while the picker is open.
  const pane = activePane();
  try {
    const paths = await api.pickFiles();
    await uploadPaths(paths, pane);
  } catch (e) {
    toast.error("Could not open file picker", e as AppError);
  }
}

/** Download objects of `bucket` (default: the active pane's; the newest files name theirs). */
export async function downloadObjects(selected: ObjectEntry[], bucket: string | null = getPane().bucket) {
  if (!bucket || !selected.length) return;
  // Archived objects that aren't restored can't be read: left out, with the reason.
  const { readable: objects, blocked } = await splitReadable(bucket, selected);
  if (!objects.length) {
    toast.error(blocked.length === 1 ? `Can’t download “${blocked[0].name}”` : "Can’t download these objects", `${ARCHIVED_MESSAGE}.`);
    return;
  }
  if (blocked.length) toastArchivedSkipped(blocked.length, "download");
  try {
    if (objects.length === 1) {
      const obj = objects[0];
      const dest = await api.pickSavePath(sanitizeFileName(obj.name));
      if (!dest) return;
      await api.startDownload(bucket, obj.key, dest);
    } else {
      const dir = await api.pickDirectory();
      if (!dir) return;
      let failed = 0;
      // Local names are sanitized (no path tricks from key segments) and made unique
      // case-insensitively, so two objects never target the same file.
      const taken = new Set<string>();
      for (const obj of objects) {
        try {
          const local = uniqueFileName(sanitizeFileName(obj.name), taken);
          await api.startDownload(bucket, obj.key, await api.joinPath(dir, local));
        } catch (e) {
          failed++;
          toastFailure(`Could not download ${obj.name}`, e as AppError, "download files");
        }
      }
      if (failed < objects.length) toast.info(`Downloading ${objects.length - failed} files`, dir);
    }
    setTransfersOpen(true);
    scheduleTransferResync();
  } catch (e) {
    toastFailure("Download failed", e as AppError, "download files");
  }
}

/** Create `name` in `bucket`/`prefix` (captured when the dialog opened). */
export async function createFolder(name: string, bucket: string, prefix: string): Promise<boolean> {
  const full = joinKey(prefix, name.trim() + "/");
  try {
    await api.createFolder(bucket, full);
    toast.success("Folder created", full);
    // Every pane that shows the folder.
    for (const id of PANE_IDS) if (getPane(id).bucket === bucket && getPane(id).prefix === prefix) void refresh(id);
    markHiddenTabsStale((b, p) => b === bucket && p === prefix);
    return true;
  } catch (e) {
    toastFailure("Could not create folder", e as AppError, "create folders");
    return false;
  }
}

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast.success(`${what} copied`, text);
}

/**
 * Transfers that finished since the queue last drained, reported in one OS notification. Several
 * transfers often finish in the same frame; each would otherwise see an empty queue and notify.
 */
let drained: Transfer[] = [];
let drainScheduled = false;

function notifyDrained() {
  drainScheduled = false;
  const done = drained;
  drained = [];
  // A paused transfer waits for the user: the queue has drained without it.
  if (!done.length || selectMovingCount(useTransfers.getState()) > 0) return;
  const failed = done.filter((t) => t.status === "failed").length;
  const title = failed ? (failed === 1 ? "Transfer failed" : `${failed} transfers failed`) : "Transfers finished";
  const body = done.length === 1 ? basename(done[0].key) : `${done.length} transfers${failed ? `, ${failed} failed` : ""}`;
  notifyInBackground(title, body);
}

/** Keep the listing in sync with finished uploads and surface failures. */
export function installTransferEffects(): () => void {
  return onTransferFinished((t) => {
    // One notification when the queue drains, not one per file.
    if (t.status !== "cancelled") {
      drained.push(t);
      if (selectMovingCount(useTransfers.getState()) === 0 && !drainScheduled) {
        drainScheduled = true;
        queueMicrotask(notifyDrained);
      }
    }
    if (t.status === "failed") {
      if (isDenied(t.error)) toastDenied(t.kind === "upload" ? "upload files" : "download files", t.error ?? undefined);
      else toast.error(`${t.kind === "upload" ? "Upload" : "Download"} failed: ${basename(t.key)}`, t.error ?? undefined);
      return;
    }
    if (t.status !== "completed" || t.kind !== "upload") return;
    // Every pane showing the folder the file went into (or a parent of it) gets the new row; hidden
    // tabs showing it refresh when they are shown.
    markHiddenTabsStale((bucket, prefix) => t.bucket === bucket && t.key.startsWith(prefix));
    for (const pane of PANE_IDS) {
      const { bucket, prefix } = getPane(pane);
      if (t.bucket !== bucket || !t.key.startsWith(prefix)) continue;
      const rest = t.key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        upsertListedFolder(t.bucket, { prefix: prefix + rest.slice(0, slash + 1), name: rest.slice(0, slash) }, pane);
      } else {
        upsertListedObject(
          t.bucket,
          {
            key: t.key,
            name: rest,
            size: t.totalBytes,
            lastModified: t.finishedAt ?? new Date().toISOString(),
            etag: null,
            storageClass: "STANDARD",
          },
          pane,
        );
      }
    }
  });
}

/** Open the New folder dialog for a pane's folder (default: the active pane), captured now. */
export function openNewFolder(pane: PaneId = activePane()) {
  const { bucket, prefix } = getPane(pane);
  if (bucket) openModal({ kind: "newFolder", bucket, prefix });
}
