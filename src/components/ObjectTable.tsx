import { memo, useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, ArrowDown, ArrowUp, FolderOpen, Loader2, RefreshCw, Upload } from "lucide-react";
import {
  loadMore,
  navigate,
  openContextMenu,
  refresh,
  setDetailsOpen,
  setSelection,
  setSort,
  useApp,
  type SortKey,
} from "../store/app";
import { getViewRows, useViewRows, type Row } from "../store/view";
import { formatBytes, formatExact, formatRelative, formatStorageClass, parentPrefix, displayName } from "../lib/format";
import { FileIcon } from "./FileIcon";
import { Welcome } from "./Welcome";
import { pickAndUpload } from "../store/actions";
import { useClipboard } from "../store/clipboard";
import { copySelection, requestDelete, requestPaste, requestRename } from "../store/ops";
import { isDenied, permissionText } from "../store/toasts";
import { useRowDrag, useRowDragView } from "./RowDrag";

const ROW_H = 28;

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: "name", label: "Name", className: "col-name" },
  { key: "size", label: "Size", className: "col-size" },
  { key: "modified", label: "Last modified", className: "col-modified" },
  { key: "class", label: "Storage class", className: "col-class" },
];

const RowView = memo(function RowView({
  row,
  index,
  start,
  selected,
  focused,
  cut,
  dragged,
  bucket,
}: {
  row: Row;
  index: number;
  start: number;
  selected: boolean;
  focused: boolean;
  cut: boolean;
  dragged: boolean;
  bucket: string;
}) {
  const obj = row.kind === "object" ? row.object : null;
  const sc = obj?.storageClass ?? null;
  // Folder rows are drop targets for dragged rows (see RowDrag.tsx); the prefix is the server's own.
  const drop = row.kind === "folder" ? { "data-drop-bucket": bucket, "data-drop-prefix": row.folder.prefix } : {};
  return (
    <div
      className={`trow ${selected ? "selected" : ""} ${focused ? "focused" : ""} ${index % 2 ? "odd" : ""} ${cut ? "cut" : ""} ${dragged ? "dragged" : ""}`}
      data-index={index}
      data-row-id={row.id}
      role="row"
      aria-selected={selected}
      style={{ transform: `translateY(${start}px)` }}
      {...drop}
    >
      <div className="cell col-name" title={row.kind === "folder" ? row.folder.prefix : row.object.key}>
        <FileIcon name={row.name} folder={row.kind === "folder"} />
        <span className="name-text">{displayName(row.name)}</span>
        {cut && <span className="cut-tag" title="Cut: will be moved when you paste">cut</span>}
      </div>
      <div className="cell col-size">{obj ? formatBytes(obj.size) : <span className="dim">—</span>}</div>
      <div className="cell col-modified" title={obj ? formatExact(obj.lastModified) : undefined}>
        {obj ? formatRelative(obj.lastModified) : <span className="dim">—</span>}
      </div>
      <div className="cell col-class">
        {obj ? (
          <span className={`sc-pill sc-${(sc ?? "none").toLowerCase()}`}>{formatStorageClass(sc)}</span>
        ) : (
          <span className="dim">Folder</span>
        )}
      </div>
    </div>
  );
});

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

export function ObjectTable() {
  const rows = useViewRows();
  const bucket = useApp((s) => s.bucket);
  const prefix = useApp((s) => s.prefix);
  const selection = useApp((s) => s.selection);
  const focus = useApp((s) => s.focus);
  const sort = useApp((s) => s.sort);
  const filter = useApp((s) => s.filter);
  const loading = useApp((s) => s.listing.loading);
  const loadingMore = useApp((s) => s.listing.loadingMore);
  const truncated = useApp((s) => s.listing.truncated);
  const error = useApp((s) => s.listing.error);
  const hasRows = rows.length > 0;
  // Rows on the clipboard in "cut" mode get a subtle indicator (only for this bucket).
  const cutIds = useClipboard((s) => (s.clip && s.clip.mode === "cut" && s.clip.bucket === bucket ? s.clip.ids : null));

  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRowDrag(scrollRef);
  const dragIds = useRowDragView((s) => s.ids);
  const scrollTo = useApp((s) => s.scrollTo);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 16,
  });

  // Reset scroll when the folder or sort order changes.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [bucket, prefix, sort]);

  // Bring a revealed row (a newest file opened from the sidebar) into view once it is loaded.
  useEffect(() => {
    if (!scrollTo) return;
    const index = getViewRows().findIndex((r) => r.id === scrollTo.id);
    if (index >= 0) requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: "center" }));
  }, [scrollTo, virtualizer]);

  // Infinite scroll (only without a filter, otherwise we'd page through everything looking for matches).
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1].index : -1;
  useEffect(() => {
    if (!filter && truncated && !loadingMore && !loading && lastIndex >= rows.length - 40) void loadMore();
  }, [lastIndex, rows.length, truncated, loadingMore, loading, filter]);

  const openRow = useCallback((row: Row) => {
    const { bucket } = useApp.getState();
    if (!bucket) return;
    if (row.kind === "folder") navigate(bucket, row.folder.prefix);
    else {
      setSelection(new Set([row.id]), row.id, row.id);
      setDetailsOpen(true);
    }
  }, []);

  const selectIndex = useCallback((index: number, mode: "single" | "toggle" | "range" | "range-add") => {
    const rows = getViewRows();
    const row = rows[index];
    if (!row) return;
    const { selection, anchor } = useApp.getState();
    if (mode === "toggle") {
      const next = new Set(selection);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      setSelection(next, row.id, row.id);
    } else if (mode === "range" || mode === "range-add") {
      const a = anchor ? rows.findIndex((r) => r.id === anchor) : -1;
      const from = a < 0 ? index : Math.min(a, index);
      const to = a < 0 ? index : Math.max(a, index);
      const next = mode === "range-add" ? new Set(selection) : new Set<string>();
      for (let i = from; i <= to; i++) next.add(rows[i].id);
      setSelection(next, a < 0 ? row.id : anchor, row.id);
    } else {
      setSelection(new Set([row.id]), row.id, row.id);
    }
  }, []);

  const rowIndexFromEvent = (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : -1;
  };

  const onClick = (e: ReactMouseEvent) => {
    const index = rowIndexFromEvent(e);
    if (index < 0) {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) setSelection(new Set(), null, null);
      return;
    }
    const multi = e.ctrlKey || e.metaKey;
    selectIndex(index, e.shiftKey ? (multi ? "range-add" : "range") : multi ? "toggle" : "single");
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    const index = rowIndexFromEvent(e);
    if (index >= 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) openRow(rows[index]);
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    const index = rowIndexFromEvent(e);
    if (index >= 0) {
      const row = rows[index];
      if (!useApp.getState().selection.has(row.id)) selectIndex(index, "single");
    } else {
      setSelection(new Set(), null, null);
    }
    openContextMenu({ x: e.clientX, y: e.clientY });
  };

  const moveFocus = (delta: number | "home" | "end", extend: boolean) => {
    const rows = getViewRows();
    if (!rows.length) return;
    const { focus } = useApp.getState();
    const cur = focus ? rows.findIndex((r) => r.id === focus) : -1;
    let next: number;
    if (delta === "home") next = 0;
    else if (delta === "end") next = rows.length - 1;
    else next = cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, cur + delta));
    selectIndex(next, extend ? "range" : "single");
    virtualizer.scrollToIndex(next, { align: "auto" });
  };

  const handleKey = (e: KeyboardEvent) => {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_H) - 1);
    switch (e.key) {
      case "ArrowDown":
        moveFocus(1, e.shiftKey);
        break;
      case "ArrowUp":
        moveFocus(-1, e.shiftKey);
        break;
      case "PageDown":
        moveFocus(page, e.shiftKey);
        break;
      case "PageUp":
        moveFocus(-page, e.shiftKey);
        break;
      case "Home":
        moveFocus("home", e.shiftKey);
        break;
      case "End":
        moveFocus("end", e.shiftKey);
        break;
      case "Enter": {
        const rows = getViewRows();
        const { focus, selection } = useApp.getState();
        const row =
          rows.find((r) => r.id === focus && selection.has(r.id)) ??
          (selection.size === 1 ? rows.find((r) => selection.has(r.id)) : undefined);
        if (row) openRow(row);
        break;
      }
      case "Backspace": {
        const { bucket, prefix } = useApp.getState();
        if (bucket && prefix) navigate(bucket, parentPrefix(prefix));
        break;
      }
      case "Escape":
        setSelection(new Set(), null, null);
        break;
      case "Delete":
        if (e.ctrlKey || e.metaKey || e.altKey || !useApp.getState().selection.size) return;
        requestDelete();
        break;
      case "F2":
        if (useApp.getState().selection.size !== 1) return;
        requestRename();
        break;
      case "a":
      case "A":
        if (e.ctrlKey || e.metaKey) {
          const rows = getViewRows();
          setSelection(new Set(rows.map((r) => r.id)), rows[0]?.id ?? null, useApp.getState().focus);
          break;
        }
        return;
      case "c":
      case "C":
      case "x":
      case "X":
      case "v":
      case "V": {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
        // Text selected outside the table (e.g. in the details panel): let the browser copy it.
        const inTable = !!scrollRef.current?.contains(e.target as Node);
        const text = window.getSelection();
        if (!inTable && text && !text.isCollapsed && text.toString()) return;
        const k = e.key.toLowerCase();
        if (k === "v") requestPaste();
        else if (!useApp.getState().selection.size) return;
        else copySelection(k === "x" ? "cut" : "copy");
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  // Global shortcuts (when focus isn't in an input and no modal is open).
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const st = useApp.getState();
      if (st.modal || st.contextMenu || !st.bucket) return;
      const target = e.target as HTMLElement;
      const inTable = scrollRef.current?.contains(target);
      if (!inTable && target !== document.body) {
        // Let focused buttons/menus handle their own activation keys and arrows.
        if (target.closest(".context-menu, .popover, .modal")) return;
        if (target.closest(".sidebar, .transfers")) {
          // Backspace (up) and paste (e.g. right after picking another bucket) still work here.
          const paste = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v";
          if (e.key !== "Backspace" && !paste) return;
        } else if (e.key === "Enter" || e.key === " ") return;
      }
      handleKeyRef.current(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!bucket) return <Welcome />;

  return (
    <div className="object-table" role="grid" aria-rowcount={rows.length}>
      <div className="thead" role="row">
        {COLUMNS.map((c) => (
          <button key={c.key} className={`th ${c.className} ${sort.key === c.key ? "sorted" : ""}`} onClick={() => setSort(c.key)} role="columnheader">
            <span>{c.label}</span>
            {sort.key === c.key && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
          </button>
        ))}
      </div>
      <div
        className="tbody"
        ref={scrollRef}
        tabIndex={0}
        onClick={onClick}
        onClickCapture={drag.onClickCapture}
        onPointerDown={drag.onPointerDown}
        onDragStart={(e) => e.preventDefault()}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        {loading && !hasRows ? (
          <div className="skeleton-rows">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="trow skeleton-row" style={{ opacity: 1 - i * 0.07 }}>
                <div className="cell col-name">
                  <span className="sk sk-icon" />
                  <span className="sk" style={{ width: `${40 + ((i * 37) % 45)}%` }} />
                </div>
                <div className="cell col-size"><span className="sk" style={{ width: 48 }} /></div>
                <div className="cell col-modified"><span className="sk" style={{ width: 72 }} /></div>
                <div className="cell col-class"><span className="sk" style={{ width: 56 }} /></div>
              </div>
            ))}
          </div>
        ) : error && !hasRows ? (
          <div className="table-empty">
            <AlertCircle size={32} strokeWidth={1.25} className="err-icon" />
            <div className="empty-title">{isDenied(error) ? `${permissionText("list objects")}` : "Couldn’t list this folder"}</div>
            <div className="muted">{error.message}</div>
            <button className="btn" onClick={() => refresh()}>
              <RefreshCw size={14} /> Try again
            </button>
          </div>
        ) : !hasRows ? (
          <div className="table-empty">
            <FolderOpen size={36} strokeWidth={1.25} />
            <div className="empty-title">{filter ? "No matches" : "This folder is empty"}</div>
            <div className="muted">{filter ? `Nothing loaded matches “${filter}”.` : "Drop files here or use Upload to add some."}</div>
            {!filter && (
              <button className="btn" onClick={() => void pickAndUpload()}>
                <Upload size={14} /> Upload files
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="vlist" style={{ height: virtualizer.getTotalSize() }}>
              {items.map((vi) => {
                const row = rows[vi.index];
                return (
                  <RowView
                    key={row.id}
                    row={row}
                    index={vi.index}
                    start={vi.start}
                    selected={selection.has(row.id)}
                    focused={focus === row.id}
                    cut={!!cutIds && cutIds.has(row.id)}
                    dragged={dragIds.has(row.id)}
                    bucket={bucket}
                  />
                );
              })}
            </div>
            {(truncated || loadingMore) && (
              <div className="load-more">
                {loadingMore ? (
                  <>
                    <Loader2 size={14} className="spin" /> Loading more…
                  </>
                ) : (
                  <button className="btn btn-ghost" onClick={() => void loadMore()}>
                    Load more
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
