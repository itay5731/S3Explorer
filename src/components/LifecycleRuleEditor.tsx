// The form for one lifecycle rule (see "Lifecycle configuration" in docs/CONTRACT.md). It edits a
// LifecycleRule in place and shows, at each field, the issues `validate_lifecycle` returned for it;
// it never decides validity itself. Number fields keep what was typed: a value that isn't a whole
// number reaches the validator and is reported there.

import { useEffect, useId, useState, type ReactNode } from "react";
import { AlertTriangle, Info, Plus, X } from "lucide-react";
import type {
  BucketVersioning,
  LifecycleFilter,
  LifecycleIssue,
  LifecycleRule,
  NoncurrentTransition,
  Transition,
  TransitionStorageClass,
} from "../lib/types";
import { STORAGE_CLASS_RANK, TAG_LIMITS } from "../lib/types";
import {
  SIZE_UNITS,
  STORAGE_CLASS_NAMES,
  TRANSITION_CLASSES,
  dateFromInput,
  dateInputValue,
  describeFilter,
  fromBytes,
  isEmptyFilter,
  toBytes,
  unitBytes,
  type SizeUnit,
} from "../lib/lifecycle";

// ---- issues ---------------------------------------------------------------------------------

/** Where the editor shows issues: everything else lands at the top of the rule. */
const SECTION_PREFIXES = [
  "id",
  "filter.prefix",
  "filter.tags",
  "filter.objectSize",
  "transitions[",
  "expiration.",
  "noncurrentVersionTransitions[",
  "noncurrentVersionExpiration.",
  "abortIncompleteMultipartUpload.",
];

/** Issues of one rule, looked up by `field` (exact) or by a field prefix (a whole row or block). */
export class RuleIssues {
  readonly all: LifecycleIssue[];
  private counts: { transitions: number; noncurrent: number; tags: number };
  constructor(all: LifecycleIssue[], rule: LifecycleRule) {
    this.all = all;
    this.counts = {
      transitions: rule.transitions.length,
      noncurrent: rule.noncurrentVersionTransitions.length,
      tags: rule.filter.tags.length,
    };
  }
  at = (field: string) => this.all.filter((i) => i.field === field);
  under = (prefix: string) => this.all.filter((i) => i.field !== null && i.field.startsWith(prefix));
  has = (field: string) => this.all.some((i) => i.field === field);
  /** Issues with no field, or a field the form doesn't show (e.g. a row that no longer exists). */
  general(): LifecycleIssue[] {
    const rowIndex = (f: string, list: string) => {
      const m = new RegExp(`^${list.replace(/[[\].]/g, "\\$&")}\\[(\\d+)\\]`).exec(f);
      return m ? Number(m[1]) : -1;
    };
    return this.all.filter((i) => {
      const f = i.field;
      if (f === null) return true;
      if (!SECTION_PREFIXES.some((p) => f === p || f.startsWith(p))) return true;
      if (f.startsWith("transitions[") && rowIndex(f, "transitions") >= this.counts.transitions) return true;
      if (f.startsWith("noncurrentVersionTransitions[") && rowIndex(f, "noncurrentVersionTransitions") >= this.counts.noncurrent)
        return true;
      if (f.startsWith("filter.tags[") && rowIndex(f, "filter.tags") >= this.counts.tags) return true;
      return false;
    });
  }
}

export function IssueList({ issues, id }: { issues: LifecycleIssue[]; id?: string }) {
  if (!issues.length) return null;
  return (
    <ul className="lc-issues" id={id}>
      {issues.map((i, n) => (
        <li key={n} className="err-text">
          {i.message}
        </li>
      ))}
    </ul>
  );
}

// ---- inputs -----------------------------------------------------------------------------------

const parseNum = (t: string): number | null => (t.trim() === "" ? null : Number(t.trim()));
const showNum = (n: number | null) => (n === null || Number.isNaN(n) ? "" : String(n));

/**
 * A number typed as text: what the user types stays on screen (no reformatting mid-edit), the parent
 * gets a number (or null when empty). Text that isn't a number is sent as NaN (JSON null).
 */
export function NumField({
  value,
  onChange,
  label,
  invalid,
  describedBy,
  placeholder,
  className = "",
  disabled,
}: {
  value: number | null;
  onChange(n: number | null): void;
  label: string;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(showNum(value));
  useEffect(() => {
    // Only when the value changed from outside (e.g. a unit switch or a reload).
    setText((t) => (Object.is(parseNum(t), value) ? t : showNum(value)));
  }, [value]);
  return (
    <input
      className={`num-input lc-num ${className}`}
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseNum(e.target.value));
      }}
    />
  );
}

function ClassSelect({
  value,
  onChange,
  label,
  invalid,
}: {
  value: TransitionStorageClass;
  onChange(c: TransitionStorageClass): void;
  label: string;
  invalid?: boolean;
}) {
  return (
    <select
      className="lc-select lc-class"
      value={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value as TransitionStorageClass)}
    >
      {TRANSITION_CLASSES.map((c) => (
        <option key={c} value={c}>
          {STORAGE_CLASS_NAMES[c]} · {c}
        </option>
      ))}
    </select>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange(v: T): void;
  label: string;
  className?: string;
}) {
  // A radio group: one tab stop, arrows move (like the other segmented controls' buttons, but keyboard-first).
  const move = (dir: number) => {
    const i = options.findIndex(([v]) => v === value);
    const next = options[(i + dir + options.length) % options.length][0];
    onChange(next);
    return next;
  };
  return (
    <div
      className={`segmented lc-seg ${className}`}
      role="radiogroup"
      aria-label={label}
      style={{ gridTemplateColumns: `repeat(${options.length}, auto)` }}
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === value}
          tabIndex={v === value ? 0 : -1}
          className={v === value ? "active" : ""}
          onClick={() => onChange(v)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              const next = move(e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1);
              const group = e.currentTarget.parentElement;
              requestAnimationFrame(() => group?.querySelector<HTMLButtonElement>(`[data-v="${next}"]`)?.focus());
            }
          }}
          data-v={v}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A size condition: a number and a unit, stored as bytes (null = no condition). */
function SizeField({
  bytes,
  onChange,
  label,
  invalid,
  describedBy,
}: {
  bytes: number | null;
  onChange(b: number | null): void;
  label: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [unit, setUnit] = useState<SizeUnit>(() => (bytes === null ? "MiB" : fromBytes(bytes).unit));
  const shown = bytes === null || Number.isNaN(bytes) ? bytes : bytes / unitBytes(unit);
  return (
    <span className="lc-size">
      <NumField
        value={shown}
        onChange={(n) => onChange(n === null ? null : toBytes(n, unit))}
        label={label}
        invalid={invalid}
        describedBy={describedBy}
        placeholder="no limit"
      />
      <select
        className="lc-select lc-unit"
        value={unit}
        aria-label={`${label}: unit`}
        onChange={(e) => {
          const next = e.target.value as SizeUnit;
          setUnit(next);
          if (shown !== null && !Number.isNaN(shown)) onChange(toBytes(shown, next));
        }}
      >
        {SIZE_UNITS.map((u) => (
          <option key={u.unit} value={u.unit}>
            {u.unit}
          </option>
        ))}
      </select>
    </span>
  );
}

function Section({ title, children, note, className = "" }: { title: string; children: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <fieldset className={`lc-section ${className}`}>
      <legend>{title}</legend>
      {note}
      {children}
    </fieldset>
  );
}

// ---- defaults for added rows ------------------------------------------------------------------------

/** The class for an added transition: the warmest one colder than every existing one (null: none left). */
function nextClass(list: { storageClass: TransitionStorageClass }[]): TransitionStorageClass | null {
  const top = Math.max(0, ...list.map((t) => STORAGE_CLASS_RANK[t.storageClass] ?? 0));
  return TRANSITION_CLASSES.find((c) => STORAGE_CLASS_RANK[c] > top) ?? null;
}
const maxDays = (ns: (number | null)[]) => ns.reduce<number>((m, n) => (typeof n === "number" && Number.isFinite(n) && n > m ? n : m), 0);

type ExpMode = "none" | "days" | "date" | "markers";

const expMode = (r: LifecycleRule): ExpMode => {
  const e = r.expiration;
  if (!e) return "none";
  if (e.days !== null) return "days";
  if (e.date !== null) return "date";
  return e.expiredObjectDeleteMarker ? "markers" : "days";
};

// ---- the editor ------------------------------------------------------------------------------------

export function LifecycleRuleEditor({
  rule,
  index,
  issues,
  versioning,
  onChange,
}: {
  rule: LifecycleRule;
  index: number;
  issues: LifecycleIssue[];
  versioning: BucketVersioning | null;
  onChange(r: LifecycleRule): void;
}) {
  const uid = useId();
  // "On date" chosen while no date is set yet: the data alone (both null) can't say so.
  const [dateRows, setDateRows] = useState<ReadonlySet<number>>(new Set());
  const [expWantsDate, setExpWantsDate] = useState(false);
  const iss = new RuleIssues(issues, rule);
  const f = rule.filter;
  const setFilter = (patch: Partial<LifecycleFilter>) => onChange({ ...rule, filter: { ...f, ...patch } });
  const fid = (field: string) => `${uid}-${field.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const general = iss.general();
  const emptyFilter = isEmptyFilter(f);

  // Transitions (current versions).
  const setTransition = (j: number, t: Transition) =>
    onChange({
      ...rule,
      transitions: rule.transitions.map((x, k) => (k === j ? t : x)),
    });
  const addTransition = () => {
    const days = maxDays(rule.transitions.map((t) => t.days));
    const cls = nextClass(rule.transitions) ?? "GLACIER";
    onChange({
      ...rule,
      transitions: [...rule.transitions, { days: days ? days + 30 : 30, date: null, storageClass: cls }],
    });
  };
  const canAddTransition = nextClass(rule.transitions) !== null;

  // Noncurrent-version transitions.
  const setNct = (j: number, t: NoncurrentTransition) =>
    onChange({
      ...rule,
      noncurrentVersionTransitions: rule.noncurrentVersionTransitions.map((x, k) => (k === j ? t : x)),
    });
  const addNct = () => {
    const days = maxDays(rule.noncurrentVersionTransitions.map((t) => t.noncurrentDays));
    const cls = nextClass(rule.noncurrentVersionTransitions) ?? "GLACIER";
    onChange({
      ...rule,
      noncurrentVersionTransitions: [
        ...rule.noncurrentVersionTransitions,
        {
          noncurrentDays: days ? days + 30 : 30,
          newerNoncurrentVersions: null,
          storageClass: cls,
        },
      ],
    });
  };
  const canAddNct = nextClass(rule.noncurrentVersionTransitions) !== null;

  const derived = expMode(rule);
  const e0 = rule.expiration;
  const mode: ExpMode =
    derived === "days" && expWantsDate && e0 && e0.days === null && e0.date === null && !e0.expiredObjectDeleteMarker ? "date" : derived;
  const setExpMode = (m: ExpMode) => {
    const e = rule.expiration;
    setExpWantsDate(m === "date");
    // Picking a mode (even the current one) keeps only what that mode uses. A deletion delay is
    // never pre-filled: the user types it.
    if (m === "none") onChange({ ...rule, expiration: null });
    else if (m === "days")
      onChange({
        ...rule,
        expiration: {
          days: e?.days ?? null,
          date: null,
          expiredObjectDeleteMarker: false,
        },
      });
    else if (m === "date")
      onChange({
        ...rule,
        expiration: {
          days: null,
          date: e?.date ?? null,
          expiredObjectDeleteMarker: false,
        },
      });
    else
      onChange({
        ...rule,
        expiration: { days: null, date: null, expiredObjectDeleteMarker: true },
      });
  };

  const versioned = versioning === "Enabled" || versioning === "Suspended";
  const nce = rule.noncurrentVersionExpiration;
  const abort = rule.abortIncompleteMultipartUpload;

  return (
    <div className="lc-editor" role="group" aria-label={`Edit rule ${index + 1}`}>
      {general.length > 0 && (
        <div className="callout danger lc-general" role="status">
          <AlertTriangle size={15} />
          <IssueList issues={general} />
        </div>
      )}

      <div className="lc-row lc-id-row">
        <label className="field lc-id">
          <span className="field-label">Rule ID</span>
          <input
            value={rule.id}
            spellCheck={false}
            autoComplete="off"
            maxLength={1000}
            aria-invalid={iss.has("id") || undefined}
            aria-describedby={fid("id")}
            onChange={(e) => onChange({ ...rule, id: e.target.value })}
            data-lc-field="id"
          />
        </label>
        <label className="lc-status check">
          <input
            type="checkbox"
            className="switch"
            checked={rule.status === "Enabled"}
            onChange={(e) =>
              onChange({
                ...rule,
                status: e.target.checked ? "Enabled" : "Disabled",
              })
            }
          />
          {rule.status === "Enabled" ? "Enabled" : "Disabled: kept, but does nothing"}
        </label>
      </div>
      <IssueList issues={iss.at("id")} id={fid("id")} />

      {/* ---- filter ---- */}
      <Section title="Which objects">
        {emptyFilter ? (
          <div className="callout warn lc-all-objects" role="status">
            <AlertTriangle size={15} />
            <span>
              <strong>This rule applies to every object in the bucket.</strong> Add a prefix, tags or a size to narrow it.
            </span>
          </div>
        ) : (
          <p className="lc-filter-summary" aria-live="polite">
            Applies to: <strong>{describeFilter(f)}</strong>
          </p>
        )}
        <label className="field">
          <span className="field-label">
            Prefix <span className="optional">optional</span>
          </span>
          <input
            value={f.prefix ?? ""}
            placeholder="e.g. logs/"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={iss.has("filter.prefix") || undefined}
            aria-describedby={fid("filter.prefix")}
            onChange={(e) =>
              setFilter({
                prefix: e.target.value === "" ? null : e.target.value,
              })
            }
            data-lc-field="filter.prefix"
          />
        </label>
        <IssueList issues={iss.at("filter.prefix")} id={fid("filter.prefix")} />

        <div className="field">
          <span className="field-label">
            Object tags <span className="optional">all must match</span>
          </span>
          {f.tags.length > 0 && (
            <div className="lc-tags" role="group" aria-label="Filter tags">
              {f.tags.map((t, j) => {
                const tagIssues = iss.under(`filter.tags[${j}]`);
                return (
                  <div key={j} className="lc-tag-row">
                    <input
                      value={t.key}
                      placeholder="key"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={`Filter tag ${j + 1} key`}
                      aria-invalid={tagIssues.length > 0 || undefined}
                      onChange={(e) =>
                        setFilter({
                          tags: f.tags.map((x, k) => (k === j ? { ...x, key: e.target.value } : x)),
                        })
                      }
                      data-lc-field={`filter.tags[${j}].key`}
                    />
                    <input
                      value={t.value}
                      placeholder="value"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={`Filter tag ${j + 1} value`}
                      onChange={(e) =>
                        setFilter({
                          tags: f.tags.map((x, k) => (k === j ? { ...x, value: e.target.value } : x)),
                        })
                      }
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove filter tag ${t.key || j + 1}`}
                      title="Remove this tag"
                      onClick={() => setFilter({ tags: f.tags.filter((_, k) => k !== j) })}
                    >
                      <X size={13} />
                    </button>
                    <IssueList issues={tagIssues} />
                  </div>
                );
              })}
            </div>
          )}
          <div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setFilter({ tags: [...f.tags, { key: "", value: "" }] })}
              disabled={f.tags.length >= TAG_LIMITS.objectMaxTags}
            >
              <Plus size={13} /> Add tag
            </button>
          </div>
          <IssueList issues={iss.at("filter.tags")} />
        </div>

        <div className="lc-row lc-sizes">
          <div className="field">
            <span className="field-label">
              Larger than <span className="optional">optional</span>
            </span>
            <SizeField
              bytes={f.objectSizeGreaterThan}
              onChange={(b) => setFilter({ objectSizeGreaterThan: b })}
              label="Object size larger than"
              invalid={iss.has("filter.objectSizeGreaterThan")}
              describedBy={fid("filter.objectSizeGreaterThan")}
            />
          </div>
          <div className="field">
            <span className="field-label">
              Smaller than <span className="optional">optional</span>
            </span>
            <SizeField
              bytes={f.objectSizeLessThan}
              onChange={(b) => setFilter({ objectSizeLessThan: b })}
              label="Object size smaller than"
              invalid={iss.has("filter.objectSizeLessThan")}
              describedBy={fid("filter.objectSizeLessThan")}
            />
          </div>
        </div>
        <IssueList issues={iss.at("filter.objectSizeGreaterThan")} id={fid("filter.objectSizeGreaterThan")} />
        <IssueList issues={iss.at("filter.objectSizeLessThan")} id={fid("filter.objectSizeLessThan")} />
      </Section>

      {/* ---- current versions ---- */}
      <Section
        title={versioned ? "Current versions" : "Objects"}
        note={
          versioning === "Enabled" ? (
            <p className="muted small lc-note">
              With versioning on, “expire” doesn’t remove data at once: it adds a delete marker and the object becomes a noncurrent version
              (see below).
            </p>
          ) : null
        }
      >
        <div className="field">
          <span className="field-label">Move to another storage class</span>
          {rule.transitions.map((t, j) => {
            const base = `transitions[${j}]`;
            const useDate = t.days === null && (t.date !== null || dateRows.has(j));
            return (
              <div key={j} className="lc-action-row">
                <div className="lc-action-line">
                  <ClassSelect
                    value={t.storageClass}
                    onChange={(storageClass) => setTransition(j, { ...t, storageClass })}
                    label={`Transition ${j + 1} storage class`}
                    invalid={iss.has(`${base}.storageClass`)}
                  />
                  <Segmented
                    value={useDate ? "date" : "days"}
                    options={[
                      ["days", "After days"],
                      ["date", "On date"],
                    ]}
                    label={`Transition ${j + 1}: when`}
                    onChange={(v) => {
                      const next = new Set(dateRows);
                      if (v === "date") next.add(j);
                      else next.delete(j);
                      setDateRows(next);
                      setTransition(j, v === "date" ? { ...t, days: null } : { ...t, date: null });
                    }}
                  />
                  {useDate ? (
                    <input
                      type="date"
                      className="lc-date"
                      value={dateInputValue(t.date)}
                      aria-label={`Transition ${j + 1} date (midnight UTC)`}
                      aria-invalid={iss.has(`${base}.date`) || undefined}
                      onChange={(e) =>
                        setTransition(j, {
                          ...t,
                          date: dateFromInput(e.target.value),
                        })
                      }
                    />
                  ) : (
                    <span className="lc-inline">
                      <NumField
                        value={t.days}
                        onChange={(days) => setTransition(j, { ...t, days })}
                        label={`Transition ${j + 1} days after creation`}
                        invalid={iss.has(`${base}.days`)}
                      />
                      <span className="muted small">days after creation</span>
                    </span>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove transition ${j + 1}`}
                    title="Remove this transition"
                    onClick={() => {
                      // Row indices after j shift down by one.
                      setDateRows(new Set([...dateRows].filter((k) => k !== j).map((k) => (k > j ? k - 1 : k))));
                      onChange({
                        ...rule,
                        transitions: rule.transitions.filter((_, k) => k !== j),
                      });
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
                <IssueList issues={iss.under(`${base}.`)} />
              </div>
            );
          })}
          <div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={addTransition}
              disabled={!canAddTransition}
              title={canAddTransition ? undefined : "Every colder class is already used"}
            >
              <Plus size={13} /> Add transition
            </button>
          </div>
        </div>

        <div className="field">
          <span className="field-label">Expire (delete)</span>
          <div className="lc-action-line">
            <Segmented
              value={mode}
              options={[
                ["none", "Never"],
                ["days", "After days"],
                ["date", "On date"],
                ["markers", "Delete markers only"],
              ]}
              label="Expiration"
              onChange={setExpMode}
            />
            {mode === "days" && (
              <span className="lc-inline">
                <NumField
                  value={rule.expiration?.days ?? null}
                  onChange={(days) =>
                    onChange({
                      ...rule,
                      expiration: {
                        days,
                        date: rule.expiration?.date ?? null,
                        expiredObjectDeleteMarker: rule.expiration?.expiredObjectDeleteMarker ?? false,
                      },
                    })
                  }
                  label="Expire days after creation"
                  invalid={iss.has("expiration.days")}
                />
                <span className="muted small">days after creation</span>
              </span>
            )}
            {mode === "date" && (
              <input
                type="date"
                className="lc-date"
                value={dateInputValue(rule.expiration?.date ?? null)}
                aria-label="Expiration date (midnight UTC)"
                aria-invalid={iss.has("expiration.date") || undefined}
                onChange={(e) =>
                  onChange({
                    ...rule,
                    expiration: {
                      days: null,
                      date: dateFromInput(e.target.value),
                      expiredObjectDeleteMarker: false,
                    },
                  })
                }
              />
            )}
          </div>
          {mode === "markers" && (
            <p className="muted small">
              Removes delete markers that no longer have any older version behind them. Object data is not affected.
            </p>
          )}
          {mode !== "none" && mode !== "markers" && (
            <p className="small lc-deletes">
              <AlertTriangle size={12} /> Matching objects are deleted {mode === "date" ? "on that date" : "when they reach that age"}.
            </p>
          )}
          <IssueList issues={iss.under("expiration.")} />
        </div>
      </Section>

      {/* ---- noncurrent versions ---- */}
      <Section
        title="Noncurrent versions"
        className={versioned ? "" : "lc-greyed"}
        note={
          <p className="muted small lc-note">
            {versioned ? (
              "Older versions of an object, kept when it is overwritten or deleted. Days count from when a version became noncurrent."
            ) : (
              <>
                <Info size={12} /> Versioning is {versioning === null ? "unknown" : "off"} for this bucket, so it has no noncurrent
                versions: these actions do nothing unless versioning is turned on.
              </>
            )}
          </p>
        }
      >
        <div className="field">
          <span className="field-label">Move to another storage class</span>
          {rule.noncurrentVersionTransitions.map((t, j) => {
            const base = `noncurrentVersionTransitions[${j}]`;
            return (
              <div key={j} className="lc-action-row">
                <div className="lc-action-line">
                  <ClassSelect
                    value={t.storageClass}
                    onChange={(storageClass) => setNct(j, { ...t, storageClass })}
                    label={`Noncurrent transition ${j + 1} storage class`}
                    invalid={iss.has(`${base}.storageClass`)}
                  />
                  <span className="lc-inline">
                    <NumField
                      value={t.noncurrentDays}
                      onChange={(noncurrentDays) =>
                        setNct(j, {
                          ...t,
                          noncurrentDays: noncurrentDays as number,
                        })
                      }
                      label={`Noncurrent transition ${j + 1}: days after becoming noncurrent`}
                      invalid={iss.has(`${base}.noncurrentDays`)}
                    />
                    <span className="muted small">days</span>
                  </span>
                  <span className="lc-inline">
                    <span className="muted small">keep newest</span>
                    <NumField
                      value={t.newerNoncurrentVersions}
                      onChange={(n) => setNct(j, { ...t, newerNoncurrentVersions: n })}
                      label={`Noncurrent transition ${j + 1}: newest noncurrent versions to keep (1 to 100, optional)`}
                      invalid={iss.has(`${base}.newerNoncurrentVersions`)}
                      placeholder="—"
                    />
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove noncurrent transition ${j + 1}`}
                    title="Remove this transition"
                    onClick={() =>
                      onChange({
                        ...rule,
                        noncurrentVersionTransitions: rule.noncurrentVersionTransitions.filter((_, k) => k !== j),
                      })
                    }
                  >
                    <X size={13} />
                  </button>
                </div>
                <IssueList issues={iss.under(`${base}.`)} />
              </div>
            );
          })}
          <div>
            <button type="button" className="btn btn-sm" onClick={addNct} disabled={!canAddNct}>
              <Plus size={13} /> Add transition
            </button>
          </div>
        </div>

        <div className="field">
          <label className="check lc-toggle">
            <input
              type="checkbox"
              className="switch"
              checked={nce !== null}
              onChange={(e) =>
                onChange({
                  ...rule,
                  noncurrentVersionExpiration: e.target.checked
                    ? {
                        noncurrentDays: null as unknown as number,
                        newerNoncurrentVersions: null,
                      }
                    : null,
                })
              }
            />
            Permanently delete noncurrent versions
          </label>
          {nce && (
            <div className="lc-action-line lc-indent">
              <span className="lc-inline">
                <NumField
                  value={nce.noncurrentDays}
                  onChange={(n) =>
                    onChange({
                      ...rule,
                      noncurrentVersionExpiration: {
                        ...nce,
                        noncurrentDays: n as number,
                      },
                    })
                  }
                  label="Delete noncurrent versions: days after becoming noncurrent"
                  invalid={iss.has("noncurrentVersionExpiration.noncurrentDays")}
                />
                <span className="muted small">days after becoming noncurrent</span>
              </span>
              <span className="lc-inline">
                <span className="muted small">keep newest</span>
                <NumField
                  value={nce.newerNoncurrentVersions}
                  onChange={(n) =>
                    onChange({
                      ...rule,
                      noncurrentVersionExpiration: {
                        ...nce,
                        newerNoncurrentVersions: n,
                      },
                    })
                  }
                  label="Newest noncurrent versions to keep (1 to 100, optional)"
                  invalid={iss.has("noncurrentVersionExpiration.newerNoncurrentVersions")}
                  placeholder="—"
                />
              </span>
            </div>
          )}
          <IssueList issues={iss.under("noncurrentVersionExpiration.")} />
        </div>
      </Section>

      {/* ---- multipart ---- */}
      <Section title="Incomplete multipart uploads">
        <div className="field">
          <label className="check lc-toggle">
            <input
              type="checkbox"
              className="switch"
              checked={abort !== null}
              onChange={(e) =>
                onChange({
                  ...rule,
                  abortIncompleteMultipartUpload: e.target.checked ? { daysAfterInitiation: 7 } : null,
                })
              }
            />
            Abort uploads that haven’t finished
          </label>
          {abort && (
            <div className="lc-action-line lc-indent">
              <span className="lc-inline">
                <NumField
                  value={abort.daysAfterInitiation}
                  onChange={(n) =>
                    onChange({
                      ...rule,
                      abortIncompleteMultipartUpload: {
                        daysAfterInitiation: n as number,
                      },
                    })
                  }
                  label="Abort incomplete uploads: days after they started"
                  invalid={iss.has("abortIncompleteMultipartUpload.daysAfterInitiation")}
                />
                <span className="muted small">days after they started; their uploaded parts are discarded</span>
              </span>
            </div>
          )}
          <IssueList issues={iss.under("abortIncompleteMultipartUpload.")} />
        </div>
      </Section>
    </div>
  );
}
