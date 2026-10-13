// Quick look: a large preview of the selected object (key action `act.preview`, the context menu).

import { useEffect, useId } from "react";
import { ChevronDown, ChevronUp, Eye, X } from "lucide-react";
import { activePane, openModal } from "../store/app";
import { useSelectionInfo } from "../store/view";
import { currentKeys, listKeys } from "../store/keyboard";
import { chordFromEvent } from "../lib/keys";
import { displayName, formatBytes } from "../lib/format";
import { FileIcon } from "./FileIcon";
import { ModalShell } from "./Modals";
import { PreviewView, Unsupported } from "./Preview";

/**
 * Quick look: a large preview of the selected object. It follows the selection: ArrowUp and
 * ArrowDown move it in the active list while the dialog stays open; Escape (or the Quick look key
 * again) closes.
 */
export function QuickLookModal({ bucket }: { bucket: string }) {
  const sel = useSelectionInfo();
  const obj = sel.object;
  const titleId = useId();
  const close = () => openModal(null);

  useEffect(() => {
    // The key press that opened Quick look is still being dispatched when this listener is added
    // (the module is cached after the first open, so the dialog mounts within that same event):
    // only key presses that start after the dialog opened may close it.
    const openedAt = performance.now();
    const onKey = (e: KeyboardEvent) => {
      if (e.timeStamp < openedAt) return;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        listKeys(activePane())?.move(e.key === "ArrowUp" ? "up" : "down", false);
        return;
      }
      const chord = chordFromEvent(e);
      if (chord && !e.repeat && currentKeys().index.files.get(chord) === "act.preview") {
        e.preventDefault();
        openModal(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const step = (to: "up" | "down") => listKeys(activePane())?.move(to, false);
  const folder = sel.folder;
  const name = obj?.name ?? (folder ? displayName(folder.name) : "");
  return (
    <ModalShell onClose={close} labelledBy={titleId} className="quicklook">
      <div className="ql-head">
        <div className="ql-icon">{obj || folder ? <FileIcon name={name} folder={!!folder} size={18} /> : <Eye size={18} />}</div>
        <div className="ql-title">
          <h2 id={titleId} title={obj?.key ?? folder?.prefix}>
            {obj || folder ? name : "Quick look"}
          </h2>
          {obj && <div className="muted small">{formatBytes(obj.size)}</div>}
        </div>
        <button type="button" className="icon-btn" onClick={() => step("up")} title="Previous (↑)" aria-label="Previous">
          <ChevronUp size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => step("down")} title="Next (↓)" aria-label="Next">
          <ChevronDown size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close" data-autofocus>
          <X size={16} />
        </button>
      </div>
      <div className="ql-body">
        {obj ? (
          <PreviewView key={`${bucket}\n${obj.key}`} bucket={bucket} object={obj} />
        ) : (
          <Unsupported reason={folder ? "Folders have no preview" : "Select one file to preview it"} />
        )}
      </div>
    </ModalShell>
  );
}

