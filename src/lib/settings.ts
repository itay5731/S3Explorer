// Pure helpers for transfer settings: validation and the part-size math described in
// "Settings" in docs/CONTRACT.md. Shared by the settings UI and the browser mock.

import {
  AUTO_PART_SIZE_MIB,
  MIN_UPLOAD_PART_MIB,
  TRANSFER_SETTINGS_LIMITS,
  type AppSettings,
  type TransferKind,
  type TransferSettings,
} from "./types";

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;
/** S3 limit on the number of parts in one multipart upload. */
const MAX_UPLOAD_PARTS = 10_000;

export type SettingsField = keyof TransferSettings;

/** Validation message for one integer field, or null when it is valid. */
export function validateInteger(field: SettingsField, value: unknown): string | null {
  const { min, max } = TRANSFER_SETTINGS_LIMITS[field];
  if (value === null || value === undefined || value === "") return "Enter a value.";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "Enter a number.";
  if (!Number.isInteger(n)) return "Must be a whole number.";
  if (n < min) return `Minimum is ${min}.`;
  if (n > max) return `Maximum is ${max}.`;
  return null;
}

/** First problem with a full settings object, naming the field; null when valid. */
export function validateSettings(s: TransferSettings): { field: SettingsField; message: string } | null {
  const fields: SettingsField[] = ["partSizeMib", "maxConcurrentParts", "maxConcurrentTransfers"];
  for (const field of fields) {
    if (field === "partSizeMib" && s.partSizeMib === null) continue;
    const v: unknown = s[field];
    const err = typeof v === "number" ? validateInteger(field, v) : "Must be a whole number.";
    if (err) return { field, message: err };
  }
  return null;
}

export const sameSettings = (a: TransferSettings, b: TransferSettings) =>
  a.partSizeMib === b.partSizeMib &&
  a.maxConcurrentParts === b.maxConcurrentParts &&
  a.maxConcurrentTransfers === b.maxConcurrentTransfers;

/** Download part size in bytes for an object of `size` bytes. */
export function downloadPartBytes(partSizeMib: number | null, size: number): number {
  if (partSizeMib !== null) return partSizeMib * MIB;
  return (size > GIB ? AUTO_PART_SIZE_MIB.large : AUTO_PART_SIZE_MIB.standard) * MIB;
}

/**
 * Upload part size in bytes, mirroring `upload_part_size` in src-tauri/src/transfers/plan.rs:
 * `max(setting, 5 MiB)` (Auto: 8 MiB at every size; the 16 MiB step is download-only), doubled
 * until the file fits in 10,000 parts.
 */
export function uploadPartBytes(partSizeMib: number | null, size: number): number {
  let part =
    partSizeMib === null ? AUTO_PART_SIZE_MIB.standard * MIB : Math.max(partSizeMib * MIB, MIN_UPLOAD_PART_MIB * MIB);
  while (Math.ceil(size / part) > MAX_UPLOAD_PARTS) part *= 2;
  return part;
}

/** Part size (bytes) and part count a transfer of `size` bytes uses. */
export function planParts(kind: TransferKind, partSizeMib: number | null, size: number) {
  const partBytes = kind === "upload" ? uploadPartBytes(partSizeMib, size) : downloadPartBytes(partSizeMib, size);
  return { partBytes, parts: size > partBytes ? Math.ceil(size / partBytes) : 1 };
}

/** Worst-case part size for memory estimates (Auto can use 16 MiB parts). */
export const worstCasePartMib = (partSizeMib: number | null) => partSizeMib ?? AUTO_PART_SIZE_MIB.large;

/** Full settings comparison (transfer fields plus the v0.3.0 fields). */
export const sameAppSettings = (a: AppSettings, b: AppSettings) =>
  sameSettings(a, b) && a.theme === b.theme && a.checkUpdatesOnStartup === b.checkUpdatesOnStartup;

/** Like `validateSettings`, also checking `theme` and `checkUpdatesOnStartup`. */
export function validateAppSettings(s: AppSettings): { field: keyof AppSettings; message: string } | null {
  const transfer = validateSettings(s);
  if (transfer) return transfer;
  if (s.theme !== "system" && s.theme !== "light" && s.theme !== "dark") {
    return { field: "theme", message: "Must be one of system, light, dark." };
  }
  if (typeof s.checkUpdatesOnStartup !== "boolean") return { field: "checkUpdatesOnStartup", message: "Must be true or false." };
  return null;
}
