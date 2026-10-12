import { memo, useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, ArrowDown, ArrowUp, FolderOpen, Loader2, RefreshCw, Upload } from "lucide-react";
import {
  getPane,
  loadMore,
  navigate,
  openContextMenu,
  refresh,
  setDetailsOpen,
  setSelection,
  setSort,
  usePane,
  usePaneId,
  type SortKey,
} from "../store/app";
import { registerListKeys, type ListKeys } from "../store/keyboard";
import { getViewRows, useViewRows, type Row } from "../store/view";
import { formatBytes, formatExact, formatRelative, formatStorageClass, displayName } from "../lib/format";
import { FileIcon } from "./FileIcon";
import { Welcome } from "./Welcome";
import { pickAndUpload } from "../store/actions";
import { useClipboard } from "../store/clipboard";
import { isDenied, permissionText } from "../store/toasts";
import { useRowDrag, useRowDragView } from "./RowDrag";
import { openFolderInNewTab, takeTabScroll } from "../store/tabs";

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

export function ObjectTable() {
  // The pane this table belongs to: every action below names it explicitly.
  const pane = usePaneId();
  const rows = useViewRows();
  const bucket = usePane((s) => s.bucket);
  const prefix = usePane((s) => s.prefix);
  const selection = usePane((s) => s.selection);
  const focus = usePane((s) => s.focus);
  const sort = usePane((s) => s.sort);
  const filter = usePane((s) => s.filter);
  const loading = usePane((s) => s.listing.loading);
  const loadingMore = usePane((s) => s.listing.loadingMore);
  const truncated = usePane((s) => s.listing.truncated);
  const error = usePane((s) => s.listing.error);
  const hasRows = rows.length > 0;
  // Rows on the clipboard in "cut" mode get a subtle indicator (only for this bucket).
  const cutIds = useClipboard((s) => (s.clip && s.clip.mode === "cut" && s.clip.bucket === bucket ? s.clip.ids : null));

  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRowDrag(scrollRef, pane);
  const dragIds = useRowDragView((s) => s.ids);
  const scrollTo = usePane((s) => s.scrollTo);
  const tab = usePane((s) => s.tab);

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

  // Another tab shown: back to where that tab was scrolled (after the reset above).
  useEffect(() => {
    const top = takeTabScroll(pane, tab);
    if (scrollRef.current) scrollRef.current.scrollTop = top;
  }, [pane, tab]);

  // Bring a revealed row (a newest file opened from the sidebar) into view once it is loaded.
  useEffect(() => {
    if (!scrollTo) return;
    const index = getViewRows(pane).findIndex((r) => r.id === scrollTo.id);
    if (index >= 0) requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: "center" }));
  }, [scrollTo, virtualizer, pane]);

  // Infinite scroll (only without a filter, otherwise we'd page through everything looking for matches).
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1].index : -1;
  useEffect(() => {
    if (!filter && truncated && !loadingMore && !loading && lastIndex >= rows.length - 40) void loadMore(pane);
  }, [lastIndex, rows.length, truncated, loadingMore, loading, filter, pane]);

  const openRow = useCallback(
    (row: Row) => {
      const { bucket } = getPane(pane);
      if (!bucket) return;
      if (row.kind === "folder") navigate(bucket, row.folder.prefix, pane);
      else {
        setSelection(new Set([row.id]), row.id, row.id, pane);
        setDetailsOpen(true);
      }
    },
    [pane],
  );

  const select = useCallback((selection: Set<string>, anchor: string | null, focus: string | null) => setSelection(selection, anchor, focus, pane), [pane]);

  const selectIndex = useCallback(
    (index: number, mode: "single" | "toggle" | "range" | "range-add") => {
      const rows = getViewRows(pane);
      const row = rows[index];
      if (!row) return;
      const { selection, anchor } = getPane(pane);
      if (mode === "toggle") {
        const next = new Set(selection);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        select(next, row.id, row.id);
      } else if (mode === "range" || mode === "range-add") {
        const a = anchor ? rows.findIndex((r) => r.id === anchor) : -1;
        const from = a < 0 ? index : Math.min(a, index);
        const to = a < 0 ? index : Math.max(a, index);
        const next = mode === "range-add" ? new Set(selection) : new Set<string>();
        for (let i = from; i <= to; i++) next.add(rows[i].id);
        select(next, a < 0 ? row.id : anchor, row.id);
      } else {
        select(new Set([row.id]), row.id, row.id);
      }
    },
    [pane, select],
  );

  const rowIndexFromEvent = (e: ReactMouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : -1;
  };

  const onClick = (e: ReactMouseEvent) => {
    const index = rowIndexFromEvent(e);
    if (index < 0) {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) select(new Set(), null, null);
      return;
    }
    const multi = e.ctrlKey || e.metaKey;
    selectIndex(index, e.shiftKey ? (multi ? "range-add" : "range") : multi ? "toggle" : "single");
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    const index = rowIndexFromEvent(e);
    if (index >= 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) openRow(rows[index]);
  };

  // Middle-click on a folder opens it in a new tab, in the background; the press must not start
  // the webview's autoscroll.
  const onMouseDown = (e: ReactMouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };
  const onAuxClick = (e: ReactMouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const row = rows[rowIndexFromEvent(e)];
    if (bucket && row?.kind === "folder") openFolderInNewTab(bucket, row.folder.prefix, pane, false);
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    // The menu key and Shift+F10 also fire a contextmenu event (button -1); the key dispatcher
    // already opened the menu for the focused row (sel.menu), so this one is not a click.
    if (e.button < 0) return;
    const index = rowIndexFromEvent(e);
    if (index >= 0) {
      const row = rows[index];
      if (!getPane(pane).selection.has(row.id)) selectIndex(index, "single");
    } else {
      select(new Set(), null, null);
    }
    openContextMenu({ x: e.clientX, y: e.clientY });
  };

  const moveFocus = (delta: number | "home" | "end", extend: boolean) => {
    const rows = getViewRows(pane);
    if (!rows.length) return;
    const { focus } = getPane(pane);
    const cur = focus ? rows.findIndex((r) => r.id === focus) : -1;
    let next: number;
    if (delta === "home") next = 0;
    else if (delta === "end") next = rows.length - 1;
    else next = cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, cur + delta));
    selectIndex(next, extend ? "range" : "single");
    virtualizer.scrollToIndex(next, { align: "auto" });
  };

  // The keys of this list, run by the key dispatcher (store/keyActions.ts) through the registry.
  const keysRef = useRef<ListKeys | null>(null);
  keysRef.current = {
    move(to, extend) {
      const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_H) - 1);
      const delta = { up: -1, down: 1, pageUp: -page, pageDown: page, first: "home", last: "end" } as const;
      moveFocus(delta[to], extend);
    },
    toggle() {
      const rows = getViewRows(pane);
      const { focus } = getPane(pane);
      const i = focus ? rows.findIndex((r) => r.id === focus) : -1;
      if (i >= 0) selectIndex(i, "toggle");
      else if (rows.length) selectIndex(0, "single");
    },
    toggleNext() {
      const rows = getViewRows(pane);
      if (!rows.length) return;
      const { focus } = getPane(pane);
      const i = focus ? rows.findIndex((r) => r.id === focus) : -1;
      if (i < 0) {
        selectIndex(0, "toggle");
        return;
      }
      selectIndex(i, "toggle");
      const next = Math.min(rows.length - 1, i + 1);
      const s = getPane(pane);
      select(s.selection, s.anchor, rows[next].id);
      virtualizer.scrollToIndex(next, { align: "auto" });
    },
    selectAll() {
      const rows = getViewRows(pane);
      select(new Set(rows.map((r) => r.id)), rows[0]?.id ?? null, getPane(pane).focus);
    },
    clear() {
      select(new Set(), null, null);
    },
    open() {
      const rows = getViewRows(pane);
      const { focus, selection } = getPane(pane);
      const row =
        rows.find((r) => r.id === focus && selection.has(r.id)) ??
        (selection.size === 1 ? rows.find((r) => selection.has(r.id)) : undefined);
      if (row) openRow(row);
    },
    menu() {
      const rows = getViewRows(pane);
      const { focus, selection } = getPane(pane);
      const index = focus ? rows.findIndex((r) => r.id === focus) : -1;
      if (index >= 0 && !selection.has(rows[index].id)) selectIndex(index, "single");
      const el = index >= 0 ? scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`) : null;
      const r = el?.getBoundingClientRect() ?? scrollRef.current?.getBoundingClientRect();
      if (!r) return;
      openContextMenu(el ? { x: r.left + 40, y: r.top + Math.min(r.height, ROW_H) } : { x: r.left + 40, y: r.top + 12 });
    },
  };
  useEffect(
    () =>
      registerListKeys(pane, {
        move: (to, extend) => keysRef.current?.move(to, extend),
        toggle: () => keysRef.current?.toggle(),
        toggleNext: () => keysRef.current?.toggleNext(),
        selectAll: () => keysRef.current?.selectAll(),
        clear: () => keysRef.current?.clear(),
        open: () => keysRef.current?.open(),
        menu: () => keysRef.current?.menu(),
      }),
    [pane],
  );

  if (!bucket) return <Welcome />;

  return (
    <div className="object-table" role="grid" aria-rowcount={rows.length}>
      <div className="thead" role="row">
        {COLUMNS.map((c) => (
          <button key={c.key} className={`th ${c.className} ${sort.key === c.key ? "sorted" : ""}`} onClick={() => setSort(c.key, pane)} role="columnheader">
            <span>{c.label}</span>
            {sort.key === c.key && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
          </button>
        ))}
      </div>
      <div
        className="tbody"
        ref={scrollRef}
        tabIndex={0}
        data-pane-drop={pane}
        onClick={onClick}
        onClickCapture={drag.onClickCapture}
        onPointerDown={drag.onPointerDown}
        onDragStart={(e) => e.preventDefault()}
        onDoubleClick={onDoubleClick}
        onMouseDown={onMouseDown}
        onAuxClick={onAuxClick}
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
            <button className="btn" onClick={() => refresh(pane)}>
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
                  <button className="btn btn-ghost" onClick={() => void loadMore(pane)}>
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
