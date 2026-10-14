// Keyboard plumbing (v0.7.0): what the key dispatcher needs from the rest of the UI. The lists
// (object table, search results) register what their keys do; focus helpers move the keyboard
// between the bucket list, a pane's list and the search box; the cheat sheet and the recorder in
// Settings → Keyboard have their own flags. The dispatcher itself lives in ./keyActions.ts.

import { create } from "zustand";
import { asPreset, effectiveBindings, buildIndex, formatChord, type Bindings, type KeyIndex } from "../lib/keys";
import type { KeybindingsPreset } from "../lib/types";
import type { PaneId } from "./panes";
import { useSettings } from "./settings";

interface KeysState {
  /** The keyboard cheat sheet is open. */
  cheatOpen: boolean;
  /** Settings → Keyboard is recording a chord: the dispatcher stays out of the way. */
  recording: boolean;
}

export const useKeys = create<KeysState>(() => ({ cheatOpen: false, recording: false }));

export const setCheatOpen = (cheatOpen: boolean) => useKeys.setState({ cheatOpen });
export const setRecording = (recording: boolean) => useKeys.setState({ recording });

// ---- effective bindings ------------------------------------------------------------------------

let cache: { overrides: Bindings | undefined; preset: KeybindingsPreset; bindings: Bindings; index: KeyIndex } | null = null;

/**
 * The defaults the saved overrides apply to: Total Commander, except for an upgraded install whose
 * settings still say "classic" until its one-time migration is saved (store/settings.ts).
 */
export function currentPreset(): KeybindingsPreset {
  const s = useSettings.getState().settings;
  return s ? (asPreset(s.keybindingsPreset) ?? "classic") : "commander";
}

/** Every action's chords and the dispatcher's index, from the saved preset and overrides. */
export function currentKeys(): { bindings: Bindings; index: KeyIndex } {
  const overrides = useSettings.getState().settings?.keybindings;
  const preset = currentPreset();
  if (!cache || cache.overrides !== overrides || cache.preset !== preset) {
    const bindings = effectiveBindings(overrides, preset);
    cache = { overrides, preset, bindings, index: buildIndex(bindings) };
  }
  return cache;
}

/** Hook: the chords bound to an action right now (saved settings). */
export function useChords(id: string): string[] {
  // Subscribing re-renders the caller when the bindings or the preset are saved.
  useSettings((s) => s.settings?.keybindings);
  useSettings((s) => s.settings?.keybindingsPreset);
  return currentKeys().bindings[id] ?? [];
}

/** Hook: the first chord of an action as this platform writes it ("" when unbound), for tooltips. */
export function useKeyHint(id: string): string {
  const chords = useChords(id);
  return chords.length ? formatChord(chords[0]) : "";
}

/** "Copy (Ctrl+C)", or just "Copy" when the action has no key. */
export const withKey = (label: string, hint: string) => (hint ? `${label} (${hint})` : label);

// ---- lists -------------------------------------------------------------------------------------

export type MoveTarget = "up" | "down" | "pageUp" | "pageDown" | "first" | "last";

/** What the keys do in a pane's list (the object table or the search results, whichever is shown). */
export interface ListKeys {
  move(to: MoveTarget, extend: boolean): void;
  toggle(): void;
  toggleNext(): void;
  selectAll(): void;
  /** Escape: clear the selection (results: then close them). */
  clear(): void;
  /** Enter: open the focused folder / object. */
  open(): void;
  /** The context menu for the focused row (or the folder, with nothing focused). */
  menu(): void;
  /**
   * Type to jump (v0.9.0): focus and select the row `findJump` picks for `prefix`; false when
   * nothing matches (nothing moves then).
   */
  jump(prefix: string): boolean;
}

/**
 * The row type-to-jump moves to: the first whose name starts with `prefix` (case-insensitive), or,
 * when the prefix is one letter typed again and again ("aaa"), the next row after `current` starting
 * with that letter (cycling). -1 when nothing matches.
 */
export function findJump(names: readonly string[], prefix: string, current: number): number {
  const p = prefix.toLocaleLowerCase();
  if (!p) return -1;
  const chars = [...p];
  const cycle = chars.length > 1 && chars.every((c) => c === chars[0]);
  if (cycle) {
    const c = chars[0];
    for (let k = 1; k <= names.length; k++) {
      const i = (current + k + names.length) % names.length;
      if (names[i].toLocaleLowerCase().startsWith(c)) return i;
    }
    return -1;
  }
  return names.findIndex((n) => n.toLocaleLowerCase().startsWith(p));
}

const lists: Partial<Record<PaneId, ListKeys>> = {};

/** A list registers its keys while mounted; returns the unregister function. */
export function registerListKeys(pane: PaneId, keys: ListKeys): () => void {
  lists[pane] = keys;
  return () => {
    if (lists[pane] === keys) delete lists[pane];
  };
}

export const listKeys = (pane: PaneId): ListKeys | undefined => lists[pane];

// ---- focus -------------------------------------------------------------------------------------

/** Give a pane's list (table or results) the keyboard; the pane itself when it has no list. */
export function focusPaneList(pane: PaneId): boolean {
  const root = document.querySelector<HTMLElement>(`[data-pane="${pane}"]`);
  const el = root?.querySelector<HTMLElement>(".tbody") ?? root;
  el?.focus();
  return !!el;
}

/** The same, after React has rendered (a navigation swaps the table in). */
export function focusPaneListSoon(pane: PaneId) {
  requestAnimationFrame(() => focusPaneList(pane));
}

/** The toolbar search box, or null when the toolbar is not shown. */
export const searchInput = () => document.querySelector<HTMLInputElement>(".toolbar-search input");

/** Focus the bucket list: the open bucket's row, else the first one. */
export function focusBuckets(): boolean {
  const rows = [...document.querySelectorAll<HTMLElement>(".bucket-list .bucket-item:not(.skeleton)")];
  const el = rows.find((r) => r.classList.contains("selected")) ?? rows[0];
  el?.focus();
  return !!el;
}
