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
import { buildTransferRequest, confirmOrStart, tooMany, withoutArchived } from "../store/ops";
import { toast } from "../store/toasts";
import { getViewRows, type Row } from "../store/view";

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

/** What is dragged, frozen when the drag starts; a drop sends exactly these items. */
interface Source {
  readonly bucket: string;
  readonly prefix: string;
  readonly items: readonly ClipItem[];
  readonly ids: ReadonlySet<string>;
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

/** Same drop target: the same bucket and the exact same prefix (or both nothing). */
const sameTarget = (a: Hit | null, b: Hit | null) => (a && b ? a.bucket === b.bucket && a.prefix === b.prefix : a === b);

const clipItem = (r: Row): ClipItem =>
  Object.freeze(
    r.kind === "folder" ? { key: r.folder.prefix, isPrefix: true, name: r.folder.name } : { key: r.object.key, isPrefix: false, name: r.object.name },
  );

/**
 * Pointer handlers for the table body. `scrollRef` is the virtualized list's scroll container.
 * Returns handlers to attach and nothing else: the drag lives outside React state.
 */
export function useRowDrag(scrollRef: RefObject<HTMLDivElement | null>) {
  /** A drag (or a cancelled one) just ended: the click that follows the release must not select. */
  const swallowClick = useRef(false);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
    const rowId = rowEl?.dataset.rowId;
    if (!rowEl || rowId === undefined) return;
    // What was pressed, captured now: the row by its id (never by its position, which a refresh, "load
    // more" or a re-sort can shift before the drag starts), the folder, and the selection as it is now.
    const pressed = { rowId, ...pick(useApp.getState()) };
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

    /** The drop target under the pointer (null: none), without changing anything. */
    const hitTest = (): Hit | null => {
      if (!src) return null;
      const el = document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>("[data-drop-prefix]") ?? null;
      if (!el) return null;
      const bucket = el.dataset.dropBucket ?? src.bucket;
      const prefix = el.dataset.dropPrefix ?? "";
      return { el, bucket, prefix, refused: refusal(src, bucket, prefix, copy) };
    };

    /** Hit-test what is under the pointer and update the highlight and the badge. */
    const update = () => {
      if (!src) return;
      const next = hitTest();
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
      const { bucket, prefix } = useApp.getState();
      if (!bucket || bucket !== pressed.bucket || prefix !== pressed.prefix) return false;
      const rows = getViewRows();
      // Resolve the pressed row by its id. Gone (the listing changed under the pointer): no drag.
      const row = rows.find((r) => r.id === pressed.rowId);
      if (!row) {
        toast.info("Drag cancelled", "The list changed before the drag started. Nothing was moved.");
        return false;
      }
      // The selection as it was when pressed, if the pressed row was part of it (only rows still
      // listed and shown: never an item the user can't see), otherwise just that row. Folders first.
      const picked = pressed.selection.has(row.id) ? rows.filter((r) => pressed.selection.has(r.id)) : [row];
      const items = Object.freeze([...picked.filter((r) => r.kind === "folder"), ...picked.filter((r) => r.kind !== "folder")].map(clipItem));
      if (!items.length) return false;
      if (items.length > JOB_MAX_ITEMS) {
        tooMany(items.length, "move");
        return false;
      }
      src = Object.freeze({ bucket, prefix, items, ids: new Set(items.map((i) => i.key)) });
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
          swallowClick.current = true;
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
      /** The target the user saw highlighted last. */
      const shown = hit as Hit | null;
      let target: Hit | null = null;
      if (dragged) {
        copy = copyHeld(ev);
        pointer = { x: ev.clientX, y: ev.clientY };
        target = hitTest();
      }
      finish();
      if (!dragged) return;
      // Commit only onto the target that was highlighted: if the page changed under the pointer in
      // the last frame, the release lands somewhere the user never saw.
      if (!sameTarget(shown, target)) {
        toast.info("Drop cancelled: the target changed", "Nothing was moved or copied. Drag again onto the highlighted target.");
        return;
      }
      if (!target) return;
      if (target.refused) {
        toast.info(copy ? "Nothing was copied" : "Nothing was moved", target.refused);
        return;
      }
      void drop(dragged, target.bucket, target.prefix, copy);
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
      // Nothing else reacts to keys mid-drag: no Delete, Backspace, F2, Ctrl+X/C/V or other shortcut.
      ev.preventDefault();
      ev.stopImmediatePropagation();
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

const pick = (s: ReturnType<typeof useApp.getState>) => ({ bucket: s.bucket, prefix: s.prefix, selection: s.selection });

/** A drop: the same request as paste, then the confirmation setting decides whether to ask. */
async function drop(src: Source, bucket: string, prefix: string, copy: boolean) {
  // Archived objects that aren't restored can't be copied or moved: left out, with a toast.
  const items = await withoutArchived(src.bucket, [...src.items], copy ? "copy" : "move");
  if (!items) return;
  const built = buildTransferRequest({ mode: copy ? "copy" : "cut", bucket: src.bucket, prefix: src.prefix, items }, { bucket, prefix });
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
