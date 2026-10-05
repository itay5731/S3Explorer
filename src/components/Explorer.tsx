import { useEffect, useRef, useState } from "react";
import { ChevronDown, Globe, LogOut, MapPin, UploadCloud } from "lucide-react";
import * as api from "../lib/api";
import { disconnect, useApp } from "../store/app";
import { installTransferEffects, uploadPaths } from "../store/actions";
import { installJobEffects } from "../store/ops";
import { Sidebar } from "./Sidebar";
import { Breadcrumbs, Toolbar } from "./Toolbar";
import { ObjectTable } from "./ObjectTable";
import { DetailsPanel } from "./DetailsPanel";
import { ActivityPanel } from "./TransfersPanel";
import { ContextMenu } from "./ContextMenu";
import { Modals } from "./Modals";
import { Logo } from "./Logo";
import { SettingsButton } from "./SettingsDialog";

function ConnectionChip() {
  const conn = useApp((s) => s.connection);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!conn) return null;
  return (
    <div className="conn-chip-wrap" ref={ref}>
      <button className="conn-chip" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="status-dot" />
        <span className="conn-label">{conn.label}</span>
        <span className="conn-region">{conn.region}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="popover">
          <div className="popover-row">
            <span className="muted">Identity</span>
            <span>{conn.label}</span>
          </div>
          <div className="popover-row">
            <span className="muted">
              <MapPin size={12} /> Region
            </span>
            <span className="mono">{conn.region}</span>
          </div>
          <div className="popover-row">
            <span className="muted">
              <Globe size={12} /> Endpoint
            </span>
            <span className="mono">{conn.endpoint ?? "AWS default"}</span>
          </div>
          {!conn.canListBuckets && <div className="popover-note">ListBuckets is denied for this identity.</div>}
          <button
            className="menu-item danger"
            onClick={() => {
              setOpen(false);
              void disconnect();
            }}
          >
            <LogOut size={14} /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function useFileDrop() {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let unlisten: api.Unlisten | null = null;
    let disposed = false;
    api
      .onFileDrop((e) => {
        if (e.type === "enter" || e.type === "over") setDragging(true);
        else if (e.type === "leave") setDragging(false);
        else {
          setDragging(false);
          if (e.paths.length) void uploadPaths(e.paths);
        }
      })
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => {
        /* drag & drop unavailable */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return dragging;
}

export function Explorer() {
  const detailsOpen = useApp((s) => s.detailsOpen);
  const bucket = useApp((s) => s.bucket);
  const prefix = useApp((s) => s.prefix);
  const dragging = useFileDrop();

  useEffect(() => installTransferEffects(), []);
  useEffect(() => installJobEffects(), []);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <Logo size={20} />
          <span>S3 Explorer</span>
        </div>
        <div className="spacer" />
        <ConnectionChip />
        <SettingsButton />
      </header>
      <div className={`workspace ${detailsOpen ? "with-details" : ""}`}>
        <Sidebar />
        <main className="browser">
          <Toolbar />
          <Breadcrumbs />
          <div className="table-wrap">
            <ObjectTable />
            {dragging && (
              <div className={`drop-overlay ${bucket ? "" : "disabled"}`}>
                <div className="drop-card">
                  <UploadCloud size={34} strokeWidth={1.5} />
                  <div className="drop-title">{bucket ? "Drop to upload" : "Select a bucket first"}</div>
                  {bucket && <div className="muted mono small">s3://{bucket}/{prefix}</div>}
                </div>
              </div>
            )}
          </div>
        </main>
        {detailsOpen && <DetailsPanel />}
      </div>
      <ActivityPanel />
      <ContextMenu />
      <Modals />
    </div>
  );
}
