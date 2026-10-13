// The version dialog (see "Update popup" in docs/CONTRACT.md): one box about versions at launch.
// When the startup check finds a newer version it shows that version's notes with Install; otherwise,
// once after an update, it shows "What's new": the notes of the version now running. Never both.

import { useEffect, useRef } from "react";
import { ArrowUpCircle, Download, ExternalLink, X } from "lucide-react";
import * as api from "../lib/api";
import type { AppError } from "../lib/types";
import { closeUpdateDialog, installUpdate, openUpdateDialog, useUpdates } from "../store/updates";
import { toast } from "../store/toasts";
import { Available } from "./UpdatesTab";
import { Markdown } from "./Markdown";
import { Logo } from "./Logo";

export function UpdateDialog() {
  const open = useUpdates((s) => s.dialog);
  const version = useUpdates((s) => s.version);
  const whatsNew = useUpdates((s) => s.whatsNew);
  const info = useUpdates((s) => s.info);
  const notice = useUpdates((s) => s.notice);
  const installing = useUpdates((s) => s.install !== null);
  const ref = useRef<HTMLDivElement>(null);
  const update = notice && info?.available ? info : null;
  const shown = open && (whatsNew !== null || update !== null);
  // Not while the update is being installed: the progress must stay in view.
  const close = () => !installing && closeUpdateDialog();

  useEffect(() => {
    if (!shown) return;
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!useUpdates.getState().install) closeUpdateDialog();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [shown]);

  if (!shown) return null;
  const title = update ? "An update is ready" : `What's new in v${version}`;
  const openDownloadPage = () => api.openExternal(update!.downloadUrl).catch((e: AppError) => toast.error("Couldn't open the download page", e));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} className="modal modal-wide version-modal" role="dialog" aria-modal="true" aria-labelledby="version-title" tabIndex={-1}>
        <div className="modal-head">
          <div className="modal-icon">{update ? <ArrowUpCircle size={17} /> : <Logo size={22} />}</div>
          <h2 id="version-title">{title}</h2>
          <div className="spacer" />
          <button type="button" className="icon-btn lg" onClick={close} aria-label="Close" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        {whatsNew !== null && !update && (
          <section className="version-section">
            <p className="modal-text">The update is installed. This is what changed:</p>
            <div className="upd-notes whatsnew-notes" tabIndex={0} aria-label={`Patch notes of v${version}`}>
              <Markdown source={whatsNew} />
            </div>
          </section>
        )}

        {update && (
          <section className="version-section">
            <p className="modal-text">
              You have v{update.currentVersion}. Here is what changes in v{update.latestVersion ?? "?"}:
            </p>
            <Available info={update} buttons={false} />
          </section>
        )}

        {!installing && (
          <div className="modal-actions">
            <button type="button" className={`btn ${update ? "" : "btn-primary"}`} onClick={close}>
              {update ? "Later" : "Got it"}
            </button>
            {update &&
              (update.canInstall ? (
                <button type="button" className="btn btn-primary" onClick={() => void installUpdate()}>
                  <Download size={14} /> Install and restart
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => void openDownloadPage()}>
                  <ExternalLink size={14} /> Open download page
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A small accent pill for the title bar while an update waits: opens the dialog. */
export function UpdatePill() {
  const info = useUpdates((s) => s.info);
  const notice = useUpdates((s) => s.notice);
  if (!notice || !info?.available) return null;
  return (
    <button type="button" className="update-pill" onClick={openUpdateDialog} title="See what's new and install">
      <ArrowUpCircle size={13} />
      <span>v{info.latestVersion ?? "?"} available</span>
    </button>
  );
}
