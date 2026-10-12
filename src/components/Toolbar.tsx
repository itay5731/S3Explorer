import { Fragment, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  FileUp,
  FolderUp,
  FolderPlus,
  PanelRightClose,
  PanelRightOpen,
  PencilLine,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  Upload,
  X,
  Archive,
  ArchiveRestore,
  ArrowUp,
  ArrowLeft,
  ArrowRight,
  Columns2,
  CopyPlus,
  Folder,
  FolderInput,
} from "lucide-react";
import { goHistory, navigate, readPref, refresh, setDetailsOpen, setFilter, setSplit, useApp, usePane, usePaneId, writePref } from "../store/app";
import { otherPane, usePanes } from "../store/panes";
import { getSearch, leaveSearch, requestResultsFocus, rerunSearch, runSearch, scheduleSearch, searchScheduled, setSearchScope, usePaneSearch, useSearch } from "../store/search";
import { focusPaneListSoon, useKeyHint, withKey } from "../store/keyboard";
import { clearClipboard, useClipboard } from "../store/clipboard";
import { copySelection, requestDelete, requestPaste, requestRename, requestRestoreArchived, requestTransferToOther } from "../store/ops";
import { ARCHIVED_REASON, isArchiveClass, useArchiveBlocked } from "../store/archive";
import { copyText, downloadObjects, openNewFolder, pickAndUpload } from "../store/actions";
import { pickAndUploadFolder, requestDownloadFolders } from "../store/folders";
import { PopupMenu } from "./PopupMenu";
import { getSelected, useSelectionInfo, useViewRows } from "../store/view";
import { displayName, formatBytes, parentPrefix, prefixSegments, s3Uri } from "../lib/format";
import { plural } from "../lib/ops";

function clipTitle(mode: "copy" | "cut", keys: string[]): string {
  const shown = keys.slice(0, 20).join("\n");
  const more = keys.length > 20 ? `\n… and ${keys.length - 20} more` : "";
  return `${mode === "cut" ? "Cut (moves on paste)" : "Copied"}:\n${shown}${more}`;
}

/** "Upload" (files) with a menu button next to it for "Upload files…" / "Upload folder…". */
function UploadButton({ disabled }: { disabled: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const openMenu = () => {
    const r = caret.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left - 70, y: r.bottom + 4 });
  };
  return (
    <span className="split-btn">
      <button className="btn btn-primary split-main" disabled={disabled} onClick={() => void pickAndUpload()} title="Upload files">
        <Upload size={14} />
        <span className="btn-label">Upload</span>
      </button>
      <button
        ref={caret}
        className="btn btn-primary split-caret"
        disabled={disabled}
        onClick={() => (menu ? setMenu(null) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openMenu();
          }
        }}
        title="More ways to upload"
        aria-label="More ways to upload"
        aria-haspopup="menu"
        aria-expanded={!!menu}
      >
        <ChevronDown size={13} />
      </button>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label="Upload"
          onClose={() => {
            setMenu(null);
            caret.current?.focus();
          }}
          groups={[
            [
              { label: "Upload files…", icon: <FileUp size={14} />, action: () => void pickAndUpload() },
              { label: "Upload folder…", icon: <FolderUp size={14} />, action: () => void pickAndUploadFolder() },
            ],
          ]}
        />
      )}
    </span>
  );
}

const HINT_KEY = "s3x.searchHintDismissed";
const TYPING_HINT_KEY = "s3x.searchTypingHintDismissed";

/**
 * The search box, on its own row under the toolbar: typing filters the loaded rows at once and
 * searches 500 ms after the last keystroke (Enter searches right away); Esc clears it and leaves
 * the results. The scope control sits beside it. Mod+F, `/` and typing in the file list focus it
 * (key dispatcher). While the box is empty a hint shows the query syntax; while there is text, one
 * says what is being searched and that Enter searches now, since the scope is easy to miss.
 */
function SearchBox() {
  const pane = usePaneId();
  const bucket = usePane((s) => s.bucket);
  const prefix = usePane((s) => s.prefix);
  const filter = usePane((s) => s.filter);
  const scope = useSearch((s) => s.scope);
  const searchOpen = usePaneSearch((s) => s.open);
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(() => readPref<boolean>(HINT_KEY, false));
  const [typingHintDismissed, setTypingHintDismissed] = useState(() => readPref<boolean>(TYPING_HINT_KEY, false));
  const disabled = !bucket;
  const searchKey = useKeyHint("nav.focusSearch");

  const clear = () => {
    leaveSearch(pane);
    focusPaneListSoon(pane);
  };
  const dismissHint = () => {
    setHintDismissed(true);
    writePref(HINT_KEY, true);
  };
  const dismissTypingHint = () => {
    setTypingHintDismissed(true);
    writePref(TYPING_HINT_KEY, true);
  };
  const folderTitle = `Search this folder: s3://${bucket ?? ""}/${prefix}`;
  // At the bucket root "this folder" is the whole bucket, so say so (as the results header does).
  const wholeBucket = scope === "bucket" || !prefix;

  return (
    <div className="search-wrap">
      <div className={`search-box toolbar-search ${searchOpen ? "searching" : ""}`}>
        <Search size={13} />
        <input
          ref={input}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value, pane);
            scheduleSearch(e.target.value, pane);
          }}
          placeholder={wholeBucket ? "Search the whole bucket · as you type, Enter searches now" : "Search this folder · as you type, Enter searches now"}
          aria-label="Filter loaded items; searches as you type"
          title={withKey("Search", searchKey)}
          spellCheck={false}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") {
              e.preventDefault();
              clear();
            } else if (e.key === "Enter") {
              // Right away (no waiting for the typing to stop), and the results take the keyboard.
              e.preventDefault();
              const s = getSearch(pane);
              const same = s.open && s.request?.text === filter && !searchScheduled(pane);
              if (!same) runSearch(filter, pane);
              if (getSearch(pane).open) requestResultsFocus(pane);
            } else if (e.key === "ArrowDown" && !e.altKey && !e.ctrlKey && !e.metaKey && (getSearch(pane).open || searchScheduled(pane))) {
              e.preventDefault();
              requestResultsFocus(pane);
            }
          }}
        />
        {(filter || searchOpen) && (
          <button className="icon-btn" onClick={clear} aria-label="Clear" title="Clear (Esc)">
            <X size={12} />
          </button>
        )}
        {focused && filter && !typingHintDismissed && (
          <div className="search-hint typing" role="note" onMouseDown={(e) => e.preventDefault()}>
            <span>
              {wholeBucket ? (
                <>
                  Searching the <strong>whole bucket</strong>. <kbd>Enter</kbd> searches now.
                </>
              ) : (
                <>
                  Searching <strong>this folder only</strong>. <kbd>Enter</kbd> searches now · <strong>Whole bucket</strong> is on the right.
                </>
              )}
            </span>
            <button className="icon-btn" onClick={dismissTypingHint} aria-label="Dismiss hint" title="Got it, don't show again">
              <X size={11} />
            </button>
          </div>
        )}
        {focused && !filter && !hintDismissed && (
          <div className="search-hint" role="note" onMouseDown={(e) => e.preventDefault()}>
            <span>
              Searches as you type: <code>word</code> <code>"a phrase"</code> <code>-not</code> <code>tag:key=value</code> <code>folder/part</code>
            </span>
            <button className="icon-btn" onClick={dismissHint} aria-label="Dismiss hint" title="Don't show again">
              <X size={11} />
            </button>
          </div>
        )}
      </div>
      <div className="segmented scope-seg" role="group" aria-label="Search scope">
        <button
          className={scope === "folder" ? "active" : ""}
          aria-pressed={scope === "folder"}
          disabled={disabled}
          onClick={() => setSearchScope("folder")}
          title={folderTitle}
        >
          <Folder size={12} />
          <span className="seg-long">This folder</span>
          <span className="seg-short">Folder</span>
        </button>
        <button
          className={scope === "bucket" ? "active" : ""}
          aria-pressed={scope === "bucket"}
          disabled={disabled}
          onClick={() => setSearchScope("bucket")}
          title={`Search the whole bucket: s3://${bucket ?? ""}/`}
        >
          <Archive size={12} />
          <span className="seg-long">Whole bucket</span>
          <span className="seg-short">Bucket</span>
        </button>
      </div>
    </div>
  );
}

/** The row under the toolbar that holds the search box and its scope, full width. */
export function SearchRow() {
  return (
    <div className="search-row">
      <SearchBox />
    </div>
  );
}

/** The other pane's destination when two panes are on screen: its bucket and folder, or null. */
export function useOtherPaneDest(): { bucket: string; prefix: string } | null {
  const shown = useApp((s) => s.split && !s.narrow);
  const other = otherPane(useApp((s) => s.activePane));
  const bucket = usePanes((s) => s[other].bucket);
  const prefix = usePanes((s) => s[other].prefix);
  return shown && bucket ? { bucket, prefix } : null;
}

/** Split / Single: one toggle, pressed while two panes are open (Mod+2 / Mod+1 by default). */
function SplitButton() {
  const split = useApp((s) => s.split);
  const narrow = useApp((s) => s.narrow);
  const single = useKeyHint("view.single");
  const two = useKeyHint("view.split");
  const title = split
    ? narrow
      ? `${withKey("Single view", single)}. The second pane is hidden: the window is too narrow for two panes.`
      : `${withKey("Single view", single)}: keep only the active pane`
    : `${withKey("Split view", two)}: two panes side by side`;
  return (
    <button
      className={`icon-btn lg split-toggle ${split ? "active" : ""} ${split && narrow ? "hidden-pane" : ""}`}
      onClick={() => setSplit(!split)}
      title={title}
      aria-label={split ? "Single view" : "Split view"}
      aria-pressed={split}
    >
      <Columns2 size={15} />
    </button>
  );
}

export function Toolbar() {
  const bucket = usePane((s) => s.bucket);
  const prefix = usePane((s) => s.prefix);
  const loading = usePane((s) => s.listing.loading);
  const detailsOpen = useApp((s) => s.detailsOpen);
  const searchOpen = usePaneSearch((s) => s.open);
  const searching = usePaneSearch((s) => s.loading);
  const sel = useSelectionInfo();
  const selCount = sel.folders + sel.objects;
  const clip = useClipboard((s) => s.clip);
  const disabled = !bucket;
  // One archived object that isn't restored can't be downloaded, copied, moved or renamed.
  const blocked = useArchiveBlocked(bucket, sel.object);
  const dest = useOtherPaneDest();
  const splitShown = useApp((s) => s.split && !s.narrow);
  const destUri = dest ? s3Uri(dest.bucket, dest.prefix) : "";
  const why = (title: string) => (blocked ? ARCHIVED_REASON : title);
  // Restore is offered only when the selection holds archived objects (folders: context menu).
  const archivedCount = useMemo(
    () => (sel.objects ? getSelected().objects.filter((o) => isArchiveClass(o.storageClass)).length : 0),
    [sel],
  );
  const k = {
    copy: useKeyHint("act.copy"),
    cut: useKeyHint("act.cut"),
    paste: useKeyHint("act.paste"),
    rename: useKeyHint("act.rename"),
    toOther: useKeyHint("act.copyToOther"),
    moveOther: useKeyHint("act.moveToOther"),
    del: useKeyHint("act.delete"),
    up: useKeyHint("nav.up"),
    back: useKeyHint("nav.back"),
    forward: useKeyHint("nav.forward"),
    refresh: useKeyHint("nav.refresh"),
    newFolder: useKeyHint("act.newFolder"),
    download: useKeyHint("act.download"),
    details: useKeyHint("view.details"),
  };
  // Back / Forward follow the active pane's history.
  const paneId = usePaneId();
  const backOk = usePanes((s) => s[paneId].history.index > 0);
  const forwardOk = usePanes((s) => s[paneId].history.index < s[paneId].history.entries.length - 1);

  return (
    <div className={`toolbar ${dest || splitShown ? "split" : ""}`}>
      <div className="tool-group">
        {/* No folder is in view while search results are open: nothing to upload or create into. */}
        <UploadButton disabled={disabled || searchOpen} />
        <button className="btn" disabled={disabled || searchOpen} onClick={() => openNewFolder()} title={searchOpen ? "Go back to a folder to create one" : withKey("New folder", k.newFolder)}>
          <FolderPlus size={14} />
          <span className="btn-label secondary">New folder</span>
        </button>
        <button
          className="btn"
          disabled={disabled || sel.objects + sel.folders === 0 || blocked}
          onClick={() => {
            // Objects selected: download those (as before). Only folders: download the folders.
            const { objects, folders } = getSelected();
            if (objects.length) void downloadObjects(objects);
            else void requestDownloadFolders(folders);
          }}
          title={
            blocked
              ? ARCHIVED_REASON
              : sel.objects > 1
              ? `Download ${sel.objects} objects`
              : sel.objects === 0 && sel.folders > 1
                ? `Download ${sel.folders} folders`
                : sel.objects === 0 && sel.folders === 1
                  ? withKey("Download folder", k.download)
                  : withKey("Download", k.download)
          }
        >
          <Download size={14} />
          <span className="btn-label secondary">Download</span>
        </button>
        <span className="tool-sep" />
        <button
          className="icon-btn lg"
          disabled={disabled || selCount === 0 || blocked}
          onClick={() => void copySelection("copy")}
          title={why(withKey("Copy", k.copy))}
          aria-label="Copy"
        >
          <Copy size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || selCount === 0 || blocked}
          onClick={() => void copySelection("cut")}
          title={why(withKey("Cut", k.cut))}
          aria-label="Cut"
        >
          <Scissors size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || !clip || searchOpen}
          onClick={() => requestPaste()}
          title={searchOpen ? "Go back to a folder to paste into it" : clip ? withKey("Paste into this folder", k.paste) : "Paste (clipboard is empty)"}
          aria-label="Paste"
        >
          <ClipboardPaste size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || selCount !== 1 || blocked}
          onClick={() => void requestRename()}
          title={why(withKey("Rename", k.rename))}
          aria-label="Rename"
        >
          <PencilLine size={15} />
        </button>
        {dest && (
          <>
            <button
              className="icon-btn lg"
              disabled={disabled || selCount === 0 || blocked}
              onClick={() => void requestTransferToOther("copy")}
              title={blocked ? ARCHIVED_REASON : `${withKey("Copy to other pane", k.toOther)}: ${destUri}`}
              aria-label="Copy to other pane"
            >
              <CopyPlus size={15} />
            </button>
            <button
              className="icon-btn lg"
              disabled={disabled || selCount === 0 || blocked}
              onClick={() => void requestTransferToOther("cut")}
              title={blocked ? ARCHIVED_REASON : `${withKey("Move to other pane", k.moveOther)}: ${destUri}`}
              aria-label="Move to other pane"
            >
              <FolderInput size={15} />
            </button>
          </>
        )}
        {archivedCount > 0 && (
          <button
            className="icon-btn lg"
            disabled={disabled}
            onClick={() => requestRestoreArchived()}
            title={archivedCount === 1 && selCount === 1 ? "Restore from the archive…" : `Restore archived objects (${archivedCount.toLocaleString()})…`}
            aria-label="Restore archived"
          >
            <ArchiveRestore size={15} />
          </button>
        )}
        <button
          className="btn btn-danger-ghost"
          disabled={disabled || selCount === 0}
          onClick={() => requestDelete()}
          title={withKey(selCount > 1 ? `Delete ${selCount} items` : "Delete", k.del)}
        >
          <Trash2 size={14} />
          <span className="btn-label secondary">Delete</span>
        </button>
        <span className="tool-sep" />
        <button className="icon-btn lg tb-history" disabled={!backOk} onClick={() => goHistory(-1)} title={withKey("Back", k.back)} aria-label="Back">
          <ArrowLeft size={15} />
        </button>
        <button className="icon-btn lg tb-history" disabled={!forwardOk} onClick={() => goHistory(1)} title={withKey("Forward", k.forward)} aria-label="Forward">
          <ArrowRight size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled || !prefix}
          onClick={() => bucket && navigate(bucket, parentPrefix(prefix))}
          title={withKey("Up one level", k.up)}
          aria-label="Up one level"
        >
          <ArrowUp size={15} />
        </button>
        <button
          className="icon-btn lg"
          disabled={disabled}
          onClick={() => (searchOpen ? rerunSearch() : refresh())}
          title={withKey(searchOpen ? "Search again" : "Refresh", k.refresh)}
        >
          <RefreshCw size={15} className={(searchOpen ? searching : loading) ? "spin" : ""} />
        </button>
      </div>
      <div className="tool-group right">
        {clip && (
          <div className={`clip-chip ${clip.mode}`} title={clipTitle(clip.mode, clip.items.map((i) => i.key))}>
            {clip.mode === "cut" ? <Scissors size={12} /> : <Copy size={12} />}
            <span className="clip-count">
              {plural(clip.items.length, "item")} {clip.mode === "cut" ? "cut" : "copied"}
            </span>
            <span className="clip-from">
              from <span className="mono">{s3Uri(clip.bucket, clip.prefix).slice(5)}</span>
            </span>
            <button className="icon-btn" onClick={clearClipboard} aria-label="Clear clipboard" title="Clear clipboard">
              <X size={12} />
            </button>
          </div>
        )}
        <SplitButton />
        <button
          className={`icon-btn lg ${detailsOpen ? "active" : ""}`}
          onClick={() => setDetailsOpen(!detailsOpen)}
          title={withKey(detailsOpen ? "Hide details" : "Show details", k.details)}
        >
          {detailsOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
    </div>
  );
}

export function Breadcrumbs() {
  const pane = usePaneId();
  const bucket = usePane((s) => s.bucket);
  const prefix = usePane((s) => s.prefix);
  const truncated = usePane((s) => s.listing.truncated);
  const loading = usePane((s) => s.listing.loading);
  const total = usePane((s) => s.listing.folders.length + s.listing.objects.length);
  const rows = useViewRows();
  const filter = usePane((s) => s.filter);
  const sel = useSelectionInfo();
  // While search results are open they say what they hold; the folder's counts would only confuse.
  const searchOpen = usePaneSearch((s) => s.open);
  if (!bucket) return null;
  const segs = prefixSegments(prefix);
  const selCount = sel.folders + sel.objects;
  return (
    <div className="breadcrumbs">
      <nav className="crumbs" aria-label="Path">
        <button
          className={`crumb ${segs.length === 0 ? "current" : ""}`}
          onClick={() => navigate(bucket, "", pane)}
          title={`s3://${bucket}/`}
          data-drop-bucket={bucket}
          data-drop-prefix=""
        >
          <Archive size={13} />
          {bucket}
        </button>
        {segs.map((s, i) => (
          <Fragment key={s.prefix}>
            <ChevronRight size={13} className="crumb-sep" />
            <button
              className={`crumb ${i === segs.length - 1 ? "current" : ""}`}
              onClick={() => navigate(bucket, s.prefix, pane)}
              title={`s3://${bucket}/${s.prefix}`}
              data-drop-bucket={bucket}
              data-drop-prefix={s.prefix}
            >
              {displayName(s.name)}
            </button>
          </Fragment>
        ))}
        <button
          className="icon-btn crumb-copy"
          onClick={() => void copyText(s3Uri(bucket, prefix), "Path")}
          title={`Copy path: ${s3Uri(bucket, prefix)}`}
          aria-label="Copy path"
        >
          <Copy size={12} />
        </button>
      </nav>
      <div className="crumb-info muted" hidden={searchOpen}>
        {selCount > 0 && (
          <span className="sel-info">
            {selCount.toLocaleString()} selected{sel.objects > 0 ? ` · ${formatBytes(sel.bytes)}` : ""}
            <span className="dot-sep">·</span>
          </span>
        )}
        {loading && total === 0
          ? "Loading…"
          : filter
            ? `${rows.length.toLocaleString()} of ${total.toLocaleString()}${truncated ? "+" : ""} items`
            : `${total.toLocaleString()}${truncated ? "+" : ""} items`}
      </div>
    </div>
  );
}
