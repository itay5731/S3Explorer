// Confirmations for actions on one version of an object: restore it as the current version,
// delete it permanently, or remove a delete marker (undelete). What is shown is what is sent.

import { useId, useState } from "react";
import { AlertCircle, AlertTriangle, History, Loader2, Trash2, Undo2 } from "lucide-react";
import * as api from "../lib/api";
import type { AppError, ObjectVersion } from "../lib/types";
import { openModal, refreshInPlace } from "../store/app";
import { isDenied, permissionText, toast } from "../store/toasts";
import { bumpObject, shortVersionId } from "../store/versions";
import { formatBytes, formatExact } from "../lib/format";
import { ModalShell } from "./Modals";

export function VersionActionModal({
  action,
  bucket,
  objectKey,
  version,
  onlyVersion,
  previousIsMarker,
}: {
  action: "restore" | "delete" | "undelete";
  bucket: string;
  objectKey: string;
  version: ObjectVersion;
  onlyVersion: boolean;
  previousIsMarker: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const titleId = useId();
  const close = () => openModal(null);
  const date = formatExact(version.lastModified) || "unknown date";
  const short = shortVersionId(version.versionId);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Exactly the bucket, key and version id shown in this dialog.
      if (action === "restore") {
        await api.restoreObjectVersion(bucket, objectKey, version.versionId);
        toast.success("Version restored", `${objectKey}\nThe version from ${date} is now the current version. The one it replaced is kept as a previous version.`);
      } else {
        await api.deleteObjectVersion(bucket, objectKey, version.versionId);
        if (action === "undelete") {
          toast.success("Delete marker removed", version.isLatest ? `${objectKey} is back.` : objectKey);
        } else {
          toast.success("Version permanently deleted", `${objectKey}\nVersion ${version.versionId} (${date})`);
        }
      }
      bumpObject(bucket, objectKey);
      void refreshInPlace();
      close();
    } catch (e) {
      setError(e as AppError);
      setBusy(false);
    }
  };

  const Icon = action === "restore" ? History : action === "undelete" ? Undo2 : Trash2;
  const title =
    action === "restore" ? "Restore this version?" : action === "undelete" ? "Remove this delete marker?" : "Permanently delete this version?";
  const permission = action === "restore" ? "restore versions" : "delete versions";

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId}>
      <div className="modal-head">
        <div className={`modal-icon ${action === "delete" ? "danger" : ""}`}>
          <Icon size={18} />
        </div>
        <div>
          <h2 id={titleId}>{title}</h2>
          <p className="muted small">
            In bucket <span className="mono">{bucket}</span>.{action === "delete" && " This cannot be undone."}
          </p>
        </div>
      </div>
      <div className="code-box mono">
        <span className="key-text">{objectKey}</span>
      </div>
      <dl className="vfacts">
        <dt>Version ID</dt>
        <dd className="mono">{version.versionId}</dd>
        <dt>{version.isDeleteMarker ? "Deleted" : "Saved"}</dt>
        <dd>
          {date}
          {version.isLatest && <span className="vbadge">current</span>}
        </dd>
        {!version.isDeleteMarker && (
          <>
            <dt>Size</dt>
            <dd>{formatBytes(version.size, 2)}</dd>
          </>
        )}
      </dl>
      {action === "restore" && (
        <p className="modal-text">
          A copy of this version becomes the current version. <strong>The current version becomes a previous version; nothing is deleted.</strong>
        </p>
      )}
      {action === "undelete" && (
        <p className="modal-text">
          {version.isLatest
            ? "The object reappears: the version before this marker becomes the current version again."
            : "This marker is older than the current version, so the object stays as it is now; only the marker is removed from its history."}{" "}
          No data is deleted.
        </p>
      )}
      {action === "delete" && (
        <div className="callout danger" role="note">
          <AlertTriangle size={14} />
          <span>
            <strong>Version {short} is deleted permanently.</strong>{" "}
            {onlyVersion
              ? "It is the only version: the object is gone for good."
              : version.isLatest && previousIsMarker
                ? "It is the current version and the one before it is a delete marker, so the object will appear deleted."
                : version.isLatest
                  ? "It is the current version: the previous version becomes current."
                  : "The other versions are not affected."}
          </span>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          <AlertCircle size={14} />
          <span>{isDenied(error) ? `${permissionText(permission)}.` : error.message} Nothing was changed.</span>
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} disabled={busy} data-autofocus>
          Cancel
        </button>
        <button type="button" className={`btn ${action === "delete" ? "btn-danger" : "btn-primary"}`} onClick={() => void confirm()} disabled={busy}>
          {busy && <Loader2 size={14} className="spin" />}
          {action === "restore" ? "Restore as current" : action === "undelete" ? "Remove delete marker" : "Delete permanently"}
        </button>
      </div>
    </ModalShell>
  );
}
