import { useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, Archive, Plus, RefreshCw, Search, X } from "lucide-react";
import { addManualBucket, loadBuckets, navigate, removeManualBucket, useApp } from "../store/app";
import { formatExact } from "../lib/format";

export function Sidebar() {
  const connection = useApp((s) => s.connection);
  const buckets = useApp((s) => s.buckets);
  const loading = useApp((s) => s.bucketsLoading);
  const error = useApp((s) => s.bucketsError);
  const manual = useApp((s) => s.manualBuckets);
  const selected = useApp((s) => s.bucket);
  const [filter, setFilter] = useState("");
  const [manualName, setManualName] = useState("");

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
    <aside className="sidebar">
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
    </aside>
  );
}
