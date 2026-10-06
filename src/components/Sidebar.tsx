import { useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Archive, ArchiveX, CalendarClock, FolderOpen, Info, MoreHorizontal, Plus, RefreshCw, Search, Tag, Tags, Users, X } from "lucide-react";
import { loadAddedBuckets, loadBuckets, navigate, openModal, readPref, useApp, writePref } from "../store/app";
import { useTags } from "../store/tags";
import { formatExact } from "../lib/format";
import { PopupMenu } from "./PopupMenu";
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

interface BucketEntry {
  name: string;
  title: string;
  /** Added by name ("Shared with me"), so it can be removed from the list. */
  shared: boolean;
}

/** One bucket in the sidebar. It is also a drop target for dragged rows (move to its root). */
function BucketRow({ b, selected, onMenu }: { b: BucketEntry; selected: boolean; onMenu(b: BucketEntry, x: number, y: number): void }) {
  // Only buckets whose tags were loaded anyway (e.g. in the tag editor) show the icon: never fetched for it.
  const tagCount = useTags((s) => s.buckets[b.name]?.length ?? 0);
  const openMenuAt = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onMenu(b, r.left, r.bottom + 2);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className={`bucket-item ${selected ? "selected" : ""}`}
      title={b.title}
      data-drop-bucket={b.name}
      data-drop-prefix=""
      onClick={() => navigate(b.name, "")}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(b, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(b.name, "");
        } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          openMenuAt(e as unknown as ReactMouseEvent<HTMLElement>);
        }
      }}
    >
      {b.shared ? <Users size={14} className="bucket-icon" /> : <Archive size={14} className="bucket-icon" />}
      <span className="bucket-name">{b.name}</span>
      {tagCount > 0 && (
        <span className="bucket-tagged" title={`${tagCount} bucket tag${tagCount === 1 ? "" : "s"}`} aria-label={`${tagCount} bucket tags`}>
          <Tag size={11} />
        </span>
      )}
      <button
        type="button"
        className="icon-btn bucket-more"
        aria-label={`More actions for ${b.name}`}
        aria-haspopup="menu"
        title="More actions"
        onClick={(e) => {
          e.stopPropagation();
          openMenuAt(e);
        }}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
}

export function Sidebar() {
  const connection = useApp((s) => s.connection);
  const buckets = useApp((s) => s.buckets);
  const loading = useApp((s) => s.bucketsLoading);
  const error = useApp((s) => s.bucketsError);
  const added = useApp((s) => s.addedBuckets);
  const addedLoading = useApp((s) => s.addedLoading);
  const addedError = useApp((s) => s.addedError);
  const selected = useApp((s) => s.bucket);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ b: BucketEntry; x: number; y: number } | null>(null);
  const split = useSplit();

  const canList = connection?.canListBuckets ?? true;

  const f = filter.trim().toLowerCase();
  const matches = (name: string) => !f || name.toLowerCase().includes(f);
  const listed = useMemo(
    () => buckets.map((b): BucketEntry => ({ name: b.name, title: b.creationDate ? `Created ${formatExact(b.creationDate)}` : b.name, shared: false })),
    [buckets],
  );
  // An added bucket that ListBuckets also returns is shown once, in the regular list.
  const shared = useMemo(() => {
    const inList = new Set(buckets.map((b) => b.name));
    return added
      .filter((a) => !inList.has(a.name))
      .map((a): BucketEntry => ({ name: a.name, title: `${a.name}\nAdded by name${a.region ? ` · ${a.region}` : ""}`, shared: true }));
  }, [added, buckets]);
  const shownListed = listed.filter((b) => matches(b.name));
  const shownShared = shared.filter((b) => matches(b.name));

  const onMenu = (b: BucketEntry, x: number, y: number) => setMenu({ b, x, y });
  // Buckets shared from another account are rare, so the only standing entry point is this small button;
  // the "Shared with me" group appears in the list only once such a bucket exists.
  const addButton = (
    <button
      type="button"
      className="icon-btn"
      onClick={() => openModal({ kind: "addBucket" })}
      title={canList ? "Add a bucket shared with you from another account" : "Add a bucket by name"}
      aria-label="Add a bucket by name"
    >
      <Plus size={14} />
    </button>
  );

  return (
    <aside ref={split.sidebar} className="sidebar" style={split.style}>
      <div className="sidebar-buckets">
        <div className="sidebar-head">
          <span className="section-title">Buckets</span>
          <span className="sidebar-head-actions">
            {canList && (
              <button className="icon-btn" onClick={() => void loadBuckets()} title="Reload buckets" disabled={loading}>
                <RefreshCw size={13} className={loading ? "spin" : ""} />
              </button>
            )}
            {addButton}
          </span>
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

        <nav className="bucket-list" aria-label="Buckets">
          {canList ? (
            <>
              {loading && !buckets.length && [0, 1, 2, 3].map((i) => <div key={i} className="bucket-item skeleton" />)}
              {error && (
                <div className="sidebar-error">
                  {error.message}
                  <button className="link-btn" onClick={() => void loadBuckets()}>
                    Retry
                  </button>
                </div>
              )}
              {shownListed.map((b) => (
                <BucketRow key={b.name} b={b} selected={selected === b.name} onMenu={onMenu} />
              ))}
              {!loading && !error && shownListed.length === 0 && (
                <div className="empty-note small">{filter ? "No matching buckets" : "No buckets"}</div>
              )}
              {shownShared.length > 0 && (
                <div className="bucket-group-head">
                  <span className="section-title">Shared with me</span>
                </div>
              )}
            </>
          ) : (
            <div className="bucket-note">
              <Info size={13} />
              <span>
                This connection can’t list buckets. Add the buckets you use by name, an s3:// address or an ARN; they
                are remembered for this connection.
              </span>
            </div>
          )}
          {addedLoading && !added.length && <div className="bucket-item skeleton" />}
          {addedError && (
            <div className="sidebar-error">
              {addedError.message}
              <button className="link-btn" onClick={() => void loadAddedBuckets()}>
                Retry
              </button>
            </div>
          )}
          {shownShared.map((b) => (
            <BucketRow key={b.name} b={b} selected={selected === b.name} onMenu={onMenu} />
          ))}
          {!addedLoading && !addedError && shownShared.length === 0 && !canList && (
            filter && shared.length ? (
              <div className="empty-note small">No matching buckets</div>
            ) : (
              <button type="button" className="bucket-add" onClick={() => openModal({ kind: "addBucket" })}>
                <Plus size={13} /> Add a bucket
              </button>
            )
          )}
        </nav>
        <div className="sidebar-foot muted">
          {canList
            ? `${buckets.length} bucket${buckets.length === 1 ? "" : "s"}${shared.length ? ` · ${shared.length} shared` : ""}`
            : `${shared.length} added`}
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
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.b.name}`}
          onClose={() => setMenu(null)}
          groups={[
            [{ label: "Open", icon: <FolderOpen size={14} />, action: () => navigate(menu.b.name, "") }],
            [
              { label: "Bucket tags…", icon: <Tags size={14} />, action: () => openModal({ kind: "bucketTags", bucket: menu.b.name }) },
              { label: "Lifecycle rules…", icon: <CalendarClock size={14} />, action: () => openModal({ kind: "lifecycle", bucket: menu.b.name }) },
            ],
            menu.b.shared
              ? [{ label: "Remove from list…", icon: <ArchiveX size={14} />, action: () => openModal({ kind: "removeBucket", name: menu.b.name }) }]
              : [],
          ]}
        />
      )}
    </aside>
  );
}
