// Dialogs for buckets added by name ("Shared with me"; see "Shared buckets" in docs/CONTRACT.md).

import { useId, useState, type FormEvent } from "react";
import { AlertCircle, ArchiveRestore, ArchiveX, Loader2 } from "lucide-react";
import type { AppError } from "../lib/types";
import { parseBucketInput } from "../lib/buckets";
import { addSharedBucket, navigate, openModal, removeSharedBucket, useApp } from "../store/app";
import { toast } from "../store/toasts";
import { ModalShell } from "./Modals";

const KIND_TEXT = { name: "Bucket name", uri: "From the s3:// address", arn: "From the bucket ARN", accessPoint: "Access point ARN, used as is" } as const;

function addErrorTitle(e: AppError, name: string | null): string {
  switch (e.code) {
    case "NoSuchBucket":
      return name ? `There is no bucket named “${name}”.` : "That bucket doesn’t exist.";
    case "AccessDenied":
      return "The bucket exists, but these credentials can’t list it.";
    case "InvalidInput":
      return "That isn’t a bucket name, an s3:// address or a bucket ARN.";
    default:
      return "Couldn’t add the bucket.";
  }
}

export function AddBucketModal() {
  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const titleId = useId();
  const close = () => openModal(null);
  const parsed = parseBucketInput(input);
  const shownName = parsed.ok ? parsed.name : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!parsed.ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const added = await addSharedBucket(input);
      const { buckets, connection } = useApp.getState();
      const listed = buckets.some((b) => b.name === added.name);
      toast.success(
        "Bucket added",
        listed
          ? `${added.name} is already in your bucket list, so it is shown there.`
          : connection?.canListBuckets === false
            ? `${added.name} is now in your bucket list.`
            : `${added.name} is now under “Shared with me”.`,
      );
      close();
      navigate(added.name, "");
    } catch (err) {
      setError(err as AppError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId}>
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal-head">
          <div className="modal-icon">
            <ArchiveRestore size={18} />
          </div>
          <div>
            <h2 id={titleId}>Add a bucket</h2>
            <p className="muted small">
              Buckets shared with you from another account don’t appear in the bucket list. Add one by name; it is
              remembered for this connection.
            </p>
          </div>
        </div>
        <label className="field">
          <span className="field-label">Bucket name, s3:// address or ARN</span>
          <input
            data-autofocus
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            onBlur={() => input && setTouched(true)}
            placeholder="partner-bucket  ·  s3://partner-bucket/path  ·  arn:aws:s3:::partner-bucket"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={(touched && !parsed.ok) || !!error}
            disabled={busy}
          />
        </label>
        {parsed.ok ? (
          <div className="parsed-bucket" aria-live="polite">
            <span className="parsed-label">{KIND_TEXT[parsed.kind]}</span>
            <span className="mono key-text">{parsed.name}</span>
          </div>
        ) : (
          <p className={`hint ${touched && input.trim() ? "err-text" : ""}`}>
            {touched && input.trim() ? parsed.error : "Paths after the bucket name are ignored."}
          </p>
        )}
        {error && (
          <div className="inline-error" role="alert">
            <AlertCircle size={14} />
            <div className="grow">
              <div>
                <strong>{addErrorTitle(error, shownName)}</strong> Nothing was added.
              </div>
              <div>{error.message}</div>
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !parsed.ok}>
            {busy && <Loader2 size={14} className="spin" />} {busy ? "Checking…" : "Add bucket"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

export function RemoveBucketModal({ name }: { name: string }) {
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const close = () => openModal(null);
  const confirm = async () => {
    setBusy(true);
    try {
      await removeSharedBucket(name);
      toast.success("Removed from the list", `${name}. Nothing in S3 was changed.`);
      close();
    } catch (e) {
      toast.error("Couldn’t remove the bucket from the list", e as AppError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId}>
      <div className="modal-head">
        <div className="modal-icon">
          <ArchiveX size={18} />
        </div>
        <div>
          <h2 id={titleId}>Remove from the list?</h2>
          <p className="muted small mono">{name}</p>
        </div>
      </div>
      <p className="modal-text">
        This only makes S3 Explorer forget this bucket for this connection. <strong>Nothing in S3 changes</strong>: the
        bucket and its files stay exactly as they are, and you can add it again at any time.
      </p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} disabled={busy} data-autofocus>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={busy}>
          {busy && <Loader2 size={14} className="spin" />} Remove from list
        </button>
      </div>
    </ModalShell>
  );
}
