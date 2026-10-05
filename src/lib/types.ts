// Canonical types shared with the Rust backend. See docs/CONTRACT.md.

export type ErrorCode =
  | "NotConnected" | "Auth" | "NoSuchBucket" | "NoSuchKey" | "AccessDenied"
  | "Network" | "Io" | "Cancelled" | "InvalidInput" | "Unknown";

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

export interface DeleteResult { deleted: number; errors: { key: string; message: string }[] }

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
