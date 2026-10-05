import { memo } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  FolderSearch,
  X,
  CircleStop,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
} from "lucide-react";
import * as api from "../lib/api";
import type { AppError, Transfer, TransferStatus } from "../lib/types";
import { isActive, selectActiveCount, useTransfers } from "../store/transfers";
import { setTransfersOpen, useApp } from "../store/app";
import { toast } from "../store/toasts";
import { basename, formatBytes, formatDuration, formatSpeed } from "../lib/format";

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

function Summary() {
  const summary = useTransfers((s) => {
    let speed = 0;
    let done = 0;
    let total = 0;
    for (const id of s.ids) {
      const t = s.byId[id];
      if (t && isActive(t)) {
        speed += t.bytesPerSec;
        done += t.transferredBytes;
        total += t.totalBytes;
      }
    }
    return `${speed}|${done}|${total}`;
  });
  const [speed, done, total] = summary.split("|").map(Number);
  if (!total) return null;
  const pct = Math.min(100, (done / total) * 100);
  return (
    <span className="xsummary">
      <span className="mini-bar">
        <span style={{ transform: `scaleX(${pct / 100})` }} />
      </span>
      {pct.toFixed(0)}% · {formatSpeed(speed)}
    </span>
  );
}

export function TransfersPanel() {
  const open = useApp((s) => s.transfersOpen);
  const ids = useTransfers((s) => s.ids);
  const active = useTransfers(selectActiveCount);
  const finishedCount = ids.length - active;

  const clearFinished = () => {
    const { byId, ids } = useTransfers.getState();
    void removeTransfers(ids.filter((id) => byId[id] && !isActive(byId[id])));
  };

  return (
    <section className={`transfers ${open ? "open" : ""}`}>
      <div className="transfers-bar">
        <button className="transfers-toggle" onClick={() => setTransfersOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          <span>Transfers</span>
          {active > 0 && <span className="badge">{active}</span>}
          {active === 0 && ids.length > 0 && <span className="muted small">{ids.length} finished</span>}
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
          {ids.length === 0 ? (
            <div className="empty-note">No transfers yet. Upload or download something to see progress here.</div>
          ) : (
            ids.map((id) => <TransferRow key={id} id={id} />)
          )}
        </div>
      )}
    </section>
  );
}
