// A key/value editor for one tag set, validated live against TAG_LIMITS (see "Tags" in
// docs/CONTRACT.md). The parent owns the rows and decides what Save does.

import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { Tag } from "../lib/types";
import { validateTags, type TagValidation } from "../lib/tags";

export interface TagRow {
  /** Stable React key; never sent. */
  id: number;
  key: string;
  value: string;
}

let rowSeq = 0;
export const toRows = (tags: Tag[]): TagRow[] => tags.map((t) => ({ id: ++rowSeq, key: t.key, value: t.value }));
export const fromRows = (rows: TagRow[]): Tag[] => rows.map((r) => ({ key: r.key, value: r.value }));
export const validateRows = (rows: TagRow[], max: number): TagValidation => validateTags(fromRows(rows), max);

export function TagEditor({
  rows,
  onChange,
  max,
  disabled,
  showAllErrors,
  addLabel = "Add tag",
  emptyText = "No tags.",
  label = "Tags",
}: {
  rows: TagRow[];
  onChange(rows: TagRow[]): void;
  max: number;
  disabled?: boolean;
  /** Show errors on rows the user hasn't finished with yet (e.g. after trying to save). */
  showAllErrors?: boolean;
  addLabel?: string;
  emptyText?: string;
  label?: string;
}) {
  const v = validateRows(rows, max);
  // Errors on a row show once the user has left it, so a fresh empty row isn't red right away.
  const [left, setLeft] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const full = rows.length >= max;

  const update = (id: number, patch: Partial<TagRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: number) => onChange(rows.filter((r) => r.id !== id));
  const add = () => {
    const row: TagRow = { id: ++rowSeq, key: "", value: "" };
    onChange([...rows, row]);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLInputElement>(`[data-row="${row.id}"]`)?.focus());
  };
  const leave = (id: number) => setLeft((s) => (s.has(id) ? s : new Set(s).add(id)));

  return (
    <div className="tag-editor">
      <div className="tag-editor-list" ref={listRef} role="group" aria-label={label}>
        {rows.length > 0 && (
          <div className="tag-editor-head" aria-hidden="true">
            <span>Key</span>
            <span>Value</span>
            <span />
          </div>
        )}
        {rows.length === 0 && <p className="tag-editor-empty muted small">{emptyText}</p>}
        {rows.map((r, i) => {
          const errs = v.rows[i];
          const show = showAllErrors || left.has(r.id) || r.key !== "";
          const keyErr = show ? errs.key : null;
          const valueErr = errs.value;
          return (
            <div key={r.id} className="tag-editor-row">
              <input
                data-row={r.id}
                value={r.key}
                placeholder="key"
                spellCheck={false}
                autoComplete="off"
                disabled={disabled}
                aria-label={`Tag ${i + 1} key`}
                aria-invalid={!!keyErr}
                onChange={(e) => update(r.id, { key: e.target.value })}
                onBlur={() => leave(r.id)}
              />
              <input
                value={r.value}
                placeholder="value (optional)"
                spellCheck={false}
                autoComplete="off"
                disabled={disabled}
                aria-label={`Tag ${i + 1} value`}
                aria-invalid={!!valueErr}
                onChange={(e) => update(r.id, { value: e.target.value })}
                onBlur={() => leave(r.id)}
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => remove(r.id)}
                disabled={disabled}
                aria-label={`Remove tag ${r.key || i + 1}`}
                title="Remove this tag"
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
        <button type="button" className="btn btn-sm" onClick={add} disabled={disabled || full} title={full ? `The limit is ${max} tags` : undefined}>
          <Plus size={13} /> {addLabel}
        </button>
        <span className={`tag-count ${rows.length > max ? "err-text" : full ? "at-limit" : ""}`} aria-live="polite">
          {rows.length} of {max}
        </span>
      </div>
      {v.set && (
        <p className="hint err-text" role="alert">
          {v.set}
        </p>
      )}
    </div>
  );
}

/** Tags as read-only chips ("key = value"). */
export function TagChips({ tags, empty = "No tags" }: { tags: Tag[]; empty?: string }) {
  if (!tags.length) return <div className="muted small">{empty}</div>;
  return (
    <ul className="tag-chips">
      {tags.map((t) => (
        <li key={t.key} className="tag-chip" title={t.value ? `${t.key} = ${t.value}` : t.key}>
          <span className="tag-chip-key">{t.key}</span>
          {t.value && <span className="tag-chip-value">{t.value}</span>}
        </li>
      ))}
    </ul>
  );
}
