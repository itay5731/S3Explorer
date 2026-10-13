// History: finished transfers, folder transfers and file operations (jobs), remembered across
// restarts in localStorage (see "History" in docs/CONTRACT.md). Recorded from the existing transfer,
// batch and job events, so the Now tab and notifications are untouched.

import { create } from "zustand";
import { HISTORY_MAX_ENTRIES, HISTORY_STORAGE_KEY, type Batch, type HistoryEntry, type HistoryJob, type HistoryJobKind, type Job, type Transfer } from "../lib/types";
import { isJobActive } from "../lib/ops";
import { connectionKey, onForgetConnection, useApp } from "./app";
import { isBatchActive, onBatchUpdate, useBatches } from "./batches";
import { jobRequest, onJobUpdate, useJobs } from "./jobs";
import { onTransferFinished, useTransfers } from "./transfers";
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
/** `connectionKey` is not checked: entries from before it existed read as "" (another connection). */
function valid(e: unknown): e is Omit<HistoryEntry, "connectionKey"> {
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

/** An entry as the recorders build it; `record` adds the connection key. */
type NewEntry = Omit<HistoryEntry, "connectionKey">;

/** Separate caps, so one big multi-download cannot push every file operation out (and the reverse). */
export const HISTORY_MAX_TRANSFERS = 400;
export const HISTORY_MAX_JOBS = HISTORY_MAX_ENTRIES - HISTORY_MAX_TRANSFERS;

/** Newest first; at most HISTORY_MAX_TRANSFERS transfers and HISTORY_MAX_JOBS jobs. */
function capped(entries: HistoryEntry[]): HistoryEntry[] {
  let transfers = 0;
  let jobs = 0;
  return entries.filter((e) => (e.job ? ++jobs <= HISTORY_MAX_JOBS : ++transfers <= HISTORY_MAX_TRANSFERS));
}

function load(): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return capped(
      parsed.filter(valid).map((e) => {
        const k = (e as Partial<HistoryEntry>).connectionKey;
        return { ...e, connectionKey: typeof k === "string" ? k : "" };
      }),
    );
  } catch {
    return [];
  }
}

/** Writes are coalesced: a burst of finished transfers costs one write, half a second after the last. */
const SAVE_DELAY_MS = 500;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function writeNow() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(useHistory.getState().entries));
  } catch {
    /* storage full or unavailable: the list still works for this session */
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, SAVE_DELAY_MS);
}

// A pending write is not lost when the window closes.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (saveTimer) writeNow();
  });
}

/** Newest first. */
export const useHistory = create<{ entries: HistoryEntry[] }>(() => ({ entries: load() }));

function setEntries(entries: HistoryEntry[]) {
  useHistory.setState({ entries });
  scheduleSave();
}

function record(entry: NewEntry) {
  const rest = useHistory.getState().entries.filter((e) => e.id !== entry.id);
  // The connection it ran on (noted when it first appeared), not the one in use when it finished.
  const ran = ranOn.get(entry.id);
  setEntries(capped([{ ...entry, connection: ran?.label ?? entry.connection, connectionKey: ran?.key ?? lastKey }, ...rest]));
}

/**
 * The connection each transfer, folder transfer and job ran on, by id: noted the first time the id
 * appears in its store (its first event arrives while that connection is in use), dropped when it
 * leaves the store. A transfer that finishes after a disconnect or a switch keeps its own connection.
 */
const ranOn = new Map<string, { key: string; label: string }>();

/** Note the new ids of a store, forget the removed ones (only when the id list changed). */
function trackIds(ids: string[], prev: string[] | null, live: () => Set<string>) {
  if (ids === prev) return;
  for (const id of ids) if (!ranOn.has(id)) ranOn.set(id, { key: lastKey, label: lastLabel });
  if (prev && prev.length > ids.length) {
    const all = live();
    for (const id of prev) if (!all.has(id)) ranOn.delete(id);
  }
}
const liveIds = () => new Set([...useTransfers.getState().ids, ...useBatches.getState().ids, ...useJobs.getState().ids]);

/** For tests: the connection key noted for an id. */
export const ranOnKey = (id: string) => ranOn.get(id)?.key ?? null;

/** A saved connection was deleted: its history entries go too. */
export function forgetConnectionHistory(key: string) {
  const entries = useHistory.getState().entries;
  const kept = entries.filter((e) => e.connectionKey !== key);
  if (kept.length !== entries.length) setEntries(kept);
}

export function removeHistory(ids: string[]) {
  const drop = new Set(ids);
  setEntries(useHistory.getState().entries.filter((e) => !drop.has(e.id)));
}

export function clearHistory() {
  setEntries([]);
}

/** Flush a pending write at once (tests, and before the store is read back). */
export function flushHistory() {
  if (saveTimer) writeNow();
}

// The last connection seen: transfers cancelled by a disconnect finish after the connection is gone.
let lastLabel = "";
let lastKey = "";
const connectionLabel = () => useApp.getState().connection?.label ?? lastLabel;

function fromTransfer(t: Transfer): NewEntry | null {
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

function fromBatch(b: Batch): NewEntry | null {
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

function fromJob(j: Job): NewEntry | null {
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
  lastKey = connectionKey() ?? lastKey;
  const offApp = useApp.subscribe((s) => {
    if (s.connection) {
      lastLabel = s.connection.label;
      lastKey = connectionKey() ?? lastKey;
    }
  });
  const offForget = onForgetConnection(forgetConnectionHistory);
  trackIds(useTransfers.getState().ids, null, liveIds);
  trackIds(useBatches.getState().ids, null, liveIds);
  trackIds(useJobs.getState().ids, null, liveIds);
  const offIds = [
    useTransfers.subscribe((s, p) => trackIds(s.ids, p.ids, liveIds)),
    useBatches.subscribe((s, p) => trackIds(s.ids, p.ids, liveIds)),
    useJobs.subscribe((s, p) => trackIds(s.ids, p.ids, liveIds)),
  ];
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
    offForget();
    offIds.forEach((off) => off());
    offJobs();
    offTransfers();
    offBatches();
  };
}
