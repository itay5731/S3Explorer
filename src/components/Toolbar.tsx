import { Fragment } from "react";
import {
  ChevronRight,
  Download,
  FolderPlus,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  Archive,
  ArrowUp,
} from "lucide-react";
import { navigate, openModal, refresh, setDetailsOpen, setFilter, useApp } from "../store/app";
import { downloadObjects, pickAndUpload } from "../store/actions";
import { getSelected, useSelectionInfo, useViewRows } from "../store/view";
import { displayName, formatBytes, parentPrefix, prefixSegments } from "../lib/format";

export function Toolbar() {
  const bucket = useApp((s) => s.bucket);
  const prefix = useApp((s) => s.prefix);
  const filter = useApp((s) => s.filter);
  const loading = useApp((s) => s.listing.loading);
  const detailsOpen = useApp((s) => s.detailsOpen);
  const sel = useSelectionInfo();
  const disabled = !bucket;

  return (
    <div className="toolbar">
      <div className="tool-group">
        <button className="btn btn-primary" disabled={disabled} onClick={() => void pickAndUpload()} title="Upload files">
          <Upload size={14} />
          <span className="btn-label">Upload</span>
        </button>
        <button className="btn" disabled={disabled} onClick={() => openModal({ kind: "newFolder" })} title="New folder">
          <FolderPlus size={14} />
          <span className="btn-label">New folder</span>
        </button>
        <button
          className="btn"
          disabled={disabled || sel.objects === 0}
          onClick={() => void downloadObjects(getSelected().objects)}
          title={sel.objects > 1 ? `Download ${sel.objects} objects` : "Download"}
        >
          <Download size={14} />
          <span className="btn-label secondary">Download</span>
        </button>
        <button
          className="btn btn-danger-ghost"
          disabled={disabled || !sel.folder}
          onClick={() => sel.folder && openModal({ kind: "deleteFolder", prefix: sel.folder.prefix })}
          title="Delete folder (recursive)"
        >
          <Trash2 size={14} />
          <span className="btn-label secondary">Delete folder</span>
        </button>
        <span className="tool-sep" />
        <button className="icon-btn lg" disabled={disabled || !prefix} onClick={() => bucket && navigate(bucket, parentPrefix(prefix))} title="Up one level (Backspace)">
          <ArrowUp size={15} />
        </button>
        <button className="icon-btn lg" disabled={disabled} onClick={() => refresh()} title="Refresh">
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </button>
      </div>
      <div className="tool-group right">
        <div className="search-box toolbar-search">
          <Search size={13} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter loaded items"
            spellCheck={false}
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilter("");
            }}
          />
          {filter && (
            <button className="icon-btn" onClick={() => setFilter("")} aria-label="Clear filter">
              <X size={12} />
            </button>
          )}
        </div>
        <button
          className={`icon-btn lg ${detailsOpen ? "active" : ""}`}
          onClick={() => setDetailsOpen(!detailsOpen)}
          title={detailsOpen ? "Hide details" : "Show details"}
        >
          {detailsOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
    </div>
  );
}

export function Breadcrumbs() {
  const bucket = useApp((s) => s.bucket);
  const prefix = useApp((s) => s.prefix);
  const truncated = useApp((s) => s.listing.truncated);
  const loading = useApp((s) => s.listing.loading);
  const total = useApp((s) => s.listing.folders.length + s.listing.objects.length);
  const rows = useViewRows();
  const filter = useApp((s) => s.filter);
  const sel = useSelectionInfo();
  if (!bucket) return <div className="breadcrumbs" />;
  const segs = prefixSegments(prefix);
  const selCount = sel.folders + sel.objects;
  return (
    <div className="breadcrumbs">
      <nav className="crumbs" aria-label="Path">
        <button className={`crumb ${segs.length === 0 ? "current" : ""}`} onClick={() => navigate(bucket, "")} title={`s3://${bucket}/`}>
          <Archive size={13} />
          {bucket}
        </button>
        {segs.map((s, i) => (
          <Fragment key={s.prefix}>
            <ChevronRight size={13} className="crumb-sep" />
            <button className={`crumb ${i === segs.length - 1 ? "current" : ""}`} onClick={() => navigate(bucket, s.prefix)} title={`s3://${bucket}/${s.prefix}`}>
              {displayName(s.name)}
            </button>
          </Fragment>
        ))}
      </nav>
      <div className="crumb-info muted">
        {selCount > 0 && (
          <span className="sel-info">
            {selCount.toLocaleString()} selected{sel.objects > 0 ? ` · ${formatBytes(sel.bytes)}` : ""}
            <span className="dot-sep">·</span>
          </span>
        )}
        {loading && total === 0
          ? "Loading…"
          : filter
            ? `${rows.length.toLocaleString()} of ${total.toLocaleString()}${truncated ? "+" : ""} items`
            : `${total.toLocaleString()}${truncated ? "+" : ""} items`}
      </div>
    </div>
  );
}
