# S3 Explorer — Backend/Frontend Contract

This file is the single source of truth for how the React frontend (`src/`) talks to the
Rust/Tauri backend (`src-tauri/`). Both sides implement exactly this. If something here must
change, change this file first.

## Stack

- Tauri v2, Rust 2021 edition, `aws-sdk-s3` 1.x, `tokio`.
- React 19 + TypeScript + Vite. Native dialogs via `@tauri-apps/plugin-dialog`.
- JSON over Tauri `invoke`. **All Rust structs serialize with `#[serde(rename_all = "camelCase")]`.**
  Command *parameters* are also camelCase on the JS side (Tauri converts snake_case Rust args
  to camelCase automatically, e.g. Rust `continuation_token` ⇄ JS `continuationToken`).
- The canonical TypeScript types live in `src/lib/types.ts`. Rust mirrors them exactly.

## Errors

Every command returns `Result<T, AppError>`. `AppError` serializes as:

```ts
interface AppError { code: ErrorCode; message: string }
type ErrorCode =
  | "NotConnected" | "Auth" | "NoSuchBucket" | "NoSuchKey" | "AccessDenied"
  | "Network" | "Io" | "Cancelled" | "InvalidInput" | "Unknown";
```

`message` is human-readable and safe to show in a toast.

## Commands

### Connection

| Command | Args | Returns |
|---|---|---|
| `list_profiles` | – | `ProfileInfo[]` — profiles parsed from `~/.aws/config` and `~/.aws/credentials` (merged, deduped; `region` if known). |
| `connect` | `{ config: ConnectionConfig }` | `ConnectionInfo` — builds the S3 client, verifies with `ListBuckets` (if that is denied, still connect but set `canListBuckets: false`). |
| `disconnect` | – | `void` |
| `connection_status` | – | `ConnectionInfo \| null` |

```ts
interface ProfileInfo { name: string; region: string | null; hasCredentials: boolean }

type ConnectionConfig =
  | { kind: "profile"; profile: string; region?: string | null; endpoint?: string | null }
  | { kind: "static"; accessKeyId: string; secretAccessKey: string; sessionToken?: string | null;
      region: string; endpoint?: string | null; forcePathStyle?: boolean };
// serde: #[serde(tag = "kind", rename_all = "camelCase")]; field names camelCase.
// `endpoint` enables MinIO / R2 / LocalStack. `forcePathStyle` defaults to true when endpoint is set.

interface ConnectionInfo { label: string; region: string; endpoint: string | null; canListBuckets: boolean }
```

### Browsing

| Command | Args | Returns |
|---|---|---|
| `list_buckets` | – | `Bucket[]` |
| `list_objects` | `{ bucket, prefix, continuationToken?, pageSize? }` | `ListPage` — one `ListObjectsV2` page with `Delimiter="/"`. Default `pageSize` 1000. The backend resolves and caches each bucket's region so cross-region buckets just work. |
| `head_object` | `{ bucket, key }` | `ObjectMeta` |

```ts
interface Bucket { name: string; creationDate: string | null }   // ISO-8601 UTC

interface FolderEntry { prefix: string; name: string }            // prefix = full "a/b/c/", name = "c"
interface ObjectEntry {
  key: string; name: string;            // name = last path segment
  size: number;                         // bytes
  lastModified: string | null;          // ISO-8601 UTC
  etag: string | null;
  storageClass: string | null;          // "STANDARD", "GLACIER", ...
}
interface ListPage {
  folders: FolderEntry[];
  objects: ObjectEntry[];               // excludes the "folder marker" object equal to the prefix itself
  nextContinuationToken: string | null;
  isTruncated: boolean;
}
interface ObjectMeta extends ObjectEntry {
  contentType: string | null;
  metadata: Record<string, string>;     // user metadata (x-amz-meta-*)
  versionId: string | null;
}
```

### Folders

| Command | Args | Returns |
|---|---|---|
| `create_folder` | `{ bucket, prefix }` | `void` — `prefix` must end with `/`; backend appends it if missing. Implemented as a zero-byte `PutObject`. |
| `delete_folder` | `{ bucket, prefix }` | `DeleteResult` — lists *all* keys under `prefix` (paginated, no delimiter) and deletes them with `DeleteObjects` in batches of 1000, batches running concurrently (≤ 8). Also deletes the marker object. |

```ts
interface DeleteResult { deleted: number; errors: { key: string; message: string }[] }
```

### Transfers (downloads & uploads)

Transfers run in the background on the Rust side and report via events. Commands return
immediately with a transfer id.

| Command | Args | Returns |
|---|---|---|
| `start_download` | `{ bucket, key, destPath }` | `string` (transfer id). **Parallel ranged download:** `HeadObject` for size; if size > 8 MiB split into parts of 8 MiB (grow to 16 MiB when > 1 GiB), fetch up to 8 parts concurrently with `Range` GETs, write each part at its offset into a pre-sized temp file (`destPath + "." + first 8 chars of the transfer id + ".part"`, created exclusively, renamed on completion). Small objects: single GET. |
| `start_upload` | `{ bucket, key, srcPath }` | `string` (transfer id). Files > 8 MiB use multipart upload with up to 8 concurrent part uploads (part size 8 MiB, grown so parts ≤ 10 000); otherwise `PutObject`. Content-Type guessed from extension. On failure/cancel the multipart upload is aborted. |
| `cancel_transfer` | `{ id }` | `void` — cooperative cancel; partial `.part` files are removed. |
| `remove_transfer` | `{ id }` | `void` — forget a finished/failed/cancelled transfer. |
| `list_transfers` | – | `Transfer[]` |

```ts
type TransferKind = "download" | "upload";
type TransferStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
interface Transfer {
  id: string;
  kind: TransferKind;
  bucket: string;
  key: string;
  localPath: string;
  totalBytes: number;          // 0 until known
  transferredBytes: number;
  partsTotal: number;
  partsDone: number;
  bytesPerSec: number;         // rolling average, 0 when not running
  status: TransferStatus;
  error: string | null;
  startedAt: string;           // ISO-8601
  finishedAt: string | null;
}
```

Global concurrency: at most 4 transfers *running* at once (others `queued`); within a transfer
up to 8 concurrent parts.

## Events (Rust → JS)

| Event | Payload | Notes |
|---|---|---|
| `transfer:progress` | `Transfer` | Emitted at most every 100 ms per transfer while running, and always on every status change. |

## Frontend expectations

- `src/lib/api.ts` is the only place `invoke` is called; one typed function per command.
- When not running inside Tauri (`window.__TAURI_INTERNALS__` undefined), `api.ts` routes to
  `src/lib/mock.ts` which simulates a realistic account (a few buckets, thousands of objects,
  fake progress) so the UI can be developed and screenshotted with plain `npm run dev`.

## Backend behavior notes (implemented, frontend must respect)

- `remove_transfer` returns `InvalidInput` while the transfer is `queued`/`running`; cancel first. Unknown id is a no-op.
- `cancel_transfer` returns `InvalidInput` for unknown ids; finished transfers are a no-op.
- `list_objects` may return a page with no folders and no objects but `isTruncated: true` (the only
  key on the page was the hidden folder marker). Keep following `nextContinuationToken`. `pageSize` is capped at 1000.
- `start_download` / `start_upload` reject empty keys or keys ending in `/`. Uploads need the full object key.
- Upload progress advances per completed part (8 MiB steps); files <= 8 MiB jump 0 -> 100%. Downloads update continuously.
- First `transfer:progress` event has status `queued`; the last carries `finishedAt`. Fast transfers may emit only queued, running, final.
- `start_download` creates missing parent directories of `destPath` and overwrites an existing file.
- `create_folder` / `delete_folder` append the trailing `/` if missing and reject only `""` and `"/"`. Server-provided prefixes are never normalized or trimmed: `a//` and `/foo/` are distinct, legal prefixes and must be passed through byte-for-byte. `FolderEntry.name` can be `""` for a prefix like `a//`; the UI shows a placeholder.
- ETags are returned without surrounding quotes. `ErrorCode` values are PascalCase strings exactly as in `types.ts`.
- An `endpoint` without a scheme gets `https://` prepended. With a custom endpoint, path-style addressing
  is on unless `forcePathStyle` is `false`, and checksums are only sent where S3 requires them (MinIO/R2 compatibility).
- Toolchain: `src-tauri/rust-toolchain.toml` pins rustc 1.94.1 (required by aws-sdk-s3 1.152).
- `start_download` also returns `InvalidInput` when `destPath` is relative, contains a `..` component, or is the destination of another queued/running download (compared case-insensitively on Windows).
- Downloads are consistency-checked: every GET sends `If-Match` with the ETag from `HeadObject`; a transfer fails if the object changed, if received bytes differ from the expected size, or if the server ignores `Range`.
- Stalled connections: 30 s read timeout plus a 30 s idle timeout per body chunk; both surface as `Network` and are retried per part (3 attempts).
- Uploads stream each part from disk (no whole-part buffering). `CreateMultipartUpload` and `CompleteMultipartUpload` are not interruptible; cancel takes effect between them.
- Frontend: local file names derived from S3 keys are sanitized (path separators, reserved characters and names, `.`/`..`) and de-duplicated case-insensitively before download.
- Security: `tauri.conf.json` sets a restrictive CSP (`default-src 'self'`, `connect-src ipc: http://ipc.localhost`); `devCsp` is null so Vite HMR works in dev.
