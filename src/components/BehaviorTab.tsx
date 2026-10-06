import { useId } from "react";
import { ShieldCheck } from "lucide-react";

/** Settings → Behavior: how much the app asks before it changes data. */
export function BehaviorTab({
  confirmCopyMove,
  disabled,
  onConfirmCopyMoveChange,
}: {
  confirmCopyMove: boolean;
  disabled: boolean;
  onConfirmCopyMoveChange(v: boolean): void;
}) {
  const id = useId();
  return (
    <div className="set-panel-body">
      <div className="set-field">
        <label className="toggle-row" htmlFor={`${id}-confirm`}>
          <span className="set-field-head">
            <span className="set-label">Ask before copying or moving</span>
            <span className="set-desc">
              Show what will be copied or moved, and where, before it starts. This applies to pasting and to dragging
              items onto a folder or bucket.
            </span>
          </span>
          <input
            id={`${id}-confirm`}
            type="checkbox"
            role="switch"
            className="switch"
            checked={confirmCopyMove}
            disabled={disabled}
            onChange={(e) => onConfirmCopyMoveChange(e.target.checked)}
          />
        </label>
        {!confirmCopyMove && (
          <p className="set-hint">
            Copy and move start right away when nothing is in the way. You can follow them, and cancel them, in the
            Activity panel.
          </p>
        )}
      </div>
      <div className="callout info" role="note">
        <ShieldCheck size={15} />
        <span>
          Even with this off, you are always asked when something at the destination would be overwritten, so you
          can choose to skip or replace it. Deleting always asks for confirmation.
        </span>
      </div>
    </div>
  );
}
