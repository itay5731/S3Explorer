// Object preview: what is inside a file, read with preview_object (see "Object preview" in
// docs/CONTRACT.md). Shown at the top of the details panel and, larger, in Quick look (QuickLook.tsx).

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, FileQuestion, ImageDown, Loader2, Maximize2, RotateCw } from "lucide-react";
import * as api from "../lib/api";
import { PREVIEW_LIMITS, type AppError, type ObjectEntry, type ObjectPreview } from "../lib/types";
import { openModal } from "../store/app";
import { useKeyHint, withKey } from "../store/keyboard";
import { formatBytes } from "../lib/format";

// ---- kinds -------------------------------------------------------------------------------------

/** Image extensions the backend previews, with the type the bytes are shown as. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const extOf = (key: string) => {
  const name = key.slice(key.lastIndexOf("/") + 1).toLowerCase();
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1) : "";
};

const isImageKey = (key: string) => extOf(key) in IMAGE_TYPES;

/** The type an image is shown as: by extension (an SVG must be `image/svg+xml` to render), else as stored. */
function imageType(key: string, contentType: string | null): string {
  const ct = contentType?.split(";")[0].trim().toLowerCase();
  return IMAGE_TYPES[extOf(key)] ?? (ct?.startsWith("image/") ? ct : "application/octet-stream");
}

// ---- loading -----------------------------------------------------------------------------------

/** The last few previews, so the details panel and Quick look share one read of the same object. */
const CACHE_MAX = 6;
const cache = new Map<string, Promise<ObjectPreview>>();

function loadPreview(bucket: string, o: ObjectEntry, force: boolean): Promise<ObjectPreview> {
  const id = `${bucket}\n${o.key}\n${o.etag ?? ""}\n${o.lastModified ?? ""}`;
  const hit = cache.get(id);
  if (hit && !force) {
    cache.delete(id); // most recently used goes last
    cache.set(id, hit);
    return hit;
  }
  const p = api.previewObject(bucket, o.key);
  cache.set(id, p);
  // A failed read is not remembered: Retry (or selecting it again) reads again.
  p.catch(() => cache.get(id) === p && cache.delete(id));
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

type PreviewState =
  | { status: "loading" }
  /** A large image: loaded only when asked for. */
  | { status: "ask" }
  | { status: "ok"; preview: ObjectPreview }
  | { status: "error"; error: AppError };

/**
 * The preview of `o`, tagged with the object it was read for so a late answer for a previous
 * selection is never shown. Images above `imageAutoBytes` wait for `load()`.
 */
function usePreviewOf(bucket: string, o: ObjectEntry): [PreviewState, () => void] {
  const id = `${bucket}\n${o.key}\n${o.etag ?? ""}\n${o.lastModified ?? ""}`;
  const ask = isImageKey(o.key) && o.size > PREVIEW_LIMITS.imageAutoBytes && o.size <= PREVIEW_LIMITS.imageMaxBytes;
  const [state, setState] = useState<{ id: string; attempt: number; value: PreviewState | null }>({ id, attempt: 0, value: null });
  const [wanted, setWanted] = useState<{ id: string; attempt: number } | null>(null);
  const current = state.id === id ? state : null;
  // -1: waiting for `load()`; 0: the first read; above: a retry, which reads again.
  const attempt = wanted?.id === id ? wanted.attempt : ask ? -1 : 0;
  const objRef = useRef(o);
  objRef.current = o;

  useEffect(() => {
    if (attempt < 0) return;
    let stale = false;
    // Debounced like the metadata, so arrowing through rows does not read every object.
    const t = setTimeout(() => {
      loadPreview(bucket, objRef.current, attempt > 0).then(
        (preview) => !stale && setState({ id, attempt, value: { status: "ok", preview } }),
        (error: AppError) => !stale && setState({ id, attempt, value: { status: "error", error } }),
      );
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [bucket, id, attempt]);

  const value: PreviewState =
    attempt < 0 ? { status: "ask" } : current && current.attempt === attempt && current.value ? current.value : { status: "loading" };
  const load = () => setWanted((w) => ({ id, attempt: w?.id === id ? w.attempt + 1 : 1 }));
  return [value, load];
}

// ---- rendering ---------------------------------------------------------------------------------

/** `<img>` from a `blob:` URL of the bytes (allowed by the CSP's `img-src blob:`), revoked on change. */
function ImageView({ data, type, alt }: { data: string; type: string; alt: string }) {
  const url = useMemo(() => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type }));
  }, [data, type]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [broken, setBroken] = useState(false);
  if (broken) return <Unsupported reason="This image could not be shown" />;
  return (
    <div className="pv-image">
      <img src={url} alt={alt} draggable={false} onError={() => setBroken(true)} />
    </div>
  );
}

const CSV_ROWS = 200;
const CSV_COLS = 50;

/** The first rows of a CSV/TSV text (quoted fields, doubled quotes, CRLF). */
export function parseDelimited(text: string, sep: string, maxRows = CSV_ROWS): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (rows.length < maxRows && (field !== "" || row.length)) rows.push([...row, field]);
  return rows;
}

function TableView({ text, sep }: { text: string; sep: string }) {
  const rows = useMemo(() => parseDelimited(text, sep), [text, sep]);
  const cols = Math.min(CSV_COLS, Math.max(0, ...rows.map((r) => r.length)));
  if (!rows.length) return <div className="muted small">Empty file</div>;
  const [head, ...body] = rows;
  return (
    <div className="pv-table-wrap">
      <table className="pv-table">
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i}>{head[i] ?? ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {Array.from({ length: cols }, (_, i) => (
                <td key={i}>{r[i] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TextView({ text, ext }: { text: string; ext: string }) {
  const shown = useMemo(() => {
    if (ext !== "json") return text;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text; // not valid JSON (or cut by the read limit): as it is
    }
  }, [text, ext]);
  if (!text) return <div className="muted small">Empty file</div>;
  return <pre className="pv-text">{shown}</pre>;
}

export function Unsupported({ reason }: { reason: string }) {
  return (
    <div className="pv-none">
      <FileQuestion size={22} strokeWidth={1.5} />
      <span>{reason}</span>
    </div>
  );
}

/** The preview area for one object: loading, the ask for a large image, an error with Retry, or the content. */
export function PreviewView({ bucket, object }: { bucket: string; object: ObjectEntry }) {
  const [state, load] = usePreviewOf(bucket, object);
  if (state.status === "loading") {
    return (
      <div className="pv-none">
        <Loader2 size={16} className="spin" />
        <span>Loading preview…</span>
      </div>
    );
  }
  if (state.status === "ask") {
    return (
      <div className="pv-none">
        <button type="button" className="btn btn-sm" onClick={load}>
          <ImageDown size={13} /> Load preview ({formatBytes(object.size)})
        </button>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="inline-error">
        <AlertCircle size={13} />
        <div className="grow">
          <div>{state.error.message}</div>
          <button type="button" className="link-btn pv-retry" onClick={load}>
            <RotateCw size={12} /> Retry
          </button>
        </div>
      </div>
    );
  }
  const p = state.preview;
  const ext = extOf(object.key);
  let content;
  if (p.kind === "image" && p.dataBase64 !== null) content = <ImageView data={p.dataBase64} type={imageType(object.key, p.contentType)} alt={object.name} />;
  else if (p.kind === "text" && p.text !== null && (ext === "csv" || ext === "tsv")) content = <TableView text={p.text} sep={ext === "tsv" ? "\t" : ","} />;
  else if (p.kind === "text" && p.text !== null) content = <TextView text={p.text} ext={ext} />;
  else content = <Unsupported reason={p.reason ?? "No preview for this file"} />;
  return (
    <>
      {content}
      {p.truncated && <div className="muted small pv-note">Showing the first {formatBytes(PREVIEW_LIMITS.textMaxBytes)}</div>}
    </>
  );
}

/** The details panel's Preview section (one object selected). */
export function PreviewSection({ bucket, object }: { bucket: string; object: ObjectEntry }) {
  const hint = useKeyHint("act.preview");
  return (
    <div className="dsection pv-section">
      <div className="dsection-title dsection-title-row">
        <span>Preview</span>
        <button type="button" className="link-btn" onClick={() => openModal({ kind: "quickLook" })} title={withKey("Quick look", hint)}>
          <Maximize2 size={12} /> Quick look
        </button>
      </div>
      <PreviewView key={`${bucket}\n${object.key}`} bucket={bucket} object={object} />
    </div>
  );
}
