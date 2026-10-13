// The bookmarks bar (see "Bookmarks" in docs/CONTRACT.md): a slim row under the toolbar, like a
// browser's, shown only when there is at least one bookmark. Chips that do not fit go into the "»"
// menu at the right end, in order; the split is measured from the chips' real widths on every resize.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Archive, Bookmark as BookmarkIcon, BookmarkX, ChevronsRight, Columns2, FolderOpen, PencilLine } from "lucide-react";
import type { Bookmark } from "../lib/types";
import { activePane, isSplitShown, navigate, setActivePane, useApp } from "../store/app";
import { otherPane, usePanes, type PaneId } from "../store/panes";
import { focusPaneListSoon } from "../store/keyboard";
import { bookmarkId, removeBookmark, renameBookmark, reorderBookmarks, useBookmarks } from "../store/bookmarks";
import { s3Uri } from "../lib/format";
import { FileIcon } from "./FileIcon";
import { PopupMenu } from "./PopupMenu";
import { useTileReorder } from "./useTileReorder";

/** Room kept for the "»" button (its width plus the gap) once anything overflows. */
const CHEVRON_ROOM = 32;
/** Gap between chips (matches .bm-chips). */
const GAP = 2;

/** Open a bookmark in a pane (default: the active one) and give its file list the keyboard. */
function openBookmark(b: Bookmark, pane: PaneId = activePane()) {
  navigate(b.bucket, b.prefix, pane);
  setActivePane(pane);
  focusPaneListSoon(pane);
}

/** Middle-click or Ctrl/Cmd+click opens in the other pane while two panes are shown. */
function openFromClick(b: Bookmark, e: { button: number; ctrlKey: boolean; metaKey: boolean }) {
  const toOther = e.button === 1 || e.ctrlKey || e.metaKey;
  openBookmark(b, toOther && isSplitShown() ? otherPane(activePane()) : activePane());
}

/** How many chips fit in `avail` px, given their widths; the "»" button needs room once some don't. */
function fitCount(widths: number[], avail: number): number {
  const fits = (room: number) => {
    let used = 0;
    let n = 0;
    for (const w of widths) {
      const next = used + (n ? GAP : 0) + w;
      if (next > room) break;
      used = next;
      n++;
    }
    return n;
  };
  const all = fits(avail);
  return all === widths.length ? all : fits(avail - CHEVRON_ROOM);
}

/** What the bookmark points to: the sidebar's bucket icon for a bucket root, the file table's folder icon otherwise. */
function TargetIcon({ b, size = 13 }: { b: Bookmark; size?: number }) {
  return b.prefix === "" ? <Archive size={size} className="bm-icon" /> : <FileIcon name="" folder size={size} />;
}

function RenameInput({ b, onDone }: { b: Bookmark; onDone(): void }) {
  const [text, setText] = useState(b.label);
  const finish = (keep: boolean) => {
    if (keep && text !== b.label) renameBookmark(bookmarkId(b), text);
    onDone();
  };
  return (
    <input
      className="bm-rename"
      value={text}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        // The key must not also activate whatever takes focus once the field is gone.
        if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      aria-label={`Rename bookmark ${b.label}`}
      spellCheck={false}
      maxLength={200}
    />
  );
}

export function BookmarksBar() {
  const items = useBookmarks((s) => s.items);
  const active = useApp((s) => s.activePane);
  // The chip of the active pane's folder is marked.
  const here = usePanes((s) => (s[active].bucket ? bookmarkId({ bucket: s[active].bucket!, prefix: s[active].prefix }) : null));
  const twoPanes = useApp((s) => isSplitShown(s));
  const chipsRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const [fit, setFit] = useState(items.length);
  const [menu, setMenu] = useState<{ b: Bookmark; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const shown = items.slice(0, fit);
  const hidden = items.slice(fit);
  const reorder = useTileReorder(shown.map(bookmarkId), (ids) => reorderBookmarks([...ids, ...hidden.map(bookmarkId)]));

  // Measure the chips as they would be drawn (an invisible copy of all of them) against the room the
  // bar has, now and whenever either changes size (window resize, sidebar drag, fonts loading).
  const labels = items.map((b) => b.label).join("\n");
  useLayoutEffect(() => {
    const bar = chipsRef.current;
    const measure = measureRef.current;
    if (!bar || !measure) return;
    const compute = () => {
      const widths = [...measure.children].map((c) => (c as HTMLElement).getBoundingClientRect().width);
      setFit(fitCount(widths, bar.clientWidth));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(bar);
    ro.observe(measure);
    return () => ro.disconnect();
  }, [labels, items.length]);

  // A chip being renamed that no longer fits opens the overflow menu, where it is edited.
  useEffect(() => {
    if (renaming && hidden.some((b) => bookmarkId(b) === renaming)) setOverflowOpen(true);
  }, [renaming, hidden]);

  if (!items.length) return null;

  const openMenuFor = (b: Bookmark, e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ b, x: r.left + 12, y: r.bottom + 2 });
  };
  const onChipKey = (b: Bookmark, e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      openMenuFor(b, e as unknown as ReactMouseEvent<HTMLElement>);
    } else if (e.key === "F2") {
      e.preventDefault();
      setRenaming(bookmarkId(b));
    }
  };

  const chip = (b: Bookmark) => {
    const id = bookmarkId(b);
    const uri = s3Uri(b.bucket, b.prefix);
    if (renaming === id) {
      return (
        <div key={id} data-id={id} className="bm-chip editing">
          <TargetIcon b={b} />
          <RenameInput b={b} onDone={() => setRenaming(null)} />
        </div>
      );
    }
    return (
      <button
        key={id}
        type="button"
        data-id={id}
        className={`bm-chip ${here === id ? "current" : ""} ${reorder.draggingId === id ? "dragging" : ""}`}
        title={uri}
        onPointerDown={(e) => reorder.onPointerDown(e, id)}
        // Middle-click must not start the browser's autoscroll.
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onClick={(e) => openFromClick(b, e)}
        onAuxClick={(e) => e.button === 1 && openFromClick(b, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ b, x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => onChipKey(b, e)}
      >
        <TargetIcon b={b} />
        <span className="bm-label">{b.label}</span>
      </button>
    );
  };

  return (
    <div className="bookmarks-bar" role="toolbar" aria-label="Bookmarks">
      <span className="bm-bar-label" title="Bookmarks" aria-hidden="true">
        <BookmarkIcon size={13} />
      </span>
      <div ref={chipsRef} className="bm-chips" onClickCapture={reorder.onClickCapture}>
        {shown.map(chip)}
        <div ref={measureRef} className="bm-measure" aria-hidden="true">
          {items.map((b) => (
            <span key={bookmarkId(b)} className="bm-chip">
              <TargetIcon b={b} />
              <span className="bm-label">{b.label}</span>
            </span>
          ))}
        </div>
      </div>
      {hidden.length > 0 && (
        <button
          ref={chevronRef}
          type="button"
          className={`icon-btn bm-more ${overflowOpen ? "active" : ""}`}
          title={`${hidden.length} more bookmark${hidden.length === 1 ? "" : "s"}`}
          aria-label={`${hidden.length} more bookmarks`}
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          onClick={() => setOverflowOpen(!overflowOpen)}
        >
          <ChevronsRight size={14} />
        </button>
      )}
      {overflowOpen && hidden.length > 0 && (
        <OverflowMenu
          anchor={chevronRef.current}
          items={hidden}
          here={here}
          renaming={renaming}
          onRenameDone={() => setRenaming(null)}
          onClose={(refocus) => {
            setOverflowOpen(false);
            if (refocus) chevronRef.current?.focus();
          }}
          onMenu={(b, x, y) => {
            setOverflowOpen(false);
            setMenu({ b, x, y });
          }}
        />
      )}
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for bookmark ${menu.b.label}`}
          onClose={() => setMenu(null)}
          groups={[
            [
              { label: "Open", icon: <FolderOpen size={14} />, action: () => openBookmark(menu.b) },
              ...(twoPanes
                ? [{ label: "Open in other pane", icon: <Columns2 size={14} />, action: () => openBookmark(menu.b, otherPane(activePane())) }]
                : []),
            ],
            [
              { label: "Rename bookmark", icon: <PencilLine size={14} />, action: () => setRenaming(bookmarkId(menu.b)) },
              { label: "Remove bookmark", icon: <BookmarkX size={14} />, action: () => removeBookmark(bookmarkId(menu.b)) },
            ],
          ]}
        />
      )}
    </div>
  );
}

/** The bookmarks that do not fit, in order, under the "»" button. Styled like the context menus. */
function OverflowMenu({
  anchor,
  items,
  here,
  renaming,
  onRenameDone,
  onClose,
  onMenu,
}: {
  anchor: HTMLElement | null;
  items: Bookmark[];
  here: string | null;
  renaming: string | null;
  onRenameDone(): void;
  onClose(refocus: boolean): void;
  onMenu(b: Bookmark, x: number, y: number): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const r = anchor?.getBoundingClientRect();

  useEffect(() => {
    if (!renaming) ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) closeRef.current(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // While a bookmark is renamed in the menu, Escape belongs to its field: it cancels the rename.
        if (renaming) return;
        e.preventDefault();
        e.stopPropagation();
        closeRef.current(true);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        if (!btns.length || !ref.current?.contains(document.activeElement)) return;
        e.preventDefault();
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          e.key === "Home" ? 0
          : e.key === "End" ? btns.length - 1
          : e.key === "ArrowDown" ? (i + 1) % btns.length
          : (i - 1 + btns.length) % btns.length;
        btns[next]?.focus();
      }
    };
    const close = () => closeRef.current(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [anchor, renaming]);

  return (
    <div
      ref={ref}
      className="context-menu bm-overflow"
      role="menu"
      aria-label="More bookmarks"
      style={{ top: (r?.bottom ?? 0) + 4, right: Math.max(6, window.innerWidth - (r?.right ?? 0)) }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((b) => {
        const id = bookmarkId(b);
        if (renaming === id) {
          return (
            <div key={id} className="menu-item bm-overflow-edit">
              <TargetIcon b={b} size={14} />
              <RenameInput b={b} onDone={onRenameDone} />
            </div>
          );
        }
        return (
          <button
            key={id}
            type="button"
            role="menuitem"
            className={`menu-item ${here === id ? "bm-current" : ""}`}
            title={s3Uri(b.bucket, b.prefix)}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onClick={(e) => {
              onClose(false);
              openFromClick(b, e);
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              onClose(false);
              openFromClick(b, e);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu(b, e.clientX, e.clientY);
            }}
            onKeyDown={(e) => {
              if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                onMenu(b, box.left + 12, box.bottom + 2);
              }
            }}
          >
            <TargetIcon b={b} size={14} />
            <span className="menu-label">{b.label}</span>
          </button>
        );
      })}
    </div>
  );
}
