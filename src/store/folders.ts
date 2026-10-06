// Folder uploads and downloads (batches): opening the confirmation dialogs, OS drops of folders,
// and the effects of running batches (listing refresh, completion toasts, notifications).

import * as api from "../lib/api";
import type { AppError, Batch, FolderEntry } from "../lib/types";
import { basename } from "../lib/format";
import { plural, touchesPrefix } from "../lib/ops";
import { openModal, setTransfersOpen, useApp } from "./app";
import { uploadPaths } from "./actions";
import { batchRequest, isBatchActive, onBatchUpdate, useBatches } from "./batches";
import { notifyInBackground } from "./notify";
import { scheduleRefresh } from "./ops";
import { toast } from "./toasts";

/** The destination the upload dialog offers for `localPath`: the open folder plus the folder's own name. */
export function defaultUploadPrefix(prefix: string, localPath: string): string {
  const name = basename(localPath).trim();
  // A drive root ("D:\") has no name of its own: upload straight into the open folder.
  if (!name || /^[A-Za-z]:$/.test(name)) return prefix;
  return prefix + name + "/";
}

/** Toolbar / context menu: choose a local folder, then confirm the upload. */
export async function pickAndUploadFolder() {
  const { bucket, prefix } = useApp.getState();
  if (!bucket) {
    toast.info("Select a bucket first", "Uploads go into the folder you are viewing.");
    return;
  }
  let path: string | null;
  try {
    path = await api.pickFolder();
  } catch (e) {
    toast.error("Could not open the folder picker", e as AppError);
    return;
  }
  if (!path) return;
  openModal({ kind: "uploadFolder", bucket, prefix, localPath: path });
}

let dropSeq = 0;

/**
 * Paths dropped from the OS. The drop event carries paths only and there is no file-system plugin,
 * so each path is asked about with `preview_batch` (see `api.probeFolder`): a folder opens the
 * upload-folder confirmation, anything the backend says is not a folder is uploaded as a file,
 * exactly as before.
 */
export async function handleOsDrop(paths: string[]) {
  const { bucket, prefix } = useApp.getState();
  if (!bucket) {
    toast.info("Select a bucket first", "Uploads go into the folder you are viewing.");
    return;
  }
  if (!paths.length) return;
  const seq = ++dropSeq;
  document.body.classList.add("busy-cursor");
  let results: { path: string; kind: "file" | "folder"; preview?: Awaited<ReturnType<typeof api.probeFolder>>; error?: AppError }[];
  try {
    results = await Promise.all(
      paths.map(async (path) => {
        try {
          const preview = await api.probeFolder({ kind: "upload", bucket, prefix: defaultUploadPrefix(prefix, path), localPath: path, onConflict: "skip" });
          return preview ? { path, kind: "folder" as const, preview } : { path, kind: "file" as const };
        } catch (e) {
          // Anything but the exact "<path> is not a folder" answer, including other InvalidInputs
          // (a bad prefix): treated as a folder that could not be planned, never uploaded as a
          // file. The dialog previews again and shows why.
          return { path, kind: "folder" as const, error: e as AppError };
        }
      }),
    );
  } finally {
    document.body.classList.remove("busy-cursor");
  }
  // The user may have moved on (another drop, another folder) while the paths were checked.
  const now = useApp.getState();
  if (seq !== dropSeq || now.bucket !== bucket || now.prefix !== prefix) {
    toast.info("Nothing was uploaded", "The open folder changed while the dropped items were being checked. Drop them again.");
    return;
  }
  const files = results.filter((r) => r.kind === "file").map((r) => r.path);
  const folders = results.filter((r) => r.kind === "folder");
  if (files.length) await uploadPaths(files);
  if (!folders.length) return;
  const first = folders[0];
  if (folders.length > 1) {
    toast.info(
      `${plural(folders.length, "folder")} dropped`,
      `One folder is uploaded at a time: confirm “${basename(first.path)}” now, then drop the others again.`,
    );
  }
  openModal({ kind: "uploadFolder", bucket, prefix, localPath: first.path, initialPreview: first.preview ?? undefined });
}

/** Toolbar / context menu: choose where to save, then confirm one batch per folder. */
export async function requestDownloadFolders(folders: FolderEntry[]) {
  const { bucket } = useApp.getState();
  if (!bucket || !folders.length) return;
  let dir: string | null;
  try {
    dir = await api.pickDirectory();
  } catch (e) {
    toast.error("Could not open the folder picker", e as AppError);
    return;
  }
  if (!dir) return;
  openModal({ kind: "downloadFolders", bucket, folders, dir });
}

// ---- effects ---------------------------------------------------------------------------------

export function openBatchDetails(id: string) {
  useBatches.getState().setExpanded(id, true);
  setTransfersOpen(true);
  requestAnimationFrame(() => document.getElementById(`batch-${id}`)?.scrollIntoView({ block: "nearest" }));
}

function reportFinished(b: Batch) {
  const view = { label: "View", run: () => openBatchDetails(b.id) };
  const Verb = b.kind === "upload" ? "Upload" : "Download";
  const past = b.kind === "upload" ? "uploaded" : "downloaded";
  if (b.status === "cancelled") {
    toast.info(`${Verb} cancelled`, `${b.label}\n${b.doneFiles.toLocaleString()} of ${b.totalFiles.toLocaleString()} files were ${past} before it stopped.`, view);
    return;
  }
  if (b.status === "failed" && b.error) {
    toast.error(`${Verb} failed`, `${b.label}\n${b.error}`, view);
    return;
  }
  const parts = [`${plural(b.doneFiles, "file")} ${past}`];
  if (b.skippedFiles) parts.push(`${b.skippedFiles.toLocaleString()} skipped (already existed)`);
  if (b.failedFiles) parts.push(`${b.failedFiles.toLocaleString()} failed`);
  if (b.failedFiles) toast.warning(`${Verb} finished with ${plural(b.failedFiles, "failure")}`, `${b.label}\n${parts.join(" · ")}`, view);
  else if (b.skippedFiles) toast.warning(`${Verb} finished, some skipped`, `${b.label}\n${parts.join(" · ")}`, view);
  else toast.success(`${Verb}ed ${plural(b.doneFiles, "file")}`, b.label);
}

/** Does this batch write into the folder on screen? (Downloads never change the listing.) */
function touchesView(b: Batch): boolean {
  if (b.kind !== "upload") return false;
  const { bucket, prefix } = useApp.getState();
  const req = batchRequest(b.id);
  const destBucket = req?.bucket ?? b.bucket;
  const destPrefix = req?.prefix ?? b.prefix;
  return !!bucket && destBucket === bucket && touchesPrefix(destPrefix, prefix);
}

/** Install once (Explorer): listing refresh while an upload batch writes into the open folder, toasts, notifications. */
export function installBatchEffects(): () => void {
  return onBatchUpdate((b, prev) => {
    const finished = !isBatchActive(b) && (!prev || isBatchActive(prev));
    if (finished) {
      reportFinished(b);
      if (b.status !== "cancelled") {
        const Verb = b.kind === "upload" ? "Upload" : "Download";
        notifyInBackground(`${Verb} ${b.status === "failed" ? "finished with problems" : "finished"}`, b.label);
      }
    }
    if (!touchesView(b)) return;
    if (finished) scheduleRefresh(true);
    else if (b.status === "running" && (!prev || prev.doneFiles !== b.doneFiles)) scheduleRefresh(false);
  });
}
