import { useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, Archive, Plus, RefreshCw, Search, X } from "lucide-react";
import { addManualBucket, loadBuckets, navigate, readPref, removeManualBucket, useApp, writePref } from "../store/app";
import { formatExact } from "../lib/format";
import { RecentFiles } from "./RecentFiles";

const SHARE_KEY = "s3x.bucketsShare";
/** The part of the sidebar's height the bucket list takes; the newest files get the rest. */
const DEFAULT_SHARE = 0.6;
const SHARE_MIN = 0.15;
const SHARE_MAX = 0.8;

/**
 * The divider between the buckets and the newest files. The split is kept as a share of the
 * sidebar's height, not in pixels, so it holds at any window size. While dragging, the share is
 * written straight to the element; it is saved once, on release.
 */
function useSplit() {
  const sidebar = useRef<HTMLElement>(null);
  const [share, setShare] = useState(() => readPref<number>(SHARE_KEY, DEFAULT_SHARE));
  const save = (next: number) => {
    setShare(next);
    writePref(SHARE_KEY, next);
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    const el = sidebar.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const box = el.getBoundingClientRect();
    let latest = share;
    const onMove = (move: PointerEvent) => {
      latest = Math.min(Math.max((move.clientY - box.top) / box.height, SHARE_MIN), SHARE_MAX);
      el.style.setProperty("--buckets-share", String(latest));
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      save(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };
  return { sidebar, style: { "--buckets-share": share } as CSSProperties, onPointerDown, reset: () => save(DEFAULT_SHARE) };
}

export function Sidebar() {
  const connection = useApp((s) => s.connection);
  const buckets = useApp((s) => s.buckets);
  const loading = useApp((s) => s.bucketsLoading);
  const error = useApp((s) => s.bucketsError);
  const manual = useApp((s) => s.manualBuckets);
  const selected = useApp((s) => s.bucket);
  const [filter, setFilter] = useState("");
  const [manualName, setManualName] = useState("");
  const split = useSplit();

  const canList = connection?.canListBuckets ?? true;

  const items = useMemo(() => {
    const list = canList
      ? buckets.map((b) => ({ name: b.name, title: b.creationDate ? `Created ${formatExact(b.creationDate)}` : b.name, manual: false }))
      : manual.map((name) => ({ name, title: name, manual: true }));
    const f = filter.trim().toLowerCase();
    return f ? list.filter((b) => b.name.toLowerCase().includes(f)) : list;
  }, [buckets, manual, canList, filter]);

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    if (manualName.trim()) {
      addManualBucket(manualName);
      setManualName("");
    }
  };

  return (
    <aside ref={split.sidebar} className="sidebar" style={split.style}>
      <div className="sidebar-buckets">
        <div className="sidebar-head">
          <span className="section-title">Buckets</span>
          {canList && (
            <button className="icon-btn" onClick={() => void loadBuckets()} title="Reload buckets" disabled={loading}>
              <RefreshCw size={13} className={loading ? "spin" : ""} />
            </button>
          )}
        </div>

        <div className="search-box">
          <Search size={13} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter buckets" spellCheck={false} />
          {filter && (
            <button className="icon-btn" onClick={() => setFilter("")} aria-label="Clear filter">
              <X size={12} />
            </button>
          )}
        </div>

        {!canList && (
          <form className="manual-bucket" onSubmit={submitManual}>
            <p className="hint">
              <AlertTriangle size={12} /> This identity can’t list buckets. Enter a bucket name to open it.
            </p>
            <div className="input-affix">
              <input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="bucket-name" spellCheck={false} />
              <button type="submit" className="icon-btn" aria-label="Open bucket" disabled={!manualName.trim()}>
                <Plus size={14} />
              </button>
            </div>
          </form>
        )}

        <nav className="bucket-list">
          {loading && !buckets.length && [0, 1, 2, 3].map((i) => <div key={i} className="bucket-item skeleton" />)}
          {error && canList && (
            <div className="sidebar-error">
              {error.message}
              <button className="link-btn" onClick={() => void loadBuckets()}>
                Retry
              </button>
            </div>
          )}
          {items.map((b) => (
            <div
              key={b.name}
              role="button"
              tabIndex={0}
              className={`bucket-item ${selected === b.name ? "selected" : ""}`}
              title={b.title}
              onClick={() => navigate(b.name, "")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(b.name, "");
                }
              }}
            >
              <Archive size={14} className="bucket-icon" />
              <span className="bucket-name">{b.name}</span>
              {b.manual && (
                <button
                  className="icon-btn bucket-remove"
                  aria-label={`Remove ${b.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeManualBucket(b.name);
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          {!loading && !error && items.length === 0 && (canList || manual.length > 0) && (
            <div className="empty-note small">{filter ? "No matching buckets" : "No buckets"}</div>
          )}
        </nav>
        <div className="sidebar-foot muted">
          {canList ? `${buckets.length} bucket${buckets.length === 1 ? "" : "s"}` : `${manual.length} pinned`}
        </div>
      </div>
      <div
        className="split-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the bucket list"
        title="Drag to resize. Double-click to reset."
        onPointerDown={split.onPointerDown}
        onDoubleClick={split.reset}
      />
      <RecentFiles />
    </aside>
  );
}
