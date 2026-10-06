import { Contrast } from "lucide-react";
import type { MouseEvent } from "react";
import { applyTheme, applyThemeWithReveal, useOsTheme } from "../lib/theme";
import type { AppError } from "../lib/types";
import { saveSettings, useSettings } from "../store/settings";
import { toast } from "../store/toasts";

/** One-click light/dark switch for the top bar. Saves the same `theme` setting as the Settings dialog. */
export function ThemeToggle() {
  const settings = useSettings((s) => s.settings);
  const saving = useSettings((s) => s.saving);
  const os = useOsTheme();
  if (!settings) return null;

  const current = settings.theme === "system" ? os : settings.theme;
  const next = current === "dark" ? "light" : "dark";

  const toggle = async (e: MouseEvent<HTMLButtonElement>) => {
    // The new theme spreads out from the middle of the button (a keyboard press has no pointer position).
    const button = e.currentTarget.getBoundingClientRect();
    applyThemeWithReveal(next, { x: button.left + button.width / 2, y: button.top + button.height / 2 });
    try {
      await saveSettings({ ...settings, theme: next });
    } catch (e) {
      applyTheme(settings.theme);
      toast.error("Couldn’t save the theme", e as AppError);
    }
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={(e) => void toggle(e)}
      disabled={saving}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {/* A half-filled circle in both themes: a sun reads too much like the settings gear beside it. */}
      <Contrast size={15} />
      {current === "dark" ? "Dark" : "Light"}
    </button>
  );
}
