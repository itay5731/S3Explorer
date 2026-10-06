// The "Versions" section of the details panel: an object's versions on a bucket with versioning
// Enabled or Suspended, loaded when the section is opened, with per-version actions.

import { useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronRight, Copy, Download, History, Loader2, MoreHorizontal, RotateCw, Trash2, Undo2 } from "lucide-react";
import * as api from "../lib/api";
import type { AppError, ObjectVersion, VersionListing } from "../lib/types";
import { openModal, setTransfersOpen } from "../store/app";
import { copyText } from "../store/actions";
import { scheduleTransferResync } from "../store/transfers";
import { isDenied, permissionText, toastFailure } from "../store/toasts";
import { ensureVersioning, hasVersions, rememberVersionDownload, shortVersionId, useObjectRev, useVersioning } from "../store/versions";
import { formatBytes, formatDateTime, formatExact, formatRelative, formatStorageClass, sanitizeFileName } from "../lib/format";
import { PopupMenu, type PopupMenuItem } from "./PopupMenu";

/** Rows rendered at first; more on request (the list can hold 1,000 versions). */
const PAGE = 50;

/** Once opened, the section stays open for the next selected object (this session). */
let keepOpen = false;

export function VersionsSection({ bucket, objKey, name }: { bucket: string; objKey: string; name: string }) {
  const versioning = useVersioning((s) => s.byBucket[bucket]);
  useEffect(() => ensureVersioning(bucket), [bucket]);
  if (!hasVersions(versioning)) return null;
  return <VersionsList key={`${bucket}\u0000${objKey}`} bucket={bucket} objKey={objKey} name={name} />;
}

type LoadState = { status: "loading" } | { status: "ok"; listing: VersionListing } | { status: "error"; error: AppError };

function VersionsList({ bucket, objKey, name }: { bucket: string; objKey: string; name: string }) {
  const [open, setOpen] = useState(keepOpen);
  const [state, setState] = useState<LoadState | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [attempt, setAttempt] = useState(0);
  const rev = useObjectRev(bucket, objKey);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Keep showing the previous list while it reloads after a change.
    setState((s) => (s?.status === "ok" ? s : { status: "loading" }));
    // Debounced, so arrowing through rows with the section open doesn't list every object's versions.
    const t = setTimeout(() => {
      api
        .listObjectVersions(bucket, objKey)
        .then((listing) => !cancelled && setState({ status: "ok", listing }))
        .catch((error: AppError) => !cancelled && setState({ status: "error", error }));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, bucket, objKey, rev, attempt]);

  const listing = state?.status === "ok" ? state.listing : null;
  const count = listing ? `${listing.versions.length.toLocaleString()}${listing.truncated ? "+" : ""}` : null;
  const toggle = () => {
    keepOpen = !open;
    setOpen(!open);
  };

  return (
    <div className="dsection">
      <button type="button" className="disclosure" onClick={toggle} aria-expanded={open}>
        <ChevronRight size={14} className={open ? "rot90" : ""} /> Versions
        {count && <span className="count-pill">{count}</span>}
        {open && state?.status === "loading" && <Loader2 size={12} className="spin" />}
      </button>
      {open && (
        <>
          {state?.status === "error" ? (
            <div className="inline-error" role="alert">
              <AlertCircle size={13} />
              <span className="grow">{isDenied(state.error) ? `${permissionText("list versions")}.` : state.error.message}</span>
              <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
                <RotateCw size={12} /> Retry
              </button>
            </div>
          ) : !listing ? null : listing.versions.length === 0 ? (
            <div className="muted small">No versions found.</div>
          ) : (
            <>
              <ul className="vlist" aria-label="Versions, newest first">
                {listing.versions.slice(0, shown).map((v, i) => (
                  <VersionRow key={`${v.versionId}\u0000${i}`} bucket={bucket} objKey={objKey} name={name} v={v} listing={listing} index={i} />
                ))}
              </ul>
              {listing.versions.length > shown && (
                <button type="button" className="link-btn vmore" onClick={() => setShown((n) => n + PAGE * 4)}>
                  Show {Math.min(PAGE * 4, listing.versions.length - shown).toLocaleString()} more of{" "}
                  {(listing.versions.length - shown).toLocaleString()}
                </button>
              )}
              {listing.truncated && <p className="muted small">Only the newest 1,000 versions are shown.</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}

async function downloadVersion(bucket: string, key: string, name: string, v: ObjectVersion) {
  try {
    const dest = await api.pickSavePath(sanitizeFileName(name));
    if (!dest) return;
    const id = await api.downloadObjectVersion(bucket, key, v.versionId, dest);
    rememberVersionDownload(id, v.versionId);
    setTransfersOpen(true);
    scheduleTransferResync();
  } catch (e) {
    toastFailure("Couldn’t download this version", e as AppError, "download versions");
  }
}

function VersionRow({
  bucket,
  objKey,
  name,
  v,
  listing,
  index,
}: {
  bucket: string;
  objKey: string;
  name: string;
  v: ObjectVersion;
  listing: VersionListing;
  index: number;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const short = shortVersionId(v.versionId);
  const date = formatExact(v.lastModified) || "—";

  const confirm = (action: "restore" | "delete" | "undelete") =>
    openModal({
      kind: "versionAction",
      action,
      bucket,
      key: objKey,
      version: v,
      onlyVersion: listing.versions.length === 1 && !listing.truncated,
      previousIsMarker: index === 0 && !!listing.versions[1]?.isDeleteMarker,
    });

  const items: PopupMenuItem[][] = v.isDeleteMarker
    ? [[{ label: "Remove delete marker (undelete)…", icon: <Undo2 size={14} />, action: () => confirm("undelete") }]]
    : [
        [
          { label: "Download this version…", icon: <Download size={14} />, action: () => void downloadVersion(bucket, objKey, name, v) },
          ...(v.isLatest ? [] : [{ label: "Restore as current…", icon: <History size={14} />, action: () => confirm("restore") }]),
        ],
        [{ label: "Copy version ID", icon: <Copy size={14} />, action: () => void copyText(v.versionId, "Version ID") }],
        [{ label: "Delete permanently…", icon: <Trash2 size={14} />, danger: true, action: () => confirm("delete") }],
      ];

  const openMenu = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.right - 220, y: r.bottom + 4 });
  };

  return (
    <li className={`vrow ${v.isDeleteMarker ? "marker" : ""} ${v.isLatest ? "latest" : ""}`}>
      <div className="vrow-main">
        <span className="vrow-date" title={`${date} · ${formatRelative(v.lastModified)}`}>
          {formatDateTime(v.lastModified) || "—"}
        </span>
        {v.isLatest && <span className="vbadge">current</span>}
        <span className="grow" />
        {v.isDeleteMarker ? (
          <span className="vrow-kind">
            <Trash2 size={11} /> Delete marker
          </span>
        ) : (
          <span className="vrow-size">{formatBytes(v.size)}</span>
        )}
        <button
          ref={trigger}
          type="button"
          className="icon-btn vrow-menu"
          aria-label={`Actions for version ${short}`}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          title="Version actions"
          onClick={() => (menu ? setMenu(null) : openMenu())}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              openMenu();
            }
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      <div className="vrow-sub">
        <button
          type="button"
          className="vid mono"
          onClick={() => void copyText(v.versionId, "Version ID")}
          title={v.versionId === "null" ? "Version ID “null”: written while versioning was off. Click to copy." : `Version ID ${v.versionId}. Click to copy.`}
          aria-label={`Copy version ID ${v.versionId}`}
        >
          {short}
          <Copy size={10} />
        </button>
        {!v.isDeleteMarker && v.storageClass && v.storageClass !== "STANDARD" && <span className="muted">{formatStorageClass(v.storageClass)}</span>}
      </div>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label={`Version ${short}`}
          groups={items}
          onClose={() => {
            setMenu(null);
            trigger.current?.focus();
          }}
        />
      )}
    </li>
  );
}
