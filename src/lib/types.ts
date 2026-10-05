// Canonical types shared with the Rust backend. See docs/CONTRACT.md.

export type ErrorCode =
  | "NotConnected" | "Auth" | "NoSuchBucket" | "NoSuchKey" | "AccessDenied"
  | "Network" | "Io" | "Cancelled" | "InvalidInput" | "Keychain" | "Unknown";

export interface AppError { code: ErrorCode; message: string }

export interface ProfileInfo { name: string; region: string | null; hasCredentials: boolean }

export type ConnectionConfig =
  | { kind: "profile"; profile: string; region?: string | null; endpoint?: string | null }
  | {
      kind: "static";
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string | null;
      region: string;
      endpoint?: string | null;
      forcePathStyle?: boolean;
    };

export interface ConnectionInfo { label: string; region: string; endpoint: string | null; canListBuckets: boolean }

export interface Bucket { name: string; creationDate: string | null }

export interface FolderEntry { prefix: string; name: string }

export interface ObjectEntry {
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
}

export interface ListPage {
  folders: FolderEntry[];
  objects: ObjectEntry[];
  nextContinuationToken: string | null;
  isTruncated: boolean;
}

export interface ObjectMeta extends ObjectEntry {
  contentType: string | null;
  metadata: Record<string, string>;
  versionId: string | null;
}

export type TransferKind = "download" | "upload";
export type TransferStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Transfer {
  id: string;
  kind: TransferKind;
  bucket: string;
  key: string;
  localPath: string;
  totalBytes: number;
  transferredBytes: number;
  partsTotal: number;
  partsDone: number;
  bytesPerSec: number;
  status: TransferStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const TRANSFER_PROGRESS_EVENT = "transfer:progress";

// ---- Settings (see "Settings" in docs/CONTRACT.md) ----

export interface TransferSettings {
  /** null = Auto (8 MiB; 16 MiB for objects over 1 GiB). Otherwise an integer number of MiB. */
  partSizeMib: number | null;
  /** Parts in flight per transfer. */
  maxConcurrentParts: number;
  /** Transfers running at once; the rest queue. */
  maxConcurrentTransfers: number;
}

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  partSizeMib: null,
  maxConcurrentParts: 8,
  maxConcurrentTransfers: 4,
};

export const TRANSFER_SETTINGS_LIMITS = {
  partSizeMib: { min: 1, max: 256 },
  maxConcurrentParts: { min: 1, max: 32 },
  maxConcurrentTransfers: { min: 1, max: 10 },
} as const;

/** Part size Auto mode uses for objects up to 1 GiB / above 1 GiB. */
export const AUTO_PART_SIZE_MIB = { standard: 8, large: 16 } as const;
/** S3 minimum for non-final multipart upload parts. */
export const MIN_UPLOAD_PART_MIB = 5;

// ---- v0.3.0 (see "v0.3.0 additions" in docs/CONTRACT.md) ----

export type ThemeMode = "system" | "light" | "dark";

/** Flat settings object. Supersedes TransferSettings (kept above for reference of the transfer fields). */
export interface AppSettings extends TransferSettings {
  theme: ThemeMode;
  checkUpdatesOnStartup: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  ...DEFAULT_TRANSFER_SETTINGS,
  theme: "system",
  checkUpdatesOnStartup: false,
};

// Saved connections

export interface SavedConnection {
  id: string;
  name: string;
  kind: "profile" | "static";
  profile: string | null;
  accessKeyId: string | null;
  region: string | null;
  endpoint: string | null;
  forcePathStyle: boolean;
  hasSecret: boolean;
  lastUsedAt: string | null;
}

export interface SaveConnectionInput {
  id?: string | null;
  name: string;
  config: ConnectionConfig;
}

export const SAVED_CONNECTION_NAME_MAX = 64;

// Object operations (jobs)

export type JobKind = "delete" | "copy" | "move";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ConflictPolicy = "overwrite" | "skip";

export interface JobItem {
  from: string;
  to: string | null;
  isPrefix: boolean;
}

export interface JobRequest {
  kind: JobKind;
  srcBucket: string;
  destBucket: string | null;
  items: JobItem[];
  onConflict: ConflictPolicy;
}

export interface JobPreview {
  objects: number;
  bytes: number;
  conflicts: number;
  truncated: boolean;
}

export interface JobError { key: string; message: string }

export interface Job {
  id: string;
  kind: JobKind;
  srcBucket: string;
  destBucket: string | null;
  label: string;
  phase: "listing" | "working" | "done";
  totalItems: number;
  doneItems: number;
  skippedItems: number;
  failedItems: number;
  totalBytes: number;
  doneBytes: number;
  status: JobStatus;
  error: string | null;
  errors: JobError[];
  startedAt: string;
  finishedAt: string | null;
}

export const JOB_PROGRESS_EVENT = "job:progress";
export const JOB_MAX_ITEMS = 10_000;

// Updates

export interface UpdateInfo {
  currentVersion: string;
  available: boolean;
  latestVersion: string | null;
  notes: string | null;
  publishedAt: string | null;
  canInstall: boolean;
  downloadUrl: string;
}

export type UpdatePhase = "downloading" | "installing" | "restarting";
export interface UpdateProgress { phase: UpdatePhase; downloadedBytes: number; totalBytes: number | null }

export const UPDATE_PROGRESS_EVENT = "update:progress";

/** Downloads buffer at most this much per in-flight part; larger parts are streamed to disk. */
export const DOWNLOAD_BUFFER_CAP_MIB = 16;
