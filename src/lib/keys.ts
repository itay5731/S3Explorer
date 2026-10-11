// Keyboard bindings (v0.7.0): the action registry, chords, conflicts, overrides and the
// export/import file. Pure: no React, no stores. See "Keyboard" in docs/CONTRACT.md; the registry
// below is the source of truth for the default bindings and must match the contract's table.

import { KEYBINDING_LIMITS } from "./types";
import { clientOS } from "./api";

// ---- actions ------------------------------------------------------------------------------

/** Where a chord fires: anywhere (`global`), in the file list (`files`), or in the search box. */
export type KeyContext = "global" | "files" | "search";
export type KeyGroup = "Navigate" | "Select" | "Act";
export const KEY_GROUPS: readonly KeyGroup[] = ["Navigate", "Select", "Act"];

export interface KeyAction {
  id: string;
  label: string;
  group: KeyGroup;
  context: KeyContext;
  /** Default chords, portable (`Mod` = Ctrl, or Cmd on macOS). At most 4. */
  defaults: readonly string[];
}

const a = (id: string, label: string, group: KeyGroup, context: KeyContext, ...defaults: string[]): KeyAction => ({
  id,
  label,
  group,
  context,
  defaults,
});

export const KEY_ACTIONS: readonly KeyAction[] = [
  // Navigate
  a("nav.open", "Open folder / go to object", "Navigate", "files", "Enter"),
  a("nav.up", "Up one level", "Navigate", "global", "Backspace", "Alt+ArrowUp"),
  a("nav.back", "Back", "Navigate", "global", "Alt+ArrowLeft", "Mouse4"),
  a("nav.forward", "Forward", "Navigate", "global", "Alt+ArrowRight", "Mouse5"),
  a("nav.root", "Bucket root", "Navigate", "global", "Mod+Home"),
  a("nav.refresh", "Refresh", "Navigate", "global", "F5", "Mod+R"),
  a("nav.focusFiles", "Focus the file list", "Navigate", "global", "Mod+E"),
  a("nav.focusBuckets", "Focus the bucket list", "Navigate", "global", "Mod+B"),
  a("nav.focusSearch", "Search", "Navigate", "global", "Mod+F", "/"),
  a("nav.searchScope", "Toggle search scope (this folder / whole bucket)", "Navigate", "global", "Mod+Shift+F"),
  a("nav.nextPane", "Next pane", "Navigate", "files", "Tab"),
  a("nav.prevPane", "Previous pane", "Navigate", "files", "Shift+Tab"),
  a("view.single", "Single view", "Navigate", "global", "Mod+1"),
  a("view.split", "Split view", "Navigate", "global", "Mod+2"),
  a("view.details", "Toggle details panel", "Navigate", "global", "Mod+I"),
  a("view.activity", "Toggle Activity panel", "Navigate", "global", "Mod+J"),
  a("view.settings", "Settings", "Navigate", "global", "Mod+,"),
  a("help.shortcuts", "Keyboard shortcuts (cheat sheet)", "Navigate", "global", "F1", "?"),
  // Select
  a("sel.up", "Move focus up", "Select", "files", "ArrowUp"),
  a("sel.down", "Move focus down", "Select", "files", "ArrowDown"),
  a("sel.pageUp", "Page up", "Select", "files", "PageUp"),
  a("sel.pageDown", "Page down", "Select", "files", "PageDown"),
  a("sel.first", "First row", "Select", "files", "Home"),
  a("sel.last", "Last row", "Select", "files", "End"),
  a("sel.toggle", "Toggle selection of the focused row", "Select", "files", "Space"),
  a("sel.toggleNext", "Toggle and move down", "Select", "files", "Insert"),
  a("sel.all", "Select all", "Select", "files", "Mod+A"),
  a("sel.none", "Clear selection (or close results)", "Select", "files", "Escape"),
  a("sel.menu", "Context menu", "Select", "files", "ContextMenu", "Shift+F10"),
  // Act
  a("act.upload", "Upload files", "Act", "global", "Mod+U"),
  a("act.uploadFolder", "Upload folder", "Act", "global", "Mod+Shift+U"),
  a("act.download", "Download (objects or folders)", "Act", "global", "Mod+D"),
  a("act.newFolder", "New folder", "Act", "global", "F7"),
  a("act.delete", "Delete", "Act", "files", "Delete", "F8"),
  a("act.rename", "Rename", "Act", "files", "F2"),
  a("act.copy", "Copy", "Act", "files", "Mod+C"),
  a("act.cut", "Cut", "Act", "files", "Mod+X"),
  a("act.paste", "Paste", "Act", "files", "Mod+V"),
  a("act.copyToOther", "Copy to other pane", "Act", "global", "Mod+Shift+C"),
  a("act.moveToOther", "Move to other pane", "Act", "global", "Mod+Shift+X"),
  a("act.copyKey", "Copy key", "Act", "files", "Mod+Shift+K"),
  a("act.copyUri", "Copy S3 URI", "Act", "files", "Mod+Shift+L"),
  a("act.tags", "Tags", "Act", "files", "Mod+T"),
  a("act.versions", "Show versions", "Act", "files", "Mod+Shift+V"),
  a("act.restore", "Restore archived", "Act", "files"),
  a("act.disconnect", "Disconnect", "Act", "global", "Mod+Shift+Q"),
];

export const ACTIONS_BY_ID: ReadonlyMap<string, KeyAction> = new Map(KEY_ACTIONS.map((x) => [x.id, x]));

/** Movement actions that `Shift` turns into "extend the selection" (a fixed rule, not a binding). */
export const EXTENDABLE = new Set(["sel.up", "sel.down", "sel.pageUp", "sel.pageDown", "sel.first", "sel.last"]);

// ---- chords --------------------------------------------------------------------------------

export type Modifier = "Mod" | "Ctrl" | "Alt" | "Shift" | "Meta";
export const MODIFIERS: readonly Modifier[] = ["Mod", "Ctrl", "Alt", "Shift", "Meta"];

export interface Chord {
  mods: Set<Modifier>;
  key: string;
}

const NAMED_KEYS = [
  "Enter", "Escape", "Backspace", "Delete", "Insert", "Tab", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "ContextMenu",
  "BrowserBack", "BrowserForward", "BrowserRefresh",
  // The extra mouse buttons: MouseEvent.button 3 (Back) and 4 (Forward).
  "Mouse4", "Mouse5",
];
const NAMED_LOWER = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));

/** The canonical key name for a chord's key part, or null when it is not a key name. */
function normKeyName(k: string): string | null {
  if (k.length === 1) {
    const c = k.charCodeAt(0);
    if (c <= 32 || c > 126) return null;
    return /[a-z]/.test(k) ? k.toUpperCase() : k;
  }
  const named = NAMED_LOWER.get(k.toLowerCase());
  if (named) return named;
  const f = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(k);
  if (f) return `F${f[1]}`;
  return null;
}

const MOD_ALIASES: Record<string, Modifier> = {
  mod: "Mod",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
};

/** Parse a chord such as `Mod+Shift+K` (case-insensitive names, any modifier order); null when invalid. */
export function parseChord(text: string): Chord | null {
  if (typeof text !== "string" || !text || text.length > KEYBINDING_LIMITS.chordMaxChars) return null;
  let keyPart: string;
  let modPart: string;
  if (text === "+") {
    keyPart = "+";
    modPart = "";
  } else if (text.endsWith("++")) {
    keyPart = "+";
    modPart = text.slice(0, -2);
  } else {
    const i = text.lastIndexOf("+");
    keyPart = text.slice(i + 1);
    modPart = i < 0 ? "" : text.slice(0, i);
  }
  const key = normKeyName(keyPart);
  if (!key) return null;
  const mods = new Set<Modifier>();
  if (modPart) {
    for (const m of modPart.split("+")) {
      const mod = MOD_ALIASES[m.toLowerCase()];
      if (!mod || mods.has(mod)) return null;
      mods.add(mod);
    }
  }
  // `?`, `!`, `{`…: the character already includes Shift, and a key event never reports it with
  // Shift (see chordFromEvent), so `Shift+?` is written `?`.
  if (isPunctuation(key)) mods.delete("Shift");
  return { mods, key };
}

/** A single printable ASCII character that is neither a letter nor a digit. */
function isPunctuation(key: string): boolean {
  return key.length === 1 && !/[A-Za-z0-9]/.test(key);
}

/** Format a parsed chord in the portable written form (modifiers in contract order). */
export function chordToString(c: Chord): string {
  return [...MODIFIERS.filter((m) => c.mods.has(m)), c.key].join("+");
}

/** The written, normalised form of a chord (`ctrl+shift+k` → `Ctrl+Shift+K`), or null. */
export function normalizeChord(text: string): string | null {
  const c = parseChord(text);
  return c ? chordToString(c) : null;
}

const isMac = clientOS === "mac";

/**
 * The chord as this platform presses it, for matching: `Mod` resolves to Ctrl (Windows, Linux) or
 * Meta (macOS), and the literal key it stands for is written `Mod` too, so `Ctrl+R` and `Mod+R`
 * are the same chord on Windows.
 */
export function canonicalChord(text: string): string | null {
  const c = parseChord(text);
  if (!c) return null;
  const mods = new Set(c.mods);
  const native: Modifier = isMac ? "Meta" : "Ctrl";
  if (mods.has(native)) {
    mods.delete(native);
    mods.add("Mod");
  }
  return chordToString({ mods, key: c.key });
}

/** Is this the chord of a printable character typed without modifiers (or with Shift only)? */
export function isPrintableChord(text: string): boolean {
  const c = parseChord(text);
  if (!c || c.key.length !== 1) return false;
  return [...c.mods].every((m) => m === "Shift");
}

/** Modifier-only and composition keys: no chord. */
const NOT_A_KEY = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock", "Hyper", "Super", "Symbol", "SymbolLock", "Dead", "Unidentified", "Process"]);

const LEGACY_KEYS: Record<string, string> = {
  " ": "Space",
  Spacebar: "Space",
  Esc: "Escape",
  Del: "Delete",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Apps: "ContextMenu",
};

export type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"> & {
  getModifierState?: (k: string) => boolean;
  target?: EventTarget | null;
};

/** AltGr is held (it reports Ctrl+Alt on Windows): the key types a character. */
export function isAltGraph(e: KeyEventLike): boolean {
  try {
    return !!e.getModifierState?.("AltGraph");
  } catch {
    return false;
  }
}

/** Text fields: typing there keeps the keys' editing meaning. */
export function isTextField(el: unknown): boolean {
  if (!el || typeof el !== "object" || !("tagName" in el)) return false;
  const h = el as HTMLElement;
  if (h.isContentEditable) return true;
  if (h.tagName === "TEXTAREA" || h.tagName === "SELECT") return true;
  if (h.tagName !== "INPUT") return false;
  const type = (h as HTMLInputElement).type;
  return !["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"].includes(type);
}

/** Keys that edit or move the caret in a text field: never taken from one by a global chord. */
export const EDITING_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete"]);

/** The modifiers held during a key event, in portable form. */
function eventMods(e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): Set<Modifier> {
  const mods = new Set<Modifier>();
  if (e.ctrlKey) mods.add(isMac ? "Ctrl" : "Mod");
  if (e.metaKey) mods.add(isMac ? "Mod" : "Meta");
  if (e.altKey) mods.add("Alt");
  if (e.shiftKey) mods.add("Shift");
  return mods;
}

/**
 * The chord a key event presses (portable form, `Mod` for the platform's command key), or null for
 * a modifier on its own or a key that has no chord name (a non-ASCII character, a dead key).
 * With Ctrl/Alt/Cmd held, letters and digits come from the physical key so they work on any layout;
 * a punctuation character already includes Shift (`?` is Shift+/), so Shift is not repeated for it.
 */
export function chordFromEvent(e: KeyEventLike): string | null {
  if (!e.key || NOT_A_KEY.has(e.key)) return null;
  // AltGr (Ctrl+Alt on Windows) types a character: never a Mod+Alt chord.
  if (isAltGraph(e)) return null;
  const mods = eventMods(e);
  let raw = LEGACY_KEYS[e.key] ?? e.key;
  // The layout's own character decides (Dvorak Ctrl+C is the key that types "c"); only a key whose
  // character is not ASCII (Hebrew, Cyrillic, Greek, macOS Option symbols) falls back to the
  // physical key, so Ctrl+C still works on those layouts.
  const chorded = e.ctrlKey || e.altKey || e.metaKey;
  if (chorded && raw.length === 1 && raw.charCodeAt(0) > 126) {
    const letter = /^Key([A-Z])$/.exec(e.code ?? "");
    const digit = /^Digit([0-9])$/.exec(e.code ?? "");
    if (letter) raw = letter[1];
    else if (digit && !e.shiftKey) raw = digit[1];
  }
  const key = normKeyName(raw);
  if (!key) return null;
  // `?`, `!`, `{`…: the character is what was typed; Shift is part of it. Letters keep Shift.
  if (key.length === 1 && !/[A-Z0-9]/.test(key)) mods.delete("Shift");
  return chordToString({ mods, key });
}

/** Is this chord a mouse button (`Mouse4`, `Shift+Mouse5`)? */
export function isMouseChord(text: string): boolean {
  const c = parseChord(text);
  return !!c && (c.key === "Mouse4" || c.key === "Mouse5");
}

/** The chord of a mouse press: the extra buttons only (3 = `Mouse4`, Back; 4 = `Mouse5`, Forward). */
export function chordFromMouse(e: Pick<MouseEvent, "button" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  const key = e.button === 3 ? "Mouse4" : e.button === 4 ? "Mouse5" : null;
  if (!key) return null;
  return chordToString({ mods: eventMods(e), key });
}

/** The modifiers held right now, written as a partial chord (`Ctrl+Shift+`), for live recording. */
export function partialChord(e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string {
  const mods = eventMods(e);
  return MODIFIERS.filter((m) => mods.has(m)).map((m) => `${m}+`).join("");
}

// ---- display -------------------------------------------------------------------------------

const MAC_MOD: Record<Modifier, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘", Meta: "⌘" };
const MAC_ORDER: Modifier[] = ["Ctrl", "Alt", "Shift", "Mod", "Meta"];
const WORD_MOD: Record<Modifier, string> = { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: clientOS === "windows" ? "Win" : "Meta" };
const KEY_LABEL: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Delete: "Del",
  Insert: "Ins",
  PageUp: "PgUp",
  PageDown: "PgDn",
  ContextMenu: "Menu",
  BrowserBack: "Browser Back",
  BrowserForward: "Browser Forward",
  BrowserRefresh: "Browser Refresh",
  Mouse4: "Mouse 4",
  Mouse5: "Mouse 5",
};
const MAC_KEY_LABEL: Record<string, string> = { Enter: "↩", Backspace: "⌫", Delete: "⌦", Tab: "⇥", Escape: "⎋" };

/** A chord as this platform writes it: `⌘⇧K` on macOS, `Ctrl+Shift+K` elsewhere. */
export function formatChord(text: string): string {
  const c = parseChord(text);
  if (!c) return text;
  if (isMac) {
    const mods = MAC_ORDER.filter((m) => c.mods.has(m) && !(m === "Meta" && c.mods.has("Mod")))
      .map((m) => MAC_MOD[m])
      .join("");
    return mods + (MAC_KEY_LABEL[c.key] ?? KEY_LABEL[c.key] ?? c.key);
  }
  const mods = MODIFIERS.filter((m) => c.mods.has(m)).map((m) => WORD_MOD[m]);
  // Ctrl written twice (Mod and Ctrl both held) reads as once.
  const unique = [...new Set(mods)];
  return [...unique, KEY_LABEL[c.key] ?? c.key].join("+");
}

/** A partial chord (`Mod+Shift+`) as the platform writes it, for the live recording display. */
export function formatPartial(partial: string): string {
  if (!partial) return "";
  const mods = partial.split("+").filter(Boolean) as Modifier[];
  if (isMac) return MAC_ORDER.filter((m) => mods.includes(m)).map((m) => MAC_MOD[m]).join("");
  return mods.map((m) => WORD_MOD[m]).join("+") + "+";
}

// ---- bindings ------------------------------------------------------------------------------

export type Bindings = Record<string, string[]>;

/** The chords of every known action: the overrides over the defaults. */
export function effectiveBindings(overrides: Bindings | null | undefined): Bindings {
  const out: Bindings = {};
  for (const act of KEY_ACTIONS) {
    const o = overrides?.[act.id];
    out[act.id] = Array.isArray(o) ? [...o] : [...act.defaults];
  }
  return out;
}

/** Same chords, in any order and however written (`Ctrl+R` is `Mod+R` on Windows). */
const sameChordList = (x: readonly string[], y: readonly string[]) => {
  const set = (l: readonly string[]) => [...new Set(l.map((c) => canonicalChord(c) ?? c))].sort();
  const cx = set(x);
  const cy = set(y);
  return cx.length === cy.length && cx.every((c, i) => c === cy[i]);
};

/**
 * Overrides as saved: only actions whose chords differ from the defaults (an empty list unbinds),
 * chords written in normal form, duplicates dropped. Unknown action ids are kept as they are.
 */
export function normalizeOverrides(overrides: Bindings): Bindings {
  const out: Bindings = {};
  for (const [id, chords] of Object.entries(overrides)) {
    const act = ACTIONS_BY_ID.get(id);
    if (!act) {
      out[id] = [...chords];
      continue;
    }
    const seen = new Set<string>();
    const list: string[] = [];
    for (const c of chords) {
      const n = normalizeChord(c);
      const k = n ? canonicalChord(n) : null;
      if (!n || !k || seen.has(k)) continue;
      seen.add(k);
      list.push(n);
    }
    if (!sameChordList(list, act.defaults)) out[id] = list;
  }
  return out;
}

export function sameOverrides(x: Bindings | null | undefined, y: Bindings | null | undefined): boolean {
  const a1 = Object.entries(x ?? {});
  const b1 = y ?? {};
  if (a1.length !== Object.keys(b1).length) return false;
  return a1.every(([id, chords]) => Array.isArray(b1[id]) && sameChordList(chords, b1[id]));
}

/** Context group for the conflict check: `files` and `global` count as one. */
const conflictScope = (c: KeyContext) => (c === "search" ? "search" : "explorer");

export interface Conflict {
  /** The chord, canonical for this platform. */
  chord: string;
  ids: string[];
}

/** Chords bound to more than one action in the same context (files and global count as one). */
export function findConflicts(bindings: Bindings): Conflict[] {
  const by = new Map<string, string[]>();
  for (const act of KEY_ACTIONS) {
    for (const c of bindings[act.id] ?? []) {
      const k = canonicalChord(c);
      if (!k) continue;
      const slot = `${conflictScope(act.context)}\u0000${k}`;
      const ids = by.get(slot) ?? [];
      if (!ids.includes(act.id)) ids.push(act.id);
      by.set(slot, ids);
    }
  }
  return [...by.entries()].filter(([, ids]) => ids.length > 1).map(([slot, ids]) => ({ chord: slot.split("\u0000")[1], ids }));
}

/** Why a chord can't be bound to an action (beyond conflicts), or null. */
export function chordProblem(id: string, chord: string): string | null {
  const c = parseChord(chord);
  if (!c) return "Not a key this app can use.";
  if (chord.length > KEYBINDING_LIMITS.chordMaxChars) return "Too long.";
  if (c.key === "Tab" && c.mods.size === 0 && id !== "nav.nextPane") return "Tab on its own can only switch panes.";
  if (/^[0-9]$/.test(c.key) && c.mods.has("Shift")) return "Shift with a digit types a symbol; bind that symbol instead.";
  const act = ACTIONS_BY_ID.get(id);
  if (act?.context === "global" && c.mods.size === 0 && (c.key === "Enter" || c.key === "Space")) {
    return `${c.key} on its own presses buttons; it can't be bound to an action that works anywhere.`;
  }
  if ((c.key === "Mouse4" || c.key === "Mouse5") && act && act.context !== "global") {
    return "Mouse buttons work only for actions that work anywhere.";
  }
  if (c.mods.size === 1 && c.mods.has("Shift") && SHIFT_EXTEND_KEYS.has(c.key)) {
    return "Shift with this key extends the selection; it can't be bound.";
  }
  return null;
}

/** Keys whose Shift chord is the fixed "extend the selection" rule. */
const SHIFT_EXTEND_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** For the dispatcher: context → canonical chord → action id. Earlier actions win a clash. */
export interface KeyIndex {
  files: Map<string, string>;
  global: Map<string, string>;
  search: Map<string, string>;
}

export function buildIndex(bindings: Bindings): KeyIndex {
  const idx: KeyIndex = { files: new Map(), global: new Map(), search: new Map() };
  for (const act of KEY_ACTIONS) {
    for (const c of bindings[act.id] ?? []) {
      const k = canonicalChord(c);
      if (k && !idx[act.context].has(k)) idx[act.context].set(k, act.id);
    }
  }
  return idx;
}

// ---- always prevented ----------------------------------------------------------------------

/**
 * Webview shortcuts that would reload, print, find, view source or leave the page: always
 * prevented at the window level, bound or not (see "Keyboard" in docs/CONTRACT.md).
 */
export function isAlwaysPrevented(e: KeyEventLike): boolean {
  const chord = chordFromEvent(e);
  if (!chord) return false;
  const c = parseChord(chord);
  if (!c) return false;
  // F5 (any modifiers: reload, hard reload), F3 (find next/previous), F7 (caret browsing).
  if (c.key === "F5" || c.key === "F3" || c.key === "F7") return true;
  if (c.key === "BrowserBack" || c.key === "BrowserForward" || c.key === "BrowserRefresh") return true;
  const cmd = e.ctrlKey || e.metaKey;
  // Ctrl/Cmd+R (reload), +Shift+R (hard reload), +P (print), +U (view source), +F (find).
  if (cmd && !e.altKey && ["R", "P", "U", "F"].includes(c.key)) return true;
  // Alt+Left / Alt+Right: history back / forward.
  // Not in a text field, where Alt/Option+Arrow moves the caret by word (macOS).
  if (e.altKey && !cmd && (c.key === "ArrowLeft" || c.key === "ArrowRight")) return !isTextField(e.target);
  return false;
}

// ---- export / import -----------------------------------------------------------------------

export const EXPORT_KIND = "keybindings";
export const EXPORT_VERSION = 1;

export interface KeybindingsFile {
  s3explorer: typeof EXPORT_KIND;
  version: typeof EXPORT_VERSION;
  bindings: Bindings;
}

/** The export file: every known action's chords (and kept unknown overrides), pretty-printed. */
export function exportBindings(overrides: Bindings): string {
  const bindings = effectiveBindings(overrides);
  for (const [id, chords] of Object.entries(overrides)) if (!ACTIONS_BY_ID.has(id)) bindings[id] = [...chords];
  const file: KeybindingsFile = { s3explorer: EXPORT_KIND, version: EXPORT_VERSION, bindings };
  return JSON.stringify(file, null, 2) + "\n";
}

const ID_RE = /^[A-Za-z0-9_.-]+$/;
// eslint-disable-next-line no-control-regex
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

export interface ImportChange {
  id: string;
  label: string;
  from: string[];
  to: string[];
}

export interface ImportResult {
  /** The bindings the file sets, by action id (normal form for known actions). */
  bindings: Bindings;
  /** Known actions whose chords the file changes, compared with `current`. */
  changes: ImportChange[];
  /** Action ids this version does not know (kept, shown under "Unknown actions"). */
  unknown: string[];
}

/** Check one id → chords entry against the limits; throws a readable message. */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

function checkEntry(id: string, chords: unknown): string[] {
  if (RESERVED_IDS.has(id)) throw new Error(`“${id}” is not a valid action id.`);
  if (!id || id.length > KEYBINDING_LIMITS.idMaxChars || !ID_RE.test(id)) throw new Error(`“${id.slice(0, 80)}” is not a valid action id.`);
  if (!Array.isArray(chords)) throw new Error(`The chords of ${id} must be a list.`);
  if (chords.length > KEYBINDING_LIMITS.maxChordsPerAction) {
    throw new Error(`${id} has ${chords.length} chords; at most ${KEYBINDING_LIMITS.maxChordsPerAction} are allowed.`);
  }
  for (const c of chords) {
    if (typeof c !== "string" || !c || c.length > KEYBINDING_LIMITS.chordMaxChars || !PRINTABLE_ASCII.test(c)) {
      throw new Error(`${id}: “${String(c).slice(0, 60)}” is not a valid chord.`);
    }
  }
  return chords as string[];
}

/**
 * Read and validate an export file against the current overrides. Throws an Error with a readable
 * message when the file is not a keybindings file or breaks a limit; nothing is applied then.
 */
export function parseImport(text: string, currentOverrides: Bindings): ImportResult {
  if (new TextEncoder().encode(text).length > KEYBINDING_LIMITS.fileMaxBytes) {
    throw new Error(`The file is larger than ${KEYBINDING_LIMITS.fileMaxBytes / 1024} KiB.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The file is not an S3 Explorer keybindings file.");
  const d = data as Record<string, unknown>;
  if (d.s3explorer !== EXPORT_KIND) throw new Error("The file is not an S3 Explorer keybindings file.");
  if (typeof d.version !== "number") throw new Error("The file has no version.");
  if (d.version > EXPORT_VERSION) throw new Error(`The file was made by a newer version of S3 Explorer (format ${d.version}).`);
  if (d.version !== EXPORT_VERSION) throw new Error(`Unknown file format ${d.version}.`);
  const raw = d.bindings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The file has no bindings.");
  // Own keys only, including a literal "__proto__" key that JSON.parse creates as an own property.
  const entries = Object.keys(raw as object).map((k) => [k, (raw as Record<string, unknown>)[k]] as const);
  if (entries.length > KEYBINDING_LIMITS.maxActions) {
    throw new Error(`The file binds ${entries.length} actions; at most ${KEYBINDING_LIMITS.maxActions} are allowed.`);
  }
  const current = effectiveBindings(currentOverrides);
  const bindings: Bindings = Object.create(null) as Bindings;
  const changes: ImportChange[] = [];
  const unknown: string[] = [];
  for (const [id, value] of entries) {
    const chords = checkEntry(id, value);
    const act = ACTIONS_BY_ID.get(id);
    if (!act) {
      bindings[id] = [...chords];
      unknown.push(id);
      continue;
    }
    const norm: string[] = [];
    for (const c of chords) {
      const n = normalizeChord(c);
      if (!n) throw new Error(`${id}: “${c}” is not a valid chord.`);
      const problem = chordProblem(id, n);
      if (problem) throw new Error(`${id}: ${n}: ${problem}`);
      if (!norm.includes(n)) norm.push(n);
    }
    bindings[id] = norm;
    if (!sameChordList(norm, current[id])) changes.push({ id, label: act.label, from: current[id], to: norm });
  }
  return { bindings, changes, unknown };
}

/** The overrides after applying an import: the file's bindings over the current overrides. */
export function applyImport(currentOverrides: Bindings, result: ImportResult): Bindings {
  return normalizeOverrides({ ...currentOverrides, ...result.bindings });
}

/** Validate a saved `keybindings` value as the backend does; the first problem, or null. */
export function validateKeybindings(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "Must be an object of action id → chords.";
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > KEYBINDING_LIMITS.maxActions) return `At most ${KEYBINDING_LIMITS.maxActions} entries.`;
  try {
    for (const [id, chords] of entries) checkEntry(id, chords);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}
