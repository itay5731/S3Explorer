// History: finished transfers, folder transfers and file operations (jobs), remembered across
// restarts in localStorage (see "History" in docs/CONTRACT.md). Recorded from the existing transfer,
// batch and job events, so the Now tab and notifications are untouched.

import { create } from "zustand";
import { HISTORY_MAX_ENTRIES, HISTORY_STORAGE_KEY, type Batch, type HistoryEntry, type HistoryJob, type HistoryJobKind, type Job, type Transfer } from "../lib/types";
import { isJobActive } from "../lib/ops";
import { useApp } from "./app";
import { isBatchActive, onBatchUpdate } from "./batches";
import { jobRequest, onJobUpdate } from "./jobs";
import { onTransferFinished } from "./transfers";
import { useVersionDownloads } from "./versions";

const TRANSFER_KINDS = new Set(["download", "upload", "folderDownload", "folderUpload"]);
const JOB_KINDS = new Set(["copy", "move", "rename", "delete", "tag", "restore"]);
const STATUSES = new Set(["completed", "failed", "cancelled"]);

const str = (v: unknown) => typeof v === "string";
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const num = (v: unknown) => typeof v === "number";

function validJob(j: unknown): j is HistoryJob {
  if (!j || typeof j !== "object") return false;
  const h = j as Record<string, unknown>;
  return (
    str(h.srcBucket) && str(h.srcPrefix) && strOrNull(h.destBucket) && strOrNull(h.destPrefix) && num(h.items) && str(h.first) &&
    strOrNull(h.firstTo) && num(h.objects) && num(h.done) && num(h.skipped) && num(h.failed) && strOrNull(h.firstError) && str(h.label)
  );
}

/** A stored entry is kept only when every field has the right type (the store may be from another version or edited). */
function valid(e: unknown): e is HistoryEntry {
  if (!e || typeof e !== "object") return false;
  const h = e as Record<string, unknown>;
  return (
    typeof h.id === "string" &&
    (TRANSFER_KINDS.has(h.kind as string) ? h.job == null : JOB_KINDS.has(h.kind as string) && validJob(h.job)) &&
    STATUSES.has(h.status as string) &&
    typeof h.bucket === "string" &&
    typeof h.key === "string" &&
    typeof h.localPath === "string" &&
    typeof h.bytes === "number" &&
    typeof h.files === "number" &&
    typeof h.connection === "string" &&
    typeof h.finishedAt === "string" &&
    (h.error === null || typeof h.error === "string") &&
    (h.versionId == null || typeof h.versionId === "string")
  );
}

function load(): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(valid).slice(0, HISTORY_MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function save(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* storage full or unavailable: the list still works for this session */
  }
}

/** Newest first. */
export const useHistory = create<{ entries: HistoryEntry[] }>(() => ({ entries: load() }));

function setEntries(entries: HistoryEntry[]) {
  useHistory.setState({ entries });
  save(entries);
}

function record(entry: HistoryEntry) {
  const rest = useHistory.getState().entries.filter((e) => e.id !== entry.id);
  setEntries([entry, ...rest].slice(0, HISTORY_MAX_ENTRIES));
}

export function removeHistory(ids: string[]) {
  const drop = new Set(ids);
  setEntries(useHistory.getState().entries.filter((e) => !drop.has(e.id)));
}

export function clearHistory() {
  setEntries([]);
}

// The last connection seen: transfers cancelled by a disconnect finish after the connection is gone.
let lastLabel = "";
const connectionLabel = () => useApp.getState().connection?.label ?? lastLabel;

function fromTransfer(t: Transfer): HistoryEntry | null {
  if (t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled") return null;
  return {
    id: t.id,
    kind: t.kind,
    status: t.status,
    bucket: t.bucket,
    key: t.key,
    localPath: t.localPath,
    bytes: t.status === "completed" ? t.totalBytes : t.transferredBytes,
    files: 1,
    connection: connectionLabel(),
    finishedAt: t.finishedAt ?? new Date().toISOString(),
    error: t.error,
    versionId: useVersionDownloads.getState().byTransfer[t.id] ?? null,
  };
}

function fromBatch(b: Batch): HistoryEntry | null {
  if (b.status !== "completed" && b.status !== "failed" && b.status !== "cancelled") return null;
  return {
    id: b.id,
    kind: b.kind === "upload" ? "folderUpload" : "folderDownload",
    status: b.status,
    bucket: b.bucket,
    key: b.prefix,
    localPath: b.localPath,
    bytes: b.doneBytes,
    files: b.doneFiles,
    connection: connectionLabel(),
    finishedAt: b.finishedAt ?? new Date().toISOString(),
    error: b.error,
  };
}

/** The folder that holds a key or prefix, verbatim: "a/b/c.txt" -> "a/b/", "a/b/" -> "a/", "a//" -> "a/". */
function folderOf(keyOrPrefix: string): string {
  const body = keyOrPrefix.endsWith("/") ? keyOrPrefix.slice(0, -1) : keyOrPrefix;
  return body.slice(0, body.lastIndexOf("/") + 1);
}

function fromJob(j: Job): HistoryEntry | null {
  if (j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled") return null;
  // The request names the items; it is known for every job started in this session.
  const req = jobRequest(j.id);
  const first = req?.items[0];
  const destBucket = j.kind === "copy" || j.kind === "move" ? (j.destBucket ?? j.srcBucket) : null;
  const firstTo = first?.to ?? null;
  const rename =
    j.kind === "move" && req?.items.length === 1 && destBucket === j.srcBucket && !!first && firstTo !== null && folderOf(firstTo) === folderOf(first.from);
  const kind: HistoryJobKind = rename ? "rename" : j.kind;
  const srcPrefix = first ? folderOf(first.from) : "";
  const job: HistoryJob = {
    srcBucket: j.srcBucket,
    srcPrefix,
    destBucket,
    destPrefix: destBucket === null ? null : firstTo !== null ? folderOf(firstTo) : null,
    items: req?.items.length ?? j.totalItems,
    first: first?.from ?? "",
    firstTo,
    objects: j.totalItems,
    done: j.doneItems,
    skipped: j.skippedItems,
    failed: j.failedItems,
    firstError: j.errors[0] ? `${j.errors[0].key}: ${j.errors[0].message}` : null,
    label: j.label,
  };
  return {
    id: j.id,
    kind,
    status: j.status,
    bucket: j.srcBucket,
    key: srcPrefix,
    localPath: "",
    // Deletes, tag edits and restore requests move no data: their byte counters mean nothing.
    bytes: j.kind === "copy" || j.kind === "move" ? j.doneBytes : 0,
    files: j.doneItems,
    connection: connectionLabel(),
    finishedAt: j.finishedAt ?? new Date().toISOString(),
    error: j.error ?? job.firstError,
    job,
  };
}

/** Record transfers, folder transfers and jobs as they reach a final status. */
export function installHistory(): () => void {
  lastLabel = useApp.getState().connection?.label ?? lastLabel;
  const offApp = useApp.subscribe((s) => {
    if (s.connection) lastLabel = s.connection.label;
  });
  const offTransfers = onTransferFinished((t) => {
    const e = fromTransfer(t);
    if (e) record(e);
  });
  const offBatches = onBatchUpdate((b, prev) => {
    // Once, on the update that finishes it (a finished batch seen for the first time counts too).
    if (isBatchActive(b) || (prev && !isBatchActive(prev))) return;
    const e = fromBatch(b);
    if (e) record(e);
  });
  const offJobs = onJobUpdate((j, prev) => {
    if (isJobActive(j) || (prev && !isJobActive(prev))) return;
    const e = fromJob(j);
    if (e) record(e);
  });
  return () => {
    offApp();
    offJobs();
    offTransfers();
    offBatches();
  };
}
