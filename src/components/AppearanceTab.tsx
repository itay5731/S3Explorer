import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Check, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { ACCENT_COLORS, TEXT_SETTINGS_LIMITS, type AccentColor, type ThemeMode } from "../lib/types";
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

/**
 * A slider for one of the text settings. The value is reported when the slider is let go, not
 * while it moves: the size setting rescales the whole window, slider included, and applying it
 * mid-drag would pull the slider out from under the pointer.
 */
function TextSlider({
  label,
  description,
  value,
  limits,
  unit,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  limits: { min: number; max: number; step: number };
  unit: string;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const id = useId();
  const [moving, setMoving] = useState(value);
  useEffect(() => setMoving(value), [value]);
  const commit = () => moving !== value && onChange(moving);
  const fill = ((moving - limits.min) / (limits.max - limits.min)) * 100;
  return (
    <div className="set-field">
      <div className="set-field-head">
        <label className="set-label" htmlFor={id}>
          {label}
        </label>
        <p className="set-desc" id={`${id}-desc`}>
          {description}
        </p>
      </div>
      <div className="slider-row">
        <input
          id={id}
          type="range"
          className="range"
          {...limits}
          value={moving}
          disabled={disabled}
          aria-describedby={`${id}-desc`}
          style={{ "--fill": `${fill}%` } as CSSProperties}
          onChange={(e) => setMoving(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <span className="slider-value">
          {moving}
          {unit}
        </span>
      </div>
    </div>
  );
}

const ACCENT_NAMES: Record<AccentColor, string> = { yellow: "Yellow", green: "Green", blue: "Blue", red: "Red" };

/** A row of colour swatches. Each swatch carries `data-accent`, so it is drawn in its own colour. */
function AccentPicker({ value, disabled, onChange }: { value: AccentColor; disabled: boolean; onChange(accent: AccentColor): void }) {
  const id = useId();
  return (
    <div className="set-field">
      <div className="set-field-head">
        <span className="set-label" id={`${id}-label`}>
          Accent colour
        </span>
        <p className="set-desc">The colour of buttons, selection, highlights and the logo inside the app.</p>
      </div>
      <div className="accent-options" role="radiogroup" aria-labelledby={`${id}-label`}>
        {ACCENT_COLORS.map((accent) => (
          <button
            key={accent}
            type="button"
            role="radio"
            aria-checked={accent === value}
            className={`accent-option ${accent === value ? "active" : ""}`}
            data-accent={accent}
            disabled={disabled}
            onClick={() => onChange(accent)}
          >
            <span className="accent-swatch" />
            {ACCENT_NAMES[accent]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AppearanceTab({
  value,
  accent,
  textSize,
  textWeight,
  disabled,
  onChange,
  onAccentChange,
  onTextSizeChange,
  onTextWeightChange,
}: {
  value: ThemeMode;
  accent: AccentColor;
  textSize: number;
  textWeight: number;
  disabled: boolean;
  onChange(mode: ThemeMode): void;
  onAccentChange(accent: AccentColor): void;
  onTextSizeChange(size: number): void;
  onTextWeightChange(weight: number): void;
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
      <AccentPicker value={accent} disabled={disabled} onChange={onAccentChange} />
      <TextSlider
        label="Size"
        description="Makes everything in the window larger or smaller: text, icons and spacing together."
        value={textSize}
        limits={TEXT_SETTINGS_LIMITS.textSize}
        unit="%"
        disabled={disabled}
        onChange={onTextSizeChange}
      />
      <TextSlider
        label="Text weight"
        description="How heavy ordinary text is drawn. Headings keep their own, bolder weight."
        value={textWeight}
        limits={TEXT_SETTINGS_LIMITS.textWeight}
        unit=""
        disabled={disabled}
        onChange={onTextWeightChange}
      />
    </div>
  );
}
