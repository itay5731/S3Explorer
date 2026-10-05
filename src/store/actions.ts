// User-level operations that combine API calls, state and toasts.

import * as api from "../lib/api";
import type { AppError, ObjectEntry } from "../lib/types";
import { basename, joinKey, sanitizeFileName, uniqueFileName } from "../lib/format";
import { refresh, setTransfersOpen, useApp, upsertListedFolder, upsertListedObject } from "./app";
import { toast } from "./toasts";
import { scheduleTransferResync, onTransferFinished } from "./transfers";

export async function uploadPaths(paths: string[]) {
  const { bucket, prefix } = useApp.getState();
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
      toast.error(`Could not upload ${basename(path)}`, e as AppError);
    }
  }
  if (started) {
    setTransfersOpen(true);
    scheduleTransferResync();
    toast.info(started === 1 ? `Uploading ${basename(paths[0])}` : `Uploading ${started} files`, `to s3://${bucket}/${prefix}`);
  }
}

export async function pickAndUpload() {
  try {
    const paths = await api.pickFiles();
    await uploadPaths(paths);
  } catch (e) {
    toast.error("Could not open file picker", e as AppError);
  }
}

export async function downloadObjects(objects: ObjectEntry[]) {
  const { bucket } = useApp.getState();
  if (!bucket || !objects.length) return;
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
          toast.error(`Could not download ${obj.name}`, e as AppError);
        }
      }
      if (failed < objects.length) toast.info(`Downloading ${objects.length - failed} files`, dir);
    }
    setTransfersOpen(true);
    scheduleTransferResync();
  } catch (e) {
    toast.error("Download failed", e as AppError);
  }
}

export async function createFolder(name: string): Promise<boolean> {
  const { bucket, prefix } = useApp.getState();
  if (!bucket) return false;
  const full = joinKey(prefix, name.trim() + "/");
  try {
    await api.createFolder(bucket, full);
    toast.success("Folder created", full);
    refresh();
    return true;
  } catch (e) {
    toast.error("Could not create folder", e as AppError);
    return false;
  }
}

export async function deleteFolder(prefix: string): Promise<boolean> {
  const { bucket } = useApp.getState();
  if (!bucket) return false;
  try {
    // Exactly the prefix the user confirmed. Never normalize it: "a//" must not become "a/".
    const res = await api.deleteFolder(bucket, prefix);
    if (res.errors.length) {
      toast.error(
        `Deleted ${res.deleted} objects, ${res.errors.length} failed`,
        res.errors
          .slice(0, 3)
          .map((e) => `${e.key}: ${e.message}`)
          .join("\n"),
      );
    } else {
      toast.success(`Deleted ${res.deleted.toLocaleString()} object${res.deleted === 1 ? "" : "s"}`, `s3://${bucket}/${prefix}`);
    }
    refresh();
    return true;
  } catch (e) {
    toast.error("Could not delete folder", e as AppError);
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

/** Keep the listing in sync with finished uploads and surface failures. */
export function installTransferEffects(): () => void {
  return onTransferFinished((t) => {
    if (t.status === "failed") {
      toast.error(`${t.kind === "upload" ? "Upload" : "Download"} failed: ${basename(t.key)}`, t.error ?? undefined);
      return;
    }
    if (t.status !== "completed" || t.kind !== "upload") return;
    const { bucket, prefix } = useApp.getState();
    if (t.bucket !== bucket || !t.key.startsWith(prefix)) return;
    const rest = t.key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      upsertListedFolder(t.bucket, { prefix: prefix + rest.slice(0, slash + 1), name: rest.slice(0, slash) });
    } else {
      upsertListedObject(t.bucket, {
        key: t.key,
        name: rest,
        size: t.totalBytes,
        lastModified: t.finishedAt ?? new Date().toISOString(),
        etag: null,
        storageClass: "STANDARD",
      });
    }
  });
}
