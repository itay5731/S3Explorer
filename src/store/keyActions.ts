// The key dispatcher (v0.7.0): one capture-phase keydown listener (installed by Explorer.tsx)
// resolves the context, finds the action bound to the chord and runs it. See "Dispatcher rules"
// in docs/CONTRACT.md. Dialogs, menus, the game and the connect screen keep their own local keys.

import { ACTIONS_BY_ID, chordFromMouse, chordFromEvent, chordToString, EDITING_KEYS, EXTENDABLE, isAltGraph, isAlwaysPrevented, isTextField, parseChord, type KeyContext } from "../lib/keys";
import { parentPrefix, s3Uri } from "../lib/format";
import {
  activePane,
  getPane,
  goHistory,
  isSplitShown,
  navigate,
  openModal,
  refresh,
  requestDisconnect,
  setActivePane,
  setDetailsOpen,
  setFilter,
  setSelection,
  setSplit,
  setTransfersOpen,
  shownOtherPane,
  useApp,
} from "./app";
import { otherPane } from "./panes";
import { copyText, downloadObjects, openNewFolder, pickAndUpload } from "./actions";
import { pickAndUploadFolder, requestDownloadFolders } from "./folders";
import { copySelection, requestBulkTags, requestDelete, requestPaste, requestRename, requestRestoreArchived, requestTransferToOther } from "./ops";
import { ARCHIVED_REASON, isArchiveClass, needsRestore } from "./archive";
import { useClipboard } from "./clipboard";
import { getSelected } from "./view";
import { rerunSearch, scheduleSearch, setSearchScope, useSearch } from "./search";
import { openSettings, useSettings } from "./settings";
import { toast } from "./toasts";
import { currentKeys, focusBuckets, focusPaneList, focusPaneListSoon, listKeys, searchInput, setCheatOpen, useKeys, type MoveTarget } from "./keyboard";
import { requestVersionsOpen, useVersioning, hasVersions } from "./versions";
import { closeTab, cycleTab, openTab, reopenClosedTab } from "./tabs";
import { useRowDragView } from "../components/RowDrag";
import { toggleBookmark } from "./bookmarks";

/** What a handler did: nothing to do here (`false`: the key keeps its usual meaning), or why it can't. */
type Outcome = void | boolean | { unavailable: string };

const no = (unavailable: string) => ({ unavailable });

const OPEN_BUCKET = "Open a bucket first";
const SELECT_FIRST = "Select something first";
const IN_RESULTS = "Go back to a folder first: search results are open";

/** The element the key event being dispatched was aimed at (for the text-copy rule). */
let eventTarget: Element | null = null;

/**
 * Text is selected outside the file lists and the key was not pressed in one: Ctrl+C / Ctrl+X /
 * copy key / copy URI leave it to the browser, which copies the text.
 */
function textSelectionWins(): boolean {
  if (eventTarget?.closest?.(".tbody")) return false;
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString() !== "";
}

function selection() {
  const { folders, objects } = getSelected();
  return { folders, objects, count: folders.length + objects.length };
}

/** The single selected object that needs a restore before it can be read. */
function blockedSingle(): boolean {
  const { bucket } = getPane();
  const { folders, objects } = selection();
  if (!bucket || folders.length || objects.length !== 1) return false;
  return needsRestore(bucket, objects[0]) === true;
}

const move = (to: MoveTarget) => (extend: boolean) => {
  const l = listKeys(activePane());
  if (!l) return false;
  l.move(to, extend);
};

const withList = (fn: (l: NonNullable<ReturnType<typeof listKeys>>) => void) => (): Outcome => {
  const l = listKeys(activePane());
  if (!l) return false;
  fn(l);
};

/** The action handlers. `extend` is the fixed Shift rule for the movement actions. */
const HANDLERS: Record<string, (extend: boolean) => Outcome> = {
  "nav.open": withList((l) => l.open()),
  "nav.up": () => {
    const { bucket, prefix } = getPane();
    if (!bucket || !prefix) return false;
    navigate(bucket, parentPrefix(prefix));
  },
  "nav.back": () => goHistory(-1) || undefined,
  "nav.forward": () => goHistory(1) || undefined,
  "nav.root": () => {
    const { bucket, prefix, search } = getPane();
    if (!bucket) return no(OPEN_BUCKET);
    if (prefix || search.open) navigate(bucket, "");
  },
  "nav.refresh": () => {
    const { bucket, search } = getPane();
    if (!bucket) return;
    if (search.open) rerunSearch();
    else void refresh();
  },
  "nav.focusFiles": () => {
    focusPaneList(activePane());
  },
  "nav.focusBuckets": () => {
    if (!focusBuckets()) return no("There are no buckets to choose from");
  },
  "nav.focusSearch": () => {
    const input = searchInput();
    if (!input || input.disabled) return no(OPEN_BUCKET);
    input.focus();
    input.select();
  },
  "nav.searchScope": () => {
    const next = useSearch.getState().scope === "folder" ? "bucket" : "folder";
    setSearchScope(next);
    toast.info(next === "bucket" ? "Search: the whole bucket" : "Search: this folder");
  },
  "nav.bookmark": () => {
    const { bucket, prefix } = getPane();
    if (!bucket) return no(OPEN_BUCKET);
    toggleBookmark(bucket, prefix);
  },
  "nav.nextPane": () => {
    const other = shownOtherPane();
    if (!other) return false;
    setActivePane(other);
    focusPaneList(other);
  },
  "nav.prevPane": () => {
    const other = shownOtherPane();
    if (!other) return false;
    setActivePane(other);
    focusPaneList(other);
  },
  "tab.new": () => {
    if (!getPane().bucket) return no(OPEN_BUCKET);
    afterTabSwitch(() => openTab(activePane(), null, true));
  },
  // Always used, even with nothing to do: the key must never reach the webview.
  "tab.close": () => {
    afterTabSwitch(() => closeTab(activePane()));
  },
  "tab.next": () => {
    afterTabSwitch(() => cycleTab(activePane(), 1));
  },
  "tab.prev": () => {
    afterTabSwitch(() => cycleTab(activePane(), -1));
  },
  "tab.reopen": () => {
    if (!reopenClosedTab()) return no("No closed tab to reopen");
    focusPaneListSoon(activePane());
  },
  "view.single": () => setSplit(false),
  "view.split": () => setSplit(true),
  "view.details": () => {
    setDetailsOpen(!useApp.getState().detailsOpen);
  },
  "view.activity": () => setTransfersOpen(!useApp.getState().transfersOpen),
  "view.settings": () => openSettings(),
  "help.shortcuts": () => setCheatOpen(!useKeys.getState().cheatOpen),

  "sel.up": move("up"),
  "sel.down": move("down"),
  "sel.pageUp": move("pageUp"),
  "sel.pageDown": move("pageDown"),
  "sel.first": move("first"),
  "sel.last": move("last"),
  "sel.toggle": withList((l) => l.toggle()),
  "sel.toggleNext": withList((l) => l.toggleNext()),
  "sel.all": withList((l) => l.selectAll()),
  "sel.none": withList((l) => l.clear()),
  "sel.menu": withList((l) => l.menu()),

  "act.upload": () => {
    const { bucket, search } = getPane();
    if (!bucket) return no(OPEN_BUCKET);
    if (search.open) return no(IN_RESULTS);
    void pickAndUpload();
  },
  "act.uploadFolder": () => {
    const { bucket, search } = getPane();
    if (!bucket) return no(OPEN_BUCKET);
    if (search.open) return no(IN_RESULTS);
    void pickAndUploadFolder();
  },
  "act.download": () => {
    if (!getPane().bucket) return no(OPEN_BUCKET);
    const { objects, folders, count } = selection();
    if (!count) return no(SELECT_FIRST);
    if (blockedSingle()) return no(ARCHIVED_REASON);
    if (objects.length) void downloadObjects(objects);
    else void requestDownloadFolders(folders);
  },
  "act.newFolder": () => {
    const { bucket, search } = getPane();
    if (!bucket) return no(OPEN_BUCKET);
    if (search.open) return no("Go back to a folder to create one");
    openNewFolder();
  },
  "act.delete": () => {
    if (!selection().count) return no(SELECT_FIRST);
    requestDelete();
  },
  "act.rename": () => {
    const { count } = selection();
    if (count !== 1) return no(count ? "Select one item to rename" : SELECT_FIRST);
    if (blockedSingle()) return no(ARCHIVED_REASON);
    void requestRename();
  },
  "act.copy": () => {
    if (textSelectionWins()) return false;
    if (!selection().count) return no(SELECT_FIRST);
    if (blockedSingle()) return no(ARCHIVED_REASON);
    void copySelection("copy");
  },
  "act.cut": () => {
    if (textSelectionWins()) return false;
    if (!selection().count) return no(SELECT_FIRST);
    if (blockedSingle()) return no(ARCHIVED_REASON);
    void copySelection("cut");
  },
  "act.paste": () => {
    const { bucket, search } = getPane();
    if (!bucket) return no(OPEN_BUCKET);
    if (search.open) return no("Go back to a folder to paste into it");
    if (!useClipboard.getState().clip) return no("The clipboard is empty");
    requestPaste();
  },
  "act.copyToOther": () => transferToOther("copy"),
  "act.moveToOther": () => transferToOther("cut"),
  "act.copyKey": () => {
    if (textSelectionWins()) return false;
    const keys = selectedKeys();
    if (!keys.length) return no(SELECT_FIRST);
    void copyText(keys.join("\n"), keys.length > 1 ? "Keys" : "Key");
  },
  "act.copyUri": () => {
    if (textSelectionWins()) return false;
    const { bucket } = getPane();
    const keys = selectedKeys();
    if (!bucket || !keys.length) return no(SELECT_FIRST);
    void copyText(keys.map((k) => s3Uri(bucket, k)).join("\n"), keys.length > 1 ? "S3 URIs" : "S3 URI");
  },
  "act.tags": () => {
    const { bucket } = getPane();
    const { folders, objects, count } = selection();
    if (!bucket || !count) return no(SELECT_FIRST);
    if (!folders.length && objects.length === 1) openModal({ kind: "objectTags", bucket, key: objects[0].key });
    else requestBulkTags();
  },
  "act.versions": () => {
    const { bucket, search } = getPane();
    const { folders, objects } = selection();
    if (!bucket) return no(OPEN_BUCKET);
    if (folders.length || objects.length !== 1) return no("Select one object to see its versions");
    const v = useVersioning.getState().byBucket[bucket];
    if (v !== undefined && !hasVersions(v)) return no("Versioning is not enabled on this bucket");
    const o = objects[0];
    if (!search.open) setSelection(new Set([o.key]), o.key, o.key);
    setDetailsOpen(true);
    requestVersionsOpen(bucket, o.key);
  },
  "act.restore": () => {
    const { folders, objects, count } = selection();
    if (!count) return no(SELECT_FIRST);
    if (!folders.length && !objects.some((o) => isArchiveClass(o.storageClass))) return no("None of the selected objects is archived");
    requestRestoreArchived();
  },
  "act.disconnect": () => requestDisconnect(),
};

/** Switch tabs from the keyboard: the shown tab's list keeps the keyboard if the pane had it. */
function afterTabSwitch(fn: () => boolean) {
  const pane = activePane();
  const inPane = !!document.activeElement?.closest(`[data-pane="${pane}"]`);
  if (fn() && inPane) focusPaneListSoon(pane);
}

function selectedKeys(): string[] {
  const { folders, objects } = selection();
  return [...folders.map((f) => f.prefix), ...objects.map((o) => o.key)];
}

function transferToOther(mode: "copy" | "cut"): Outcome {
  if (!isSplitShown()) return no(useApp.getState().split ? "The window is too narrow for two panes" : "Open the split view first");
  if (!getPane().bucket) return no(OPEN_BUCKET);
  if (!selection().count) return no(SELECT_FIRST);
  if (blockedSingle()) return no(ARCHIVED_REASON);
  if (!getPane(otherPane(activePane())).bucket) return no("Open a bucket in the other pane first");
  void requestTransferToOther(mode);
}

/** Run an action by id (the cheat sheet and tests use this too). Returns what the handler did. */
export function runAction(id: string, extend = false): Outcome {
  const handler = HANDLERS[id];
  return handler ? handler(extend) : false;
}

// ---- dispatcher ---------------------------------------------------------------------------------

/** A dialog, menu, popover, Settings, the cheat sheet, the game or a row drag is in the way. */
function overlayOpen(): boolean {
  const st = useApp.getState();
  if (st.modal || st.contextMenu || useSettings.getState().open || useKeys.getState().cheatOpen) return true;
  if (useRowDragView.getState().ids.size) return true;
  if (document.documentElement.classList.contains("playing-game")) return true;
  return !!document.querySelector(".modal-backdrop, .context-menu, .popover, .defend-game");
}

/** Actions that still work with a menu or Settings open (never over a confirmation dialog). */
const OVER_OVERLAY = new Set(["settings.open", "view.settings", "help.shortcuts"]);

/** Actions that may run again while their key auto-repeats (moving through the list). */
const REPEATABLE = new Set(["sel.up", "sel.down", "sel.pageUp", "sel.pageDown", "sel.first", "sel.last"]);

/** Toasts for unavailable actions: the same reason pressed again within a moment shows once. */
let lastReason = { text: "", at: 0 };
function toastUnavailable(text: string) {
  const now = Date.now();
  if (lastReason.text === text && now - lastReason.at < 1500) return;
  lastReason = { text, at: now };
  toast.info(text);
}

/** Where focus is, for the dispatcher. */
function focusContext(el: Element | null): { files: boolean; search: boolean; typing: boolean } {
  const search = !!el?.closest?.(".toolbar-search");
  const typing = isTextField(el);
  const pane = activePane();
  let files = false;
  if (!typing && el) {
    const list = el.closest(".pane .tbody");
    const paneEl = el.closest<HTMLElement>("[data-pane]");
    files =
      (!!list && paneEl?.dataset.pane === pane) ||
      // Nothing focused, or the pane itself (it takes focus when it has no list): the active pane's list.
      el === document.body ||
      (el as HTMLElement).dataset?.pane === pane;
  }
  return { files, search, typing };
}

/** Try one action; true when the key was used (handled or reported unavailable). */
function tryRun(id: string, extend: boolean): boolean {
  const out = runAction(id, extend);
  if (out === false) return false;
  if (out && typeof out === "object") toastUnavailable(out.unavailable);
  return true;
}

/**
 * The capture-phase mousedown handler: the extra mouse buttons are chords in the `global` context,
 * acting on the pane under the pointer (else the active pane). Blocked like keys by dialogs, menus
 * and Settings. The webview's own Back/Forward is prevented at the window level (main.tsx).
 */
export function onExplorerMouseDown(e: MouseEvent) {
  const chord = chordFromMouse(e);
  if (!chord) return;
  e.preventDefault();
  if (useKeys.getState().recording || overlayOpen()) return;
  const id = currentKeys().index.global.get(chord);
  if (!id || !ACTIONS_BY_ID.has(id)) return;
  const under = (e.target as Element | null)?.closest?.<HTMLElement>("[data-pane]")?.dataset.pane;
  if (under === "a" || under === "b") setActivePane(under);
  eventTarget = e.target instanceof Element ? e.target : null;
  tryRun(id, false);
}

/** The capture-phase keydown handler. */
export function onExplorerKeyDown(e: KeyboardEvent) {
  if (useKeys.getState().recording) return;
  if (e.isComposing || e.keyCode === 229) return;
  // Something before us used the key (a menu's arrows, a drag's Escape): leave it alone.
  if (e.defaultPrevented && !isAlwaysPrevented(e)) return;
  const el = (e.target as Element | null) ?? document.activeElement;
  const focus = focusContext(el instanceof Element ? el : document.activeElement);
  const overlay = overlayOpen();
  eventTarget = el instanceof Element ? el : null;
  const chord = chordFromEvent(e);
  if (!chord) {
    // A character with no chord name (Hebrew, AltGr symbols): it can still start a search.
    if (focus.files && !overlay && isTypedCharacter(e)) typeToSearch(e);
    return;
  }
  const { index } = currentKeys();

  const parsed = parseChord(chord);
  const strong = !!parsed && (parsed.mods.has("Mod") || parsed.mods.has("Ctrl") || parsed.mods.has("Meta") || parsed.mods.has("Alt") || /^F\d+$/.test(parsed.key));
  // `Shift` with a movement action extends the selection (a fixed rule, not a binding).
  const unshifted = parsed && parsed.mods.has("Shift") ? chordToString({ mods: new Set([...parsed.mods].filter((m) => m !== "Shift")), key: parsed.key }) : null;

  const lookup = (ctx: KeyContext): { id: string; extend: boolean } | null => {
    const id = index[ctx].get(chord);
    if (id) return { id, extend: false };
    if (unshifted) {
      const base = index[ctx].get(unshifted);
      if (base && EXTENDABLE.has(base)) return { id: base, extend: true };
    }
    return null;
  };

  const run = (hit: { id: string; extend: boolean } | null): boolean => {
    if (!hit || !ACTIONS_BY_ID.has(hit.id)) return false;
    if (overlay && (!OVER_OVERLAY.has(hit.id) || useApp.getState().modal)) return false;
    // A held key repeats: only moving through the list may run again (a held Mod+Shift+X must
    // never start a second job, a held Mod+D never queue pickers).
    if (e.repeat && !REPEATABLE.has(hit.id)) {
      e.preventDefault();
      return true;
    }
    if (!tryRun(hit.id, hit.extend)) return false;
    e.preventDefault();
    return true;
  };

  // 1. The search box's own context.
  if (focus.search && run(lookup("search"))) return;
  // 2. The file list: `files` beats `global` for the same chord.
  if (focus.files && !overlay) {
    if (run(lookup("files"))) return;
  }
  // 3. Global: not inside a text field unless the chord has Mod, Alt or is an F-key, and never a
  //    chord on a key that edits or moves the caret there (Ctrl+Home, Alt+Up, Option+Arrow).
  if (!focus.typing || (strong && parsed && !EDITING_KEYS.has(parsed.key))) {
    const hit = lookup("global");
    if (hit && run(hit)) return;
  }
  // 4. Type to search: a printable character typed in the file list that nothing is bound to.
  if (focus.files && !overlay && parsed && parsed.key.length === 1 && isTypedCharacter(e)) typeToSearch(e);
}

/** One printable character typed without Ctrl, Alt or Cmd (Shift and AltGr allowed). */
function isTypedCharacter(e: KeyboardEvent): boolean {
  if ([...e.key].length !== 1 || e.key === " " || /\p{C}/u.test(e.key)) return false;
  return isAltGraph(e) || (!e.ctrlKey && !e.altKey && !e.metaKey);
}

/** Put a character typed in the file list into the search box (it searches as you type). */
function typeToSearch(e: KeyboardEvent) {
  const input = searchInput();
  if (!input || input.disabled) return;
  e.preventDefault();
  const pane = activePane();
  const text = getPane(pane).filter + e.key;
  setFilter(text, pane);
  scheduleSearch(text, pane);
  input.focus();
  // The caret goes after the typed character once React has written the value.
  requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
}
