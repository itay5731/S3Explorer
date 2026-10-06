// The bucket's lifecycle rules (see "Lifecycle configuration" in docs/CONTRACT.md). S3 stores the
// rules as one document that every save replaces, so the dialog loads the whole configuration,
// edits a draft of it, and writes the whole draft back with the loaded one as `expected`: a
// configuration that changed on the server meanwhile is never overwritten. Validation is the
// backend's (`validate_lifecycle`, called live); before saving, a confirmation lists what changes
// and, in red, every rule that deletes data, because a lifecycle rule can empty a bucket a day later.

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Ban,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Loader2,
  Plus,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import * as api from "../lib/api";
import {
  LIFECYCLE_LIMITS,
  type AppError,
  type BucketVersioning,
  type LifecycleConfiguration,
  type LifecycleIssue,
  type LifecycleRule,
} from "../lib/types";
import {
  configurationJson,
  describeRule,
  diffConfigurations,
  duplicateRule,
  emptyRule,
  isNoteIssue,
  ruleDeletesData,
  rulesDeletingData,
  sameConfiguration,
  serverChangedIds,
  type ConfigurationDiff,
} from "../lib/lifecycle";
import { plural } from "../lib/ops";
import { openModal } from "../store/app";
import { isDenied, nothingWritten, permissionText, SAVED_UNREAD_PREFIX, toast } from "../store/toasts";
import { LifecycleRuleEditor } from "./LifecycleRuleEditor";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Wait this long after the last edit before asking the backend to validate. */
const VALIDATE_DEBOUNCE_MS = 200;

interface Row {
  /** Stable React key; never sent. */
  key: number;
  rule: LifecycleRule;
}

let rowSeq = 0;
const toRows = (c: LifecycleConfiguration | null): Row[] =>
  (c?.rules ?? []).map((rule) => ({
    key: ++rowSeq,
    rule: JSON.parse(JSON.stringify(rule)) as LifecycleRule,
  }));

type LoadState =
  | { phase: "loading" }
  | { phase: "ready" }
  | { phase: "unsupported" }
  /** The stored configuration uses something this version can't represent: shown read-only (not at all). */
  | { phase: "unreadable"; message: string }
  | { phase: "error"; error: AppError };

/** `Unknown` from the backend when the stored configuration uses something this version doesn't know. */
const notUnderstood = (e: AppError) => e.code === "Unknown" && /does not understand/i.test(e.message);
/** A refused or partly stored save after which the server's configuration should be read again. */
const needsReread = (e: AppError) => /did not store all of it|Reload to see what is stored now/i.test(e.message);

/** What the confirmation shows, captured when Save is pressed; exactly this is sent. */
interface PendingSave {
  config: LifecycleConfiguration;
  expected: LifecycleConfiguration | null;
  diff: ConfigurationDiff;
  deleting: { index: number; rule: LifecycleRule }[];
  /** Danger styling: a rule that deletes data is added or changed, or the configuration is removed. */
  danger: boolean;
  /** Rule ids someone else changed on the server (after a `Conflict`): saving this draft reverts them. */
  reverts: ReadonlySet<string>;
}

const NO_IDS: ReadonlySet<string> = new Set();
const disabledPrefix = (r: LifecycleRule) => (r.status === "Disabled" ? "(Disabled) " : "");
const REVERTS_TEXT = "reverts a change made on the server";

function RevertsTag({ show }: { show: boolean }) {
  return show ? <span className="lc-reverts">({REVERTS_TEXT})</span> : null;
}

type Prompt = { kind: "close" } | { kind: "discard" } | { kind: "reload" } | null;

const VERSIONING_TEXT: Record<BucketVersioning, string> = {
  Enabled: "Overwritten and deleted objects are kept as noncurrent versions. Noncurrent-version actions decide how long they stay.",
  Suspended:
    "New writes don’t create versions, but versions made while versioning was on still exist; noncurrent-version actions apply to them.",
  Off: "This bucket has no object versions, so noncurrent-version actions have no effect. Expiring an object deletes it permanently.",
};

function VersioningChip({ v, failed }: { v: BucketVersioning | null; failed: boolean }) {
  const label = v ?? (failed ? "Unknown" : "…");
  return (
    <span
      className={`lc-chip lc-ver-${(v ?? "unknown").toLowerCase()}`}
      title={failed ? "The versioning state couldn’t be read" : undefined}
    >
      Versioning: {label}
    </span>
  );
}

// ---- the confirmation --------------------------------------------------------------------------------

function ConfirmSave({
  bucket,
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  bucket: string;
  pending: PendingSave;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const { diff, deleting, config, reverts } = pending;
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (e.key === "Tab" && ref.current) {
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const removing = diff.removesConfiguration;
  return (
    <div
      className="modal-backdrop lc-confirm-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}
      onKeyDown={onKeyDown}
    >
      <div ref={ref} className="modal modal-wide lc-confirm" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-head">
          <div className={`modal-icon ${pending.danger ? "danger" : ""}`}>
            <CalendarClock size={18} />
          </div>
          <div>
            <h2 id={titleId}>{removing ? "Remove all lifecycle rules?" : "Save the lifecycle rules?"}</h2>
            <p className="muted small mono">s3://{bucket}</p>
          </div>
        </div>

        <div className="lc-confirm-body">
          {removing ? (
            <div className="callout danger" role="note">
              <AlertTriangle size={15} />
              <span>
                <strong>The bucket’s lifecycle configuration will be removed.</strong> No rule will apply to this bucket any more: nothing
                is moved, expired or cleaned up automatically until new rules are saved.
              </span>
            </div>
          ) : (
            <p className="muted small">
              This replaces the bucket’s whole lifecycle configuration with {plural(config.rules.length, "rule")}. Rules take effect at the
              next daily run, usually within 48 hours.
            </p>
          )}

          <div className="lc-changes">
            {diff.added.length > 0 && (
              <section>
                <h3>Added ({diff.added.length})</h3>
                <ul>
                  {diff.added.map(({ rule, index }) => (
                    <li key={`a${index}`}>
                      <span className="lc-change-id mono">{rule.id}</span>
                      <span className="lc-change-text">
                        {disabledPrefix(rule)}
                        {describeRule(rule)}
                        <RevertsTag show={reverts.has(rule.id)} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {diff.removed.length > 0 && (
              <section>
                <h3>Removed ({diff.removed.length})</h3>
                <ul>
                  {diff.removed.map(({ rule, index }) => (
                    <li key={`r${index}`}>
                      <span className="lc-change-id mono">{rule.id}</span>
                      <span className="lc-change-text muted">
                        {disabledPrefix(rule)}
                        {describeRule(rule)}
                        <RevertsTag show={reverts.has(rule.id)} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {diff.changed.length > 0 && (
              <section>
                <h3>Changed ({diff.changed.length})</h3>
                <ul>
                  {diff.changed.map(({ before, after, index }) => {
                    const b = `${disabledPrefix(before)}${describeRule(before)}`;
                    const a = `${disabledPrefix(after)}${describeRule(after)}`;
                    return (
                      <li key={`c${index}`}>
                        <span className="lc-change-id mono">{after.id}</span>
                        <span className="lc-change-text">
                          <span className="lc-old">{b}</span>
                          <span className="lc-arrow" aria-label="becomes">
                            →
                          </span>
                          <span>{a}</span>
                          <RevertsTag show={reverts.has(after.id)} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {diff.reordered && <p className="muted small">The order of the rules changes.</p>}
          </div>

          {!removing &&
            (deleting.length > 0 ? (
              <div className="callout danger lc-deleting" role="note">
                <AlertTriangle size={15} />
                <div className="grow">
                  <strong>
                    {deleting.length === 1 ? "1 rule deletes data" : `${deleting.length} rules delete data`}. S3 runs it on its own, without
                    asking again: matching objects are deleted, and can’t be recovered unless versioning keeps older versions.
                  </strong>
                  <ul>
                    {deleting.map(({ rule, index }) => (
                      <li key={index}>
                        <span className="mono">{rule.id}</span>
                        {rule.status === "Disabled" && <span className="lc-badge">Disabled: deletes nothing until enabled</span>}
                        <span className="lc-deleting-text">{describeRule(rule)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="muted small">No rule in the new configuration deletes data.</p>
            ))}
        </div>

        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${pending.danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={busy}
            // Enter must not confirm: only a click or Space does.
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
          >
            {busy && <Loader2 size={14} className="spin" />}
            {busy ? "Saving…" : removing ? "Remove all rules" : `Save ${plural(config.rules.length, "rule")}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- one rule in the list ---------------------------------------------------------------------------

/** Row actions, stable across renders so unchanged rule cards don't re-render (up to 1,000 of them). */
interface RuleActions {
  toggle(key: number): void;
  change(key: number, rule: LifecycleRule): void;
  move(index: number, dir: -1 | 1): void;
  duplicate(index: number): void;
  remove(index: number): void;
}

const NO_ISSUES: LifecycleIssue[] = [];

const RuleCard = memo(function RuleCard({
  row,
  index,
  count,
  issues,
  marker,
  reverts,
  expanded,
  versioning,
  actions,
  canAdd,
}: {
  row: Row;
  index: number;
  count: number;
  issues: LifecycleIssue[];
  marker: "new" | "edited" | null;
  /** After a `Conflict`: this rule differs from a change someone else made on the server. */
  reverts: boolean;
  expanded: boolean;
  versioning: BucketVersioning | null;
  actions: RuleActions;
  canAdd: boolean;
}) {
  const onToggle = () => actions.toggle(row.key);
  const onChange = (r: LifecycleRule) => actions.change(row.key, r);
  const onMove = (d: -1 | 1) => actions.move(index, d);
  const onDuplicate = () => actions.duplicate(index);
  const onDelete = () => actions.remove(index);

  const r = row.rule;
  const deletes = ruleDeletesData(r);
  const enabled = r.status === "Enabled";
  const bodyId = `lc-rule-body-${row.key}`;
  const label = r.id || `rule ${index + 1}`;
  const problems = issues.filter((i) => !isNoteIssue(i)).length;
  return (
    <li
      className={`lc-rule ${expanded ? "expanded" : ""} ${enabled ? "" : "disabled"} ${problems ? "has-issues" : ""}`}
      data-rule-index={index}
      data-row-key={row.key}
    >
      <div className="lc-rule-head">
        <input
          type="checkbox"
          className="switch"
          checked={enabled}
          aria-label={`Rule ${label} enabled`}
          title={enabled ? "Enabled: click to disable" : "Disabled: click to enable"}
          onChange={(e) =>
            onChange({
              ...r,
              status: e.target.checked ? "Enabled" : "Disabled",
            })
          }
        />
        <button type="button" className="lc-rule-title" onClick={onToggle} aria-expanded={expanded} aria-controls={bodyId}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="lc-rule-num">{index + 1}</span>
          <span className="lc-rule-id">{r.id || <em className="muted">no ID</em>}</span>
        </button>
        <span className="lc-badges">
          {!enabled && <span className="lc-badge">Disabled</span>}
          {deletes && (
            <span className="lc-badge danger" title="This rule deletes data (an expiration or a noncurrent-version expiration)">
              <Trash2 size={11} /> deletes data
            </span>
          )}
          {marker && <span className={`lc-badge accent`}>{marker === "new" ? "new" : "edited"}</span>}
          {reverts && (
            <span className="lc-badge reverts" title="Someone else changed this rule on the server; saving your draft undoes that change">
              {REVERTS_TEXT}
            </span>
          )}
          {problems > 0 && (
            <button
              type="button"
              className="lc-badge warn"
              onClick={() => !expanded && onToggle()}
              title="Open the rule to see the problems"
            >
              <AlertCircle size={11} /> {plural(problems, "problem")}
            </button>
          )}
        </span>
        <span className="spacer" />
        <span className="lc-rule-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={`Move rule ${label} up`}
            title="Move up"
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            aria-label={`Move rule ${label} down`}
            title="Move down"
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onDuplicate}
            disabled={!canAdd}
            aria-label={`Duplicate rule ${label}`}
            title="Duplicate"
          >
            <Copy size={14} />
          </button>
          <button
            type="button"
            className="icon-btn lc-delete"
            onClick={onDelete}
            aria-label={`Delete rule ${label}`}
            title="Delete this rule (saved only when you save)"
          >
            <Trash2 size={14} />
          </button>
        </span>
      </div>
      <p className="lc-rule-summary">{describeRule(r)}</p>
      {expanded && (
        <div id={bodyId}>
          <LifecycleRuleEditor rule={r} index={index} issues={issues} versioning={versioning} onChange={onChange} />
        </div>
      )}
    </li>
  );
});

// ---- the dialog -----------------------------------------------------------------------------------

export function LifecycleDialog({ bucket }: { bucket: string }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  /** The configuration on the server as last read: `expected` for the next save. */
  const [loaded, setLoaded] = useState<LifecycleConfiguration | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [versioning, setVersioning] = useState<BucketVersioning | null>(null);
  const [versioningFailed, setVersioningFailed] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [tab, setTab] = useState<"rules" | "json">("rules");
  const [validation, setValidation] = useState<{
    key: string;
    issues: LifecycleIssue[];
  } | null>(null);
  const [validationError, setValidationError] = useState<AppError | null>(null);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  /** Set after a save hit `Conflict` and the server version was reloaded under the draft. */
  const [conflict, setConflict] = useState(false);
  /** The server configuration the draft was made from, kept across `Conflict` reloads (to label reverts). */
  const [conflictBase, setConflictBase] = useState<{ config: LifecycleConfiguration | null } | null>(null);
  /** A save whose result isn't known for sure; the server state was read again under the draft. */
  const [outcome, setOutcome] = useState<{ kind: "applied" | "unknown"; detail: string; reread: boolean } | null>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const titleId = useId();

  const config = useMemo<LifecycleConfiguration>(() => ({ rules: rows.map((r) => r.rule) }), [rows]);
  const configKey = useMemo(() => JSON.stringify(config), [config]);
  const ready = state.phase === "ready";
  const dirty = ready && !sameConfiguration(loaded, config);
  const fresh = validation !== null && validation.key === configKey;
  const issues = fresh ? validation.issues : (validation?.issues ?? []);
  // "Note: …" issues (e.g. a date that has passed) are warnings: shown at the field, never blocking.
  const blocking = useMemo(() => issues.filter((i) => !isNoteIssue(i)), [issues]);
  const valid = fresh && validation.issues.every(isNoteIssue) && !validationError;
  const canSave = ready && dirty && valid && !saving;
  const diff = useMemo(() => diffConfigurations(loaded, config), [loaded, config]);
  /** After a `Conflict`: rule ids someone else changed on the server since the draft was made. */
  const revertIds = useMemo(
    () => (conflictBase ? serverChangedIds(conflictBase.config, loaded) : NO_IDS),
    [conflictBase, loaded],
  );
  const atLimit = rows.length >= LIFECYCLE_LIMITS.maxRules;

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    setSaveError(null);
    setConflict(false);
    setConflictBase(null);
    setOutcome(null);
    setVersioningFailed(false);
    const ver = api.getBucketVersioning(bucket).then(
      (v) => setVersioning(v),
      () => {
        setVersioning(null);
        setVersioningFailed(true);
      },
    );
    try {
      const c = await api.getLifecycle(bucket);
      setLoaded(c);
      setRows(toRows(c));
      setExpanded(null);
      setState({ phase: "ready" });
    } catch (e) {
      const err = e as AppError;
      setState(
        err.code === "NotSupported"
          ? { phase: "unsupported" }
          : notUnderstood(err)
            ? { phase: "unreadable", message: err.message }
            : { phase: "error", error: err },
      );
    }
    await ver;
  }, [bucket]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live validation by the backend, debounced; a late answer for an older draft is ignored.
  const latestKey = useRef(configKey);
  latestKey.current = configKey;
  useEffect(() => {
    if (!ready) return;
    const key = configKey;
    const t = setTimeout(() => {
      api.validateLifecycle(JSON.parse(key) as LifecycleConfiguration).then(
        (res) => {
          if (latestKey.current !== key) return;
          setValidation({ key, issues: res });
          setValidationError(null);
        },
        (e) => {
          if (latestKey.current === key) setValidationError(e as AppError);
        },
      );
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [configKey, ready]);

  // Focus: the dialog itself on open; the opener again on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      requestAnimationFrame(() => {
        if (opener && opener.isConnected && opener !== document.body) opener.focus();
      });
    };
  }, []);
  useEffect(() => {
    if (prompt) keepEditingRef.current?.focus();
  }, [prompt]);

  const close = () => openModal(null);
  const update = (next: Row[]) => {
    setRows(next);
    setSaveError(null);
    setPrompt(null);
  };
  const setRule = (key: number, rule: LifecycleRule) => update(rows.map((r) => (r.key === key ? { ...r, rule } : r)));

  const focusRule = (key: number) =>
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${key}"] .lc-rule-title`);
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });

  const addRule = () => {
    const row = { key: ++rowSeq, rule: emptyRule(rows.map((r) => r.rule.id)) };
    update([...rows, row]);
    setExpanded(row.key);
    setTab("rules");
    focusRule(row.key);
  };
  const duplicate = (i: number) => {
    const row = {
      key: ++rowSeq,
      rule: duplicateRule(
        rows[i].rule,
        rows.map((r) => r.rule.id),
      ),
    };
    update([...rows.slice(0, i + 1), row, ...rows.slice(i + 1)]);
    setExpanded(row.key);
    focusRule(row.key);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
    // Keep focus on the same arrow of the moved rule (if it can still move that way).
    const key = rows[i].key;
    requestAnimationFrame(() => {
      const card = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${key}"]`);
      const btns = card?.querySelectorAll<HTMLButtonElement>(".lc-rule-actions .icon-btn");
      const target = btns?.[dir < 0 ? 0 : 1];
      (target && !target.disabled ? target : card?.querySelector<HTMLElement>(".lc-rule-title"))?.focus();
    });
  };
  const remove = (i: number) => {
    const next = rows.filter((_, k) => k !== i);
    update(next);
    const neighbour = next[Math.min(i, next.length - 1)];
    if (neighbour) focusRule(neighbour.key);
    else requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>(".lc-add")?.focus());
  };

  /** Esc, the backdrop, the close button: ask before dropping unsaved edits. */
  const requestClose = () => {
    if (saving) return;
    if (dirty) setPrompt({ kind: "close" });
    else close();
  };
  const requestReload = () => {
    if (dirty) setPrompt({ kind: "reload" });
    else void load();
  };
  const keepEditing = () => {
    setPrompt(null);
    requestAnimationFrame(() => dialogRef.current?.focus());
  };
  const confirmPrompt = () => {
    const p = prompt;
    setPrompt(null);
    if (!p) return;
    if (p.kind === "close") close();
    else if (p.kind === "reload") void load();
    else {
      setRows(toRows(loaded));
      setExpanded(null);
      setSaveError(null);
      requestAnimationFrame(() => dialogRef.current?.focus());
    }
  };

  const startSave = () => {
    if (!canSave) return;
    // Capture exactly what the confirmation shows; this is what is sent.
    const snapshot = JSON.parse(configKey) as LifecycleConfiguration;
    const expected = loaded ? (JSON.parse(JSON.stringify(loaded)) as LifecycleConfiguration) : null;
    const d = diffConfigurations(expected, snapshot);
    const deletingIds = new Set([...d.added.map((x) => x.index), ...d.changed.map((x) => x.index)]);
    const deleting = rulesDeletingData(snapshot);
    setPending({
      config: snapshot,
      expected,
      diff: d,
      deleting,
      danger: d.removesConfiguration || deleting.some((x) => deletingIds.has(x.index)),
      reverts: new Set(revertIds),
    });
  };

  const confirmSave = async () => {
    if (!pending) return;
    setSaving(true);
    setSaveError(null);
    setOutcome(null);
    try {
      await api.putLifecycle(bucket, pending.config, pending.expected);
      toast.success(pending.diff.removesConfiguration ? "Lifecycle configuration removed" : "Lifecycle rules saved", `s3://${bucket}`);
      setPending(null);
      close();
    } catch (e) {
      const err = e as AppError;
      setPending(null);
      if (err.code === "Conflict") {
        toast.warning("Lifecycle rules changed on the server", "Your edits are kept. Review the current rules and save again.");
        try {
          // The server's version becomes `expected`; the draft stays as the user left it. The version
          // the draft was made from is kept (first conflict only) to tell which differences undo
          // someone else's change.
          const base = pending.expected;
          setLoaded(await api.getLifecycle(bucket));
          setConflictBase((cur) => cur ?? { config: base });
          setConflict(true);
        } catch (e2) {
          setSaveError(e2 as AppError);
        }
      } else if (notUnderstood(err)) {
        setState({ phase: "unreadable", message: err.message });
      } else if (err.code !== "NotSupported" && !nothingWritten(err)) {
        // The write may have landed ("Saved, but reading back failed…": it did). Never say nothing
        // changed; read the server's configuration again under the draft before anything else can be
        // done (saving stays on until then). If it was applied, the draft now equals it.
        const kind = err.message.startsWith(SAVED_UNREAD_PREFIX) ? "applied" : "unknown";
        let reread = false;
        try {
          setLoaded(await api.getLifecycle(bucket));
          reread = true;
        } catch {
          /* said in the callout */
        }
        setOutcome({ kind, detail: err.message, reread });
      } else {
        // NotSupported on save: the server refused part of this configuration ("Nothing was changed")
        // or stored only part of it and the previous one was put back. Either way the draft stays so
        // it can be adjusted; when the server may hold something else now, read it again.
        setSaveError(err);
        if (needsReread(err)) {
          try {
            setLoaded(await api.getLifecycle(bucket));
          } catch {
            /* the save error already says to reload */
          }
        }
      }
    } finally {
      setSaving(false);
      requestAnimationFrame(() => dialogRef.current?.focus());
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keep keys inside the dialog: the explorer's global shortcuts must not see them.
    e.stopPropagation();
    if (pending) return; // the confirmation handles its own keys
    if (e.key === "Escape") {
      e.preventDefault();
      if (prompt) keepEditing();
      else requestClose();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(configurationJson(config));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn’t copy to the clipboard");
    }
  };

  // Stable for RuleCard's memo; always calls the latest handlers.
  const latest = useRef({ setRule, move, duplicate, remove, setExpanded });
  latest.current = { setRule, move, duplicate, remove, setExpanded };
  const actions = useMemo<RuleActions>(
    () => ({
      toggle: (key) => latest.current.setExpanded((cur) => (cur === key ? null : key)),
      change: (key, rule) => latest.current.setRule(key, rule),
      move: (i, d) => latest.current.move(i, d),
      duplicate: (i) => latest.current.duplicate(i),
      remove: (i) => latest.current.remove(i),
    }),
    [],
  );

  const configIssues = blocking.filter((i) => i.ruleIndex === null);
  const issuesByRule = useMemo(() => {
    const m = new Map<number, LifecycleIssue[]>();
    for (const i of issues) if (i.ruleIndex !== null) m.set(i.ruleIndex, [...(m.get(i.ruleIndex) ?? []), i]);
    return m;
  }, [issues]);
  const addedIdx = new Set(diff.added.map((x) => x.index));
  const changedIdx = new Set(diff.changed.map((x) => x.index));
  const invalidCount = new Set(blocking.filter((i) => i.ruleIndex !== null).map((i) => i.ruleIndex)).size;
  /** Draft rules that differ from the server; those whose server version someone else changed are reverts. */
  const differs = new Set([...diff.added.map((x) => x.rule.id), ...diff.changed.map((x) => x.after.id)]);

  const saveTitle = !ready
    ? undefined
    : !dirty
      ? "Nothing has changed"
      : !fresh
        ? "Checking the rules…"
        : !valid
          ? "Fix the problems first"
          : undefined;

  const promptText =
    prompt?.kind === "reload"
      ? "Discard your changes and reload?"
      : prompt?.kind === "discard"
        ? "Discard all changes?"
        : "Discard unsaved changes?";

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && requestClose()} onKeyDown={onKeyDown}>
      <div ref={dialogRef} className="modal lc-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="settings-head">
          <div className="modal-icon">
            <CalendarClock size={17} />
          </div>
          <div className="lc-title">
            <h2 id={titleId}>Lifecycle rules</h2>
            <span className="muted small mono">s3://{bucket}</span>
          </div>
          <div className="spacer" />
          {ready && (
            <span className={`lc-count ${atLimit ? "at-limit" : ""}`} title="S3 allows at most 1,000 rules per bucket">
              {rows.length.toLocaleString("en-US")} of 1,000 rules
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={requestReload}
            disabled={saving || state.phase === "loading"}
            title="Read the rules from the server again"
          >
            <RotateCw size={12} className={state.phase === "loading" ? "spin" : ""} /> Reload
          </button>
          <button
            type="button"
            className="icon-btn lg"
            onClick={requestClose}
            aria-label="Close lifecycle rules"
            title="Close (Esc)"
            disabled={saving}
          >
            <X size={16} />
          </button>
        </header>

        {ready && (
          <div className="lc-bar">
            <VersioningChip v={versioning} failed={versioningFailed} />
            <span className="muted small lc-ver-text">
              {versioning
                ? VERSIONING_TEXT[versioning]
                : versioningFailed
                  ? "The versioning state couldn’t be read; noncurrent-version actions apply only if versioning was ever enabled."
                  : ""}
            </span>
            <div className="segmented lc-tabs" role="tablist" aria-label="View">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "rules"}
                className={tab === "rules" ? "active" : ""}
                onClick={() => setTab("rules")}
              >
                Rules
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "json"}
                className={tab === "json" ? "active" : ""}
                onClick={() => setTab("json")}
              >
                As JSON
              </button>
            </div>
          </div>
        )}

        <div className="lc-body">
          {state.phase === "loading" ? (
            <div className="settings-state muted" role="status">
              <Loader2 size={16} className="spin" /> Loading lifecycle rules…
            </div>
          ) : state.phase === "unsupported" ? (
            <div className="tags-unsupported" role="status">
              <Ban size={18} />
              <div>
                <strong>This server doesn’t support lifecycle rules.</strong>
                <p className="muted small">Some S3-compatible services implement lifecycle configuration only partly or not at all.</p>
              </div>
            </div>
          ) : state.phase === "unreadable" ? (
            <div className="tags-unsupported" role="status">
              <Ban size={18} />
              <div>
                <strong>These lifecycle rules can’t be shown or edited here.</strong>
                <p className="muted small lc-unreadable">{state.message}</p>
              </div>
            </div>
          ) : state.phase === "error" ? (
            <div className="inline-error" role="alert">
              <AlertCircle size={14} />
              <div className="grow">
                <div>
                  <strong>
                    {isDenied(state.error) ? `${permissionText("view lifecycle rules")}.` : "Couldn’t load the lifecycle rules."}
                  </strong>
                </div>
                <div>{state.error.message}</div>
              </div>
              {!isDenied(state.error) && (
                <button type="button" className="btn btn-sm" onClick={() => void load()}>
                  <RotateCw size={12} /> Retry
                </button>
              )}
            </div>
          ) : (
            <>
              {conflict && (
                <div className="callout warn" role="status">
                  <AlertTriangle size={15} />
                  <span>
                    <strong>Someone changed this configuration since you loaded it.</strong> Your edits are kept; review the current rules
                    and save again. Rules marked “new” or “edited” differ from what is on the server now
                    {diff.removed.length
                      ? `, and ${plural(diff.removed.length, "rule")} on the server ${diff.removed.length === 1 ? "is" : "are"} not in your draft`
                      : ""}
                    . “As JSON” shows both.
                  </span>
                </div>
              )}
              {outcome && (
                <div className="callout warn" role="alert" data-save-outcome={outcome.kind}>
                  <AlertTriangle size={15} />
                  <span>
                    <strong>
                      {outcome.kind === "applied"
                        ? "The rules were probably saved, but reading them back failed."
                        : "Couldn’t confirm whether the save was applied."}
                    </strong>{" "}
                    {outcome.reread
                      ? dirty
                        ? "The server’s configuration was read again: rules marked “new” or “edited” differ from it."
                        : "The server’s configuration was read again and matches your rules."
                      : "Reading the configuration again failed too: reload before saving again."}
                    <span className="small save-outcome-detail">{outcome.detail}</span>
                  </span>
                </div>
              )}
              {saveError && (
                <div className="inline-error" role="alert">
                  <AlertCircle size={14} />
                  <div className="grow">
                    <div>
                      <strong>
                        {isDenied(saveError)
                          ? `${permissionText("change lifecycle rules")}.`
                          : saveError.code === "NotSupported"
                            ? "The server didn’t accept these rules."
                            : "Couldn’t save the lifecycle rules."}
                      </strong>
                      {(isDenied(saveError) || saveError.code === "InvalidInput") && " Nothing was changed."}
                    </div>
                    <div>{saveError.message}</div>
                  </div>
                </div>
              )}
              {validationError && (
                <div className="inline-error" role="alert">
                  <AlertCircle size={14} />
                  <div className="grow">
                    <strong>Couldn’t check the rules.</strong> {validationError.message}
                  </div>
                </div>
              )}
              {configIssues.length > 0 && (
                <div className="callout danger" role="status">
                  <AlertTriangle size={15} />
                  <ul className="lc-issues">
                    {configIssues.map((i, n) => (
                      <li key={n}>{i.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {tab === "rules" ? (
                <>
                  {rows.length === 0 ? (
                    <div className="lc-empty">
                      <CalendarClock size={22} />
                      <p>
                        <strong>{loaded ? "All rules removed." : "This bucket has no lifecycle rules."}</strong>
                      </p>
                      <p className="muted small">
                        {loaded
                          ? "Saving now removes the bucket’s lifecycle configuration."
                          : "Rules move objects to cheaper storage classes, delete them after a time, or clean up unfinished uploads."}
                      </p>
                    </div>
                  ) : (
                    <ol className="lc-rules" ref={listRef} aria-label="Rules, in the order S3 keeps them">
                      {rows.map((row, i) => (
                        <RuleCard
                          key={row.key}
                          row={row}
                          index={i}
                          count={rows.length}
                          issues={issuesByRule.get(i) ?? NO_ISSUES}
                          marker={addedIdx.has(i) ? "new" : changedIdx.has(i) ? "edited" : null}
                          reverts={differs.has(row.rule.id) && revertIds.has(row.rule.id)}
                          expanded={expanded === row.key}
                          versioning={versioning}
                          actions={actions}
                          canAdd={!atLimit}
                        />
                      ))}
                    </ol>
                  )}
                  {diff.removed.length > 0 && (
                    <p className="lc-removed small">
                      <Trash2 size={12} /> {conflict ? "On the server but not in your draft" : "Removed (until you save)"}:{" "}
                      {diff.removed.map((x) => x.rule.id + (revertIds.has(x.rule.id) ? ` (${REVERTS_TEXT})` : "")).join(", ")}
                    </p>
                  )}
                  <div>
                    <button
                      type="button"
                      className="btn btn-sm lc-add"
                      onClick={addRule}
                      disabled={atLimit}
                      title={atLimit ? "S3 allows at most 1,000 rules" : undefined}
                    >
                      <Plus size={13} /> Add rule
                    </button>
                  </div>
                </>
              ) : (
                <div className="lc-json">
                  <div className="lc-json-head">
                    <span className="field-label">{dirty ? "Your draft (not saved)" : "The configuration"}</span>
                    <button type="button" className="btn btn-sm" onClick={() => void copyJson()}>
                      <ClipboardCopy size={12} /> {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="code-box lc-pre" tabIndex={0} aria-label="The configuration as JSON">
                    {configurationJson(config)}
                  </pre>
                  {(dirty || conflict) && (
                    <>
                      <div className="lc-json-head">
                        <span className="field-label">
                          {conflict ? "Current on the server (read again after the conflict)" : "On the server (as loaded)"}
                        </span>
                      </div>
                      <pre className="code-box lc-pre lc-pre-server" tabIndex={0} aria-label="The configuration on the server as JSON">
                        {loaded ? configurationJson(loaded) : "No configuration (null)"}
                      </pre>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <footer className="settings-foot">
          {prompt ? (
            <>
              <span className="confirm-text" role="alert">
                <AlertTriangle size={14} /> {promptText}
              </span>
              <div className="spacer" />
              <button ref={keepEditingRef} type="button" className="btn" onClick={keepEditing}>
                Keep editing
              </button>
              <button type="button" className="btn btn-danger" onClick={confirmPrompt}>
                {prompt.kind === "reload" ? "Discard and reload" : "Discard"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setPrompt({ kind: "discard" })}
                disabled={!dirty || saving}
                title="Go back to the rules as loaded"
              >
                <RotateCw size={13} /> Discard changes
              </button>
              <div className="spacer" />
              {ready && fresh && invalidCount + configIssues.length > 0 && (
                <span className="small err-text lc-foot-issues">
                  <AlertCircle size={13} /> {invalidCount > 0 ? `${plural(invalidCount, "rule")} with problems` : "Problems to fix"}
                </span>
              )}
              {dirty && !saving && <span className="unsaved muted small">Unsaved changes</span>}
              <button type="button" className="btn" onClick={requestClose} disabled={saving}>
                {dirty ? "Cancel" : "Close"}
              </button>
              <button type="button" className="btn btn-primary" onClick={startSave} disabled={!canSave} title={saveTitle}>
                {saving && <Loader2 size={14} className="spin" />} {saving ? "Saving…" : "Save…"}
              </button>
            </>
          )}
        </footer>
      </div>
      {pending && (
        <ConfirmSave
          bucket={bucket}
          pending={pending}
          busy={saving}
          onCancel={() => {
            setPending(null);
            requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>(".settings-foot .btn-primary")?.focus());
          }}
          onConfirm={() => void confirmSave()}
        />
      )}
    </div>
  );
}
