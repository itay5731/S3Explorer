// A pane's tabs (see "Tabs" in docs/CONTRACT.md): shown only when the pane has two or more. Tabs
// reorder by dragging, move to the other pane when dropped on its tab strip or path bar, and are
// drop targets for dragged rows (see RowDrag.tsx: the data-drop-* attributes).

import { useMemo, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Folder, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { usePanes, usePaneTabs, type PaneId } from "../store/panes";
import { closeTab, moveTabToPane, reorderTabs, showTab } from "../store/tabs";
import { isSplitShown } from "../store/app";
import { displayName, prefixSegments, s3Uri } from "../lib/format";
import { useTileReorder } from "./useTileReorder";

interface TabView {
  id: number;
  bucket: string | null;
  prefix: string;
}

/** The folder name of a location, the bucket name at a bucket root. */
function tabLabel(t: TabView): string {
  if (!t.bucket) return "Empty";
  const segs = prefixSegments(t.prefix);
  return segs.length ? displayName(segs[segs.length - 1].name) : t.bucket;
}

const tileId = (id: number) => `tab-${id}`;

/** The other pane's tab strip or path bar under a point (with where in its strip), while two panes are shown. */
function otherPaneDrop(pane: PaneId, x: number, y: number): { el: HTMLElement; to: PaneId; index?: number } | null {
  if (!isSplitShown()) return null;
  const under = document.elementFromPoint(x, y);
  const to = under?.closest<HTMLElement>("[data-pane]")?.dataset.pane as PaneId | undefined;
  const el = under?.closest<HTMLElement>(".tab-strip, .breadcrumbs") ?? null;
  if (!el || !to || to === pane) return null;
  const tab = under?.closest<HTMLElement>(".tab");
  if (!tab) return { el, to };
  // Before the tab under the pointer, or after it past its middle.
  const r = tab.getBoundingClientRect();
  const index = [...el.querySelectorAll(".tab")].indexOf(tab) + (x > r.left + r.width / 2 ? 1 : 0);
  return { el, to, index };
}

export function TabStrip({ pane }: { pane: PaneId }) {
  const shown = usePanes((s) => s[pane].tab);
  const shownBucket = usePanes((s) => s[pane].bucket);
  const shownPrefix = usePanes((s) => s[pane].prefix);
  // Only what the strip draws, so a hidden tab's listing or selection changing doesn't re-render it.
  const hidden = usePaneTabs(useShallow((s) => s[pane].map((t) => `${t.id}\u0000${t.saved?.bucket ?? ""}\u0000${t.saved?.prefix ?? ""}`)));
  const tabs = useMemo<TabView[]>(
    () =>
      hidden.map((h) => {
        const [id, bucket, prefix] = h.split("\u0000");
        const n = Number(id);
        return n === shown ? { id: n, bucket: shownBucket, prefix: shownPrefix } : { id: n, bucket: bucket || null, prefix };
      }),
    [hidden, shown, shownBucket, shownPrefix],
  );
  const reorder = useTileReorder(
    tabs.map((t) => tileId(t.id)),
    (ids) => reorderTabs(pane, ids.map((x) => Number(x.slice(4)))),
  );

  if (tabs.length < 2) return null;

  // A press on a tab: reorder within the strip (useTileReorder), and watch for a release over the
  // other pane's tab strip or path bar, which moves the tab there.
  const onPointerDown = (e: ReactPointerEvent, id: number) => {
    reorder.onPointerDown(e, tileId(id));
    if (e.button !== 0) return;
    let target: ReturnType<typeof otherPaneDrop> = null;
    const mark = (next: typeof target) => {
      if (target?.el !== next?.el) delete target?.el.dataset.tabDrop;
      target = next;
      if (next) next.el.dataset.tabDrop = "on";
    };
    const onMove = (ev: PointerEvent) => mark(otherPaneDrop(pane, ev.clientX, ev.clientY));
    const onEnd = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      const drop = ev.type === "pointerup" ? otherPaneDrop(pane, ev.clientX, ev.clientY) : null;
      mark(null);
      if (drop) moveTabToPane(pane, id, drop.to, drop.index);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  // Middle-click closes; the press itself must not start the webview's autoscroll.
  const onMouseDown = (e: ReactMouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };
  const onAuxClick = (e: ReactMouseEvent, id: number) => {
    if (e.button !== 1) return;
    e.preventDefault();
    closeTab(pane, id);
  };

  return (
    <div className="tab-strip" role="tablist" aria-label="Tabs" onClickCapture={reorder.onClickCapture}>
      {tabs.map((t) => {
        const active = t.id === shown;
        const path = t.bucket ? s3Uri(t.bucket, t.prefix) : "No bucket open";
        return (
          <div
            key={t.id}
            data-id={tileId(t.id)}
            className={`tab ${active ? "active" : ""} ${reorder.draggingId === tileId(t.id) ? "dragging" : ""}`}
            role="tab"
            aria-selected={active}
            title={path}
            data-tab-pane={pane}
            data-tab-id={t.id}
            {...(t.bucket ? { "data-drop-bucket": t.bucket, "data-drop-prefix": t.prefix } : {})}
            onPointerDown={(e) => onPointerDown(e, t.id)}
            onMouseDown={onMouseDown}
            onAuxClick={(e) => onAuxClick(e, t.id)}
            onClick={() => showTab(pane, t.id)}
          >
            <Folder size={13} className="tab-icon" />
            <span className="tab-label">{tabLabel(t)}</span>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close tab ${tabLabel(t)}`}
              title="Close tab"
              tabIndex={-1}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(pane, t.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
