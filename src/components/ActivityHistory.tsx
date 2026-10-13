// The Activity panel's History tab: finished transfers and file operations kept across restarts (see
// "History" in docs/CONTRACT.md). Rows are virtualized; actions re-use the existing commands and
// dialogs. Jobs are never offered again: a stale repeat of a delete or move is unsafe.

import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { create } from "zustand";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CheckCircle2,
  Copy,
  ExternalLink,
  FolderDown,
  FolderInput,
  FolderSearch,
  FolderUp,
  History,
  LocateFixed,
  PencilLine,
  RotateCw,
  Search,
  Tags,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import * as api from "../lib/api";
import type { AppError, HistoryEntry, HistoryJob, HistoryKind } from "../lib/types";
import { basename, displayName, formatBytes, formatExact, formatRelative, parentPrefix, refusedToOpen, sanitizeFileName } from "../lib/format";
import { plural } from "../lib/ops";
import { connectionKey, openModal, setTransfersOpen, useApp } from "../store/app";
import { copyText } from "../store/actions";
import { clearHistory, removeHistory, useHistory } from "../store/history";
import { scheduleTransferResync, useTransfers } from "../store/transfers";
import { useBatches } from "../store/batches";
import { rememberVersionDownload, shortVersionId } from "../store/versions";
import { toast, toastFailure } from "../store/toasts";
import { PopupMenu, type PopupMenuItem } from "./PopupMenu";
import { ModalShell } from "./Modals";
import { copyPathItem, goFolder, goObject, useKnownBucket } from "./activityItems";

// ---- panel state -------------------------------------------------------------------------------

export type HistoryFilter = "all" | "transfers" | "jobs";

/**
 * Which tab the Activity panel shows, the History filter chip and search text, and whether History
 * shows every connection's entries (`allConnections`) or only the current connection's (the default).
 */
export const useActivityTab = create<{ tab: "now" | "history"; filter: HistoryFilter; query: string; allConnections: boolean }>(() => ({
  tab: "now",
  filter: "all",
  query: "",
  allConnections: false,
}));
const showNow = () => useActivityTab.setState({ tab: "now" });

/** The entries the History tab lists before the chips and search: this connection's, or all. */
function useScopedEntries(): HistoryEntry[] {
  const entries = useHistory((s) => s.entries);
  const all = useActivityTab((s) => s.allConnections);
  // Re-read when the connection changes (the key itself lives outside the store).
  const connection = useApp((s) => s.connection);
  return useMemo(() => {
    if (all) return entries;
    const key = connection ? connectionKey() : null;
    return key ? entries.filter((e) => e.connectionKey === key) : entries;
  }, [entries, all, connection]);
}

export const useHistoryCount = () => useHistory((s) => s.entries.length);

/**
 * Whether an entry's "Go to …", "Download again" and "Upload again" apply here: only on the connection
 * it ran on (same `connectionKey()`), and only while its bucket is one of this connection's buckets.
 * The reason is the hint and tooltip of the disabled item.
 */
type Availability = { ok: true } | { ok: false; hint: string; title: string };
function useAvailability(): (e: HistoryEntry, bucket: string) => Availability {
  const known = useKnownBucket();
  const connection = useApp((s) => s.connection);
  return useMemo(() => {
    const key = connection ? connectionKey() : null;
    return (e: HistoryEntry, bucket: string): Availability => {
      if (!key || e.connectionKey !== key) return { ok: false, hint: "Other connection", title: "From another connection" };
      if (!known(bucket)) return { ok: false, hint: "Not in this connection", title: `s3://${bucket} is not one of this connection's buckets` };
      return { ok: true };
    };
  }, [known, connection]);
}

/** A menu item that is disabled, with the reason, when the entry does not apply to this connection. */
function gated(item: PopupMenuItem, avail: Availability): PopupMenuItem {
  return avail.ok ? item : { ...item, action: () => {}, disabled: true, hint: avail.hint, title: avail.title };
}

const ROW_H = 44;

const isFolder = (k: HistoryKind) => k === "folderDownload" || k === "folderUpload";
/** A file operation (job) entry: it carries `job`. */
const jobOf = (e: HistoryEntry): HistoryJob | null => e.job ?? null;
const isDownload = (k: HistoryKind) => k === "download" || k === "folderDownload";

const KIND_ICON: Record<HistoryKind, typeof FolderUp> = {
  download: ArrowDownToLine,
  upload: ArrowUpFromLine,
  folderDownload: FolderDown,
  folderUpload: FolderUp,
  copy: Copy,
  move: FolderInput,
  rename: PencilLine,
  delete: Trash2,
  tag: Tags,
  restore: ArchiveRestore,
};
const KIND_LABEL: Record<HistoryKind, string> = {
  download: "Download",
  upload: "Upload",
  folderDownload: "Folder download",
  folderUpload: "Folder upload",
  copy: "Copy",
  move: "Move",
  rename: "Rename",
  delete: "Delete",
  tag: "Tag",
  restore: "Restore",
};
const STATUS: Record<HistoryEntry["status"], { label: string; icon: typeof Ban }> = {
  completed: { label: "Done", icon: CheckCircle2 },
  failed: { label: "Failed", icon: XCircle },
  cancelled: { label: "Cancelled", icon: Ban },
};

/** Last segment of a key or prefix, kept verbatim ("a/b/" -> "b", "a//" -> ""). */
function lastSegment(keyOrPrefix: string): string {
  const body = keyOrPrefix.endsWith("/") ? keyOrPrefix.slice(0, -1) : keyOrPrefix;
  return body.slice(body.lastIndexOf("/") + 1);
}

function entryName(e: HistoryEntry): string {
  if (isFolder(e.kind)) return e.key === "" ? e.bucket : lastSegment(e.key) || "(empty name)";
  const name = lastSegment(e.key) || e.key;
  return e.versionId ? `${name} (version ${shortVersionId(e.versionId)})` : name;
}

/** The S3 folder the entry lives in, for the muted line under the name. */
function entryFolder(e: HistoryEntry): string {
  return `s3://${e.bucket}/${isFolder(e.kind) ? parentPrefix(e.key) : e.key.slice(0, e.key.lastIndexOf("/") + 1)}`;
}

function entryWhere(e: HistoryEntry): string {
  const s3 = `s3://${e.bucket}/${e.key}${e.versionId ? ` (version ${e.versionId})` : ""}`;
  const route = isDownload(e.kind) ? `${s3} → ${e.localPath}` : `${e.localPath} → ${s3}`;
  return e.connection ? `${route}\nConnection: ${e.connection}` : route;
}

/** The folder that holds a local path ("C:\a\b" -> "C:\a", "C:\a" -> "C:\", "/a" -> "/"). */
function localParent(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (i < 0) return path;
  const parent = trimmed.slice(0, i);
  if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
  return parent || "/";
}

// ---- file operations (jobs) ----------------------------------------------------------------------

/** "a.txt", "photos/" or "12 items". */
function jobWhat(j: HistoryJob): string {
  if (j.items !== 1) return plural(j.items, "item");
  return displayName(lastSegment(j.first)) + (j.first.endsWith("/") ? "/" : "");
}

/** A folder as the sentence names it: "reports/2026/", "other-bucket/reports/", or the bucket for its root. */
function jobPlace(bucket: string, prefix: string, srcBucket: string): string {
  if (!prefix) return bucket;
  return bucket === srcBucket ? prefix : `${bucket}/${prefix}`;
}

const DONE_VERB: Record<string, string> = { copy: "Copied", move: "Moved", rename: "Renamed", delete: "Deleted", tag: "Tagged", restore: "Requested restore of" };
const TODO_VERB: Record<string, string> = { copy: "Copy", move: "Move", rename: "Rename", delete: "Delete", tag: "Tag", restore: "Restore" };

/** "Moved 12 items to reports/2026/", "Deleted 3 items from images/", "Renamed a.txt to b.txt". */
function jobSentence(e: HistoryEntry, j: HistoryJob): string {
  // A job whose request was not known (started before a reload) has only the backend's label.
  if (!j.first) return j.label || KIND_LABEL[e.kind];
  // A job that did not finish is named for what it set out to do.
  const verb = (e.status === "completed" ? DONE_VERB : TODO_VERB)[e.kind];
  const what = jobWhat(j);
  const src = jobPlace(j.srcBucket, j.srcPrefix, j.srcBucket);
  switch (e.kind) {
    case "rename":
      return `${verb} ${what} to ${displayName(lastSegment(j.firstTo ?? ""))}`;
    case "copy":
    case "move":
      return `${verb} ${what} to ${jobPlace(j.destBucket ?? j.srcBucket, j.destPrefix ?? "", j.srcBucket)}`;
    case "delete":
      return `${verb} ${what} from ${src}`;
    default:
      return `${verb} ${what} in ${src}`;
  }
}

const jobSource = (j: HistoryJob) => `s3://${j.srcBucket}/${j.items === 1 ? j.first : j.srcPrefix}`;
const jobDest = (j: HistoryJob) =>
  j.destBucket === null ? null : `s3://${j.destBucket}/${j.items === 1 && j.firstTo !== null ? j.firstTo : (j.destPrefix ?? "")}`;

/** "12 of 14 objects done · 1 skipped · 1 failed" (zero counts left out). */
function jobCounts(j: HistoryJob): string {
  const parts = [`${j.done.toLocaleString()} of ${plural(j.objects, "object")} done`];
  if (j.skipped) parts.push(`${j.skipped.toLocaleString()} skipped`);
  if (j.failed) parts.push(`${j.failed.toLocaleString()} failed`);
  return parts.join(" · ");
}

function jobTooltip(e: HistoryEntry, j: HistoryJob): string {
  const lines = [jobSentence(e, j), `From: ${jobSource(j)}`];
  const dest = jobDest(j);
  if (dest) lines.push(`To: ${dest}`);
  lines.push(jobCounts(j));
  if (e.error) lines.push(`First failure: ${e.error}`);
  if (e.connection) lines.push(`Connection: ${e.connection}`);
  return lines.join("\n");
}

/** The bucket "Go to" opens: the destination of a copy / move / rename, else the source. */
const jobTargetBucket = (j: HistoryJob) => j.destBucket ?? j.srcBucket;

/** Go to the destination (copy, move, rename) or the source folder (delete); a single object is selected. */
function jobGo(e: HistoryEntry, j: HistoryJob) {
  if (j.destBucket !== null) {
    if (j.items === 1 && j.firstTo !== null && !j.firstTo.endsWith("/")) goObject(j.destBucket, j.firstTo);
    else goFolder(j.destBucket, j.items === 1 && j.firstTo !== null ? j.firstTo : (j.destPrefix ?? ""));
    return;
  }
  // A deleted object is gone: open its folder. Tagged or restored objects are still there.
  if (e.kind !== "delete" && j.items === 1 && j.first && !j.first.endsWith("/")) goObject(j.srcBucket, j.first);
  else goFolder(j.srcBucket, j.srcPrefix);
}

function jobGoLabel(e: HistoryEntry, j: HistoryJob): string {
  if (j.destBucket !== null) return "Go to destination";
  return e.kind !== "delete" && j.items === 1 && j.first && !j.first.endsWith("/") ? "Go to object" : "Go to folder";
}

function jobMenuGroups(e: HistoryEntry, j: HistoryJob, avail: Availability, el: HTMLElement | null): PopupMenuItem[][] {
  const go = gated({ label: jobGoLabel(e, j), icon: <LocateFixed size={14} />, action: () => jobGo(e, j) }, avail);
  const copies: PopupMenuItem[] = [{ label: "Copy source path", icon: <Copy size={14} />, action: () => void copyText(jobSource(j), "Source path") }];
  const dest = jobDest(j);
  if (dest) copies.push({ label: "Copy destination path", icon: <Copy size={14} />, action: () => void copyText(dest, "Destination path") });
  if (e.error) copies.push({ label: "Copy first failure", icon: <Copy size={14} />, action: () => void copyText(e.error ?? "", "Failure") });
  const remove: PopupMenuItem = { label: "Remove from history", icon: <X size={14} />, action: () => removeEntry(e, el) };
  return [[go], copies, [remove]];
}

// ---- actions -----------------------------------------------------------------------------------

/**
 * Downloads that can be opened: a finished file, or a folder transfer that wrote something, while the
 * transfer or folder transfer is still in the Activity list (`open_local` only accepts downloads the
 * backend still knows; Show in folder works for any path).
 */
const canOpen = (e: HistoryEntry, live: boolean) =>
  live && ((e.kind === "download" && e.status === "completed") || (e.kind === "folderDownload" && e.files > 0)) && !refusedToOpen(e.localPath);

/** Is the entry's transfer or folder transfer still in the backend's list (this session, not removed)? */
function useLive(e: HistoryEntry): boolean {
  const transfer = useTransfers((s) => e.kind === "download" && !!s.byId[e.id]);
  const batch = useBatches((s) => e.kind === "folderDownload" && !!s.byId[e.id]);
  return transfer || batch;
}
const isLive = (e: HistoryEntry) =>
  (e.kind === "download" && !!useTransfers.getState().byId[e.id]) || (e.kind === "folderDownload" && !!useBatches.getState().byId[e.id]);
/** Show in folder: anything that finished on this computer (the local file or folder of an upload too). */
const canShow = (e: HistoryEntry) => e.status === "completed" || (e.kind === "folderDownload" && e.files > 0);

async function openEntry(e: HistoryEntry) {
  const what = e.kind === "folderDownload" ? "folder" : "file";
  try {
    await api.openLocal(e.localPath);
  } catch {
    // The backend opens only finished downloads it knows (this session) whose file is still there.
    toast.info(
      `Can’t open this ${what} from here`,
      `It may have been moved or deleted, or it was downloaded before S3 Explorer was last started. Show in folder still finds it if it is there.\n${e.localPath}`,
    );
  }
}

async function showEntry(e: HistoryEntry) {
  try {
    await api.revealInFolder(e.localPath);
  } catch {
    toast.info("Can’t show it in its folder", `It may have been moved or deleted.\n${e.localPath}`);
  }
}

function goToEntry(e: HistoryEntry) {
  if (isFolder(e.kind)) goFolder(e.bucket, e.key);
  else goObject(e.bucket, e.key);
}

/** Run the transfer again through the usual commands and confirmations. */
async function runAgain(e: HistoryEntry) {
  const name = entryName(e);
  try {
    switch (e.kind) {
      case "download": {
        const dest = await api.pickSavePath(sanitizeFileName(lastSegment(e.key)));
        if (!dest) return;
        if (e.versionId) rememberVersionDownload(await api.downloadObjectVersion(e.bucket, e.key, e.versionId, dest), e.versionId);
        else await api.startDownload(e.bucket, e.key, dest);
        break;
      }
      case "upload":
        await api.startUpload(e.bucket, e.key, e.localPath);
        toast.info(`Uploading ${basename(e.localPath)}`, `to s3://${e.bucket}/${e.key}`);
        break;
      case "folderDownload":
        // The confirmation shows the preview and the conflict choice, as from the file list.
        openModal({ kind: "downloadFolders", bucket: e.bucket, folders: [{ prefix: e.key, name: lastSegment(e.key) || e.bucket }], dir: localParent(e.localPath) });
        return;
      case "folderUpload":
        openModal({ kind: "uploadFolder", bucket: e.bucket, prefix: parentPrefix(e.key), localPath: e.localPath, initialDest: e.key });
        return;
    }
    showNow();
    setTransfersOpen(true);
    scheduleTransferResync();
  } catch (err) {
    const download = isDownload(e.kind);
    toastFailure(`Could not ${download ? "download" : "upload"} ${name}`, err as AppError, download ? "download files" : "upload files");
  }
}

/** Remove a row and keep the keyboard focus in the list (next row, else previous, else the tab). */
function removeEntry(e: HistoryEntry, el: HTMLElement | null) {
  const rows = [...document.querySelectorAll<HTMLElement>(".history-body .xrow[tabindex]")];
  const i = el ? rows.indexOf(el) : -1;
  const next = i >= 0 ? (rows[i + 1] ?? rows[i - 1] ?? null) : null;
  const nextId = next?.dataset.id;
  removeHistory([e.id]);
  if (!el || document.activeElement !== el) return;
  requestAnimationFrame(() => {
    const target = nextId ? document.querySelector<HTMLElement>(`.history-body .xrow[data-id="${CSS.escape(nextId)}"]`) : null;
    (target ?? document.querySelector<HTMLElement>(".xtabs button.active"))?.focus();
  });
}

function againLabel(e: HistoryEntry) {
  return isDownload(e.kind) ? "Download again" : "Upload again";
}

function menuGroups(e: HistoryEntry, avail: Availability, el: HTMLElement | null): PopupMenuItem[][] {
  const j = jobOf(e);
  if (j) return jobMenuGroups(e, j, avail, el);
  const open: PopupMenuItem[] = [];
  if (canOpen(e, isLive(e))) {
    open.push({ label: e.kind === "folderDownload" ? "Open folder" : "Open file", icon: <ExternalLink size={14} />, action: () => void openEntry(e) });
  }
  if (canShow(e)) open.push({ label: "Show in folder", icon: <FolderSearch size={14} />, action: () => void showEntry(e) });
  const go = gated({ label: isFolder(e.kind) ? "Go to folder" : "Go to object", icon: <LocateFixed size={14} />, action: () => goToEntry(e) }, avail);
  const again = gated({ label: againLabel(e), icon: <RotateCw size={14} />, action: () => void runAgain(e) }, avail);
  const copyKey: PopupMenuItem = isFolder(e.kind)
    ? { label: "Copy prefix", icon: <Copy size={14} />, action: () => void copyText(e.key, "Prefix") }
    : { label: "Copy key", icon: <Copy size={14} />, action: () => void copyText(e.key, "Key") };
  const remove: PopupMenuItem = { label: "Remove from history", icon: <X size={14} />, action: () => removeEntry(e, el) };
  return [open, [go, again], [copyKey, copyPathItem(e.localPath)], [remove]];
}

// ---- right-click menu ----------------------------------------------------------------------------

type MenuTarget = { id: string; x: number; y: number; el: HTMLElement | null };
const useHistoryMenu = create<{ menu: MenuTarget | null }>(() => ({ menu: null }));

function menuProps(id: string) {
  return {
    tabIndex: 0,
    "data-id": id,
    onContextMenu: (ev: ReactMouseEvent<HTMLElement>) => {
      ev.preventDefault();
      useHistoryMenu.setState({ menu: { id, x: ev.clientX, y: ev.clientY, el: ev.currentTarget } });
    },
    onKeyDown: (ev: ReactKeyboardEvent<HTMLElement>) => {
      if (ev.key !== "ContextMenu" && !(ev.key === "F10" && ev.shiftKey)) return;
      ev.preventDefault();
      const el = ev.currentTarget;
      const r = el.getBoundingClientRect();
      useHistoryMenu.setState({ menu: { id, x: r.left + 40, y: r.bottom - 6, el } });
    },
  };
}

function HistoryMenu() {
  const menu = useHistoryMenu((s) => s.menu);
  const entry = useHistory((s) => (menu ? s.entries.find((e) => e.id === menu.id) : undefined));
  const availability = useAvailability();
  const groups = useMemo(() => (menu && entry ? menuGroups(entry, availability(entry, targetBucket(entry)), menu.el) : null), [menu, entry, availability]);
  const close = () => {
    const el = useHistoryMenu.getState().menu?.el;
    useHistoryMenu.setState({ menu: null });
    if (el?.isConnected) el.focus();
  };
  // The entry went away (removed, history cleared): close.
  useEffect(() => {
    if (menu && !entry) useHistoryMenu.setState({ menu: null });
  }, [menu, entry]);
  if (!menu || !groups) return null;
  return <PopupMenu x={menu.x} y={menu.y} groups={groups} onClose={close} label="History item" />;
}

// ---- rows --------------------------------------------------------------------------------------

/** The bucket an entry's "Go to" needs in the current connection. */
const targetBucket = (e: HistoryEntry) => {
  const j = jobOf(e);
  return j ? jobTargetBucket(j) : e.bucket;
};

const JobHistoryRow = memo(function JobHistoryRow({ e, j, avail, now, top }: { e: HistoryEntry; j: HistoryJob; avail: Availability; now: number; top: number }) {
  const Icon = KIND_ICON[e.kind];
  const { label, icon: StatusIcon } = STATUS[e.status];
  const tip = jobTooltip(e, j);
  const dest = jobDest(j);
  const moved = e.kind === "copy" || e.kind === "move" || e.kind === "rename";
  return (
    <div className={`xrow hrow status-${e.status}`} style={{ transform: `translateY(${top}px)` }} {...menuProps(e.id)}>
      <div className={`xdir job-${e.kind === "rename" ? "move" : e.kind}`} title={KIND_LABEL[e.kind]}>
        <Icon size={14} />
      </div>
      <div className="xname">
        <div className="xname-main" title={tip}>
          {jobSentence(e, j)}
        </div>
        <div className="xname-sub" title={tip}>
          {e.error ? <span className="err-text">{e.error}</span> : dest && e.kind !== "rename" ? `${jobSource(j)} → ${dest}` : jobSource(j)}
        </div>
      </div>
      <div className="xnum hsize" title={jobCounts(j)}>
        <span>{moved ? formatBytes(e.bytes) : plural(j.done, "object")}</span>
        {j.failed > 0 ? (
          <span className="hsize-files hfailed">{j.failed.toLocaleString()} failed</span>
        ) : j.skipped > 0 ? (
          <span className="hsize-files">{j.skipped.toLocaleString()} skipped</span>
        ) : (
          moved && <span className="hsize-files">{plural(j.done, "object")}</span>
        )}
      </div>
      <div className="xnum hwhen" title={formatExact(e.finishedAt)}>
        {formatRelative(e.finishedAt, now)}
      </div>
      <div className={`xstatus s-${e.status}`}>
        <StatusIcon size={13} />
        {label}
      </div>
      <div className="xactions hactions">
        <button
          className="icon-btn"
          onClick={() => jobGo(e, j)}
          disabled={!avail.ok}
          title={avail.ok ? jobGoLabel(e, j) : `${jobGoLabel(e, j)}: ${avail.title}`}
          aria-label={jobGoLabel(e, j)}
        >
          <LocateFixed size={14} />
        </button>
        <button className="icon-btn" onClick={(ev) => removeEntry(e, ev.currentTarget.closest<HTMLElement>(".xrow"))} title="Remove from history" aria-label="Remove from history">
          <X size={14} />
        </button>
      </div>
    </div>
  );
});

const HistoryRow = memo(function HistoryRow({ e, avail, now, top }: { e: HistoryEntry; avail: Availability; now: number; top: number }) {
  const Icon = KIND_ICON[e.kind];
  const live = useLive(e);
  const goLabel = isFolder(e.kind) ? "Go to folder" : "Go to object";
  const { label, icon: StatusIcon } = STATUS[e.status];
  const where = entryWhere(e);
  return (
    <div className={`xrow hrow status-${e.status}`} style={{ transform: `translateY(${top}px)` }} {...menuProps(e.id)}>
      <div className={`xdir ${isDownload(e.kind) ? "download" : "upload"}`} title={KIND_LABEL[e.kind]}>
        <Icon size={14} />
      </div>
      <div className="xname">
        <div className="xname-main" title={where}>
          {entryName(e)}
        </div>
        <div className="xname-sub" title={e.error ?? where}>
          {e.status === "failed" && e.error ? <span className="err-text">{e.error}</span> : entryFolder(e)}
        </div>
      </div>
      <div className="xnum hsize">
        <span>{formatBytes(e.bytes)}</span>
        {isFolder(e.kind) && <span className="hsize-files">{plural(e.files, "file")}</span>}
      </div>
      <div className="xnum hwhen" title={formatExact(e.finishedAt)}>
        {formatRelative(e.finishedAt, now)}
      </div>
      <div className={`xstatus s-${e.status}`}>
        <StatusIcon size={13} />
        {label}
      </div>
      <div className="xactions hactions">
        {canOpen(e, live) && (
          <button className="icon-btn" onClick={() => void openEntry(e)} title={e.kind === "folderDownload" ? "Open folder" : "Open file"} aria-label="Open">
            <ExternalLink size={14} />
          </button>
        )}
        {canShow(e) && (
          <button className="icon-btn" onClick={() => void showEntry(e)} title="Show in folder" aria-label="Show in folder">
            <FolderSearch size={14} />
          </button>
        )}
        <button className="icon-btn" onClick={() => goToEntry(e)} disabled={!avail.ok} title={avail.ok ? goLabel : `${goLabel}: ${avail.title}`} aria-label={goLabel}>
          <LocateFixed size={14} />
        </button>
        <button
          className="icon-btn"
          onClick={() => void runAgain(e)}
          disabled={!avail.ok}
          title={avail.ok ? againLabel(e) : `${againLabel(e)}: ${avail.title}`}
          aria-label={againLabel(e)}
        >
          <RotateCw size={14} />
        </button>
        <button className="icon-btn" onClick={(ev) => removeEntry(e, ev.currentTarget.closest<HTMLElement>(".xrow"))} title="Remove from history" aria-label="Remove from history">
          <X size={14} />
        </button>
      </div>
    </div>
  );
});

function matches(e: HistoryEntry, q: string): boolean {
  const j = jobOf(e);
  if (j) {
    return [jobSentence(e, j), j.first, j.firstTo ?? "", j.srcBucket, j.srcPrefix, j.destBucket ?? "", j.destPrefix ?? ""].some((t) => t.toLowerCase().includes(q));
  }
  return entryName(e).toLowerCase().includes(q) || e.key.toLowerCase().includes(q) || e.bucket.toLowerCase().includes(q) || e.localPath.toLowerCase().includes(q);
}

/** The History tab's list (the panel body). */
export function HistoryList() {
  const entries = useScopedEntries();
  const total = useHistoryCount();
  const query = useActivityTab((s) => s.query);
  const filter = useActivityTab((s) => s.filter);
  const availability = useAvailability();
  const scrollRef = useRef<HTMLDivElement>(null);
  // "5 minutes ago" moves on while the panel is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => entries.filter((e) => (filter === "all" || (filter === "jobs") === !!e.job) && (!q || matches(e, q))),
    [entries, q, filter],
  );
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  return (
    <div className="transfers-body history-body" ref={scrollRef}>
      {total === 0 ? (
        <div className="empty-note">
          <History size={16} />
          Nothing here yet. Finished uploads, downloads and file operations are listed here, and kept after you close the app.
        </div>
      ) : entries.length === 0 ? (
        <div className="empty-note">
          <History size={16} />
          Nothing from this connection yet. Choose “All connections” to see the others.
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-note">
          {q ? `Nothing in the history matches “${query.trim()}”.` : filter === "jobs" ? "No file operations in the history yet." : "No transfers in the history yet."}
        </div>
      ) : (
        <div className="history-inner" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const e = shown[v.index];
            const j = jobOf(e);
            return j ? (
              <JobHistoryRow key={e.id} e={e} j={j} avail={availability(e, jobTargetBucket(j))} now={now} top={v.start} />
            ) : (
              <HistoryRow key={e.id} e={e} avail={availability(e, e.bucket)} now={now} top={v.start} />
            );
          })}
        </div>
      )}
      <HistoryMenu />
    </div>
  );
}

// ---- bar: filter chips, search and Clear history -----------------------------------------------

const FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "transfers", label: "Transfers" },
  { id: "jobs", label: "File operations" },
];

function ClearHistoryModal({ count, onClose }: { count: number; onClose: () => void }) {
  const titleId = useId();
  return (
    <ModalShell onClose={onClose} labelledBy={titleId}>
      <div className="modal-head">
        <div className="modal-icon">
          <Trash2 size={18} />
        </div>
        <div>
          <h2 id={titleId}>Clear the history?</h2>
          <p className="muted small">{plural(count, "entry", "entries")}</p>
        </div>
      </div>
      <p className="modal-text">
        This only empties the list. <strong>No file is deleted</strong>, neither on this computer nor in S3, and nothing that is running stops.
      </p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} data-autofocus>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            clearHistory();
            onClose();
          }}
        >
          Clear history
        </button>
      </div>
    </ModalShell>
  );
}

/** The bar's right side while the History tab is open. */
export function HistoryBar() {
  const count = useHistoryCount();
  const query = useActivityTab((s) => s.query);
  const filter = useActivityTab((s) => s.filter);
  const all = useActivityTab((s) => s.allConnections);
  const connected = useApp((s) => !!s.connection);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      {count > 0 && (
        <div className="hchips" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} className={`hchip ${filter === f.id ? "active" : ""}`} aria-pressed={filter === f.id} onClick={() => useActivityTab.setState({ filter: f.id })}>
              {f.label}
            </button>
          ))}
          {connected && (
            <button
              className={`hchip hchip-conn ${all ? "active" : ""}`}
              aria-pressed={all}
              title={all ? "Showing the history of every connection" : "Showing this connection's history only"}
              onClick={() => useActivityTab.setState({ allConnections: !all })}
            >
              All connections
            </button>
          )}
        </div>
      )}
      {count > 0 && (
        <label className="hsearch">
          <Search size={12} />
          <input
            type="search"
            value={query}
            placeholder="Filter history"
            aria-label="Filter history by name or path"
            onChange={(ev) => useActivityTab.setState({ query: ev.target.value })}
            onKeyDown={(ev) => {
              if (ev.key === "Escape" && query) {
                ev.stopPropagation();
                useActivityTab.setState({ query: "" });
              }
            }}
          />
        </label>
      )}
      {count > 0 && (
        <button className="link-btn" onClick={() => setConfirming(true)}>
          Clear history
        </button>
      )}
      {confirming && <ClearHistoryModal count={count} onClose={() => setConfirming(false)} />}
    </>
  );
}
