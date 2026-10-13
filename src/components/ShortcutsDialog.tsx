// The keyboard cheat sheet (v0.7.0, `help.shortcuts`: F1 or ? by default): every action with the
// chords bound to it right now, by group. Changing them is in Settings → Keyboard.

import { useEffect, useRef } from "react";
import { Keyboard, Settings as SettingsIcon, X } from "lucide-react";
import { formatChord, KEY_ACTIONS, KEY_GROUPS, type KeyAction } from "../lib/keys";
import { currentKeys, setCheatOpen, useKeys } from "../store/keyboard";
import { openSettings, useSettings } from "../store/settings";

const CONTEXT_NOTE: Record<KeyAction["context"], string> = {
  files: "in the file list",
  global: "",
  search: "in the search box",
};

/** One chord as key caps: `Ctrl` `Shift` `K` (or ⌘⇧K on macOS). */
export function ChordKeys({ chord }: { chord: string }) {
  const text = formatChord(chord);
  // Split "Ctrl+Shift+K" into caps, keeping a literal "+" key.
  const parts = text.length > 1 && text.includes("+") ? text.split(/\+(?!$)/) : [text];
  return (
    <span className="chord" aria-label={text}>
      {parts.map((p, i) => (
        <kbd key={i}>{p}</kbd>
      ))}
    </span>
  );
}

function Sheet() {
  useSettings((s) => s.settings?.keybindings);
  const { bindings } = currentKeys();
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setCheatOpen(false);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // The list takes the focus, so the arrow keys, Page Up/Down, Home and End scroll it.
    (listRef.current ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "Tab" && ref.current) {
        // Keep the focus inside the sheet.
        const items = [...ref.current.querySelectorAll<HTMLElement>("button:not([disabled]), .shortcuts-grid")];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !ref.current.contains(active))) {
          e.preventDefault();
          e.stopPropagation();
          last.focus();
        } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
          e.preventDefault();
          e.stopPropagation();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} className="modal modal-wide shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" tabIndex={-1}>
        <div className="modal-head">
          <div className="modal-icon">
            <Keyboard size={17} />
          </div>
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <div className="spacer" />
          <button type="button" className="icon-btn lg" onClick={close} aria-label="Close" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div ref={listRef} className="shortcuts-grid" tabIndex={0} aria-label="Shortcuts list (scroll with the arrow keys)">
          {KEY_GROUPS.map((g) => (
            <section key={g} className="shortcuts-group" aria-label={g}>
              <h3 className="section-title">{g}</h3>
              <dl>
                {KEY_ACTIONS.filter((a) => a.group === g).map((a) => {
                  const chords = bindings[a.id] ?? [];
                  return (
                    <div key={a.id} className="shortcut-row" data-action={a.id}>
                      <dt>
                        {a.label}
                        {CONTEXT_NOTE[a.context] && <span className="shortcut-ctx">{CONTEXT_NOTE[a.context]}</span>}
                      </dt>
                      <dd>
                        {chords.length ? (
                          chords.map((c, i) => (
                            <span key={i} className="chord-alt">
                              {i > 0 && <span className="chord-or">or</span>}
                              <ChordKeys chord={c} />
                            </span>
                          ))
                        ) : (
                          <span className="dim small">not bound</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ))}
        </div>
        <div className="modal-actions shortcuts-foot">
          <span className="muted small">
            <kbd>Shift</kbd> with the arrow keys, Page Up/Down, Home or End extends the selection. Typing a letter in the
            file list starts a search.
          </span>
          <div className="spacer" />
          <button
            type="button"
            className="btn"
            onClick={() => {
              close();
              openSettings("keyboard");
            }}
          >
            <SettingsIcon size={14} /> Change shortcuts…
          </button>
        </div>
      </div>
    </div>
  );
}

export function ShortcutsDialog() {
  const open = useKeys((s) => s.cheatOpen);
  return open ? <Sheet /> : null;
}
