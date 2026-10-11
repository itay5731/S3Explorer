// Keyboard plumbing (v0.7.0): what the key dispatcher needs from the rest of the UI. The lists
// (object table, search results) register what their keys do; focus helpers move the keyboard
// between the bucket list, a pane's list and the search box; the cheat sheet and the recorder in
// Settings → Keyboard have their own flags. The dispatcher itself lives in ./keyActions.ts.

import { create } from "zustand";
import { effectiveBindings, buildIndex, formatChord, type Bindings, type KeyIndex } from "../lib/keys";
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

let cache: { overrides: Bindings | undefined; bindings: Bindings; index: KeyIndex } | null = null;

/** Every action's chords and the dispatcher's index, from the saved overrides. */
export function currentKeys(): { bindings: Bindings; index: KeyIndex } {
  const overrides = useSettings.getState().settings?.keybindings;
  if (!cache || cache.overrides !== overrides) {
    const bindings = effectiveBindings(overrides);
    cache = { overrides, bindings, index: buildIndex(bindings) };
  }
  return cache;
}

/** Hook: the chords bound to an action right now (saved settings). */
export function useChords(id: string): string[] {
  // Subscribing re-renders the caller when the bindings are saved.
  useSettings((s) => s.settings?.keybindings);
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
