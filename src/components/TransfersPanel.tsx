import { memo, useMemo } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  FolderInput,
  FolderSearch,
  Trash2,
  X,
  CircleStop,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  Tags,
} from "lucide-react";
import * as api from "../lib/api";
import type { AppError, Job, JobKind, Transfer, TransferStatus } from "../lib/types";
import { isActive, selectActiveCount, useTransfers } from "../store/transfers";
import { removeJobs, selectActiveJobCount, useJobs } from "../store/jobs";
import { setTransfersOpen, useApp } from "../store/app";
import { toast } from "../store/toasts";
import { basename, formatBytes, formatDuration, formatSpeed } from "../lib/format";
import { isJobActive, jobFraction, plural } from "../lib/ops";

const STATUS_LABEL: Record<TransferStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_ICON: Record<TransferStatus, typeof Clock | null> = {
  queued: Clock,
  running: null,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: Ban,
};

async function cancel(id: string) {
  try {
    await api.cancelTransfer(id);
  } catch {
    /* unknown or already finished: nothing to do */
  }
}

/** Forget finished transfers. Active ones are skipped (the backend rejects them). */
async function removeTransfers(ids: string[]) {
  const { byId, remove } = useTransfers.getState();
  const finished = ids.filter((id) => !byId[id] || !isActive(byId[id]));
  const removed: string[] = [];
  for (const id of finished) {
    try {
      await api.removeTransfer(id);
      removed.push(id);
    } catch (e) {
      const err = e as AppError;
      // Unknown on the backend means it is already gone; drop it locally too.
      if (err.code === "InvalidInput" && byId[id] && isActive(byId[id])) continue;
      removed.push(id);
    }
  }
  remove(removed);
}

async function reveal(t: Transfer) {
  try {
    await api.revealInFolder(t.localPath);
  } catch (e) {
    toast.error("Could not show file", e as AppError);
  }
}

const TransferRow = memo(function TransferRow({ id }: { id: string }) {
  const t = useTransfers((s) => s.byId[id]);
  if (!t) return null;
  const name = basename(t.key);
  const pct = t.totalBytes > 0 ? Math.min(100, (t.transferredBytes / t.totalBytes) * 100) : 0;
  // Uploads only advance per completed part: show an indeterminate bar until bytes move.
  const indeterminate = (t.status === "running" && t.transferredBytes === 0) || t.status === "queued";
  const eta = t.status === "running" && t.bytesPerSec > 0 ? (t.totalBytes - t.transferredBytes) / t.bytesPerSec : NaN;
  const DirIcon = t.kind === "download" ? ArrowDownToLine : ArrowUpFromLine;
  const StatusIcon = STATUS_ICON[t.status];
  const where = t.kind === "download" ? `s3://${t.bucket}/${t.key} → ${t.localPath}` : `${t.localPath} → s3://${t.bucket}/${t.key}`;
  return (
    <div className={`xrow status-${t.status}`}>
      <div className={`xdir ${t.kind}`} title={t.kind === "download" ? "Download" : "Upload"}>
        <DirIcon size={14} />
      </div>
      <div className="xname">
        <div className="xname-main" title={where}>
          {name}
        </div>
        <div className="xname-sub" title={t.error ?? where}>
          {t.status === "failed" && t.error ? <span className="err-text">{t.error}</span> : where}
        </div>
      </div>
      <div className="xprogress">
        <div className={`pbar ${indeterminate ? "indeterminate" : ""} ${t.status === "queued" ? "queued" : ""}`}>
          {!indeterminate && <div className="pbar-fill" style={{ transform: `scaleX(${pct / 100})` }} />}
        </div>
        <div className="xbytes">
          {formatBytes(t.transferredBytes)} / {t.totalBytes ? formatBytes(t.totalBytes) : "?"}
        </div>
      </div>
      <div className="xnum xspeed">{t.status === "running" ? formatSpeed(t.bytesPerSec) : ""}</div>
      <div className="xnum xparts" title="Parts done / total">
        {t.partsTotal > 1 ? `${t.partsDone}/${t.partsTotal}` : ""}
      </div>
      <div className="xnum xeta">{t.status === "running" ? formatDuration(eta) : ""}</div>
      <div className={`xstatus s-${t.status}`}>
        {StatusIcon ? <StatusIcon size={13} /> : <span className="pulse-dot" />}
        {t.status === "running" ? (indeterminate ? "Starting" : `${pct.toFixed(0)}%`) : STATUS_LABEL[t.status]}
      </div>
      <div className="xactions">
        {t.kind === "download" && t.status === "completed" && (
          <button className="icon-btn" onClick={() => void reveal(t)} title="Show in folder">
            <FolderSearch size={14} />
          </button>
        )}
        {isActive(t) ? (
          <button className="icon-btn" onClick={() => void cancel(t.id)} title="Cancel">
            <CircleStop size={14} />
          </button>
        ) : (
          <button className="icon-btn" onClick={() => void removeTransfers([t.id])} title="Remove from list">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
});

const JOB_ICON: Record<JobKind, typeof Copy> = { delete: Trash2, copy: Copy, move: FolderInput, tag: Tags };
const JOB_KIND_LABEL: Record<JobKind, string> = { delete: "Delete", copy: "Copy", move: "Move", tag: "Tag" };

async function cancelJob(id: string) {
  try {
    await api.cancelJob(id);
  } catch {
    /* unknown or already finished */
  }
}

function jobWhere(j: Job): string {
  if (j.kind !== "delete" && j.destBucket && j.destBucket !== j.srcBucket) return `${j.srcBucket} → ${j.destBucket}`;
  return `in ${j.srcBucket}`;
}

function jobProgressText(j: Job): string {
  if (j.status === "queued") return "Queued: waits for a running job";
  if (j.phase === "listing") return `Listing… ${plural(j.totalItems, "object")} found`;
  const processed = j.doneItems + j.skippedItems + j.failedItems;
  const objects = `${processed.toLocaleString()} / ${j.totalItems.toLocaleString()} objects`;
  if (j.kind === "delete") return objects;
  return `${objects} · ${formatBytes(j.doneBytes)} / ${formatBytes(j.totalBytes)}`;
}

const JobRow = memo(function JobRow({ id }: { id: string }) {
  const j = useJobs((s) => s.byId[id]);
  const expanded = useJobs((s) => !!s.expanded[id]);
  if (!j) return null;
  const Icon = JOB_ICON[j.kind];
  const active = isJobActive(j);
  const pct = jobFraction(j) * 100;
  const indeterminate = j.status === "queued" || (j.status === "running" && j.phase === "listing");
  const StatusIcon = STATUS_ICON[j.status];
  const hasProblems = j.failedItems > 0 || !!j.error;
  const canExpand = j.errors.length > 0 || !!j.error;
  const statusText =
    j.status === "running"
      ? j.phase === "listing"
        ? "Listing"
        : `${pct.toFixed(0)}%`
      : j.status === "failed"
        ? "Failed"
        : STATUS_LABEL[j.status];
  return (
    <div id={`job-${id}`} className={`jobwrap ${hasProblems ? "has-problems" : ""}`}>
      <div className={`xrow jrow status-${j.status}`}>
        <div className={`xdir job-${j.kind}`} title={JOB_KIND_LABEL[j.kind]}>
          <Icon size={14} />
        </div>
        <div className="xname">
          <div className="xname-main" title={j.label}>
            {j.label}
          </div>
          <div className="xname-sub" title={j.error ?? jobWhere(j)}>
            {j.error ? <span className="err-text">{j.error}</span> : jobWhere(j)}
          </div>
        </div>
        <div className="xprogress">
          <div className={`pbar ${indeterminate ? "indeterminate" : ""} ${j.status === "queued" ? "queued" : ""}`}>
            {!indeterminate && <div className="pbar-fill" style={{ transform: `scaleX(${pct / 100})` }} />}
          </div>
          <div className="xbytes">{jobProgressText(j)}</div>
        </div>
        <div className="jcounts">
          {j.skippedItems > 0 && <span className="jcount skipped">{j.skippedItems.toLocaleString()} skipped</span>}
          {j.failedItems > 0 && <span className="jcount failed">{j.failedItems.toLocaleString()} failed</span>}
        </div>
        <div className={`xstatus s-${j.status}`}>
          {StatusIcon ? <StatusIcon size={13} /> : <span className="pulse-dot" />}
          {statusText}
        </div>
        <div className="xactions">
          {canExpand && (
            <button
              className="icon-btn"
              onClick={() => useJobs.getState().setExpanded(id, !expanded)}
              title={expanded ? "Hide errors" : "Show errors"}
              aria-label={expanded ? "Hide errors" : "Show errors"}
              aria-expanded={expanded}
              aria-controls={`job-errors-${id}`}
            >
              <ChevronRight size={14} className={expanded ? "rot90" : ""} />
            </button>
          )}
          {active ? (
            <button className="icon-btn" onClick={() => void cancelJob(j.id)} title="Cancel" aria-label="Cancel job">
              <CircleStop size={14} />
            </button>
          ) : (
            <button className="icon-btn" onClick={() => void removeJobs([j.id])} title="Remove from list" aria-label="Remove job">
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {expanded && canExpand && (
        <div className="jerrors" id={`job-errors-${id}`}>
          {j.error && (
            <div className="jerror">
              <AlertTriangle size={12} />
              <span className="jerror-msg">{j.error}</span>
            </div>
          )}
          {j.errors.map((e, i) => (
            <div key={i} className="jerror">
              <span className="jerror-key mono">{e.key}</span>
              <span className="jerror-msg">{e.message}</span>
            </div>
          ))}
          {j.failedItems > j.errors.length && (
            <div className="jerror-more muted">
              Showing the first {j.errors.length} of {j.failedItems.toLocaleString()} errors.
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** Overall progress of everything active: each transfer or job weighs the same. */
function Summary() {
  const transfers = useTransfers((s) => {
    let speed = 0;
    let frac = 0;
    let n = 0;
    for (const id of s.ids) {
      const t = s.byId[id];
      if (t && isActive(t)) {
        speed += t.bytesPerSec;
        frac += t.totalBytes ? Math.min(1, t.transferredBytes / t.totalBytes) : 0;
        n++;
      }
    }
    return `${speed}|${frac}|${n}`;
  });
  const jobs = useJobs((s) => {
    let frac = 0;
    let n = 0;
    for (const id of s.ids) {
      const j = s.byId[id];
      if (j && isJobActive(j)) {
        frac += jobFraction(j);
        n++;
      }
    }
    return `${frac}|${n}`;
  });
  const [speed, tFrac, tN] = transfers.split("|").map(Number);
  const [jFrac, jN] = jobs.split("|").map(Number);
  const n = tN + jN;
  if (!n) return null;
  const pct = Math.min(100, ((tFrac + jFrac) / n) * 100);
  return (
    <span className="xsummary">
      <span className="mini-bar">
        <span style={{ transform: `scaleX(${pct / 100})` }} />
      </span>
      {pct.toFixed(0)}%{tN > 0 && speed > 0 ? ` · ${formatSpeed(speed)}` : ""}
    </span>
  );
}

type ActivityRow = { kind: "job" | "transfer"; id: string };

/** Bottom panel: transfers (uploads/downloads) and jobs (delete/copy/move), newest first. */
export function ActivityPanel() {
  const open = useApp((s) => s.transfersOpen);
  const transferIds = useTransfers((s) => s.ids);
  const jobIds = useJobs((s) => s.ids);
  const activeTransfers = useTransfers(selectActiveCount);
  const activeJobs = useJobs(selectActiveJobCount);
  const active = activeTransfers + activeJobs;
  const total = transferIds.length + jobIds.length;
  const finishedCount = total - active;

  // Start times never change, so this only re-sorts when rows are added or removed.
  const rows = useMemo<ActivityRow[]>(() => {
    const t = useTransfers.getState().byId;
    const j = useJobs.getState().byId;
    const all = [
      ...jobIds.map((id) => ({ kind: "job" as const, id, at: j[id]?.startedAt ?? "" })),
      ...transferIds.map((id) => ({ kind: "transfer" as const, id, at: t[id]?.startedAt ?? "" })),
    ];
    return all.sort((a, b) => b.at.localeCompare(a.at));
  }, [jobIds, transferIds]);

  const clearFinished = () => {
    const ts = useTransfers.getState();
    void removeTransfers(ts.ids.filter((id) => ts.byId[id] && !isActive(ts.byId[id])));
    const js = useJobs.getState();
    void removeJobs(js.ids.filter((id) => js.byId[id] && !isJobActive(js.byId[id])));
  };

  return (
    <section className={`transfers ${open ? "open" : ""}`} aria-label="Activity">
      <div className="transfers-bar">
        <button className="transfers-toggle" onClick={() => setTransfersOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          <span>Activity</span>
          {active > 0 && (
            <span className="badge" title={`${activeTransfers} transfers, ${activeJobs} file operations active`}>
              {active}
            </span>
          )}
          {active === 0 && total > 0 && <span className="muted small">{total} finished</span>}
        </button>
        <Summary />
        <div className="spacer" />
        {open && finishedCount > 0 && (
          <button className="link-btn" onClick={clearFinished}>
            Clear finished
          </button>
        )}
      </div>
      {open && (
        <div className="transfers-body">
          {total === 0 ? (
            <div className="empty-note">Nothing here yet. Uploads, downloads and file operations show their progress here.</div>
          ) : (
            rows.map((r) => (r.kind === "job" ? <JobRow key={r.id} id={r.id} /> : <TransferRow key={r.id} id={r.id} />))
          )}
        </div>
      )}
    </section>
  );
}
