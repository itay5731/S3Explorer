// Restoring archived objects: one object (restore_object) or a selection / folder (a "restore" job).
// Both ask for the retrieval tier and the number of days, with the typical wait and cost per tier.

import { useId, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, ArchiveRestore, Info, Loader2 } from "lucide-react";
import * as api from "../lib/api";
import { RESTORE_DAYS, type AppError, type JobItem, type JobRequest, type RestoreRequest, type RestoreTier } from "../lib/types";
import { openModal } from "../store/app";
import { markRestoreRequested } from "../store/archive";
import { startConfirmedJob } from "../store/ops";
import { isDenied, permissionText, toast } from "../store/toasts";
import { bumpObject } from "../store/versions";
import { basename, s3Uri } from "../lib/format";
import { plural } from "../lib/ops";
import { KeyList, ModalShell, PreviewLine, usePreview } from "./Modals";

export const ARCHIVE_CLASS_NAME: Record<string, string> = {
  GLACIER: "Glacier Flexible Retrieval",
  DEEP_ARCHIVE: "Glacier Deep Archive",
};

const TIERS: RestoreTier[] = ["Bulk", "Standard", "Expedited"];

/** Typical wait per tier (AWS's published ranges), for Flexible Retrieval and for Deep Archive. */
function tierWait(tier: RestoreTier, deep: boolean): string {
  if (tier === "Expedited") return "usually ready in 1–5 minutes";
  if (tier === "Standard") return deep ? "usually ready within 12 hours" : "usually ready in 3–5 hours";
  return deep ? "usually ready within 48 hours" : "usually ready in 5–12 hours";
}

function tierNote(tier: RestoreTier, deep: boolean | "mixed"): string {
  const cost = tier === "Expedited" ? "The fastest and most expensive tier." : tier === "Bulk" ? "The slowest and cheapest tier." : "The default tier.";
  if (deep === "mixed") {
    return `${cost} Glacier Flexible Retrieval: ${tierWait(tier, false)}. Deep Archive: ${tier === "Expedited" ? "not available" : tierWait(tier, true)}.`;
  }
  const wait = tierWait(tier, deep);
  return `${wait[0].toUpperCase()}${wait.slice(1)}. ${cost}`;
}

function daysError(text: string): string | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return `Enter a whole number of days from ${RESTORE_DAYS.min} to ${RESTORE_DAYS.max}`;
  const n = Number(t);
  if (n < RESTORE_DAYS.min || n > RESTORE_DAYS.max) return `Enter a number of days from ${RESTORE_DAYS.min} to ${RESTORE_DAYS.max}`;
  return null;
}

/** Tier and days, shared by both dialogs. */
function RestoreOptions({
  tier,
  setTier,
  daysText,
  setDaysText,
  deep,
  expeditedOff,
  busy,
  showDaysError,
}: {
  tier: RestoreTier;
  setTier: (t: RestoreTier) => void;
  daysText: string;
  setDaysText: (t: string) => void;
  deep: boolean | "mixed";
  /** Deep Archive offers no Expedited retrieval. */
  expeditedOff: boolean;
  busy: boolean;
  showDaysError: boolean;
}) {
  const dErr = daysError(daysText);
  const daysId = useId();
  return (
    <>
      <div className="field">
        <span className="field-label">Retrieval tier</span>
        <div className="segmented restore-tiers" role="radiogroup" aria-label="Retrieval tier">
          {TIERS.map((t) => {
            const off = t === "Expedited" && expeditedOff;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={tier === t}
                className={tier === t ? "active" : ""}
                onClick={() => setTier(t)}
                disabled={busy || off}
                title={off ? "Glacier Deep Archive has no Expedited retrieval" : undefined}
              >
                {t}
              </button>
            );
          })}
        </div>
        <p className="hint">{tierNote(tier, deep)}</p>
        {expeditedOff && <p className="hint">Expedited isn’t available for Glacier Deep Archive.</p>}
      </div>
      <label className="field" htmlFor={daysId}>
        <span className="field-label">Keep the restored copy for</span>
        <span className="days-input">
          <input
            id={daysId}
            type="number"
            inputMode="numeric"
            min={RESTORE_DAYS.min}
            max={RESTORE_DAYS.max}
            step={1}
            value={daysText}
            onChange={(e) => setDaysText(e.target.value)}
            // A restore is billed: Enter in the field must not submit the form. Only the Restore button sends it.
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
            disabled={busy}
            aria-invalid={showDaysError && !!dErr}
          />
          <span className="muted">days</span>
        </span>
      </label>
      {showDaysError && dErr ? (
        <p className="hint err-text" role="alert">
          {dErr}
        </p>
      ) : (
        <p className="hint">
          A temporary readable copy is made for this many days; the archived object itself is not changed. AWS bills each restore (per
          request and per GB retrieved, more for faster tiers) and the copy’s storage while it exists.
        </p>
      )}
    </>
  );
}

// ---- one object ------------------------------------------------------------------------------

export function RestoreModal({ bucket, objectKey, storageClass }: { bucket: string; objectKey: string; storageClass: string | null }) {
  const deep = storageClass === "DEEP_ARCHIVE";
  const [tier, setTier] = useState<RestoreTier>("Standard");
  const [daysText, setDaysText] = useState(String(RESTORE_DAYS.default));
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const titleId = useId();
  const close = () => openModal(null);
  const dErr = daysError(daysText);
  const where = storageClass ? (ARCHIVE_CLASS_NAME[storageClass] ?? storageClass) : "an archive tier";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (dErr || busy) return;
    const request: RestoreRequest = { tier: deep && tier === "Expedited" ? "Standard" : tier, days: Number(daysText.trim()) };
    setBusy(true);
    setError(null);
    try {
      await api.restoreObject(bucket, objectKey, request);
      markRestoreRequested(bucket, objectKey, storageClass);
      bumpObject(bucket, objectKey);
      toast.success(
        "Restore requested",
        `${basename(objectKey)}: ${tierWait(request.tier, deep)}. It can be downloaded or copied for ${plural(request.days, "day")} once the restore is done.`,
      );
      close();
    } catch (err) {
      const ae = err as AppError;
      if (ae.code === "Conflict") {
        // Already being restored: say so and show the new state behind the dialog.
        bumpObject(bucket, objectKey);
      }
      setError(ae);
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <div className="modal-head">
          <div className="modal-icon">
            <ArchiveRestore size={18} />
          </div>
          <div>
            <h2 id={titleId}>Restore from {where}</h2>
            <p className="muted small mono">{s3Uri(bucket, objectKey)}</p>
          </div>
        </div>
        <RestoreOptions
          tier={deep && tier === "Expedited" ? "Standard" : tier}
          setTier={setTier}
          daysText={daysText}
          setDaysText={setDaysText}
          deep={deep}
          expeditedOff={deep}
          busy={busy}
          showDaysError={touched || daysText.trim() !== ""}
        />
        {error && (
          <div className="inline-error" role="alert">
            <AlertCircle size={14} />
            <span>
              {error.code === "Conflict" ? "This object is already being restored." : isDenied(error) ? `${permissionText("restore archived files")}.` : error.message}
            </span>
          </div>
        )}
        <div className="modal-actions">
          {/* Cancel has the initial focus: a restore is billed, so Enter must not send one. */}
          <button type="button" className="btn" onClick={close} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || (touched && !!dErr)}>
            {busy && <Loader2 size={14} className="spin" />} Restore
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ---- a selection or folder (job) --------------------------------------------------------------------

export function BulkRestoreModal({
  bucket,
  prefix,
  items,
  deepArchive,
  allDeep,
}: {
  bucket: string;
  prefix: string;
  items: JobItem[];
  /** Some selected objects are in Deep Archive (no Expedited). */
  deepArchive: boolean;
  /** Every item is a Deep Archive object (no folders): the waits shown are Deep Archive's. */
  allDeep: boolean;
}) {
  const folders = items.filter((i) => i.isPrefix).length;
  const [tier, setTier] = useState<RestoreTier>("Standard");
  const [daysText, setDaysText] = useState(String(RESTORE_DAYS.default));
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const close = () => openModal(null);
  const dErr = daysError(daysText);
  // Selected Deep Archive objects rule Expedited out; inside folders the storage classes aren't known.
  const effectiveTier: RestoreTier = deepArchive && tier === "Expedited" ? "Standard" : tier;
  const days = dErr ? null : Number(daysText.trim());
  const request = useMemo<JobRequest | null>(
    () =>
      days === null
        ? null
        : {
            kind: "restore",
            srcBucket: bucket,
            destBucket: null,
            // Exact keys and prefixes of the selection, never rewritten.
            items,
            onConflict: "skip",
            restore: { tier: effectiveTier, days },
          },
    [bucket, items, effectiveTier, days],
  );
  const display = useMemo<JobRequest>(() => ({ kind: "restore", srcBucket: bucket, destBucket: null, items, onConflict: "skip" }), [bucket, items]);
  const [state, retry] = usePreview(request, 300);
  const preview = state?.status === "ok" ? state.preview : null;
  const empty = !!preview && preview.objects === 0;
  const canStart = !!request && !!preview && !empty && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canStart || !request) return;
    setBusy(true);
    const id = await startConfirmedJob(request);
    setBusy(false);
    if (id) close();
  };

  return (
    <ModalShell onClose={close} busy={busy} labelledBy={titleId} wide>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <div className="modal-head">
          <div className="modal-icon">
            <ArchiveRestore size={18} />
          </div>
          <div>
            <h2 id={titleId}>Restore archived objects</h2>
            <p className="muted small mono">{s3Uri(bucket, prefix)}</p>
          </div>
        </div>
        <RestoreOptions
          tier={effectiveTier}
          setTier={setTier}
          daysText={daysText}
          setDaysText={setDaysText}
          deep={allDeep ? true : "mixed"}
          expeditedOff={deepArchive}
          busy={busy}
          showDaysError
        />
        <KeyList request={display} label="Objects with these exact keys, and everything under these prefixes" />
        {request &&
          (state?.status === "ok" ? (
            <div className="preview-line restore-preview" role="status">
              <Info size={14} />
              <span className="grow">
                Checks <strong>{`${preview!.truncated ? "at least " : ""}${plural(preview!.objects, "object")}`}</strong>. Those archived and not yet
                restored are restored; the others are skipped and counted in Activity.
              </span>
            </div>
          ) : (
            <PreviewLine state={state} retry={retry} verb="restore" />
          ))}
        {empty && <div className="hint err-text">Nothing to restore: there are no objects here.</div>}
        {folders > 0 && !deepArchive && effectiveTier === "Expedited" && (
          <p className="muted small">Objects in Glacier Deep Archive have no Expedited retrieval; any found inside the folders fail and are listed in Activity.</p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canStart}>
            {(busy || (request && state?.status === "loading")) && <Loader2 size={14} className="spin" />}
            {busy ? "Starting…" : "Restore archived objects"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
