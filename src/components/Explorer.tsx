import { Fragment, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, Globe, LogOut, MapPin, UploadCloud } from "lucide-react";
import * as api from "../lib/api";
import { activePane, getPane, readPref, requestDisconnect, setActivePane, setNarrow, useApp, writePref } from "../store/app";
import { PaneContext, PANE_IDS, usePanes, type PaneId } from "../store/panes";
import { onExplorerKeyDown, onExplorerMouseDown } from "../store/keyActions";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { installTransferEffects } from "../store/actions";
import { handleOsDrop, installBatchEffects } from "../store/folders";
import { installJobEffects } from "../store/ops";
import { installTagEffects } from "../store/tags";
import { installArchiveEffects } from "../store/archive";
import { DragBadge } from "./RowDrag";
import { Sidebar } from "./Sidebar";
import { Breadcrumbs, Toolbar } from "./Toolbar";
import { BookmarksBar } from "./BookmarksBar";
import { ObjectTable } from "./ObjectTable";
import { SearchResults } from "./SearchResults";
import { toast } from "../store/toasts";
import { DetailsPanel } from "./DetailsPanel";
import { ActivityPanel } from "./TransfersPanel";
import { ContextMenu } from "./ContextMenu";
import { Modals } from "./Modals";
import { Logo } from "./Logo";
import { SettingsButton } from "./SettingsDialog";
import { ThemeToggle } from "./ThemeToggle";

function ConnectionChip() {
  const conn = useApp((s) => s.connection);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!conn) return null;
  return (
    <div className="conn-chip-wrap" ref={ref}>
      <button className="conn-chip" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="status-dot" />
        <span className="conn-label">{conn.label}</span>
        <span className="conn-region">{conn.region}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="popover">
          <div className="popover-head">
            <span className="popover-status">
              <span className="status-dot" /> Connected
            </span>
            <span className="popover-name">{conn.label}</span>
          </div>
          <div className="popover-row">
            <span className="muted">
              <MapPin size={13} /> Region
            </span>
            <span>{conn.region}</span>
          </div>
          <div className="popover-row">
            <span className="muted">
              <Globe size={13} /> Endpoint
            </span>
            <span title={conn.endpoint ?? undefined}>{conn.endpoint ?? "AWS"}</span>
          </div>
          {!conn.canListBuckets && <div className="popover-note">This connection is not allowed to list buckets.</div>}
          <button
            className="btn btn-danger-ghost popover-action"
            onClick={() => {
              setOpen(false);
              requestDisconnect();
            }}
          >
            <LogOut size={14} /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

/** The pane under a point of the page, if any. */
function paneAt(p: api.DropPoint | undefined): PaneId | null {
  if (!p) return null;
  const el = document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>("[data-pane]");
  const id = el?.dataset.pane;
  return id === "a" || id === "b" ? id : null;
}

/**
 * OS files dragged over the window: which pane they would land in (the pane under the pointer, else
 * the active pane), or null while nothing is dragged.
 */
function useFileDrop(): PaneId | null {
  const [target, setTarget] = useState<PaneId | null>(null);
  useEffect(() => {
    let unlisten: api.Unlisten | null = null;
    let disposed = false;
    api
      .onFileDrop((e) => {
        if (e.type === "enter" || e.type === "over") setTarget(paneAt(e.position) ?? activePane());
        else if (e.type === "leave") setTarget(null);
        else {
          setTarget(null);
          // Files upload right away; a folder opens the upload-folder confirmation. Not while search
          // results are open in that pane: no folder is in view to upload into.
          if (!e.paths.length) return;
          const pane = paneAt(e.position) ?? activePane();
          // The pane that receives the drop becomes the active one (its dialogs and toolbar follow).
          if (!useApp.getState().modal) setActivePane(pane);
          if (getPane(pane).search.open) toast.info("Go back to a folder to upload", "Search results are open; nothing was uploaded.");
          else void handleOsDrop(e.paths, pane);
        }
      })
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => {
        /* drag & drop unavailable */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return target;
}

/** Below this main-area width the second pane is hidden (not closed). */
const SPLIT_MIN_WIDTH = 560;

/** Watch the main area's width and hide the second pane when two would not fit. */
function useNarrowWatch() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < SPLIT_MIN_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return ref;
}

/**
 * The key dispatcher: one capture-phase keydown listener for the whole explorer (see "Dispatcher
 * rules" in docs/CONTRACT.md and store/keyActions.ts).
 */
function useKeyDispatcher() {
  useEffect(() => {
    window.addEventListener("keydown", onExplorerKeyDown, true);
    window.addEventListener("mousedown", onExplorerMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onExplorerKeyDown, true);
      window.removeEventListener("mousedown", onExplorerMouseDown, true);
    };
  }, []);
}

/** One explorer pane: its path bar and its table (or search results), and the OS-drop overlay. */
function Pane({ id, dropping }: { id: PaneId; dropping: boolean }) {
  const bucket = usePanes((s) => s[id].bucket);
  const prefix = usePanes((s) => s[id].prefix);
  const searchOpen = usePanes((s) => s[id].search.open) && bucket !== null;
  const split = useApp((s) => s.split && !s.narrow);
  const active = useApp((s) => s.activePane === id);

  return (
    <PaneContext.Provider value={id}>
      <section
        className={`pane ${split ? (active ? "active" : "inactive") : ""}`}
        data-pane={id}
        tabIndex={-1}
        aria-label={split ? (id === "a" ? "Left pane" : "Right pane") : undefined}
        onPointerDownCapture={() => setActivePane(id)}
        onFocusCapture={() => setActivePane(id)}
      >
        {bucket && <Breadcrumbs />}
        <div className="table-wrap">
          {searchOpen ? <SearchResults /> : <ObjectTable />}
          {dropping && (
            <div className={`drop-overlay ${bucket ? "" : "disabled"}`}>
              <div className="drop-card">
                <UploadCloud size={34} strokeWidth={1.5} />
                <div className="drop-title">
                  {!bucket ? "Select a bucket first" : searchOpen ? "Go back to a folder to upload" : "Drop files or a folder to upload"}
                </div>
                {bucket && <div className="muted mono small">s3://{bucket}/{prefix}</div>}
              </div>
            </div>
          )}
        </div>
      </section>
    </PaneContext.Provider>
  );
}

const SIDEBAR_WIDTH_KEY = "s3x.sidebarWidth";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 640;

/**
 * The sidebar's width as set by dragging its border, or null while it follows the window size.
 * During a drag the width is written straight to the element, so the file table does not re-render
 * on every pointer move; the state and the saved preference are updated once, on release.
 */
function useSidebarResize() {
  const workspace = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => readPref<number | null>(SIDEBAR_WIDTH_KEY, null));

  const save = (next: number | null) => {
    setWidth(next);
    writePref(SIDEBAR_WIDTH_KEY, next);
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    const el = workspace.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const left = el.getBoundingClientRect().left;
    let latest = width;
    const onMove = (move: PointerEvent) => {
      latest = Math.round(Math.min(Math.max(move.clientX - left, SIDEBAR_MIN), SIDEBAR_MAX));
      el.style.setProperty("--sidebar-w", `${latest}px`);
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

  const style = width === null ? undefined : ({ "--sidebar-w": `${width}px` } as CSSProperties);
  return { workspace, style, onPointerDown, reset: () => save(null) };
}

export function Explorer() {
  const active = useApp((s) => s.activePane);
  const split = useApp((s) => s.split);
  const shown = useApp((s) => s.split && !s.narrow);
  const bucket = usePanes((s) => s[active].bucket);
  // Details describe an item inside a bucket, so the panel stays closed until one is open.
  const detailsOpen = useApp((s) => s.detailsOpen) && bucket !== null;
  const dropTarget = useFileDrop();
  const sidebar = useSidebarResize();
  const main = useNarrowWatch();
  useKeyDispatcher();
  // Two panes side by side, or only the active one.
  const panes = shown ? PANE_IDS : [active];

  useEffect(() => installTransferEffects(), []);
  useEffect(() => installJobEffects(), []);
  useEffect(() => installBatchEffects(), []);
  useEffect(() => installTagEffects(), []);
  useEffect(() => installArchiveEffects(), []);

  return (
    <div className="app">
      <header className="titlebar">
        <button type="button" className="brand brand-link" onClick={requestDisconnect} title="Back to connections">
          <Logo size={26} />
          <span>S3 Explorer</span>
        </button>
        <div className="spacer" />
        <ConnectionChip />
        <ThemeToggle />
        <SettingsButton />
      </header>
      <div ref={sidebar.workspace} className={`workspace ${detailsOpen ? "with-details" : ""}`} style={sidebar.style}>
        <Sidebar />
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the sidebar"
          title="Drag to resize. Double-click to reset."
          onPointerDown={sidebar.onPointerDown}
          onDoubleClick={sidebar.reset}
        />
        <main className="browser" ref={main}>
          {/* The toolbar acts on the active pane; in split view it stays (the Split button lives there). */}
          {(bucket || split) && <Toolbar />}
          <BookmarksBar />
          <div className={`panes ${shown ? "split" : ""}`}>
            {panes.map((id, i) => (
              <Fragment key={id}>
                {i > 0 && <div className="pane-divider" aria-hidden="true" />}
                <Pane id={id} dropping={dropTarget === id} />
              </Fragment>
            ))}
          </div>
        </main>
        {detailsOpen && <DetailsPanel />}
      </div>
      <ActivityPanel />
      <ContextMenu />
      <Modals />
      <ShortcutsDialog />
      <DragBadge />
    </div>
  );
}
