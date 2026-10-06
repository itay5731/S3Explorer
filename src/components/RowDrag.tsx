// Drag rows of the object table onto a folder row, a path-bar segment or a bucket in the sidebar to
// move them there; hold Ctrl (Option on macOS) to copy instead (see "Drag and drop to move or copy" in
// docs/CONTRACT.md). Built on pointer events, like useTileReorder: inside the Tauri webview the OS
// file-drop handling (uploads) swallows HTML5 drag and drop. The two never share a handler: OS file
// drops arrive through api.onFileDrop, row drags only through the listeners below.

import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { create } from "zustand";
import { Ban, CopyPlus, FolderInput } from "lucide-react";
import { JOB_MAX_ITEMS } from "../lib/types";
import { plural } from "../lib/ops";
import { useApp } from "../store/app";
import type { ClipItem } from "../store/clipboard";
import { buildTransferRequest, confirmOrStart, selectedItems, tooMany } from "../store/ops";
import { toast } from "../store/toasts";
import { getViewRows } from "../store/view";

/** The pointer must move this far (px) before a press becomes a drag, so clicks still work. */
const DRAG_THRESHOLD = 6;
/** Distance (px) from the table's top or bottom edge where dragging scrolls it. */
const SCROLL_EDGE = 40;
/** Fastest auto-scroll, in px per frame, reached at the very edge. */
const SCROLL_MAX_STEP = 22;

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
/** The modifier that turns a move into a copy: Ctrl, or Option on macOS. */
export const COPY_KEY_LABEL = IS_MAC ? "Option" : "Ctrl";
const copyHeld = (e: { ctrlKey: boolean; altKey: boolean }) => (IS_MAC ? e.altKey : e.ctrlKey);
const isCopyKey = (key: string) => (IS_MAC ? key === "Alt" : key === "Control");

interface DragView {
  /** Ids (exact keys/prefixes) of the dragged rows; empty when no drag is in progress. */
  ids: ReadonlySet<string>;
  count: number;
  copy: boolean;
  x: number;
  y: number;
  /** Where a drop would go, or why it would be refused. Null over anything that isn't a drop target. */
  target: { label: string; refused: string | null } | null;
}

const NONE: ReadonlySet<string> = new Set();

/** Drag state for the badge and the row styling. Only these subscribe; the table rows don't re-render on moves. */
export const useRowDragView = create<DragView>(() => ({ ids: NONE, count: 0, copy: false, x: 0, y: 0, target: null }));

interface Source {
  bucket: string;
  prefix: string;
  items: ClipItem[];
  ids: Set<string>;
}

interface Hit {
  el: HTMLElement;
  bucket: string;
  prefix: string;
  refused: string | null;
}

/** Why dropping `src` into bucket/prefix is refused (nothing is sent then), or null when it is fine. */
function refusal(src: Source, bucket: string, prefix: string, copy: boolean): string | null {
  if (bucket !== src.bucket) return null;
  const many = src.items.length > 1;
  if (prefix === src.prefix) return `${many ? "They are" : "It is"} already in this folder.`;
  if (src.ids.has(prefix)) return "Can’t drop a folder onto itself.";
  const parent = src.items.find((i) => i.isPrefix && prefix.startsWith(i.key));
  if (parent) return `Can’t ${copy ? "copy" : "move"} a folder into its own subfolder.`;
  return null;
}

const targetLabel = (bucket: string, prefix: string) => `${bucket}/${prefix}`;

/**
 * Pointer handlers for the table body. `scrollRef` is the virtualized list's scroll container.
 * Returns handlers to attach and nothing else: the drag lives outside React state.
 */
export function useRowDrag(scrollRef: RefObject<HTMLDivElement | null>) {
  /** A drag (or a cancelled one) just ended: the click that follows the release must not select. */
  const swallowClick = useRef(false);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (!rowEl) return;
    const index = Number(rowEl.dataset.index);
    const start = { x: e.clientX, y: e.clientY };
    swallowClick.current = false;

    let src: Source | null = null;
    let copy = copyHeld(e);
    let pointer = { x: e.clientX, y: e.clientY };
    let hit: Hit | null = null;
    let frame = 0;

    const mark = (h: Hit | null) => {
      if (hit && hit.el !== h?.el) delete hit.el.dataset.dropTarget;
      hit = h;
      if (h) h.el.dataset.dropTarget = h.refused ? "refused" : copy ? "copy" : "move";
      const body = document.body.classList;
      body.toggle("drag-copy", copy && !h?.refused);
      body.toggle("drag-refused", !!h?.refused);
    };

    /** Hit-test what is under the pointer and update the highlight and the badge. */
    const update = () => {
      if (!src) return;
      const el = document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>("[data-drop-prefix]") ?? null;
      let next: Hit | null = null;
      if (el) {
        const bucket = el.dataset.dropBucket ?? src.bucket;
        const prefix = el.dataset.dropPrefix ?? "";
        next = { el, bucket, prefix, refused: refusal(src, bucket, prefix, copy) };
      }
      mark(next);
      useRowDragView.setState({
        copy,
        x: pointer.x,
        y: pointer.y,
        target: next ? { label: targetLabel(next.bucket, next.prefix), refused: next.refused } : null,
      });
    };

    /** Scroll the table while the pointer is near its top or bottom edge, then hit-test again. */
    const autoScroll = () => {
      frame = 0;
      const box = scrollRef.current?.getBoundingClientRect();
      const el = scrollRef.current;
      if (!src || !box || !el) return;
      let step = 0;
      if (pointer.x >= box.left && pointer.x <= box.right) {
        if (pointer.y < box.top + SCROLL_EDGE && pointer.y >= box.top - SCROLL_EDGE) {
          step = -Math.ceil(((box.top + SCROLL_EDGE - pointer.y) / (2 * SCROLL_EDGE)) * SCROLL_MAX_STEP);
        } else if (pointer.y > box.bottom - SCROLL_EDGE && pointer.y <= box.bottom + SCROLL_EDGE) {
          step = Math.ceil(((pointer.y - (box.bottom - SCROLL_EDGE)) / (2 * SCROLL_EDGE)) * SCROLL_MAX_STEP);
        }
      }
      if (!step) return;
      const before = el.scrollTop;
      el.scrollTop = before + step;
      if (el.scrollTop !== before) update();
      frame = requestAnimationFrame(autoScroll);
    };

    const begin = (): boolean => {
      const rows = getViewRows();
      const row = rows[index];
      const { bucket, prefix, selection } = useApp.getState();
      if (!row || !bucket) return false;
      // The whole selection when the pressed row is part of it, otherwise just that row.
      const items: ClipItem[] = selection.has(row.id)
        ? selectedItems()
        : [row.kind === "folder" ? { key: row.folder.prefix, isPrefix: true, name: row.folder.name } : { key: row.object.key, isPrefix: false, name: row.object.name }];
      if (!items.length) return false;
      if (items.length > JOB_MAX_ITEMS) {
        tooMany(items.length, "move");
        return false;
      }
      src = { bucket, prefix, items, ids: new Set(items.map((i) => i.key)) };
      document.body.classList.add("row-dragging");
      window.getSelection()?.removeAllRanges();
      useRowDragView.setState({ ids: src.ids, count: items.length, copy, x: pointer.x, y: pointer.y, target: null });
      return true;
    };

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onCancel);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      mark(null);
      document.body.classList.remove("row-dragging", "drag-copy", "drag-refused");
      if (src) useRowDragView.setState({ ids: NONE, count: 0, target: null });
    };

    const onMove = (ev: PointerEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!src) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        if (!begin()) {
          finish();
          return;
        }
        swallowClick.current = true;
      }
      copy = copyHeld(ev);
      update();
      if (!frame) frame = requestAnimationFrame(autoScroll);
    };

    const onUp = (ev: PointerEvent) => {
      const dragged = src;
      if (dragged) {
        copy = copyHeld(ev);
        pointer = { x: ev.clientX, y: ev.clientY };
        update();
      }
      const target = hit as Hit | null;
      finish();
      if (!dragged || !target) return;
      if (target.refused) {
        toast.info(copy ? "Nothing was copied" : "Nothing was moved", target.refused);
        return;
      }
      drop(dragged, target.bucket, target.prefix, copy);
    };

    const onCancel = () => finish();

    const onKey = (ev: KeyboardEvent) => {
      if (!src) return;
      if (ev.key === "Escape") {
        // Esc cancels the drag only; it must not also clear the selection or close something.
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.type === "keydown") finish();
        return;
      }
      if (isCopyKey(ev.key)) {
        copy = ev.type === "keydown";
        update();
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onCancel);
  };

  /** Put on the table body in the capture phase: releasing a drag must not also click a row. */
  const onClickCapture = (e: ReactMouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { onPointerDown, onClickCapture };
}

/** A drop: the same request as paste, then the confirmation setting decides whether to ask. */
function drop(src: Source, bucket: string, prefix: string, copy: boolean) {
  const built = buildTransferRequest({ mode: copy ? "copy" : "cut", bucket: src.bucket, prefix: src.prefix, items: src.items }, { bucket, prefix });
  if (!built.ok) {
    if (built.info) toast.info(built.title, built.detail);
    else toast.error(built.title, built.detail);
    return;
  }
  void confirmOrStart({
    request: built.request,
    mode: copy ? "copy" : "cut",
    srcPrefix: src.prefix,
    destPrefix: prefix,
    renamed: false,
    clearCut: false,
  });
}

/** The badge that follows the pointer while rows are dragged: what will happen, and where. */
export function DragBadge() {
  const v = useRowDragView();
  if (!v.count) return null;
  const refused = v.target?.refused ?? null;
  const Icon = refused ? Ban : v.copy ? CopyPlus : FolderInput;
  return (
    <div
      className={`drag-badge ${refused ? "refused" : v.copy ? "copy" : "move"}`}
      style={{ transform: `translate(${v.x + 14}px, ${v.y + 16}px)` }}
      role="status"
      aria-live="polite"
    >
      <span className="drag-badge-icon">
        <Icon size={14} />
      </span>
      <span className="drag-badge-text">
        <span className="drag-badge-title">
          {v.copy ? "Copy" : "Move"} {plural(v.count, "item")}
        </span>
        <span className="drag-badge-sub">
          {refused ?? (v.target ? <>to <span className="mono">{v.target.label}</span></> : v.copy ? `Release ${COPY_KEY_LABEL} to move instead` : `Hold ${COPY_KEY_LABEL} to copy instead`)}
        </span>
      </span>
    </div>
  );
}
