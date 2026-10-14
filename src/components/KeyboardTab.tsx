// Settings → Keyboard (v0.7.0): every action by group with its chords, record / remove / reset,
// conflicts, unknown actions, and export / import of the bindings (see "Settings → Keyboard" in
// docs/CONTRACT.md). The draft holds overrides only; the dialog's Save stores them.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, Download, Info, Loader2, Plus, RotateCcw, Trash2, Upload, X } from "lucide-react";
import * as api from "../lib/api";
import type { AppError, KeybindingsPreset } from "../lib/types";
import { KEYBINDING_LIMITS } from "../lib/types";
import {
  ACTIONS_BY_ID,
  applyImport,
  canonicalChord,
  chordFromEvent,
  chordFromMouse,
  chordProblem,
  effectiveBindings,
  exportBindings,
  findConflicts,
  formatChord,
  formatPartial,
  isPrintableChord,
  KEY_ACTIONS,
  KEY_GROUPS,
  normalizeOverrides,
  parseImport,
  partialChord,
  type Bindings,
  type ImportResult,
  type KeyAction,
} from "../lib/keys";
import { setRecording } from "../store/keyboard";
import { toast } from "../store/toasts";
import { ChordKeys } from "./ShortcutsDialog";

const EXPORT_NAME = "s3explorer-keybindings.json";

const CONTEXT_LABEL: Record<KeyAction["context"], string> = {
  global: "Anywhere",
  files: "File list",
  search: "Search box",
};

interface Recording {
  id: string;
  /** Modifiers held so far, e.g. "Mod+Shift+". */
  live: string;
}

export function KeyboardTab({
  value,
  preset,
  disabled,
  onChange,
}: {
  value: Bindings;
  preset: KeybindingsPreset;
  disabled: boolean;
  /** New overrides, and the defaults' preset when an import names one (there is no preset control). */
  onChange(next: Bindings, preset?: KeybindingsPreset): void;
}) {
  const bindings = useMemo(() => effectiveBindings(value, preset), [value, preset]);
  const conflicts = useMemo(() => findConflicts(bindings), [bindings]);
  const unknown = useMemo(() => Object.keys(value).filter((id) => !ACTIONS_BY_ID.has(id)), [value]);
  const [recording, setRec] = useState<Recording | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [preview, setPreview] = useState<{ path: string; result: ImportResult } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const recordButtons = useRef(new Map<string, HTMLButtonElement | null>());

  /** Chord (canonical) → the other actions that share it, per action. */
  const conflictsOf = useMemo(() => {
    const m = new Map<string, { chord: string; others: string[] }[]>();
    for (const c of conflicts) {
      for (const id of c.ids) {
        const list = m.get(id) ?? [];
        list.push({ chord: c.chord, others: c.ids.filter((x) => x !== id) });
        m.set(id, list);
      }
    }
    return m;
  }, [conflicts]);

  const setChords = (id: string, chords: string[]) => onChange(normalizeOverrides({ ...value, [id]: chords }, preset));

  // Recording: the next chord pressed is added to the action. Escape cancels, a click elsewhere too.
  useEffect(() => {
    if (!recording) return;
    setRecording(true);
    const id = recording.id;
    const stop = () => {
      setRec(null);
      requestAnimationFrame(() => recordButtons.current.get(id)?.focus());
    };
    const onKey = (e: KeyboardEvent) => {
      // Nothing else sees the keys while recording (not the dialog's Escape, not the explorer).
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keyup") {
        setRec((r) => (r ? { ...r, live: partialChord(e) } : r));
        return;
      }
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        stop();
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) {
        setRec((r) => (r ? { ...r, live: partialChord(e) } : r));
        if (e.key.length === 1 && e.key.charCodeAt(0) > 126) setRowError({ id, message: "Only keys of a US keyboard layout can be bound." });
        return;
      }
      accept(chord);
    };
    /** Add a recorded chord (a key or an extra mouse button) to the action, or say why not. */
    const accept = (chord: string) => {
      const problem = chordProblem(id, chord);
      const current = effectiveBindings(value, preset)[id] ?? [];
      const k = canonicalChord(chord);
      if (problem) setRowError({ id, message: `${formatChord(chord)}: ${problem}` });
      else if (current.some((c) => canonicalChord(c) === k)) setRowError(null);
      else if (current.length >= KEYBINDING_LIMITS.maxChordsPerAction) {
        setRowError({ id, message: `At most ${KEYBINDING_LIMITS.maxChordsPerAction} keys per action; remove one first.` });
      } else {
        setRowError(null);
        setChords(id, [...current, chord]);
      }
      stop();
    };
    const onDown = (e: MouseEvent) => {
      // The extra mouse buttons (Back / Forward) are chords too.
      const mouse = chordFromMouse(e);
      if (mouse) {
        e.preventDefault();
        e.stopPropagation();
        accept(mouse);
        return;
      }
      if (!(e.target as Element).closest?.(".kb-recording")) stop();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", stop);
      setRecording(false);
    };
  }, [recording?.id, preset]); // eslint-disable-line react-hooks/exhaustive-deps

  const startRecording = (id: string) => {
    setRowError(null);
    setRec({ id, live: "" });
  };

  const exportFile = async () => {
    setBusy("export");
    try {
      const picked = await api.pickExportPath(EXPORT_NAME);
      if (!picked) return;
      // Some save dialogs (GTK) return the name as typed, without the extension the filter implies.
      const path = /\.json$/i.test(picked) ? picked : `${picked}.json`;
      await api.writeTextFile(path, exportBindings(value, preset));
      toast.success("Keyboard shortcuts exported", path);
    } catch (e) {
      toast.error("Couldn't export the shortcuts", e as AppError);
    } finally {
      setBusy(null);
    }
  };

  const importFile = async () => {
    setBusy("import");
    setImportError(null);
    try {
      const path = await api.pickImportFile();
      if (!path) return;
      const text = await api.readTextFile(path);
      try {
        setPreview({ path, result: parseImport(text, value, preset) });
      } catch (err) {
        setImportError((err as Error).message);
      }
    } catch (e) {
      setImportError((e as AppError).message);
    } finally {
      setBusy(null);
    }
  };

  const modified = (a: KeyAction) => Object.prototype.hasOwnProperty.call(value, a.id);
  const anyKnownModified = KEY_ACTIONS.some(modified);

  return (
    <div className="set-panel-body kb-tab">
      <div className="kb-toolbar">
        <p className="set-desc grow">
          Click <b>Record</b> and press the keys. Chords with Ctrl, Alt or an F-key also work while typing in a text box.
        </p>
        <button type="button" className="btn btn-sm" onClick={() => void exportFile()} disabled={disabled || busy !== null}>
          {busy === "export" ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Export…
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void importFile()} disabled={disabled || busy !== null}>
          {busy === "import" ? <Loader2 size={13} className="spin" /> : <Upload size={13} />} Import…
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled || !anyKnownModified}
          onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([id]) => !ACTIONS_BY_ID.has(id))))}
          title="Every action back to its default keys. Changes still need to be saved."
        >
          <RotateCcw size={13} /> Reset all
        </button>
      </div>

      {importError && (
        <div className="form-error" role="alert">
          <AlertTriangle size={15} />
          <span className="grow">Couldn't import: {importError}</span>
          <button type="button" className="icon-btn" onClick={() => setImportError(null)} aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="callout warn" role="alert">
          <AlertTriangle size={15} />
          <span>
            <strong>{conflicts.length === 1 ? "One key is" : `${conflicts.length} keys are`} bound to two actions.</strong> Change or
            remove one of them to save.
          </span>
        </div>
      )}

      {preview && (
        <ImportPreview
          preview={preview}
          currentPreset={preset}
          onCancel={() => setPreview(null)}
          onApply={() => {
            const next = applyImport(value, preview.result, preset);
            onChange(next.overrides, next.preset);
            setPreview(null);
          }}
        />
      )}

      {KEY_GROUPS.map((g) => (
        <section key={g} className="kb-group" aria-label={g}>
          <h4 className="section-title">{g}</h4>
          <div className="kb-rows">
            {KEY_ACTIONS.filter((a) => a.group === g).map((a) => {
              const chords = bindings[a.id] ?? [];
              const rec = recording?.id === a.id;
              const clash = conflictsOf.get(a.id) ?? [];
              const clashKeys = new Set(clash.map((c) => c.chord));
              const printable = chords.filter(isPrintableChord);
              const problems = chords.map((c) => [c, chordProblem(a.id, c)] as const).filter(([, m]) => m);
              const err = rowError?.id === a.id ? rowError.message : null;
              return (
                <div key={a.id} className={`kb-row ${clash.length || problems.length ? "conflict" : ""} ${rec ? "kb-recording" : ""}`} data-action={a.id}>
                  <div className="kb-label">
                    <span>{a.label}</span>
                    <span className="kb-ctx">{CONTEXT_LABEL[a.context]}</span>
                  </div>
                  <div className="kb-chords">
                    {chords.map((c) => (
                      <span key={c} className={`kb-chip ${clashKeys.has(canonicalChord(c) ?? "") ? "clash" : ""}`}>
                        <ChordKeys chord={c} />
                        <button
                          type="button"
                          className="kb-chip-x"
                          aria-label={`Remove ${formatChord(c)} from ${a.label}`}
                          title="Remove"
                          disabled={disabled}
                          onClick={() => setChords(a.id, chords.filter((x) => x !== c))}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                    {rec ? (
                      <span className="kb-chip kb-live" aria-live="polite">
                        {recording.live ? `${formatPartial(recording.live)}…` : "Press keys…"}
                        <span className="muted small"> Esc cancels</span>
                      </span>
                    ) : (
                      !chords.length && <span className="dim small">Not bound</span>
                    )}
                  </div>
                  <div className="kb-actions">
                    <button
                      type="button"
                      ref={(el) => {
                        recordButtons.current.set(a.id, el);
                      }}
                      className={`btn btn-sm ${rec ? "active" : ""}`}
                      disabled={disabled || chords.length >= KEYBINDING_LIMITS.maxChordsPerAction}
                      onClick={() => (rec ? setRec(null) : startRecording(a.id))}
                      title={chords.length >= KEYBINDING_LIMITS.maxChordsPerAction ? `At most ${KEYBINDING_LIMITS.maxChordsPerAction} keys per action` : `Record a key for ${a.label}`}
                    >
                      <Plus size={12} /> Record
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={disabled || !modified(a)}
                      onClick={() => {
                        const next = { ...value };
                        delete next[a.id];
                        onChange(next);
                      }}
                      aria-label={`Reset ${a.label}`}
                      title="Back to the default keys"
                    >
                      <RotateCcw size={13} />
                    </button>
                  </div>
                  {(clash.length > 0 || err || printable.length > 0 || problems.length > 0) && (
                    <div className="kb-notes">
                      {clash.map((c) => (
                        <span key={c.chord} className="err-text">
                          <AlertTriangle size={12} /> {formatChord(c.chord)} is also bound to {c.others.map((o) => ACTIONS_BY_ID.get(o)?.label ?? o).join(", ")}.
                        </span>
                      ))}
                      {err && <span className="err-text">{err}</span>}
                      {problems.map(([c, m]) => (
                        <span key={`p-${c}`} className="err-text">
                          <AlertTriangle size={12} /> {formatChord(c)}: {m}
                        </span>
                      ))}
                      {printable.map((c) => (
                        <span key={c} className="muted">
                          <Info size={12} /> Typing {formatChord(c)} in the file list runs this action instead of starting a search with it.
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {unknown.length > 0 && (
        <section className="kb-group" aria-label="Unknown actions">
          <h4 className="section-title">Unknown actions</h4>
          <p className="set-desc">These come from another version of S3 Explorer. They are kept for it and do nothing here.</p>
          <div className="kb-rows">
            {unknown.map((id) => (
              <div key={id} className="kb-row" data-unknown={id}>
                <div className="kb-label">
                  <span className="mono">{id}</span>
                </div>
                <div className="kb-chords">
                  {(value[id] ?? []).map((c, i) => (
                    <span key={i} className="kb-chip">
                      <span className="mono small">{c}</span>
                    </span>
                  ))}
                  {!(value[id] ?? []).length && <span className="dim small">Not bound</span>}
                </div>
                <div className="kb-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-danger-ghost"
                    disabled={disabled}
                    onClick={() => {
                      const next = { ...value };
                      delete next[id];
                      onChange(next);
                    }}
                  >
                    <Trash2 size={12} /> Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** What an import would change, applied on confirm. Esc or Cancel drops it. */
function ImportPreview({
  preview,
  currentPreset,
  onApply,
  onCancel,
}: {
  preview: { path: string; result: ImportResult };
  currentPreset: KeybindingsPreset;
  onApply(): void;
  onCancel(): void;
}) {
  const { changes, unknown, preset } = preview.result;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".btn-primary")?.focus();
  }, []);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  const nothing = !changes.length && !unknown.length && (!preset || preset === currentPreset);
  return (
    <div ref={ref} className="kb-import" role="dialog" aria-modal="false" aria-labelledby="kb-import-title" onKeyDown={onKeyDown}>
      <div className="kb-import-head">
        <Upload size={15} />
        <h4 id="kb-import-title">Import shortcuts</h4>
        <span className="mono small muted grow kb-import-path" title={preview.path}>
          {preview.path}
        </span>
      </div>
      {nothing ? (
        <p className="set-desc">The file matches your current shortcuts. Nothing changes.</p>
      ) : (
        <>
          {changes.length > 0 && (
            <>
              <p className="set-desc">
                {changes.length === 1 ? "1 action changes" : `${changes.length} actions change`}:
              </p>
              <ul className="kb-import-list">
                {changes.map((c) => (
                  <li key={c.id}>
                    <span className="kb-import-label">{c.label}</span>
                    <span className="kb-import-from">{c.from.length ? c.from.map((x) => <ChordKeys key={x} chord={x} />) : <span className="dim small">not bound</span>}</span>
                    <span className="muted">→</span>
                    <span className="kb-import-to">{c.to.length ? c.to.map((x) => <ChordKeys key={x} chord={x} />) : <span className="dim small">not bound</span>}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {unknown.length > 0 && (
            <p className="set-desc">
              Not known to this version (kept under Unknown actions): <span className="mono">{unknown.join(", ")}</span>
            </p>
          )}
        </>
      )}
      <div className="kb-import-actions">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onApply} disabled={nothing}>
          Apply
        </button>
      </div>
    </div>
  );
}
