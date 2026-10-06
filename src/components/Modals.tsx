import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, ArrowRight, ClipboardPaste, FolderPlus, Loader2, LogOut, PencilLine, RotateCw, Trash2 } from "lucide-react";
import * as api from "../lib/api";
import type { AppError, ConflictPolicy, JobPreview, JobRequest } from "../lib/types";
import { BUCKETLESS_MODALS, disconnect, openModal, useApp, type RenameTarget } from "../store/app";
import { isDenied, permissionText } from "../store/toasts";
import { AddBucketModal, RemoveBucketModal } from "./BucketDialogs";
import { createFolder } from "../store/actions";
import { startConfirmedJob } from "../store/ops";
import { joinKey, s3Uri, validateFolderName } from "../lib/format";
import { plural, previewSummary, splitExt, validateNewName } from "../lib/ops";

// The lifecycle editor is large and rarely opened: load it on first use.
const LifecycleDialog = lazy(() => import("./LifecycleDialog").then((m) => ({ default: m.LifecycleDialog })));
// Tag and folder transfer dialogs: also loaded on first use (keeps the start-up bundle small).
const BucketTagsModal = lazy(() => import("./TagDialogs").then((m) => ({ default: m.BucketTagsModal })));
const ObjectTagsModal = lazy(() => import("./TagDialogs").then((m) => ({ default: m.ObjectTagsModal })));
const BulkTagsModal = lazy(() => import("./TagDialogs").then((m) => ({ default: m.BulkTagsModal })));
const UploadFolderModal = lazy(() => import("./BatchDialogs").then((m) => ({ default: m.UploadFolderModal })));
const DownloadFoldersModal = lazy(() => import("./BatchDialogs").then((m) => ({ default: m.DownloadFoldersModal })));

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Dialog frame: Esc / backdrop close (unless busy), focus trapped inside, focus restored to
 * the element that opened it. The first element marked `data-autofocus` gets initial focus.
 */
export function ModalShell({
  children,
  onClose,
  busy,
  labelledBy,
  wide,
}: {
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  labelledBy?: string;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Captured while rendering, before the dialog takes focus (an effect would see the dialog's
  // own button when StrictMode re-runs it).
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    first?.focus();
    return () => {
      // Restore focus to the opener; if it vanished (e.g. a context menu item), fall back to the table.
      // Skip while the dialog is still mounted (StrictMode re-runs effects without unmounting).
      requestAnimationFrame(() => {
        if (el?.isConnected) return;
        if (opener && opener.isConnected && opener !== document.body) opener.focus();
        else document.querySelector<HTMLElement>(".tbody")?.focus();
      });
    };
  }, [opener]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !el.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={ref} className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
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
  const error = validateFolderName(name);
  const close = () => openModal(null);
  const titleId = useId();

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
    <ModalShell onClose={close} busy={busy} labelledBy={titleId}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div className="modal-icon">
            <FolderPlus size={18} />
          </div>
          <div>
            <h2 id={titleId}>New folder</h2>
            <p className="muted small mono">{s3Uri(bucket, prefix)}</p>
          </div>
        </div>
        <label className="field">
          <span className="field-label">Folder name</span>
          <input
            data-autofocus
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

// ---- shared pieces for job confirmations -------------------------------------------------

type PreviewState = { status: "loading" } | { status: "ok"; preview: JobPreview } | { status: "error"; error: AppError };

const PREVIEW_LOADING: PreviewState = { status: "loading" };

/**
 * Run `preview_job` for `request` (null = nothing to preview). `delayMs` debounces typing.
 * The result is tagged with the exact request object (and retry attempt) it was computed for;
 * until the result for the current `request` arrives this returns "loading", never the result
 * of a previous request (state set by an effect lags the render that changed `request`).
 */
export function usePreview(request: JobRequest | null, delayMs = 0): [PreviewState | null, () => void] {
  const [tagged, setTagged] = useState<{ request: JobRequest; attempt: number; state: PreviewState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!request) {
      setTagged(null);
      return;
    }
    let cancelled = false;
    setTagged({ request, attempt, state: PREVIEW_LOADING });
    const t = setTimeout(() => {
      api
        .previewJob(request)
        .then((preview) => !cancelled && setTagged({ request, attempt, state: { status: "ok", preview } }))
        .catch((error: AppError) => !cancelled && setTagged({ request, attempt, state: { status: "error", error } }));
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [request, attempt, delayMs]);
  const state = !request ? null : tagged && tagged.request === request && tagged.attempt === attempt ? tagged.state : PREVIEW_LOADING;
  return [state, () => setAttempt((n) => n + 1)];
}

const PREVIEW_ACTION: Record<string, string> = {
  delete: "delete files",
  copy: "copy files",
  move: "move files",
  tag: "change tags",
};

/** The preview line: spinner while counting, the error (with retry), or "N objects, X GiB". */
export function PreviewLine({ state, retry, verb }: { state: PreviewState | null; retry: () => void; verb: string }) {
  if (!state) return null;
  if (state.status === "loading") {
    return (
      <div className="preview-line muted" role="status">
        <Loader2 size={14} className="spin" /> Counting the objects this will {verb}…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="inline-error" role="alert">
        <AlertCircle size={14} />
        <div className="grow">
          <div>
            <strong>
              {isDenied(state.error) ? `${permissionText(PREVIEW_ACTION[verb] ?? `${verb} files`)}.` : `Couldn’t check what this would ${verb}.`}
            </strong>{" "}
            Nothing has been changed.
          </div>
          <div>{state.error.message}</div>
        </div>
        <button type="button" className="btn btn-sm" onClick={retry}>
          <RotateCw size={12} /> Retry
        </button>
      </div>
    );
  }
  const p = state.preview;
  return (
    <div className="preview-line" role="status">
      <span>
        This will {verb}{" "}
        <strong>{verb === "tag" ? `${p.truncated ? "at least " : ""}${plural(p.objects, "object")}` : previewSummary(p)}</strong>
        {p.truncated ? <span className="muted"> (counting stopped there)</span> : null}.
      </span>
    </div>
  );
}

/** Exact keys/prefixes as they will be sent: monospace, untruncated, selectable. */
export function KeyList({ request, label }: { request: JobRequest; label: string }) {
  const withDest = request.kind === "copy" || request.kind === "move";
  return (
    <div className="key-list-wrap">
      <div className="key-list-head">
        <span>{label}</span>
        <span className="muted">{plural(request.items.length, "item")}</span>
      </div>
      <ol className="key-list mono" aria-label={label}>
        {request.items.map((it, i) => (
          <li key={i} className={withDest ? "with-dest" : ""}>
            <span className="key-kind">{it.isPrefix ? "folder" : "object"}</span>
            <span className="key-text">{it.from}</span>
            {withDest && (
              <>
                <ArrowRight size={12} className="key-arrow" aria-label="to" />
                <span className="key-text">{it.to}</span>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---- delete -------------------------------------------------------------------------------

function DeleteModal({ request }: { request: JobRequest }) {
  const [state, retry] = usePreview(request);
  const [busy, setBusy] = useState(false);
  const close = () => openModal(null);
  const titleId = useId();
  const n = request.items.length;
  const folders = request.items.filter((i) => i.isPrefix).length;
  const single = n === 1 ? request.items[0] : null;
  const preview = state?.status === "ok" ? state.preview : null;
  const nothing = !!preview && preview.objects === 0;
  const canDelete = !!preview && !nothing && !busy;

  const confirm = async () => {
    if (!canDelete) return;
    setBusy(true);
    const id = await startConfirmedJob(request);
    setBusy(false);
    if (id) close();
  };

  const title = single
    ? single.isPrefix
      ? "Delete this folder?"
      : "Delete this object?"
    : `Delete ${plural(n, "item")}?`;

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide={!single}>
      <div className="modal-head">
        <div className="modal-icon danger">
          <Trash2 size={18} />
        </div>
        <div>
          <h2 id={titleId}>{title}</h2>
          <p className="muted small">
            In bucket <span className="mono">{request.srcBucket}</span>. This cannot be undone.
          </p>
        </div>
      </div>
      {single ? (
        <>
          <p className="modal-text">{single.isPrefix ? "Permanently deletes every object under this prefix:" : "Permanently deletes the object with this exact key:"}</p>
          <div className="code-box mono">
            <span className="key-text">{single.from}</span>
          </div>
        </>
      ) : (
        <KeyList request={request} label="These exact keys and prefixes will be deleted" />
      )}
      {folders > 0 && (
        <div className="callout danger">
          <AlertTriangle size={14} />
          <span>
            <strong>Everything inside {folders === 1 ? "this folder" : `these ${folders} folders`} is deleted</strong>, including all
            subfolders and their files.
          </span>
        </div>
      )}
      <PreviewLine state={state} retry={retry} verb="delete" />
      {nothing && <div className="hint err-text">Nothing to delete: these keys no longer exist.</div>}
      <p className="muted small">On a bucket with versioning enabled, S3 adds delete markers and older versions remain.</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} disabled={busy} data-autofocus>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={!canDelete}>
          {(busy || state?.status === "loading") && <Loader2 size={14} className="spin" />}
          {busy ? "Starting…" : preview ? `Delete ${plural(preview.objects, "object")}${preview.truncated ? "+" : ""}` : "Delete"}
        </button>
      </div>
    </ModalShell>
  );
}

// ---- rename -------------------------------------------------------------------------------

function RenameModal({ target }: { target: RenameTarget }) {
  const { bucket, key, isPrefix, name: current, parent } = target;
  const [value, setValue] = useState(current);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const close = () => openModal(null);

  // Names of the same kind already loaded in this folder (the preview is the authority).
  const listing = useApp((s) => s.listing);
  const viewing = useApp((s) => s.bucket === bucket && s.prefix === parent);
  const existing = useMemo(
    () => new Set(viewing ? (isPrefix ? listing.folders.map((f) => f.name) : listing.objects.map((o) => o.name)) : []),
    [viewing, isPrefix, listing],
  );

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the stem for files ("report" of "report.pdf"); everything for folders.
    el.setSelectionRange(0, isPrefix ? current.length : splitExt(current)[0].length);
  }, [current, isPrefix]);

  const name = value.trim(); // only the typed name is normalized
  const error = validateNewName(name, current, existing, isPrefix);
  const newKey = parent + name + (isPrefix ? "/" : "");
  const request = useMemo<JobRequest | null>(
    () =>
      error
        ? null
        : {
            kind: "move",
            srcBucket: bucket,
            destBucket: bucket,
            items: [{ from: key, to: newKey, isPrefix }],
            // If something appears at the new name after the preview, leave it alone.
            onConflict: "skip",
          },
    [error, bucket, key, newKey, isPrefix],
  );
  const [state, retry] = usePreview(request, 300);
  const preview = state?.status === "ok" ? state.preview : null;
  const conflict = !!preview && preview.conflicts > 0;
  const nothing = !!preview && preview.objects === 0;
  const canRename = !!request && !!preview && !conflict && !nothing && !busy;
  const shownError = edited ? error : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setEdited(true);
    if (!canRename || !request) return;
    setBusy(true);
    const id = await startConfirmedJob(request);
    setBusy(false);
    if (id) close();
  };

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div className="modal-icon">
            <PencilLine size={18} />
          </div>
          <div>
            <h2 id={titleId}>Rename {isPrefix ? "folder" : "object"}</h2>
            <p className="muted small mono">{s3Uri(bucket, parent)}</p>
          </div>
        </div>
        <label className="field">
          <span className="field-label">New name</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setEdited(true);
            }}
            spellCheck={false}
            aria-invalid={!!shownError || conflict}
          />
        </label>
        {shownError ? (
          <p className="hint err-text" role="alert">
            {shownError}
          </p>
        ) : conflict ? (
          <p className="hint err-text" role="alert">
            {isPrefix
              ? `${plural(preview!.conflicts, "object")} already exist under the new name. Choose another name.`
              : "An object with this name already exists. Choose another name."}
          </p>
        ) : null}
        <div className="rename-map">
          <div className="rename-row">
            <span className="rename-label">From</span>
            <span className="mono key-text">{key}</span>
          </div>
          <div className="rename-row">
            <span className="rename-label">To</span>
            <span className={`mono key-text ${error ? "dim" : ""}`}>{error ? "—" : newKey}</span>
          </div>
        </div>
        {request && (
          <>
            {isPrefix ? (
              <PreviewLine state={state} retry={retry} verb="move" />
            ) : (
              state?.status === "error" && <PreviewLine state={state} retry={retry} verb="move" />
            )}
            {nothing && <p className="hint err-text">Nothing to rename: the {isPrefix ? "folder is empty or gone" : "object no longer exists"}.</p>}
          </>
        )}
        <p className="muted small">
          S3 has no real rename: {isPrefix ? "every object is copied to the new prefix, then the originals are deleted. Large folders can take a while." : "the object is copied to the new key, then the original is deleted."}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canRename}>
            {(busy || state?.status === "loading") && <Loader2 size={14} className="spin" />} Rename
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ---- conflict choice (paste, folder uploads and downloads) -----------------------------------------

/**
 * "Skip existing" / "Overwrite" when something is already at the destination. Nothing is chosen
 * until the user picks (`policy` null), so Overwrite is never a default.
 */
export function ConflictChoice({
  policy,
  onChange,
  legend,
  skipText,
  overwriteText,
}: {
  policy: ConflictPolicy | null;
  onChange: (p: ConflictPolicy) => void;
  legend: ReactNode;
  skipText: ReactNode;
  overwriteText: ReactNode;
}) {
  // One choice is on screen at a time; the name stays what it was before this was shared.
  const name = "conflict";
  return (
    <fieldset className="conflict-choice">
      <legend>
        <AlertTriangle size={14} /> {legend}
      </legend>
      <label className={`choice ${policy === "skip" ? "active" : ""}`}>
        <input type="radio" name={name} checked={policy === "skip"} onChange={() => onChange("skip")} />
        <span>
          <strong>Skip existing</strong>
          <span className="choice-sub">{skipText}</span>
        </span>
      </label>
      <label className={`choice danger ${policy === "overwrite" ? "active" : ""}`}>
        <input type="radio" name={name} checked={policy === "overwrite"} onChange={() => onChange("overwrite")} />
        <span>
          <strong>Overwrite</strong>
          <span className="choice-sub">{overwriteText}</span>
        </span>
      </label>
    </fieldset>
  );
}

// ---- paste (copy / move) -----------------------------------------------------------------------

function PasteModal({
  request,
  mode,
  srcPrefix,
  destPrefix,
  renamed,
  clearCut,
}: {
  request: JobRequest;
  mode: "copy" | "cut";
  srcPrefix: string;
  destPrefix: string;
  renamed: boolean;
  clearCut: boolean;
}) {
  const [state, retry] = usePreview(request);
  const [policy, setPolicy] = useState<ConflictPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const close = () => openModal(null);
  const move = mode === "cut";
  const verb = move ? "move" : "copy";
  const Verb = move ? "Move" : "Copy";
  const preview = state?.status === "ok" ? state.preview : null;
  const conflicts = preview?.conflicts ?? 0;
  const nothing = !!preview && preview.objects === 0;
  const needChoice = conflicts > 0;
  const canStart = !!preview && !nothing && (!needChoice || policy !== null) && !busy;
  const overwrite = needChoice && policy === "overwrite";
  // Without conflicts "skip" is sent, so anything that appears meanwhile is not overwritten.
  const finalRequest: JobRequest = { ...request, onConflict: needChoice && policy ? policy : "skip" };

  const confirm = async () => {
    if (!canStart) return;
    setBusy(true);
    const id = await startConfirmedJob(finalRequest, { clearCut });
    setBusy(false);
    if (id) close();
  };

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide>
      <div className="modal-head">
        <div className="modal-icon">
          <ClipboardPaste size={18} />
        </div>
        <div>
          <h2 id={titleId}>
            {Verb} {plural(request.items.length, "item")}?
          </h2>
          <p className="muted small">
            {move ? "Each object is copied, then its original is deleted." : "The originals stay where they are."}
          </p>
        </div>
      </div>
      <div className="route">
        <div className="route-end">
          <span className="route-label">From</span>
          <span className="mono key-text">{s3Uri(request.srcBucket, srcPrefix)}</span>
        </div>
        <ArrowRight size={14} className="route-arrow" />
        <div className="route-end">
          <span className="route-label">To</span>
          <span className="mono key-text">{s3Uri(request.destBucket ?? "", destPrefix)}</span>
        </div>
      </div>
      <KeyList request={request} label={`Exact keys and prefixes (source → destination)`} />
      {renamed && (
        <p className="hint">Pasting into the same folder: the copies get “(copy)” names, as listed above.</p>
      )}
      <PreviewLine state={state} retry={retry} verb={verb} />
      {nothing && <div className="hint err-text">Nothing to paste: the copied items no longer exist.</div>}
      {needChoice && (
        <ConflictChoice
          policy={policy}
          onChange={setPolicy}
          legend={
            <>
              {plural(conflicts, "object")} already {conflicts === 1 ? "exists" : "exist"} at the destination. Choose what happens to{" "}
              {conflicts === 1 ? "it" : "them"}:
            </>
          }
          skipText={
            <>
              Objects already at the destination are left untouched.
              {move && " Their sources are not deleted: skipped items stay where they are now."}
            </>
          }
          overwriteText="The existing objects are replaced by the pasted ones. This cannot be undone."
        />
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} disabled={busy} data-autofocus>
          Cancel
        </button>
        <button type="button" className={`btn ${overwrite ? "btn-danger" : "btn-primary"}`} onClick={() => void confirm()} disabled={!canStart}>
          {(busy || state?.status === "loading") && <Loader2 size={14} className="spin" />}
          {busy ? "Starting…" : `${Verb}${preview ? ` ${plural(preview.objects, "object")}${preview.truncated ? "+" : ""}` : ""}${overwrite ? ", overwrite" : ""}`}
        </button>
      </div>
    </ModalShell>
  );
}

// ---- disconnect while work is running ------------------------------------------------------

function DisconnectModal({ running }: { running: number }) {
  const titleId = useId();
  const close = () => openModal(null);
  return (
    <ModalShell onClose={close} labelledBy={titleId}>
      <div className="modal-head">
        <div className="modal-icon danger">
          <LogOut size={18} />
        </div>
        <div>
          <h2 id={titleId}>
            {running === 1 ? "1 operation is" : `${running.toLocaleString()} operations are`} still running. Disconnect anyway?
          </h2>
          <p className="muted small">Transfers and file operations are listed in the Activity panel.</p>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} data-autofocus>
          Stay connected
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            close();
            void disconnect();
          }}
        >
          Disconnect
        </button>
      </div>
    </ModalShell>
  );
}

export function Modals() {
  return (
    <Suspense fallback={null}>
      <ModalSwitch />
    </Suspense>
  );
}

function ModalSwitch() {
  const modal = useApp((s) => s.modal);
  const bucket = useApp((s) => s.bucket);
  if (!modal) return null;
  // Most dialogs act on the open bucket; these don't need one.
  if (!bucket && !BUCKETLESS_MODALS.has(modal.kind)) return null;
  switch (modal.kind) {
    case "addBucket":
      return <AddBucketModal />;
    case "removeBucket":
      return <RemoveBucketModal name={modal.name} />;
    case "bucketTags":
      return <BucketTagsModal key={modal.bucket} bucket={modal.bucket} />;
    case "lifecycle":
      return (
        <Suspense fallback={null}>
          <LifecycleDialog key={modal.bucket} bucket={modal.bucket} />
        </Suspense>
      );
    case "objectTags":
      return <ObjectTagsModal key={`${modal.bucket}/${modal.key}`} bucket={modal.bucket} objectKey={modal.key} />;
    case "bulkTags":
      return <BulkTagsModal bucket={modal.bucket} prefix={modal.prefix} items={modal.items} />;
    case "disconnect":
      return <DisconnectModal running={modal.running} />;
    case "uploadFolder":
      return (
        <Suspense fallback={null}>
          <UploadFolderModal key={modal.localPath} bucket={modal.bucket} prefix={modal.prefix} localPath={modal.localPath} initialPreview={modal.initialPreview} />
        </Suspense>
      );
    case "downloadFolders":
      return (
        <Suspense fallback={null}>
          <DownloadFoldersModal bucket={modal.bucket} folders={modal.folders} dir={modal.dir} />
        </Suspense>
      );
    case "newFolder":
      return <NewFolderModal />;
    case "delete":
      return <DeleteModal request={modal.request} />;
    case "rename":
      return <RenameModal target={modal.target} />;
    case "paste":
      return (
        <PasteModal
          request={modal.request}
          mode={modal.mode}
          srcPrefix={modal.srcPrefix}
          destPrefix={modal.destPrefix}
          renamed={modal.renamed}
          clearCut={modal.clearCut}
        />
      );
  }
}
