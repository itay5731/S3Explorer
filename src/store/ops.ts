// User-level object operations: delete, rename, copy/cut/paste. Everything that changes data
// goes through a confirmation modal that previews the exact request (see components/JobModals).

import * as api from "../lib/api";
import { JOB_MAX_ITEMS, type AppError, type Job, type JobItem, type JobRequest } from "../lib/types";
import { copyName, isJobActive, KIND_VERB, plural, touchesPrefix } from "../lib/ops";
import { openModal, refreshInPlace, setTransfersOpen, useApp } from "./app";
import { clearClipboard, setClipboard, useClipboard, type ClipItem } from "./clipboard";
import { jobRequest, onJobUpdate, rememberJobRequest, useJobs } from "./jobs";
import { toast } from "./toasts";
import { getSelected } from "./view";

/** The current selection as clip items (exact keys/prefixes), folders first. */
function selectedItems(): ClipItem[] {
  const { folders, objects } = getSelected();
  return [
    ...folders.map((f) => ({ key: f.prefix, isPrefix: true, name: f.name })),
    ...objects.map((o) => ({ key: o.key, isPrefix: false, name: o.name })),
  ];
}

function tooMany(count: number, what: string): boolean {
  if (count <= JOB_MAX_ITEMS) return false;
  toast.error(
    `Too many items to ${what}`,
    `${count.toLocaleString()} items are selected; one operation can include at most ${JOB_MAX_ITEMS.toLocaleString()}. ` +
      "Select fewer items, or select the folder that contains them (a folder counts as one item).",
  );
  return true;
}

// ---- delete ---------------------------------------------------------------------------

export function requestDelete() {
  const { bucket } = useApp.getState();
  const items = selectedItems();
  if (!bucket || !items.length) return;
  if (tooMany(items.length, "delete")) return;
  const request: JobRequest = {
    kind: "delete",
    srcBucket: bucket,
    destBucket: null,
    // Verbatim: never normalize a server-provided key or prefix.
    items: items.map((i) => ({ from: i.key, to: null, isPrefix: i.isPrefix })),
    onConflict: "skip",
  };
  openModal({ kind: "delete", request });
}

// ---- rename -------------------------------------------------------------------------------

export function requestRename() {
  const { bucket } = useApp.getState();
  const items = selectedItems();
  if (!bucket || items.length !== 1) return;
  const it = items[0];
  // The parent is the exact key minus the exact name (and the folder's trailing "/").
  const tail = it.name.length + (it.isPrefix ? 1 : 0);
  const parent = it.key.slice(0, it.key.length - tail);
  if (it.key !== parent + it.name + (it.isPrefix ? "/" : "")) {
    toast.error("Can’t rename this item", "Its name doesn’t match its key.");
    return;
  }
  openModal({ kind: "rename", target: { bucket, key: it.key, isPrefix: it.isPrefix, name: it.name, parent } });
}

// ---- clipboard ------------------------------------------------------------------------------

export function copySelection(mode: "copy" | "cut") {
  const { bucket, prefix } = useApp.getState();
  const items = selectedItems();
  if (!bucket || !items.length) return;
  if (tooMany(items.length, mode === "copy" ? "copy" : "move")) return;
  setClipboard(mode, bucket, prefix, items);
  toast.info(
    `${plural(items.length, "item")} ${mode === "copy" ? "copied" : "cut"}`,
    `Open the destination folder and paste (Ctrl+V).`,
  );
}

/** Build the paste request for the current folder, or explain why it can't be done. */
export function requestPaste() {
  const { bucket, prefix, listing } = useApp.getState();
  const clip = useClipboard.getState().clip;
  if (!bucket || !clip || !clip.items.length) return;
  if (tooMany(clip.items.length, "paste")) return;

  const sameBucket = clip.bucket === bucket;
  const sameFolder = sameBucket && clip.prefix === prefix;
  if (sameFolder && clip.mode === "cut") {
    toast.info("Nothing to move", "The items are already in this folder.");
    return;
  }
  // A folder can't be pasted into itself or anything inside it.
  if (sameBucket) {
    const into = clip.items.find((i) => i.isPrefix && prefix.startsWith(i.key));
    if (into) {
      toast.error(
        `Can’t paste a folder into itself`,
        `“${into.key}” would be ${clip.mode === "cut" ? "moved" : "copied"} into ${prefix === into.key ? "itself" : `its own subfolder “${prefix}”`}.`,
      );
      return;
    }
  }

  let renamed = false;
  const items: JobItem[] = [];
  if (sameFolder) {
    // Copy into the same folder: suggest "name (copy).ext" so the request is valid.
    const takenObjects = new Set(listing.objects.map((o) => o.name));
    const takenFolders = new Set(listing.folders.map((f) => f.name));
    for (const it of clip.items) {
      const taken = it.isPrefix ? takenFolders : takenObjects;
      const name = copyName(it.name, it.isPrefix, taken);
      taken.add(name);
      renamed = true;
      items.push({ from: it.key, to: prefix + name + (it.isPrefix ? "/" : ""), isPrefix: it.isPrefix });
    }
  } else {
    for (const it of clip.items) {
      items.push({ from: it.key, to: prefix + it.name + (it.isPrefix ? "/" : ""), isPrefix: it.isPrefix });
    }
  }
  const request: JobRequest = {
    kind: clip.mode === "cut" ? "move" : "copy",
    srcBucket: clip.bucket,
    destBucket: bucket,
    items,
    onConflict: "skip",
  };
  openModal({ kind: "paste", request, mode: clip.mode, srcPrefix: clip.prefix, destPrefix: prefix, renamed });
}

// ---- starting jobs -------------------------------------------------------------------------

/** Start a confirmed job. Returns the job id, or null after showing the error. */
export async function startConfirmedJob(request: JobRequest, opts: { clearCut?: boolean } = {}): Promise<string | null> {
  try {
    const id = await api.startJob(request);
    rememberJobRequest(id, request);
    if (opts.clearCut) clearClipboard();
    setTransfersOpen(true);
    return id;
  } catch (e) {
    toast.error(`Couldn’t start the ${KIND_VERB[request.kind].noun}`, e as AppError);
    return null;
  }
}

// ---- effects: keep the listing in sync and report results -----------------------------------

function touchesView(job: Job): boolean {
  const { bucket, prefix } = useApp.getState();
  if (!bucket) return false;
  const req = jobRequest(job.id);
  if (!req) return job.srcBucket === bucket || job.destBucket === bucket;
  for (const it of req.items) {
    if (req.srcBucket === bucket && touchesPrefix(it.from, prefix)) return true;
    if (req.destBucket === bucket && it.to !== null && touchesPrefix(it.to, prefix)) return true;
  }
  return false;
}

export function openJobDetails(id: string) {
  useJobs.getState().setExpanded(id, true);
  setTransfersOpen(true);
  requestAnimationFrame(() => document.getElementById(`job-${id}`)?.scrollIntoView({ block: "nearest" }));
}

function reportFinished(j: Job) {
  const verb = KIND_VERB[j.kind];
  const view = { label: "View", run: () => openJobDetails(j.id) };
  if (j.status === "cancelled") {
    const processed = j.doneItems + j.skippedItems + j.failedItems;
    toast.info(
      `${verb.present} cancelled`,
      `${j.label}\n${processed.toLocaleString()} of ${j.totalItems.toLocaleString()} objects were processed before it stopped` +
        (j.kind === "move" ? ". Objects moved so far are in the destination; the rest are still in the source." : "."),
      view,
    );
    return;
  }
  if (j.status === "failed" && j.error) {
    toast.error(`${verb.present} failed`, `${j.label}\n${j.error}`, view);
    return;
  }
  const parts = [`${plural(j.doneItems, "object")} ${verb.past.toLowerCase()}`];
  if (j.skippedItems) parts.push(`${j.skippedItems.toLocaleString()} skipped (already existed)`);
  if (j.failedItems) parts.push(`${j.failedItems.toLocaleString()} failed`);
  if (j.failedItems || j.skippedItems) {
    const title = j.failedItems ? `${verb.present} finished with ${plural(j.failedItems, "failure")}` : `${verb.present} finished, some skipped`;
    toast.warning(title, `${j.label}\n${parts.join(" · ")}`, view);
  } else {
    toast.success(`${verb.past} ${plural(j.doneItems, "object")}`, j.label);
  }
}

const REFRESH_EVERY_MS = 2000;
let lastRefresh = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(now: boolean) {
  if (now) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    lastRefresh = Date.now();
    void refreshInPlace();
    return;
  }
  if (refreshTimer) return;
  const wait = Math.max(0, lastRefresh + REFRESH_EVERY_MS - Date.now());
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    lastRefresh = Date.now();
    void refreshInPlace();
  }, wait);
}

/** Install once (Explorer): listing refresh while jobs touch the visible folder, and completion toasts. */
export function installJobEffects(): () => void {
  const off = onJobUpdate((j, prev) => {
    const finished = !isJobActive(j) && (!prev || isJobActive(prev));
    if (finished) reportFinished(j);
    if (!touchesView(j)) return;
    if (finished) scheduleRefresh(true);
    else if (j.status === "running" && j.phase === "working" && (!prev || prev.doneItems !== j.doneItems)) scheduleRefresh(false);
  });
  return () => {
    off();
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
  };
}
