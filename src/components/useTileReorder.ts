import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** The pointer must move this far (px) before a press becomes a drag, so ordinary clicks still work. */
const DRAG_THRESHOLD = 6;
/** How the other tiles slide to their new places, and the dropped tile settles: quick start, soft landing. */
const SLIDE = { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
/** The dragged tile is drawn slightly larger, as if lifted off the page. */
const LIFT_SCALE = 1.04;

const tileElement = (id: string) => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
const allTiles = () => [...document.querySelectorAll<HTMLElement>("[data-id]")];

/** The drag in progress: which tile, where it was grabbed (px inside the tile) and where the pointer is. */
interface Drag {
  id: string;
  grabX: number;
  grabY: number;
  x: number;
  y: number;
}

/**
 * Drag-to-reorder for tiles that carry a `data-id` attribute. The dragged tile follows the pointer,
 * and the order changes as it passes over other tiles, which slide to their new places. Built on
 * pointer events: the window's OS file-drop handling (used for uploads) swallows HTML5
 * drag-and-drop inside the Tauri webview.
 */
export function useTileReorder(ids: string[], onReorder: (ids: string[]) => void) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // The listeners below outlive the render that created them, so they read the latest order from a ref.
  const latestIds = useRef(ids);
  latestIds.current = ids;
  const drag = useRef<Drag | null>(null);
  const didDrag = useRef(false);
  /** Each tile's place in the layout after the last render, to tell which ones moved. */
  const places = useRef(new Map<string, { left: number; top: number }>());

  /**
   * Keep the dragged tile under the pointer: shift it from its slot in the grid to where the pointer
   * is. It stays inside the list, which scrolls: a tile pushed past the edge would be clipped and
   * would make the list scroll. Returns the middle of the tile where it now is.
   */
  const followPointer = () => {
    const d = drag.current;
    const el = d && tileElement(d.id);
    const list = el?.parentElement?.getBoundingClientRect();
    if (!d || !el || !list) return null;
    el.style.transform = "";
    const slot = el.getBoundingClientRect();
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
    const left = clamp(d.x - d.grabX, list.left, list.right - slot.width);
    const top = clamp(d.y - d.grabY, list.top, list.bottom - slot.height);
    el.style.transform = `translate(${left - slot.left}px, ${top - slot.top}px) scale(${LIFT_SCALE})`;
    return { x: left + slot.width / 2, y: top + slot.height / 2 };
  };

  // After the order changes: slide every tile that moved from its old place to its new one, and
  // keep the dragged tile under the pointer although its slot just changed.
  const order = ids.join();
  useLayoutEffect(() => {
    for (const el of allTiles()) {
      const id = el.dataset.id!;
      const before = places.current.get(id);
      const now = { left: el.offsetLeft, top: el.offsetTop };
      places.current.set(id, now);
      if (!before || id === drag.current?.id) continue;
      const [dx, dy] = [before.left - now.left, before.top - now.top];
      if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], SLIDE);
    }
    followPointer();
  }, [order]);

  const onPointerDown = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    didDrag.current = false;
    const start = { x: e.clientX, y: e.clientY };
    const tile = e.currentTarget.getBoundingClientRect();

    const onMove = (move: PointerEvent) => {
      if (!drag.current) {
        if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_THRESHOLD) return;
        didDrag.current = true;
        drag.current = { id, grabX: start.x - tile.left, grabY: start.y - tile.top, x: move.clientX, y: move.clientY };
        setDraggingId(id);
      }
      drag.current.x = move.clientX;
      drag.current.y = move.clientY;
      const middle = followPointer();
      if (!middle) return;

      // Tiles trade places as soon as the middle of the dragged tile is over another one, which
      // happens well before the pointer itself gets there. The dragged tile ignores hit-testing
      // (see .dragging), so this finds the tile underneath it.
      const overTile = document.elementFromPoint(middle.x, middle.y)?.closest<HTMLElement>("[data-id]");
      const over = overTile?.dataset.id;
      const current = latestIds.current;
      if (!overTile || !over || over === id || !current.includes(over)) return;
      // A tile that is still sliding away is only passing underneath; swapping with it again would
      // make the two flip back and forth.
      if (overTile.getAnimations().length > 0) return;
      // Take the dragged tile out and put it where the tile underneath was.
      const next = current.filter((other) => other !== id);
      next.splice(current.indexOf(over), 0, id);
      onReorder(next);
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      // Let the tile glide from where it was dropped into its slot.
      const el = drag.current && tileElement(drag.current.id);
      if (el) {
        el.animate([{ transform: el.style.transform }, { transform: "none" }], SLIDE);
        el.style.transform = "";
      }
      drag.current = null;
      setDraggingId(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  /** Put on the list in the capture phase: releasing a drag must not also click the tile. */
  const onClickCapture = (e: ReactMouseEvent) => {
    if (!didDrag.current) return;
    didDrag.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { draggingId, onPointerDown, onClickCapture };
}
