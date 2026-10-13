import { memo } from "react";
import { AlertCircle, Calculator, Loader2, RefreshCw, X } from "lucide-react";
import { formatBytes, formatExact, formatRelative } from "../lib/format";
import { plural } from "../lib/ops";
import { FOLDER_SIZE_SCAN_LIMIT } from "../lib/types";
import {
  calculateFolderSizes,
  cancelFolderSizes,
  folderSizeId,
  useFolderSize,
  useFolderSizes,
  type FolderSizeEntry,
} from "../store/folderSizes";

/** The scan stops at 2,000 pages too (see "Folder size" in docs/CONTRACT.md). */
const FOLDER_SIZE_PAGE_LIMIT = 2_000;

/**
 * Why a truncated scan stopped: the key limit, or the page limit when fewer keys than that were
 * listed (a server returning small pages).
 */
export function truncationReason(scanned: number): string {
  return scanned >= FOLDER_SIZE_SCAN_LIMIT
    ? `stopped after ${FOLDER_SIZE_SCAN_LIMIT.toLocaleString()} keys`
    : `stopped after ${FOLDER_SIZE_PAGE_LIMIT.toLocaleString()} pages (${scanned.toLocaleString()} keys)`;
}

/**
 * The file table's Size cell for a folder: its calculated size (muted), a spinner while scanning
 * (next to the previous size while recalculating), else "—".
 */
export const FolderSizeCell = memo(function FolderSizeCell({ bucket, prefix }: { bucket: string; prefix: string }) {
  const e = useFolderSize(bucket, prefix);
  if (e?.size) {
    const at = e.at ? ` · calculated ${formatRelative(e.at)}` : "";
    return (
      <span className="dim" title={`${e.scan ? "Recalculating… " : ""}${plural(e.size.objects, "object")}${e.size.truncated ? " at least" : ""}${at}`}>
        {e.scan && <Loader2 size={11} className="spin fsize-cell-spin" aria-label="Recalculating size" />}
        {e.size.truncated ? "≥ " : ""}
        {formatBytes(e.size.bytes)}
      </span>
    );
  }
  if (e?.scan) return <Loader2 size={12} className="spin dim" aria-label="Calculating size" />;
  return <span className="dim">—</span>;
});

/** Folders inside another one of the list are already counted by it. */
function outermost(prefixes: string[]): string[] {
  const sorted = [...new Set(prefixes)].sort();
  const out: string[] = [];
  for (const p of sorted) if (!out.some((o) => p.startsWith(o))) out.push(p);
  return out;
}

/**
 * The details panel's "Size" row for one or several folders: Calculate, a spinner and Cancel while
 * scanning, then "1,234 objects · 5.6 GiB" (summed over several), "At least" when a scan was truncated.
 */
export function FolderSizeField({ bucket, prefixes }: { bucket: string; prefixes: string[] }) {
  const byId = useFolderSizes((s) => s.byId);
  const list = outermost(prefixes);
  const entries = list.map((p) => byId[folderSizeId(bucket, p)] as FolderSizeEntry | undefined);
  const running = list.filter((_, i) => entries[i]?.scan);
  const done = entries.filter((e) => e?.size && !e.scan);
  const missing = list.filter((_, i) => !entries[i]?.size && !entries[i]?.scan);
  const error = entries.find((e) => e?.error && !e.scan)?.error ?? null;
  const many = list.length > 1;

  let value;
  if (running.length) {
    value = (
      <span className="fsize-line">
        <Loader2 size={12} className="spin" /> Calculating…
        {many && <span className="muted"> {done.length.toLocaleString()} of {list.length.toLocaleString()} done</span>}
        <button type="button" className="link-btn" onClick={() => cancelFolderSizes(bucket, running)}>
          <X size={12} /> Cancel
        </button>
      </span>
    );
  } else if (!missing.length) {
    const objects = done.reduce((n, e) => n + e!.size!.objects, 0);
    const bytes = done.reduce((n, e) => n + e!.size!.bytes, 0);
    const truncated = done.some((e) => e!.size!.truncated);
    // Several results: the oldest one says how fresh the sum is.
    const at = done.map((e) => e!.at ?? "").sort()[0] || null;
    value = (
      <>
        <span className="fsize-line">
          {truncated ? "At least " : ""}
          {plural(objects, "object")} · {formatBytes(bytes)}
          <button type="button" className="link-btn" onClick={() => calculateFolderSizes(bucket, list)} title="Calculate again">
            <RefreshCw size={12} /> Recalculate
          </button>
        </span>
        <span className="muted small" title={formatExact(at)}>
          Calculated {formatRelative(at)}
          {truncated
            ? ` · ${done
                .filter((e) => e!.size!.truncated)
                .map((e) => truncationReason(e!.size!.scanned))
                .filter((r, i, all) => all.indexOf(r) === i)
                .join("; ")}`
            : ""}
        </span>
        {error && (
          <span className="inline-error">
            <AlertCircle size={13} /> {error.message}
          </span>
        )}
      </>
    );
  } else {
    value = (
      <>
        <span className="fsize-line">
          {done.length ? <span className="muted">{done.length.toLocaleString()} of {list.length.toLocaleString()} calculated</span> : <span className="muted">Not calculated</span>}
          <button type="button" className="link-btn" onClick={() => calculateFolderSizes(bucket, missing)}>
            <Calculator size={12} /> {many ? `Calculate ${missing.length === list.length ? "all" : "the rest"}` : "Calculate"}
          </button>
        </span>
        {error && (
          <span className="inline-error">
            <AlertCircle size={13} /> {error.message}
          </span>
        )}
      </>
    );
  }
  return (
    <div className="dfield">
      <div className="dlabel">{many ? `Size of ${plural(list.length, "folder")}` : "Size"}</div>
      <div className="dvalue fsize">{value}</div>
    </div>
  );
}
