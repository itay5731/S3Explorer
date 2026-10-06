import { useId } from "react";

export function NotificationsTab({
  notifyOnFinish,
  disabled,
  onNotifyOnFinishChange,
}: {
  notifyOnFinish: boolean;
  disabled: boolean;
  onNotifyOnFinishChange(v: boolean): void;
}) {
  const id = useId();
  return (
    <div className="set-panel-body">
      <div className="set-field">
        <label className="toggle-row" htmlFor={`${id}-finish`}>
          <span className="set-field-head">
            <span className="set-label">Notify me when work finishes in the background</span>
            <span className="set-desc">
              A desktop notification when your transfers are done, or a copy, move or delete finishes, while you are
              in another window. Nothing is shown while S3 Explorer is in front.
            </span>
          </span>
          <input
            id={`${id}-finish`}
            type="checkbox"
            role="switch"
            className="switch"
            checked={notifyOnFinish}
            disabled={disabled}
            onChange={(e) => onNotifyOnFinishChange(e.target.checked)}
          />
        </label>
      </div>
    </div>
  );
}
