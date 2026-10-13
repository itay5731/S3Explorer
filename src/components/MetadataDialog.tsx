// Edit one object's content type, Cache-Control, Content-Disposition and user metadata. S3 can't
// change headers in place: the backend copies the object onto itself (see "Edit content type and
// metadata" in docs/CONTRACT.md). Save shows exactly what will be sent before anything is written.

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertCircle, AlertTriangle, ArrowRight, FileCog, Info, Loader2, Plus, RotateCw, X } from "lucide-react";
import * as api from "../lib/api";
import { METADATA_LIMITS, type AppError, type MetadataEdit, type ObjectMeta } from "../lib/types";
import {
  COMMON_CONTENT_TYPES,
  MAX_EDIT_BYTES,
  contentTypeError,
  metaKeyError,
  metaValueError,
  metadataBytes,
  metadataChanges,
  optionalHeaderError,
  type MetadataChange,
} from "../lib/metadata";
import { formatStorageClass, s3Uri } from "../lib/format";
import { openModal, replaceListedObject } from "../store/app";
import { isArchiveClass, rememberArchiveMeta } from "../store/archive";
import { bumpObject, ensureVersioning, hasVersions, useVersioning } from "../store/versions";
import { isDenied, nothingWritten, permissionText, toast } from "../store/toasts";
import { ModalShell } from "./Modals";

interface Row {
  /** Stable React key; never sent. */
  id: number;
  key: string;
  value: string;
}

let rowSeq = 0;
const toRows = (m: Record<string, string>): Row[] =>
  Object.entries(m)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ id: ++rowSeq, key, value }));

interface Form {
  contentType: string;
  cacheControl: string;
  contentDisposition: string;
  rows: Row[];
}

const formOf = (m: ObjectMeta): Form => ({
  contentType: m.contentType ?? "",
  cacheControl: m.cacheControl ?? "",
  contentDisposition: m.contentDisposition ?? "",
  rows: toRows(m.metadata),
});

type Load = { phase: "loading" } | { phase: "ready"; meta: ObjectMeta } | { phase: "error"; error: AppError };

/** What the dialog says after a save that didn't end cleanly. */
type Outcome = { kind: "conflict" } | { kind: "unknown"; detail: string };

function Value({ v }: { v: string | null }) {
  return v === null ? <span className="muted">none</span> : <code className="meta-value">{v}</code>;
}

function ChangeList({ changes }: { changes: MetadataChange[] }) {
  return (
    <ul className="meta-changes" aria-label="Changes">
      {changes.map((c) => (
        <li key={c.label}>
          <div className="meta-change-label mono">{c.label}</div>
          <div className="meta-change-values">
            <Value v={c.before} />
            <ArrowRight size={12} className="muted" aria-label="becomes" />
            <Value v={c.after} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MetadataDialog({ bucket, objectKey }: { bucket: string; objectKey: string }) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [form, setForm] = useState<Form | null>(null);
  /** The exact request the confirmation shows; Apply sends this object, nothing recomputed. */
  const [pending, setPending] = useState<MetadataEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [tried, setTried] = useState(false);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const titleId = useId();
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const versioning = useVersioning((s) => s.byBucket[bucket]);
  useEffect(() => ensureVersioning(bucket), [bucket]);
  const close = () => openModal(null);

  /** Read the object fresh: its ETag is what the copy is conditional on. */
  const reload = async () => {
    setLoad({ phase: "loading" });
    try {
      const m = await api.headObject(bucket, objectKey);
      rememberArchiveMeta(bucket, m);
      setLoad({ phase: "ready", meta: m });
      setForm(formOf(m));
      setTried(false);
      setLeft(new Set());
    } catch (e) {
      setLoad({ phase: "error", error: e as AppError });
    }
  };
  useEffect(() => {
    void reload();
    // Once per mount; the dialog is keyed by bucket/key.
  }, []);

  const meta = load.phase === "ready" ? load.meta : null;

  const v = useMemo(() => {
    if (!form) return null;
    const counts = new Map<string, number>();
    for (const r of form.rows) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
    const rows = form.rows.map((r) => ({
      key: metaKeyError(r.key) ?? ((counts.get(r.key) ?? 0) > 1 ? "This key is used more than once." : null),
      value: metaValueError(r.value),
    }));
    const bytes = metadataBytes(form.rows.map((r) => [r.key, r.value]));
    const fields = {
      contentType: contentTypeError(form.contentType),
      cacheControl: optionalHeaderError(form.cacheControl),
      contentDisposition: optionalHeaderError(form.contentDisposition),
    };
    const tooBig = bytes > METADATA_LIMITS.maxTotalBytes;
    const valid = !tooBig && !Object.values(fields).some(Boolean) && rows.every((r) => !r.key && !r.value);
    return { rows, bytes, fields, tooBig, valid };
  }, [form]);

  const edit: MetadataEdit | null =
    form && meta?.etag && meta.lastModified
      ? {
          bucket,
          key: objectKey,
          expectedEtag: meta.etag,
          expectedLastModified: meta.lastModified,
          contentType: form.contentType,
          cacheControl: form.cacheControl === "" ? null : form.cacheControl,
          contentDisposition: form.contentDisposition === "" ? null : form.contentDisposition,
          metadata: Object.fromEntries(form.rows.map((r) => [r.key, r.value])),
        }
      : null;
  const changes = meta && edit ? metadataChanges(meta, edit) : [];
  const blocked = !meta
    ? null
    : isArchiveClass(meta.storageClass)
      ? `The object is in ${formatStorageClass(meta.storageClass ?? "")}. Editing metadata copies the object, which would put it back in the archive (a restored copy would be lost), so it can’t be edited here.`
      : meta.archived
        ? "The object is archived; restore it first to edit its metadata."
        : meta.size > MAX_EDIT_BYTES
        ? "The object is larger than 5 GiB, the most S3 can copy in one request, so its metadata can’t be edited here."
        : !meta.etag || !meta.lastModified
          ? "The server didn’t report an ETag and last-modified time for this object, so the edit can’t be made safely."
          : null;
  const versioned = hasVersions(versioning);
  // Intelligent-Tiering archive tiers (an object that was restored from one): the copy is a new object,
  // so it starts again in the Frequent Access tier.
  const intelligentTiering = !!meta && meta.storageClass === "INTELLIGENT_TIERING" && !!meta.restore;

  const set = (patch: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setError(null);
  };
  const setRow = (id: number, patch: Partial<Row>) => form && set({ rows: form.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const addRow = () => {
    if (!form) return;
    const row: Row = { id: ++rowSeq, key: "", value: "" };
    set({ rows: [...form.rows, row] });
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLInputElement>(`[data-row="${row.id}"]`)?.focus());
  };
  const leave = (name: string) => setLeft((s) => (s.has(name) ? s : new Set(s).add(name)));
  const shown = (name: string) => tried || left.has(name);

  const review = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!edit || !v?.valid || blocked || busy || changes.length === 0) return;
    // A copy of the request: later typing can't change what the confirmation shows and sends.
    setPending({ ...edit, metadata: { ...edit.metadata } });
    setOutcome(null);
    setError(null);
  };

  const apply = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await api.updateObjectMetadata(pending);
      rememberArchiveMeta(bucket, fresh);
      bumpObject(bucket, objectKey);
      // Every pane and tab listing the object shows its new Last modified (and ETag) at once.
      replaceListedObject(bucket, { key: fresh.key, name: fresh.name, size: fresh.size, lastModified: fresh.lastModified, etag: fresh.etag, storageClass: fresh.storageClass });
      toast.success("Metadata saved", s3Uri(bucket, objectKey));
      close();
    } catch (err) {
      const ae = err as AppError;
      setPending(null);
      if (ae.code === "Conflict") setOutcome({ kind: "conflict" });
      else if (nothingWritten(ae)) setError(ae);
      else {
        // The copy may have landed: never say nothing changed. Show what the server has now.
        setOutcome({ kind: "unknown", detail: ae.message });
        bumpObject(bucket, objectKey);
        await reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const head = (
    <div className="modal-head">
      <div className="modal-icon">
        <FileCog size={18} />
      </div>
      <div>
        <h2 id={titleId}>{pending ? "Confirm metadata changes" : "Edit metadata"}</h2>
        <p className="muted small mono">{s3Uri(bucket, objectKey)}</p>
      </div>
    </div>
  );

  if (pending && meta) {
    const shownChanges = metadataChanges(meta, pending);
    return (
      <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void apply();
          }}
        >
          {head}
          <p className="small">
            {shownChanges.length === 1 ? "This change is" : `These ${shownChanges.length} changes are`} written by copying the object onto
            itself. Its content, storage class ({formatStorageClass(meta.storageClass ?? "STANDARD")}), encryption and tags stay as they are.
          </p>
          <ChangeList changes={shownChanges} />
          {versioned ? (
            <p className="hint">
              <Info size={12} /> Versioning is on: this saves a new version, and the current one stays in the version history.
            </p>
          ) : (
            <p className="hint">
              <Info size={12} /> The object is replaced by the copy; its last-modified time changes.
            </p>
          )}
          <p className="hint hint-block">
            <Info size={12} />
            <span>Object ACL grants are not kept: the copy gets the bucket’s default (private unless the bucket says otherwise).</span>
          </p>
          {intelligentTiering && (
            <div className="callout warn">
              <AlertTriangle size={15} />
              <span>
                The object was restored from an Intelligent-Tiering archive tier: the copy is a new object, so it starts again in the
                Frequent Access tier and moves back to the archive tiers only by the bucket’s Intelligent-Tiering configuration.
              </span>
            </div>
          )}
          {error && (
            <div className="inline-error" role="alert">
              <AlertCircle size={14} />
              <span>{isDenied(error) ? `${permissionText("edit metadata")}.` : error.message}</span>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setPending(null)} disabled={busy} data-autofocus>
              Back
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy && <Loader2 size={14} className="spin" />} Apply changes
            </button>
          </div>
        </form>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide>
      <form onSubmit={review} noValidate>
        {head}
        {outcome?.kind === "conflict" && (
          <div className="callout warn" role="alert" data-save-outcome="conflict">
            <AlertTriangle size={15} />
            <span>
              <strong>The object changed since the dialog opened.</strong> Nothing was written.{" "}
              <button type="button" className="link-btn" onClick={() => (setOutcome(null), void reload())} disabled={load.phase === "loading"}>
                <RotateCw size={12} /> Load the current values
              </button>
            </span>
          </div>
        )}
        {outcome?.kind === "unknown" && (
          <div className="callout warn" role="alert" data-save-outcome="unknown">
            <AlertTriangle size={15} />
            <span>
              <strong>Couldn’t confirm whether the edit was applied.</strong> The values below were read again from the server: check them
              before changing anything.
              <span className="small save-outcome-detail">{outcome.detail}</span>
            </span>
          </div>
        )}
        {load.phase === "loading" ? (
          <div className="preview-line muted" role="status">
            <Loader2 size={14} className="spin" /> Reading the object…
          </div>
        ) : load.phase === "error" ? (
          <div className="inline-error" role="alert">
            <AlertCircle size={14} />
            <div className="grow">
              <div>
                <strong>{isDenied(load.error) ? `${permissionText("read this object")}.` : "Couldn’t read the object."}</strong>
              </div>
              <div>{load.error.message}</div>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => void reload()}>
              <RotateCw size={12} /> Retry
            </button>
          </div>
        ) : blocked ? (
          <div className="callout warn" role="status">
            <AlertTriangle size={15} />
            <span>{blocked}</span>
          </div>
        ) : (
          form &&
          v && (
            <>
              <label className="field">
                <span className="field-label">Content type</span>
                <input
                  value={form.contentType}
                  list={listId}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy}
                  aria-invalid={!!v.fields.contentType}
                  onChange={(e) => set({ contentType: e.target.value })}
                  onBlur={() => leave("contentType")}
                  data-autofocus
                />
                <datalist id={listId}>
                  {COMMON_CONTENT_TYPES.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                {(shown("contentType") || form.contentType !== "") && v.fields.contentType && (
                  <span className="hint err-text" role="alert">
                    {v.fields.contentType}
                  </span>
                )}
              </label>
              <div className="meta-fields-row">
                <label className="field">
                  <span className="field-label">
                    Cache-Control<span className="optional">optional</span>
                  </span>
                  <input
                    value={form.cacheControl}
                    placeholder="e.g. max-age=3600"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                    aria-invalid={!!v.fields.cacheControl}
                    onChange={(e) => set({ cacheControl: e.target.value })}
                  />
                  {v.fields.cacheControl && (
                    <span className="hint err-text" role="alert">
                      {v.fields.cacheControl}
                    </span>
                  )}
                </label>
                <label className="field">
                  <span className="field-label">
                    Content-Disposition<span className="optional">optional</span>
                  </span>
                  <input
                    value={form.contentDisposition}
                    placeholder="e.g. attachment"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                    aria-invalid={!!v.fields.contentDisposition}
                    onChange={(e) => set({ contentDisposition: e.target.value })}
                  />
                  {v.fields.contentDisposition && (
                    <span className="hint err-text" role="alert">
                      {v.fields.contentDisposition}
                    </span>
                  )}
                </label>
              </div>
              <div className="field">
                <span className="field-label">User metadata</span>
                <div className="tag-editor">
                  <div className="tag-editor-list" ref={listRef} role="group" aria-label="User metadata">
                    {form.rows.length > 0 ? (
                      <div className="tag-editor-head" aria-hidden="true">
                        <span>Key (x-amz-meta-…)</span>
                        <span>Value</span>
                        <span />
                      </div>
                    ) : (
                      <p className="tag-editor-empty muted small">No user metadata.</p>
                    )}
                    {form.rows.map((r, i) => {
                      const errs = v.rows[i];
                      const show = shown(`row:${r.id}`) || r.key !== "";
                      const keyErr = show ? errs.key : null;
                      const valueErr = show || r.value !== "" ? errs.value : null;
                      return (
                        <div key={r.id} className="tag-editor-row">
                          <input
                            data-row={r.id}
                            value={r.key}
                            placeholder="key"
                            spellCheck={false}
                            autoComplete="off"
                            disabled={busy}
                            aria-label={`Metadata ${i + 1} key`}
                            aria-invalid={!!keyErr}
                            onChange={(e) => setRow(r.id, { key: e.target.value })}
                            onBlur={() => leave(`row:${r.id}`)}
                          />
                          <input
                            value={r.value}
                            placeholder="value"
                            spellCheck={false}
                            autoComplete="off"
                            disabled={busy}
                            aria-label={`Metadata ${i + 1} value`}
                            aria-invalid={!!valueErr}
                            onChange={(e) => setRow(r.id, { value: e.target.value })}
                            onBlur={() => leave(`row:${r.id}`)}
                          />
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => set({ rows: form.rows.filter((x) => x.id !== r.id) })}
                            disabled={busy}
                            aria-label={`Remove metadata ${r.key || i + 1}`}
                            title="Remove this entry"
                          >
                            <X size={13} />
                          </button>
                          {(keyErr || valueErr) && (
                            <p className="tag-editor-err err-text" role="alert">
                              {keyErr ? `Key: ${keyErr}` : ""}
                              {keyErr && valueErr ? " " : ""}
                              {valueErr ? `Value: ${valueErr}` : ""}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="tag-editor-foot">
                    <button type="button" className="btn btn-sm" onClick={addRow} disabled={busy}>
                      <Plus size={13} /> Add entry
                    </button>
                    <span className={`tag-count ${v.tooBig ? "err-text" : ""}`} aria-live="polite">
                      {v.bytes.toLocaleString()} of {METADATA_LIMITS.maxTotalBytes.toLocaleString()} bytes
                    </span>
                  </div>
                  {v.tooBig && (
                    <p className="hint err-text" role="alert">
                      S3 allows at most {METADATA_LIMITS.maxTotalBytes.toLocaleString()} bytes of user metadata (keys and values together).
                    </p>
                  )}
                </div>
              </div>
              {versioned && (
                <p className="hint">
                  <Info size={12} /> Versioning is on: saving creates a new version; the current one stays in the version history.
                </p>
              )}
              {error && (
                <div className="inline-error" role="alert">
                  <AlertCircle size={14} />
                  <span>{isDenied(error) ? `${permissionText("edit metadata")}.` : error.message}</span>
                </div>
              )}
            </>
          )
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !meta || !!blocked || changes.length === 0 || (tried && !v?.valid)}
            title={meta && !blocked && changes.length === 0 ? "Nothing has changed" : undefined}
          >
            Review changes…
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
