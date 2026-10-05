import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, FolderPlus, Loader2 } from "lucide-react";
import { openModal, useApp } from "../store/app";
import { createFolder, deleteFolder } from "../store/actions";
import { joinKey, s3Uri, validateFolderName } from "../lib/format";

function ModalShell({ children, onClose, busy }: { children: ReactNode; onClose: () => void; busy?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

function NewFolderModal() {
  const bucket = useApp((s) => s.bucket)!;
  const prefix = useApp((s) => s.prefix);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const error = validateFolderName(name);
  const close = () => openModal(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (error || busy) return;
    setBusy(true);
    const ok = await createFolder(name);
    setBusy(false);
    if (ok) close();
  };

  return (
    <ModalShell onClose={close} busy={busy}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div className="modal-icon">
            <FolderPlus size={18} />
          </div>
          <div>
            <h2>New folder</h2>
            <p className="muted small mono">{s3Uri(bucket, prefix)}</p>
          </div>
        </div>
        <label className="field">
          <span className="field-label">Folder name</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. reports or reports/2026"
            spellCheck={false}
            aria-invalid={touched && !!error}
          />
        </label>
        <p className={`hint ${touched && error ? "err-text" : ""}`}>
          {touched && error ? error : name.trim() ? <>Creates <span className="mono">{joinKey(prefix, name.trim() + "/")}</span></> : "Use “/” to create nested folders."}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || (touched && !!error)}>
            {busy && <Loader2 size={14} className="spin" />} Create
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function DeleteFolderModal({ prefix }: { prefix: string }) {
  const bucket = useApp((s) => s.bucket)!;
  const [busy, setBusy] = useState(false);
  const close = () => openModal(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);

  const confirm = async () => {
    setBusy(true);
    const ok = await deleteFolder(prefix);
    setBusy(false);
    if (ok) close();
  };

  return (
    <ModalShell onClose={close} busy={busy}>
      <div className="modal-head">
        <div className="modal-icon danger">
          <AlertTriangle size={18} />
        </div>
        <div>
          <h2>Delete folder?</h2>
          <p className="muted small">This cannot be undone.</p>
        </div>
      </div>
      <p className="modal-text">
        This will <strong>permanently delete every object</strong> under
      </p>
      <div className="code-box mono">{s3Uri(bucket, prefix)}</div>
      <p className="modal-text muted">including all nested folders and their contents, recursively.</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button ref={confirmRef} type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={busy}>
          {busy && <Loader2 size={14} className="spin" />} {busy ? "Deleting…" : "Delete everything"}
        </button>
      </div>
    </ModalShell>
  );
}

export function Modals() {
  const modal = useApp((s) => s.modal);
  const bucket = useApp((s) => s.bucket);
  if (!modal || !bucket) return null;
  if (modal.kind === "newFolder") return <NewFolderModal />;
  return <DeleteFolderModal prefix={modal.prefix} />;
}
