// The hidden game's cheat code: typing a word (letters in sequence, no modifiers, the whole word
// within the window) fires once. Pure, so it can be tested without the game's WebGL scene.

export const GOD_MODE_CODE = "iddqd";
export const CHEAT_WINDOW_MS = 2000;

export type CheatKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "repeat">;

/**
 * A matcher for one code word. Feed it every keydown; it returns true on the key that completes the
 * word. A key with Ctrl, Alt or Cmd, or any key that is not a letter, starts over; letters typed
 * longer than the window before the last one are forgotten.
 */
export function cheatMatcher(word: string = GOD_MODE_CODE, windowMs: number = CHEAT_WINDOW_MS) {
  let typed: { letter: string; at: number }[] = [];
  return (e: CheatKey, now: number = Date.now()): boolean => {
    if (e.repeat) return false;
    const letter = e.key.length === 1 && /^[a-z]$/i.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey ? e.key.toLowerCase() : null;
    if (!letter) {
      typed = [];
      return false;
    }
    typed.push({ letter, at: now });
    // Keep the longest recent tail that could still become the word ("iiddqd" still matches).
    const text = () => typed.map((t) => t.letter).join("");
    while (typed.length && (now - typed[0].at > windowMs || !word.startsWith(text()))) typed.shift();
    if (text() === word) {
      typed = [];
      return true;
    }
    return false;
  };
}
