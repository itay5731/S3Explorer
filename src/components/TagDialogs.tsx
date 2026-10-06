// Tag dialogs: one object's tags, a bucket's tags, and bulk tagging of a selection (a "tag" job).
// See "Tags (buckets and objects)" in docs/CONTRACT.md.

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { AlertCircle, AlertTriangle, Ban, Loader2, Plus, RotateCw, Tags, X } from "lucide-react";
import * as api from "../lib/api";
import { TAG_LIMITS, type AppError, type JobItem, type JobRequest, type Tag } from "../lib/types";
import { sameTagSet, splitSystemTags, tagKeyError } from "../lib/tags";
import { plural } from "../lib/ops";
import { s3Uri } from "../lib/format";
import { openModal } from "../store/app";
import { startConfirmedJob } from "../store/ops";
import { setBucketTags, setObjectTags } from "../store/tags";
import { isDenied, nothingWritten, permissionText, SAVED_UNREAD_PREFIX, toast } from "../store/toasts";
import { KeyList, ModalShell, PreviewLine, usePreview } from "./Modals";
import { fromRows, TagEditor, toRows, validateRows, type TagRow } from "./TagEditor";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; loaded: Tag[] }
  | { phase: "unsupported" }
  | { phase: "error"; error: AppError };

/**
 * What the dialog says after a save that did not end cleanly, kept across the reload that follows.
 * "conflict": someone else changed the tags, nothing was written. "applied": the write went through
 * but couldn't be read back. "unknown": it is not known whether the write went through.
 */
type Outcome = { kind: "conflict" | "applied" | "unknown"; detail: string | null };

/** The plain state for a server without tagging (MinIO, R2, SeaweedFS and others implement it only partly). */
function Unsupported() {
  return (
    <div className="tags-unsupported" role="status">
      <Ban size={18} />
      <div>
        <strong>This server doesn’t support tags.</strong>
        <p className="muted small">Some S3-compatible services implement tagging only partly or not at all.</p>
      </div>
    </div>
  );
}

/**
 * Load one tag set, edit it, and write it back with the loaded set as `expected`: a set that changed
 * on the server meanwhile is never overwritten (`Conflict` reloads it instead).
 */
function TagSetDialog({
  title,
  where,
  max,
  load,
  save,
  onLoaded,
}: {
  title: string;
  where: string;
  max: number;
  load(): Promise<Tag[]>;
  save(tags: Tag[], expected: Tag[]): Promise<Tag[]>;
  onLoaded(tags: Tag[]): void;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [rows, setRows] = useState<TagRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [tried, setTried] = useState(false);
  const titleId = useId();
  const close = () => openModal(null);

  const reload = useCallback(
    async () => {
      setState({ phase: "loading" });
      try {
        const tags = await load();
        setState({ phase: "ready", loaded: tags });
        // AWS system tags are not editable: only the user's tags become rows.
        setRows(toRows(splitSystemTags(tags).user));
        setTried(false);
        onLoaded(tags);
      } catch (e) {
        const err = e as AppError;
        setState(err.code === "NotSupported" ? { phase: "unsupported" } : { phase: "error", error: err });
      }
    },
    // load/onLoaded are recreated on every render by the wrappers: the dialog loads once per mount.
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const loaded = state.phase === "ready" ? state.loaded : null;
  /** System tags as loaded: passed through unchanged, in the saved set and in `expected`. */
  const system = useMemo(() => (loaded ? splitSystemTags(loaded).system : []), [loaded]);
  const tags = [...system, ...fromRows(rows)];
  const v = validateRows(rows, max, system.length);
  const unchanged = !!loaded && sameTagSet(tags, loaded);
  const canSave = !!loaded && v.valid && !unchanged && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!canSave || !loaded) return;
    setBusy(true);
    setSaveError(null);
    setOutcome(null);
    try {
      const stored = await save(tags, loaded);
      onLoaded(stored);
      toast.success("Tags saved", where);
      close();
    } catch (err) {
      const appErr = err as AppError;
      if (appErr.code === "Conflict") {
        setOutcome({ kind: "conflict", detail: null });
        await reload();
      } else if (appErr.code === "NotSupported") setState({ phase: "unsupported" });
      else if (nothingWritten(appErr)) setSaveError(appErr);
      else {
        // The write may have landed (or did, but couldn't be read back): never claim nothing changed.
        // Read the tags again before anything else can be done (busy stays on until then).
        setOutcome({ kind: appErr.message.startsWith(SAVED_UNREAD_PREFIX) ? "applied" : "unknown", detail: appErr.message });
        await reload();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide>
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal-head">
          <div className="modal-icon">
            <Tags size={18} />
          </div>
          <div>
            <h2 id={titleId}>{title}</h2>
            <p className="muted small mono">{where}</p>
          </div>
        </div>
        {outcome && outcome.kind !== "conflict" && state.phase !== "loading" && (
          <div className="callout warn" role="alert" data-save-outcome={outcome.kind}>
            <AlertTriangle size={15} />
            <span>
              <strong>
                {outcome.kind === "applied"
                  ? "The tags were probably saved, but reading them back failed."
                  : "Couldn’t confirm whether the save was applied."}
              </strong>{" "}
              {state.phase === "ready"
                ? "The tags below were read again from the server: check them before changing anything."
                : "Reading the tags again failed too; retry to see what the server has now."}
              {outcome.detail && <span className="small save-outcome-detail">{outcome.detail}</span>}
            </span>
          </div>
        )}
        {state.phase === "loading" ? (
          <div className="preview-line muted" role="status">
            <Loader2 size={14} className="spin" /> Loading tags…
          </div>
        ) : state.phase === "unsupported" ? (
          <Unsupported />
        ) : state.phase === "error" ? (
          <div className="inline-error" role="alert">
            <AlertCircle size={14} />
            <div className="grow">
              <div>
                <strong>{isDenied(state.error) ? `${permissionText("read tags")}.` : "Couldn’t load the tags."}</strong>
              </div>
              <div>{state.error.message}</div>
            </div>
            {!isDenied(state.error) && (
              <button type="button" className="btn btn-sm" onClick={() => void reload()}>
                <RotateCw size={12} /> Retry
              </button>
            )}
          </div>
        ) : (
          <>
            {outcome?.kind === "conflict" && (
              <div className="callout warn" role="status" data-save-outcome="conflict">
                <AlertTriangle size={15} />
                <span>
                  <strong>Tags changed on the server. Reloaded.</strong> Someone else changed them; your edits were not saved. Make
                  them again on the current tags.
                </span>
              </div>
            )}
            <TagEditor
              rows={rows}
              locked={system}
              onChange={(r) => (setRows(r), setSaveError(null))}
              max={max}
              disabled={busy}
              showAllErrors={tried}
            />
            {saveError && (
              <div className="inline-error" role="alert">
                <AlertCircle size={14} />
                <div className="grow">
                  <div>
                    <strong>{isDenied(saveError) ? `${permissionText("change tags")}.` : "Couldn’t save the tags."}</strong> Nothing
                    was changed.

                  </div>
                  <div>{saveError.message}</div>
                </div>
              </div>
            )}
            <p className="muted small">
              Keys and values: letters, numbers, spaces and + - = . _ : / @. Keys are case-sensitive and can’t start
              with “aws:”.
            </p>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            {state.phase === "ready" && !unchanged ? "Cancel" : "Close"}
          </button>
          {state.phase === "ready" && (
            <button type="submit" className="btn btn-primary" disabled={!canSave}>
              {busy && <Loader2 size={14} className="spin" />} {busy ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </form>
    </ModalShell>
  );
}

export function ObjectTagsModal({ bucket, objectKey }: { bucket: string; objectKey: string }) {
  return (
    <TagSetDialog
      title="Object tags"
      where={s3Uri(bucket, objectKey)}
      max={TAG_LIMITS.objectMaxTags}
      load={() => api.getObjectTags(bucket, objectKey)}
      save={(tags, expected) => api.putObjectTags(bucket, objectKey, tags, expected)}
      onLoaded={(tags) => setObjectTags(bucket, objectKey, tags)}
    />
  );
}

export function BucketTagsModal({ bucket }: { bucket: string }) {
  return (
    <TagSetDialog
      title="Bucket tags"
      where={`s3://${bucket}`}
      max={TAG_LIMITS.bucketMaxTags}
      load={() => api.getBucketTags(bucket)}
      save={(tags, expected) => api.putBucketTags(bucket, tags, expected)}
      onLoaded={(tags) => setBucketTags(bucket, tags)}
    />
  );
}

// ---- bulk ------------------------------------------------------------------------------------

type BulkMode = "merge" | "replace";

/** Edit the tags of every object in a selection (folders: everything under them), as a background job. */
export function BulkTagsModal({ bucket, prefix, items }: { bucket: string; prefix: string; items: JobItem[] }) {
  const [mode, setMode] = useState<BulkMode>("merge");
  const [rows, setRows] = useState<TagRow[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [removeInput, setRemoveInput] = useState("");
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const close = () => openModal(null);
  const max = TAG_LIMITS.objectMaxTags;
  const folders = items.filter((i) => i.isPrefix).length;

  const set = fromRows(rows);
  const v = validateRows(rows, max);
  const setKeys = new Set(set.map((t) => t.key));
  const removeInputError = removeInput ? tagKeyError(removeInput) : null;
  const overlap = mode === "merge" ? remove.filter((k) => setKeys.has(k)) : [];
  const nothing = mode === "merge" && set.length === 0 && remove.length === 0;
  const valid = v.valid && overlap.length === 0 && !nothing;

  const setKey = JSON.stringify(set);
  const removeKey = JSON.stringify(remove);
  const request = useMemo<JobRequest | null>(
    () =>
      valid
        ? {
            kind: "tag",
            srcBucket: bucket,
            destBucket: null,
            // Exact keys and prefixes of the selection, never rewritten.
            items,
            onConflict: "skip",
            tags: { mode, set: JSON.parse(setKey) as Tag[], remove: mode === "merge" ? (JSON.parse(removeKey) as string[]) : [] },
          }
        : null,
    [valid, bucket, items, mode, setKey, removeKey],
  );
  const display = useMemo<JobRequest>(() => ({ kind: "tag", srcBucket: bucket, destBucket: null, items, onConflict: "skip" }), [bucket, items]);
  const [state, retry] = usePreview(request, 400);
  const preview = state?.status === "ok" ? state.preview : null;
  const empty = !!preview && preview.objects === 0;
  const canStart = !!request && !!preview && !empty && !busy;
  const replace = mode === "replace";

  const addRemoveKey = () => {
    const k = removeInput;
    if (!k || tagKeyError(k) || remove.includes(k)) return;
    setRemove([...remove, k]);
    setRemoveInput("");
  };
  const onRemoveKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addRemoveKey();
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!canStart || !request) return;
    setBusy(true);
    const id = await startConfirmedJob(request);
    setBusy(false);
    if (id) close();
  };

  const count = preview ? `${plural(preview.objects, "object")}${preview.truncated ? "+" : ""}` : null;

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide>
      <form onSubmit={(e) => void confirm(e)}>
        <div className="modal-head">
          <div className="modal-icon">
            <Tags size={18} />
          </div>
          <div>
            <h2 id={titleId}>Edit tags for {plural(items.length, "item")}</h2>
            <p className="muted small mono">{s3Uri(bucket, prefix)}</p>
          </div>
        </div>
        <div className="segmented bulk-mode" role="radiogroup" aria-label="How to change the tags">
          {(
            [
              ["merge", "Merge"],
              ["replace", "Replace all"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "active" : ""}
              onClick={() => setMode(m)}
              disabled={busy}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="muted small">
          {replace
            ? "Every object gets exactly the tags below. Tags it has now are removed."
            : "Tags below are added to every object, or updated where the key already exists. Other tags are kept."}
        </p>
        <TagEditor
          rows={rows}
          onChange={setRows}
          max={max}
          disabled={busy}
          label={replace ? "The new tag set" : "Tags to add or update"}
          addLabel={replace ? "Add tag" : "Add or update a tag"}
          emptyText={replace ? "No tags: every object’s tags are removed." : "No tags to add or update."}
        />
        {!replace && (
          <div className="remove-keys">
            <span className="field-label">Keys to remove</span>
            {remove.length > 0 && (
              <ul className="tag-chips">
                {remove.map((k) => (
                  <li key={k} className={`tag-chip removing ${overlap.includes(k) ? "invalid" : ""}`}>
                    <span className="tag-chip-key">{k}</span>
                    <button type="button" className="icon-btn" onClick={() => setRemove(remove.filter((x) => x !== k))} aria-label={`Keep ${k}`}>
                      <X size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="input-affix">
              <input
                value={removeInput}
                onChange={(e) => setRemoveInput(e.target.value)}
                onKeyDown={onRemoveKey}
                placeholder="key to remove"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                aria-label="Key to remove"
                aria-invalid={!!removeInputError}
              />
              <button type="button" className="icon-btn" onClick={addRemoveKey} disabled={busy || !removeInput || !!removeInputError} aria-label="Add key to remove">
                <Plus size={14} />
              </button>
            </div>
            {removeInputError && <p className="hint err-text">{removeInputError}</p>}
            {overlap.length > 0 && (
              <p className="hint err-text" role="alert">
                {overlap.map((k) => `“${k}”`).join(", ")} {overlap.length === 1 ? "is" : "are"} both set and removed. Keep one.
              </p>
            )}
          </div>
        )}
        {replace && (
          <div className="callout danger" role="note">
            <AlertTriangle size={15} />
            <span>
              <strong>Every object’s existing tags are discarded</strong>
              {set.length === 0
                ? ": all tags are removed from every object."
                : ` and replaced with exactly ${plural(set.length, "tag")}. This can’t be undone.`}
              {folders > 0 && ` This includes everything inside ${folders === 1 ? "the selected folder" : `the ${folders} selected folders`}.`}
            </span>
          </div>
        )}
        <KeyList request={display} label="Objects with these exact keys, and everything under these prefixes" />
        {request ? (
          <PreviewLine state={state} retry={retry} verb="tag" />
        ) : (
          <p className="hint">{nothing ? "Add a tag, or a key to remove." : "Fix the tags above to continue."}</p>
        )}
        {empty && <div className="hint err-text">Nothing to tag: there are no objects here.</div>}
        {!replace && (
          <p className="muted small">An object that would end up with more than {max} tags is left unchanged and reported.</p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="submit" className={`btn ${replace ? "btn-danger" : "btn-primary"}`} disabled={!canStart}>
            {(busy || (request && state?.status === "loading")) && <Loader2 size={14} className="spin" />}
            {busy ? "Starting…" : `${replace ? "Replace tags of" : "Tag"}${count ? ` ${count}` : ""}`}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
