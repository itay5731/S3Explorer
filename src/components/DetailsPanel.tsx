import { useEffect, useState, type ReactNode } from "react";
import { Copy, Download, FolderOpen, Loader2, MousePointerClick, Trash2, X, Files, AlertCircle } from "lucide-react";
import * as api from "../lib/api";
import type { AppError, ObjectMeta } from "../lib/types";
import { navigate, openModal, setDetailsOpen, useApp } from "../store/app";
import { copyText, downloadObjects } from "../store/actions";
import { getSelected, useSelectionInfo } from "../store/view";
import { displayName, formatBytes, formatExact, formatRelative, formatStorageClass, s3Uri } from "../lib/format";
import { FileIcon } from "./FileIcon";

function Field({ label, children, mono, copy }: { label: string; children: ReactNode; mono?: boolean; copy?: string }) {
  return (
    <div className="dfield">
      <div className="dlabel">{label}</div>
      <div className={`dvalue ${mono ? "mono" : ""}`}>
        <span className="dvalue-text">{children}</span>
        {copy && (
          <button className="icon-btn copy-btn" onClick={() => void copyText(copy, label)} title={`Copy ${label.toLowerCase()}`}>
            <Copy size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

export function DetailsPanel() {
  const bucket = useApp((s) => s.bucket);
  const prefix = useApp((s) => s.prefix);
  const sel = useSelectionInfo();
  const obj = sel.object;
  const [meta, setMeta] = useState<ObjectMeta | null>(null);
  const [metaError, setMetaError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(false);

  const objKey = obj?.key ?? null;
  useEffect(() => {
    setMeta(null);
    setMetaError(null);
    if (!bucket || !objKey) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .headObject(bucket, objKey)
        .then((m) => !cancelled && setMeta(m))
        .catch((e: AppError) => !cancelled && setMetaError(e))
        .finally(() => !cancelled && setLoading(false));
    }, 120); // debounce while arrowing through rows
    return () => {
      cancelled = true;
      clearTimeout(t);
      setLoading(false);
    };
  }, [bucket, objKey]);

  let body: ReactNode;
  if (!bucket) {
    body = (
      <div className="dempty">
        <MousePointerClick size={28} strokeWidth={1.25} />
        <div>Select a bucket, then an item to see its details</div>
      </div>
    );
  } else if (obj) {
    const m = meta && meta.key === obj.key ? meta : null;
    const metaEntries = m ? Object.entries(m.metadata) : [];
    body = (
      <>
        <div className="dhero">
          <div className="dhero-icon">
            <FileIcon name={obj.name} size={22} />
          </div>
          <div className="dhero-text">
            <div className="dhero-name" title={obj.name}>
              {obj.name}
            </div>
            <div className="muted small">{formatBytes(obj.size)}</div>
          </div>
        </div>
        <div className="dactions">
          <button className="btn" onClick={() => void downloadObjects([obj])}>
            <Download size={14} /> Download
          </button>
          <button className="btn" onClick={() => void copyText(s3Uri(bucket, obj.key), "S3 URI")}>
            <Copy size={14} /> Copy URI
          </button>
        </div>
        <div className="dsection">
          <Field label="Key" mono copy={obj.key}>
            {obj.key}
          </Field>
          <Field label="Size">
            {formatBytes(obj.size, 2)} <span className="muted">({obj.size.toLocaleString()} bytes)</span>
          </Field>
          <Field label="Last modified">
            {formatExact(m?.lastModified ?? obj.lastModified) || "—"}{" "}
            <span className="muted">· {formatRelative(m?.lastModified ?? obj.lastModified)}</span>
          </Field>
          <Field label="Storage class">{formatStorageClass(m?.storageClass ?? obj.storageClass ?? "STANDARD")}</Field>
          <Field label="ETag" mono copy={(m?.etag ?? obj.etag) || undefined}>
            {(m?.etag ?? obj.etag)?.replace(/"/g, "") || "—"}
          </Field>
          <Field label="Content type" mono>
            {m ? m.contentType ?? "—" : loading ? <Loader2 size={12} className="spin" /> : "—"}
          </Field>
          {m?.versionId && (
            <Field label="Version ID" mono copy={m.versionId}>
              {m.versionId}
            </Field>
          )}
        </div>
        <div className="dsection">
          <div className="dsection-title">User metadata</div>
          {metaError ? (
            <div className="inline-error">
              <AlertCircle size={13} /> {metaError.message}
            </div>
          ) : !m ? (
            <div className="muted small">{loading ? "Loading…" : "—"}</div>
          ) : metaEntries.length === 0 ? (
            <div className="muted small">No user metadata</div>
          ) : (
            <table className="meta-table">
              <tbody>
                {metaEntries.map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td className="mono">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </>
    );
  } else if (sel.folder) {
    const f = sel.folder;
    body = (
      <>
        <div className="dhero">
          <div className="dhero-icon">
            <FileIcon name={f.name} folder size={22} />
          </div>
          <div className="dhero-text">
            <div className="dhero-name" title={f.prefix}>
              {displayName(f.name)}
            </div>
            <div className="muted small">Folder</div>
          </div>
        </div>
        <div className="dactions">
          <button className="btn" onClick={() => navigate(bucket, f.prefix)}>
            <FolderOpen size={14} /> Open
          </button>
          <button className="btn btn-danger-ghost" onClick={() => openModal({ kind: "deleteFolder", prefix: f.prefix })}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
        <div className="dsection">
          <Field label="Prefix" mono copy={f.prefix}>
            {f.prefix}
          </Field>
          <Field label="S3 URI" mono copy={s3Uri(bucket, f.prefix)}>
            {s3Uri(bucket, f.prefix)}
          </Field>
        </div>
      </>
    );
  } else if (sel.folders + sel.objects > 1) {
    body = (
      <>
        <div className="dhero">
          <div className="dhero-icon">
            <Files size={22} />
          </div>
          <div className="dhero-text">
            <div className="dhero-name">{(sel.folders + sel.objects).toLocaleString()} items selected</div>
            <div className="muted small">
              {sel.objects.toLocaleString()} object{sel.objects === 1 ? "" : "s"} · {formatBytes(sel.bytes)}
              {sel.folders ? ` · ${sel.folders} folder${sel.folders === 1 ? "" : "s"}` : ""}
            </div>
          </div>
        </div>
        {sel.objects > 0 && (
          <div className="dactions">
            <button className="btn" onClick={() => void downloadObjects(getSelected().objects)}>
              <Download size={14} /> Download {sel.objects}
            </button>
          </div>
        )}
        {sel.folders > 0 && <p className="muted small dnote">Folders are skipped when downloading a selection.</p>}
      </>
    );
  } else {
    body = (
      <div className="dempty">
        <MousePointerClick size={28} strokeWidth={1.25} />
        <div>Select an item to see its details</div>
        <div className="muted small mono">{s3Uri(bucket, prefix)}</div>
      </div>
    );
  }

  return (
    <aside className="details">
      <div className="panel-head">
        <span className="section-title">Details</span>
        <button className="icon-btn" onClick={() => setDetailsOpen(false)} aria-label="Close details">
          <X size={14} />
        </button>
      </div>
      <div className="details-body">{body}</div>
    </aside>
  );
}
