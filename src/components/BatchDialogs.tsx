// Confirmations for folder transfers (batches): upload a local folder, download one or more folders.
// Each shows the exact request it will send (destination prefix / local folder), the backend's
// preview (files, bytes, conflicts, notes) and, when something already exists, the Skip / Overwrite
// choice. A batch always asks first, whatever the "Ask before copying or moving" setting says,
// because it can overwrite many files.

import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, ArrowRight, ChevronRight, FolderDown, FolderUp, Loader2, RotateCw } from "lucide-react";
import * as api from "../lib/api";
import { BATCH_LIMITS, type AppError, type BatchPlanRequest, type BatchPreview, type ConflictPolicy, type FolderEntry } from "../lib/types";
import { formatBytes, s3Uri, sanitizeFileName, uniqueFileName } from "../lib/format";
import { plural } from "../lib/ops";
import { openModal, setTransfersOpen } from "../store/app";
import { startBatch } from "../store/batches";
import { defaultUploadPrefix } from "../store/folders";
import { isDenied, permissionText, toastFailure } from "../store/toasts";
import { ConflictChoice, ModalShell } from "./Modals";

/** `at`: when the preview arrived (ms since epoch), so a destructive Start can insist on a fresh one. */
type PreviewState = { status: "loading" } | { status: "ok"; preview: BatchPreview; at: number } | { status: "error"; error: AppError };
const LOADING: PreviewState = { status: "loading" };

/**
 * `preview_batch` for each request (null = nothing to preview yet). Results are tagged with the
 * exact request array they were computed for, so a stale result is never shown for a new request.
 * `seed` is a preview already made for the first request (an OS drop checks the folder that way).
 */
function useBatchPreviews(
  requests: BatchPlanRequest[] | null,
  delayMs: number,
  seed?: { request: BatchPlanRequest; preview: BatchPreview },
): [PreviewState[] | null, () => void] {
  const [tagged, setTagged] = useState<{ requests: BatchPlanRequest[]; attempt: number; states: PreviewState[] } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [seedUsed, setSeedUsed] = useState(false);
  // The seed was made just before the dialog opened.
  const [seedAt] = useState(() => Date.now());
  const seeded =
    !seedUsed && !!seed && !!requests && requests.length === 1 && attempt === 0 && sameRequest(requests[0], seed.request);
  // The seed answers the first request only: once the request changes, always ask again.
  useEffect(() => {
    if (seed && requests && !(requests.length === 1 && sameRequest(requests[0], seed.request))) setSeedUsed(true);
  }, [requests, seed]);
  useEffect(() => {
    if (!requests || seeded) return;
    let cancelled = false;
    const states: PreviewState[] = requests.map(() => LOADING);
    setTagged({ requests, attempt, states });
    const t = setTimeout(() => {
      requests.forEach((r, i) => {
        api
          .previewBatch(r)
          .then((preview) => ({ status: "ok", preview, at: Date.now() }) as const)
          .catch((error: AppError) => ({ status: "error", error }) as const)
          .then((st) => {
            if (cancelled) return;
            setTagged((cur) => {
              if (!cur || cur.requests !== requests || cur.attempt !== attempt) return cur;
              const next = cur.states.slice();
              next[i] = st;
              return { ...cur, states: next };
            });
          });
      });
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [requests, attempt, delayMs, seeded]);
  if (!requests) return [null, () => {}];
  if (seeded) return [[{ status: "ok", preview: seed!.preview, at: seedAt }], () => {
    setSeedUsed(true);
    setAttempt((n) => n + 1);
  }];
  const states = tagged && tagged.requests === requests && tagged.attempt === attempt ? tagged.states : requests.map(() => LOADING);
  return [states, () => {
    setSeedUsed(true);
    setAttempt((n) => n + 1);
  }];
}

const sameRequest = (a: BatchPlanRequest, b: BatchPlanRequest) =>
  a.kind === b.kind && a.bucket === b.bucket && a.prefix === b.prefix && a.localPath === b.localPath;

/**
 * Start re-plans on the backend, so its numbers can differ from the preview. With Overwrite (the
 * destructive choice) the preview must be at most this old at Start; otherwise it is made again
 * and the user chooses again, so what was shown is what is sent.
 */
const OVERWRITE_PREVIEW_MAX_AGE_MS = 60_000;

const REPLAN_NOTE = "Counts are re-checked when the transfer starts; files added since may be included.";

function StaleNotice() {
  return (
    <div className="callout warn" role="alert">
      <AlertTriangle size={14} />
      <span>
        <strong>The preview was more than a minute old, so it was made again.</strong> Check the numbers and choose again before
        overwriting.
      </span>
    </div>
  );
}

const limitText = `A folder transfer can include at most ${BATCH_LIMITS.maxFiles.toLocaleString()} files and ${formatBytes(BATCH_LIMITS.maxBytes, 0)}.`;

/**
 * How many files Start would transfer: `files` counts every file found (conflicts included), so
 * with "skip" the conflicting ones are left out. Null while a choice is still needed.
 */
function startCount(files: number, conflicts: number, policy: ConflictPolicy | null): number | null {
  if (conflicts === 0) return files;
  if (policy === null) return null;
  return policy === "skip" ? files - conflicts : files;
}

/** "1,204 files, 3.1 GiB", with "at least" when planning stopped at the limit. */
function filesSummary(p: BatchPreview): string {
  const text = `${plural(p.files, "file")}, ${formatBytes(p.bytes)}`;
  return p.truncated ? `at least ${text}` : text;
}

/** The backend's notes (first 50), collapsed behind a disclosure. */
function Notes({ notes, capped, title }: { notes: { head?: string; text: string }[]; capped: boolean; title: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!notes.length) return null;
  return (
    <div className="batch-notes">
      <button type="button" className="batch-notes-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className={open ? "rot90" : ""} />
        {title}
      </button>
      {open && (
        <ul id={id} className="batch-notes-list">
          {notes.map((n, i) => (
            <li key={i}>
              {n.head && <span className="batch-note-head mono">{n.head}</span>}
              <span className="batch-note-text">{n.text}</span>
            </li>
          ))}
          {capped && <li className="muted">Only the first 50 notes{notes.some((n) => n.head) ? " of each folder" : ""} are shown.</li>}
        </ul>
      )}
    </div>
  );
}

function PlanError({ error, retry, upload }: { error: AppError; retry: () => void; upload: boolean }) {
  return (
    <div className="inline-error" role="alert">
      <AlertCircle size={14} />
      <div className="grow">
        <div>
          <strong>
            {isDenied(error)
              ? `${permissionText(upload ? "upload files" : "download files")}.`
              : error.code === "InvalidInput"
                ? `This folder can’t be ${upload ? "uploaded" : "downloaded"} as shown.`
                : upload
                ? "Couldn’t read this folder."
                : "Couldn’t list this folder."}
          </strong>{" "}
          Nothing has been transferred.
        </div>
        <div>{error.message}</div>
      </div>
      <button type="button" className="btn btn-sm" onClick={retry}>
        <RotateCw size={12} /> Retry
      </button>
    </div>
  );
}

function Counting({ children }: { children: ReactNode }) {
  return (
    <div className="preview-line muted" role="status">
      <Loader2 size={14} className="spin" /> {children}
    </div>
  );
}

// ---- upload a folder ----------------------------------------------------------------------------

export function UploadFolderModal({
  bucket,
  prefix,
  localPath,
  initialPreview,
}: {
  bucket: string;
  prefix: string;
  localPath: string;
  initialPreview?: BatchPreview;
}) {
  const initial = defaultUploadPrefix(prefix, localPath);
  const [value, setValue] = useState(initial);
  const [policy, setPolicy] = useState<ConflictPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<AppError | null>(null);
  const [stale, setStale] = useState(false);
  const titleId = useId();
  const inputId = useId();
  const close = () => openModal(null);

  // Only the typed text is normalized, and only by adding the trailing "/" a prefix needs.
  const dest = value === "" || value.endsWith("/") ? value : value + "/";
  const requests = useMemo<BatchPlanRequest[]>(() => [{ kind: "upload", bucket, prefix: dest, localPath, onConflict: "skip" }], [bucket, dest, localPath]);
  const seed = useMemo(
    () => (initialPreview ? { request: { kind: "upload" as const, bucket, prefix: initial, localPath, onConflict: "skip" as const }, preview: initialPreview } : undefined),
    [initialPreview, bucket, initial, localPath],
  );
  const [states, retry] = useBatchPreviews(requests, value === initial ? 0 : 350, seed);
  const state = states?.[0] ?? LOADING;
  const preview = state.status === "ok" ? state.preview : null;
  const conflicts = preview?.conflicts ?? 0;
  const needChoice = conflicts > 0;
  const empty = !!preview && preview.files === 0;
  const tooBig = !!preview && preview.truncated;
  const canStart = !!preview && !empty && !tooBig && (!needChoice || policy !== null) && !busy;
  const overwrite = needChoice && policy === "overwrite";
  const uploadCount = preview ? startCount(preview.files, conflicts, policy) : null;

  // The prefix is the user's to choose; point out the usual slips without changing what they typed.
  const warnings: string[] = [];
  if (dest.startsWith("/")) warnings.push("The prefix starts with “/”: S3 keeps it, so the files go into a folder with an empty name.");
  if (dest.includes("//") && !initial.includes("//")) warnings.push("The prefix contains “//”, an empty folder name.");
  if (dest !== value && value !== "") warnings.push(`A “/” is added at the end: the folder is “${dest}”.`);

  useEffect(() => {
    setPolicy(null); // a different destination has different conflicts: choose again
    setStartError(null);
    setStale(false);
  }, [dest]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    // Exactly the previewed request; "skip" unless the user chose to overwrite.
    const request: BatchPlanRequest = { ...requests[0], onConflict: needChoice && policy ? policy : "skip" };
    if (request.onConflict === "overwrite" && state.status === "ok" && Date.now() - state.at > OVERWRITE_PREVIEW_MAX_AGE_MS) {
      setPolicy(null);
      setStale(true);
      retry();
      return;
    }
    setStale(false);
    setBusy(true);
    setStartError(null);
    try {
      await startBatch(request);
      setTransfersOpen(true);
      close();
    } catch (err) {
      setStartError(err as AppError);
      setBusy(false);
    }
  };

  const notes = (preview?.notes ?? []).map((text) => ({ text }));

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div className="modal-icon">
            <FolderUp size={18} />
          </div>
          <div className="grow">
            <h2 id={titleId}>Upload a folder</h2>
            <p className="muted small">Every file inside, including sub-folders, is uploaded. Empty sub-folders are not created.</p>
          </div>
        </div>
        <div className="route">
          <div className="route-end">
            <span className="route-label">From this computer</span>
            <span className="mono key-text">{localPath}</span>
          </div>
          <ArrowRight size={14} className="route-arrow" />
          <div className="route-end">
            <span className="route-label">To</span>
            <span className="mono key-text">{s3Uri(bucket, dest)}</span>
          </div>
        </div>
        <label className="field batch-prefix-field" htmlFor={inputId}>
          <span className="field-label">Destination folder in {bucket}</span>
          <span className="prefix-input">
            <span className="prefix-input-fixed mono" aria-hidden>
              s3://{bucket}/
            </span>
            <input
              id={inputId}
              data-autofocus
              className="mono"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="(the bucket’s top level)"
            />
          </span>
        </label>
        {warnings.length > 0 && (
          <ul className="hint batch-warnings">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {state.status === "loading" ? (
          <Counting>Reading the folder and checking what already exists…</Counting>
        ) : state.status === "error" ? (
          <PlanError error={state.error} retry={retry} upload />
        ) : (
          <div className="preview-line" role="status">
            <span>
              {state.preview.conflicts > 0 ? "The folder has " : "This will upload "}
              <strong>{filesSummary(state.preview)}</strong>
              {state.preview.truncated && <span className="muted"> (counting stopped there)</span>}.
            </span>
          </div>
        )}
        {state.status !== "error" && <p className="hint">{REPLAN_NOTE}</p>}
        {stale && <StaleNotice />}
        {tooBig && (
          <div className="callout danger">
            <AlertTriangle size={14} />
            <span>
              <strong>This folder is too large for one upload.</strong> {limitText} Choose a sub-folder instead.
            </span>
          </div>
        )}
        {empty && <p className="hint err-text">Nothing to upload: the folder has no files that can be read.</p>}
        {preview && preview.skippedUnreadable > 0 && (
          <div className="callout warn">
            <AlertTriangle size={14} />
            <span>
              <strong>{plural(preview.skippedUnreadable, "file")} can’t be read</strong> and will not be uploaded. They are listed in the notes
              below and reported as failed.
            </span>
          </div>
        )}
        {preview && <Notes notes={notes} capped={notes.length >= 50} title={`Notes (${notes.length >= 50 ? "50+" : notes.length})`} />}
        {needChoice && !tooBig && (
          <ConflictChoice
            policy={policy}
            onChange={setPolicy}
            legend={
              <>
                {plural(conflicts, "file")} already {conflicts === 1 ? "exists" : "exist"} in {s3Uri(bucket, dest)}. Choose what happens to{" "}
                {conflicts === 1 ? "it" : "them"}:
              </>
            }
            skipText="Objects already in the bucket are left untouched; those files are not uploaded."
            overwriteText="The existing objects are replaced by the files from this computer. This cannot be undone."
          />
        )}
        {startError && (
          <div className="inline-error" role="alert">
            <AlertCircle size={14} />
            <div className="grow">
              <div>
                <strong>{isDenied(startError) ? `${permissionText("upload files")}.` : "The upload didn’t start."}</strong> Nothing has been
                transferred.
              </div>
              <div>{startError.message}</div>
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={`btn ${overwrite ? "btn-danger" : "btn-primary"}`} disabled={!canStart}>
            {(busy || state.status === "loading") && <Loader2 size={14} className="spin" />}
            {busy ? "Starting…" : `Upload${uploadCount !== null && !tooBig ? ` ${plural(uploadCount, "file")}` : ""}${overwrite ? ", overwrite" : ""}`}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ---- download folders ----------------------------------------------------------------------------

export function DownloadFoldersModal({ bucket, folders, dir: initialDir }: { bucket: string; folders: FolderEntry[]; dir: string }) {
  const [dir, setDir] = useState(initialDir);
  const [targets, setTargets] = useState<{ dir: string; paths: string[] } | null>(null);
  const [policy, setPolicy] = useState<ConflictPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const titleId = useId();
  const close = () => openModal(null);

  // Each folder goes into its own sub-folder of `dir`, named like a single download would be
  // (sanitized, and made unique so two folders never share one local folder).
  useEffect(() => {
    let cancelled = false;
    const taken = new Set<string>();
    Promise.all(folders.map((f) => api.joinPath(dir, uniqueFileName(sanitizeFileName(f.name), taken))))
      .then((paths) => !cancelled && setTargets({ dir, paths }))
      .catch(() => !cancelled && setTargets({ dir, paths: [] }));
    return () => {
      cancelled = true;
    };
  }, [dir, folders]);

  const requests = useMemo<BatchPlanRequest[] | null>(
    () =>
      targets && targets.dir === dir && targets.paths.length === folders.length
        ? // Verbatim: the folder's own prefix from the listing.
          folders.map((f, i) => ({ kind: "download" as const, bucket, prefix: f.prefix, localPath: targets.paths[i], onConflict: "skip" as const }))
        : null,
    [targets, dir, folders, bucket],
  );
  const [states, retry] = useBatchPreviews(requests, 0);
  const all = states ?? folders.map(() => LOADING);
  const loading = all.some((s) => s.status === "loading");
  const errors = all.filter((s) => s.status === "error").length;
  const previews = all.map((s) => (s.status === "ok" ? s.preview : null));
  const ready = !loading && errors === 0 && previews.every(Boolean);
  const files = previews.reduce((n, p) => n + (p?.files ?? 0), 0);
  const bytes = previews.reduce((n, p) => n + (p?.bytes ?? 0), 0);
  const conflicts = previews.reduce((n, p) => n + (p?.conflicts ?? 0), 0);
  const truncated = previews.some((p) => p?.truncated);
  const tooBigNames = folders.filter((_, i) => previews[i]?.truncated).map((f) => f.prefix);
  const needChoice = conflicts > 0;
  const startable = requests ? requests.filter((_, i) => (previews[i]?.files ?? 0) > 0) : [];
  const canStart = ready && !truncated && startable.length > 0 && (!needChoice || policy !== null) && !busy;
  const overwrite = needChoice && policy === "overwrite";
  const downloadCount = startCount(files, conflicts, policy);
  const single = folders.length === 1;

  useEffect(() => {
    setPolicy(null);
    setStartError(null);
    setStale(false);
  }, [dir]);

  const changeDir = async () => {
    try {
      const next = await api.pickDirectory();
      if (next) setDir(next);
    } catch {
      /* picker unavailable: keep the current folder */
    }
  };

  const start = async () => {
    if (!canStart) return;
    const onConflict: ConflictPolicy = needChoice && policy ? policy : "skip";
    const oldest = Math.min(...all.map((st) => (st.status === "ok" ? st.at : 0)));
    if (onConflict === "overwrite" && Date.now() - oldest > OVERWRITE_PREVIEW_MAX_AGE_MS) {
      setPolicy(null);
      setStale(true);
      retry();
      return;
    }
    setStale(false);
    setBusy(true);
    setStartError(null);
    let started = 0;
    const failed: string[] = [];
    // One batch per folder, started in the order shown.
    for (const r of startable) {
      try {
        await startBatch({ ...r, onConflict });
        started++;
      } catch (e) {
        failed.push(`${r.prefix}: ${(e as AppError).message}`);
        if (started === 0 && startable.length === 1) {
          setStartError((e as AppError).message);
          setBusy(false);
          return;
        }
      }
    }
    if (started) {
      setTransfersOpen(true);
      close();
      if (failed.length) toastFailure(`${plural(failed.length, "folder")} didn’t start`, failed.join("\n"), "download files");
    } else {
      setStartError(failed.join("\n"));
      setBusy(false);
    }
  };

  const notes = folders.flatMap((f, i) => (previews[i]?.notes ?? []).map((text) => ({ head: single ? undefined : f.prefix, text })));
  const notesCapped = previews.some((p) => (p?.notes.length ?? 0) >= 50);

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide>
      <div className="modal-head">
        <div className="modal-icon">
          <FolderDown size={18} />
        </div>
        <div className="grow">
          <h2 id={titleId}>{single ? "Download this folder?" : `Download ${plural(folders.length, "folder")}?`}</h2>
          <p className="muted small">
            Every file inside, including sub-folders, is saved under the folder on this computer. Names this computer can’t use are changed, as shown in the notes.
          </p>
        </div>
      </div>
      <div className="batch-dest">
        <div className="route-end grow">
          <span className="route-label">Save into</span>
          <span className="mono key-text">{dir}</span>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void changeDir()} disabled={busy}>
          Change…
        </button>
      </div>
      <div className="key-list-wrap">
        <div className="key-list-head">
          <span>Exact folders (bucket → this computer)</span>
          <span className="muted">{s3Uri(bucket, "")}</span>
        </div>
        <ol className="key-list mono batch-folder-list" aria-label="Folders to download">
          {folders.map((f, i) => {
            const st = all[i];
            return (
              <li key={f.prefix} className="with-dest">
                <span className="key-kind">folder</span>
                <span className="key-text">{f.prefix}</span>
                <ArrowRight size={12} className="key-arrow" aria-label="to" />
                <span className="batch-folder-dest">
                  <span className="key-text">{requests?.[i]?.localPath ?? "…"}</span>
                  <span className="batch-folder-count">
                    {st.status === "loading" ? (
                      <>
                        <Loader2 size={11} className="spin" /> counting…
                      </>
                    ) : st.status === "error" ? (
                      <span className="err-text">couldn’t list it</span>
                    ) : st.preview.files === 0 ? (
                      <span className="muted">empty: nothing to download</span>
                    ) : (
                      <>
                        {filesSummary(st.preview)}
                        {st.preview.conflicts > 0 && <span className="warn-text"> · {st.preview.conflicts.toLocaleString()} already on disk</span>}
                      </>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {all.map((st, i) =>
        st.status === "error" ? (
          <div key={i}>
            <PlanError error={st.error} retry={retry} upload={false} />
            {!single && <p className="hint mono">{folders[i].prefix}</p>}
          </div>
        ) : null,
      )}
      {loading ? (
        <Counting>Listing the {single ? "folder" : "folders"} and checking what is already on disk…</Counting>
      ) : errors === 0 ? (
        <div className="preview-line" role="status">
          <span>
            {conflicts > 0 ? "The bucket has " : "This will download "}
            <strong>{truncated ? "at least " : ""}{plural(files, "file")}, {formatBytes(bytes)}</strong>
            {!single && <> from {plural(startable.length, "folder")}</>}.
          </span>
        </div>
      ) : null}
      {errors === 0 && <p className="hint">{REPLAN_NOTE}</p>}
      {stale && <StaleNotice />}
      {truncated && (
        <div className="callout danger">
          <AlertTriangle size={14} />
          <span>
            <strong>Too large for one download:</strong> <span className="mono">{tooBigNames.join(", ")}</span>. {limitText} Download its sub-folders
            instead.
          </span>
        </div>
      )}
      {ready && !truncated && startable.length === 0 && <p className="hint err-text">Nothing to download: {single ? "the folder is" : "the folders are"} empty.</p>}
      <Notes notes={notes} capped={notesCapped} title={`Notes (${notesCapped ? `${notes.length}+` : notes.length})`} />
      {needChoice && !truncated && (
        <ConflictChoice
          policy={policy}
          onChange={setPolicy}
          legend={
            <>
              {plural(conflicts, "file")} already {conflicts === 1 ? "exists" : "exist"} on this computer. Choose what happens to {conflicts === 1 ? "it" : "them"}:
            </>
          }
          skipText="Files already on this computer are left untouched; those objects are not downloaded."
          overwriteText="The files on this computer are replaced by the ones from the bucket. This cannot be undone."
        />
      )}
      {startError && (
        <div className="inline-error" role="alert">
          <AlertCircle size={14} />
          <div className="grow">
            <div>
              <strong>The download didn’t start.</strong> Nothing has been transferred.
            </div>
            <div className="pre-line">{startError}</div>
          </div>
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close} disabled={busy} data-autofocus>
          Cancel
        </button>
        <button type="button" className={`btn ${overwrite ? "btn-danger" : "btn-primary"}`} onClick={() => void start()} disabled={!canStart}>
          {(busy || loading) && <Loader2 size={14} className="spin" />}
          {busy ? "Starting…" : `Download${ready && !truncated && downloadCount !== null ? ` ${plural(downloadCount, "file")}` : ""}${overwrite ? ", overwrite" : ""}`}
        </button>
      </div>
    </ModalShell>
  );
}
