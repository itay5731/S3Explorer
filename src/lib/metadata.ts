// Pure helpers for editing an object's content type and metadata (see "Edit content type and
// metadata" in docs/CONTRACT.md). The backend enforces the same rules; shared by the dialog and the mock.

import { METADATA_LIMITS, type MetadataEdit, type ObjectMeta } from "./types";

/** S3 copies at most 5 GiB in one request; larger objects can't be edited this way. */
export const MAX_EDIT_BYTES = 5 * 1024 ** 3;

const encoder = new TextEncoder();
export const utf8Bytes = (s: string) => encoder.encode(s).length;

/** Common content types for the dialog's suggestions. */
export const COMMON_CONTENT_TYPES = [
  "application/octet-stream",
  "application/json",
  "application/pdf",
  "application/xml",
  "application/zip",
  "application/gzip",
  "application/javascript",
  "application/wasm",
  "text/plain",
  "text/plain; charset=utf-8",
  "text/html",
  "text/html; charset=utf-8",
  "text/css",
  "text/csv",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  "audio/mpeg",
  "video/mp4",
  "video/webm",
  "font/woff2",
];

/**
 * Why a header value can't be written and read back unchanged: it must be printable ASCII (S3 stores
 * anything else encoded) without leading or trailing spaces (HTTP trims them). null = fine.
 */
export function headerValueError(s: string): string | null {
  if (s === "") return "Enter a value.";
  if (/[\u0000-\u001f\u007f]/.test(s)) return "No control characters (tabs, line breaks).";
  if (!/^[\x20-\x7e]*$/.test(s)) return "Use plain ASCII characters only; S3 would store others encoded.";
  if (s.trim() !== s) return "No spaces at the start or end.";
  return null;
}

export function contentTypeError(s: string): string | null {
  if (s === "") return "A content type is required.";
  const e = headerValueError(s);
  if (e) return e;
  if (s.length > 255) return `At most 255 characters (this has ${s.length}).`;
  return null;
}

/** Cache-Control / Content-Disposition: empty means "no header". */
export const optionalHeaderError = (s: string) => (s === "" ? null : headerValueError(s));

export function metaKeyError(key: string): string | null {
  if (key === "") return "Enter a key.";
  if (key.length > METADATA_LIMITS.maxKeyChars) return `At most ${METADATA_LIMITS.maxKeyChars} characters (this has ${key.length}).`;
  if (!/^[a-z0-9-]+$/.test(key)) return "Use lowercase letters a-z, digits and hyphens only.";
  return null;
}

/** User metadata size as S3 counts it: keys and values in UTF-8 bytes. */
export const metadataBytes = (pairs: [string, string][]) => pairs.reduce((n, [k, v]) => n + utf8Bytes(k) + utf8Bytes(v), 0);

/** The first problem with a whole edit (the backend's order), or null. Used by the mock. */
export function metadataEditError(edit: MetadataEdit): string | null {
  const ct = contentTypeError(edit.contentType);
  if (ct) return `Content type: ${ct}`;
  for (const [name, v] of [["Cache-Control", edit.cacheControl], ["Content-Disposition", edit.contentDisposition]] as const) {
    if (v !== null) {
      const e = headerValueError(v);
      if (e) return `${name}: ${e}`;
    }
  }
  const pairs = Object.entries(edit.metadata);
  for (const [k, v] of pairs) {
    const ke = metaKeyError(k);
    if (ke) return `Metadata key “${k}”: ${ke}`;
    const ve = headerValueError(v);
    if (ve) return `The value of metadata key “${k}”: ${ve}`;
  }
  const total = metadataBytes(pairs);
  if (total > METADATA_LIMITS.maxTotalBytes) return `User metadata is ${total} bytes; S3 allows at most ${METADATA_LIMITS.maxTotalBytes}.`;
  return null;
}

/** One line of the confirmation: a field or metadata key, before and after (null = absent). */
export interface MetadataChange {
  label: string;
  before: string | null;
  after: string | null;
}

/** Every difference between what the object has and what `edit` sends, in display order. */
export function metadataChanges(meta: ObjectMeta, edit: MetadataEdit): MetadataChange[] {
  const out: MetadataChange[] = [];
  const field = (label: string, before: string | null, after: string | null) => {
    if (before !== after) out.push({ label, before, after });
  };
  field("Content type", meta.contentType, edit.contentType);
  field("Cache-Control", meta.cacheControl, edit.cacheControl);
  field("Content-Disposition", meta.contentDisposition, edit.contentDisposition);
  const keys = [...new Set([...Object.keys(meta.metadata), ...Object.keys(edit.metadata)])].sort();
  for (const k of keys) field(`x-amz-meta-${k}`, meta.metadata[k] ?? null, edit.metadata[k] ?? null);
  return out;
}
