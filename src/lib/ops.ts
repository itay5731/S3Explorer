// Pure helpers for object operations (delete / rename / copy / move jobs).
// Keys and prefixes from the server are opaque: these helpers never trim, collapse or
// otherwise rewrite them. Only names the user types are normalized (trimmed).

import type { Job, JobKind, JobPreview } from "./types";
import { formatBytes } from "./format";

/** Split an object name into stem and extension: "a.tar.gz" -> ["a.tar", ".gz"], ".env" -> [".env", ""]. */
export function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/**
 * A name for a copy pasted into its own folder: "a.txt" -> "a (copy).txt", then "a (copy 2).txt", ...
 * Folders: "photos" -> "photos (copy)". `taken` holds names already used in the folder
 * (objects and folders separately, compared exactly as S3 does: case-sensitive).
 */
export function copyName(name: string, isFolder: boolean, taken: Set<string>): string {
  const [stem, ext] = isFolder ? [name, ""] : splitExt(name);
  for (let i = 1; ; i++) {
    const candidate = `${stem} (copy${i === 1 ? "" : " " + i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Validate a new name typed in the rename dialog. Returns an error message or null.
 * `name` is the trimmed input; `existing` are names of the same kind already in the folder.
 */
export function validateNewName(name: string, current: string, existing: Set<string>, isFolder: boolean): string | null {
  if (!name) return "Enter a name";
  if (name.includes("/")) return "A name can’t contain “/”. Use Cut and Paste to move it to another folder.";
  if (name === "." || name === "..") return "“.” and “..” are not allowed as names";
  if (name === current) return "The new name is the same as the current one";
  if (existing.has(name)) return `A ${isFolder ? "folder" : "file"} named “${name}” already exists here`;
  if (new TextEncoder().encode(name).length > 1024) return "Name is too long";
  return null;
}

/** True when `path` (a key or prefix) is shown in, or contains, the folder `viewPrefix`. */
export function touchesPrefix(path: string, viewPrefix: string): boolean {
  return path.startsWith(viewPrefix) || viewPrefix.startsWith(path);
}

export const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "1,234 objects, 4.2 GiB", with "at least" when the backend stopped counting. */
export function previewSummary(p: JobPreview): string {
  const text = `${plural(p.objects, "object")}, ${formatBytes(p.bytes)}`;
  return p.truncated ? `at least ${text}` : text;
}

export const KIND_VERB: Record<JobKind, { present: string; past: string; noun: string }> = {
  delete: { present: "Delete", past: "Deleted", noun: "deletion" },
  copy: { present: "Copy", past: "Copied", noun: "copy" },
  move: { present: "Move", past: "Moved", noun: "move" },
  tag: { present: "Tag", past: "Tagged", noun: "tag edit" },
};

export const isJobActive = (j: Job) => j.status === "queued" || j.status === "running";

/** Fraction 0..1 of the job that is finished (processed objects / discovered objects). */
export function jobFraction(j: Job): number {
  if (j.status === "completed") return 1;
  if (j.phase === "listing" || j.totalItems === 0) return 0;
  return Math.min(1, (j.doneItems + j.skippedItems + j.failedItems) / j.totalItems);
}
