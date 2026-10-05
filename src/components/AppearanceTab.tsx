import { useId, useRef, type KeyboardEvent } from "react";
import { Check, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import type { ThemeMode } from "../lib/types";
import { useOsTheme } from "../lib/theme";

const OPTIONS: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [
  { mode: "system", label: "System", icon: Monitor },
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
];

/** A miniature window drawn with the theme's own tokens (scoped by `data-theme`). */
function MiniWindow({ theme }: { theme: "light" | "dark" }) {
  return (
    <div className="tp-window" data-theme={theme}>
      <div className="tp-side">
        <span className="tp-line accent" />
        <span className="tp-line" />
        <span className="tp-line short" />
      </div>
      <div className="tp-main">
        <span className="tp-bar" />
        <span className="tp-row sel" />
        <span className="tp-row" />
        <span className="tp-row" />
      </div>
    </div>
  );
}

function Preview({ mode }: { mode: ThemeMode }) {
  if (mode !== "system") {
    return (
      <div className="theme-preview">
        <MiniWindow theme={mode} />
      </div>
    );
  }
  return (
    <div className="theme-preview split">
      <MiniWindow theme="light" />
      <MiniWindow theme="dark" />
    </div>
  );
}

export function AppearanceTab({
  value,
  disabled,
  onChange,
}: {
  value: ThemeMode;
  disabled: boolean;
  onChange(mode: ThemeMode): void;
}) {
  const id = useId();
  const os = useOsTheme();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    const next = (i + (back ? -1 : 1) + OPTIONS.length) % OPTIONS.length;
    onChange(OPTIONS[next].mode);
    refs.current[next]?.focus();
  };

  return (
    <div className="set-panel-body">
      <div className="set-field">
        <div className="set-field-head">
          <span className="set-label" id={`${id}-label`}>
            Theme
          </span>
          <p className="set-desc" id={`${id}-desc`}>
            Changes preview immediately. Save to keep them; Cancel restores the saved theme.
          </p>
        </div>
        <div className="theme-options" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={`${id}-desc`}>
          {OPTIONS.map((o, i) => {
            const Icon = o.icon;
            const selected = value === o.mode;
            return (
              <button
                key={o.mode}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                className={`theme-option ${selected ? "active" : ""}`}
                disabled={disabled}
                onClick={() => onChange(o.mode)}
                onKeyDown={(e) => onKey(e, i)}
              >
                <Preview mode={o.mode} />
                <span className="theme-option-label">
                  <Icon size={14} />
                  {o.label}
                  {selected && <Check size={14} className="theme-check" aria-hidden="true" />}
                </span>
                {o.mode === "system" && (
                  <span className="theme-option-sub">Follows your OS · now {os === "light" ? "Light" : "Dark"}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
