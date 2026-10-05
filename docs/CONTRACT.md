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

`delete_folder` was removed in v0.3.0; folders are deleted with `start_job` (see "Object operations (jobs)").

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
- Stalled connections (downloads): a response that sends no bytes is cut off by the SDK's stalled-stream protection (about 5 s) or our 30 s idle timeout; both surface as `Network`. The part is retried and **resumes from the bytes already written** (`Range` from the resume offset, still with `If-Match`). A part fails only after 3 consecutive attempts that received nothing. `transferredBytes` never decreases.
- Uploads: requests that carry a body (`PutObject`, `UploadPart`) run without a read timeout, because the SDK's read timeout would include the time spent sending the body and break slow links. They rely on connect timeout, TCP errors and stalled-stream protection.
- Uploads stream each part from disk (no whole-part buffering). `CreateMultipartUpload` and `CompleteMultipartUpload` are not interruptible; cancel takes effect between them.
- Frontend: local file names derived from S3 keys are sanitized (path separators, reserved characters and names, `.`/`..`) and de-duplicated case-insensitively before download.
- Security: `tauri.conf.json` sets a restrictive CSP (`default-src 'self'`, `connect-src ipc: http://ipc.localhost`); `devCsp` is null so Vite HMR works in dev.

## Settings (added after v1)

User-tunable transfer settings, owned and persisted by the backend.

```ts
interface TransferSettings {
  partSizeMib: number | null;      // null = Auto (8 MiB; 16 MiB for objects over 1 GiB). Integer 1..=256 otherwise.
  maxConcurrentParts: number;      // parts in flight per transfer. Integer 1..=32. Default 8.
  maxConcurrentTransfers: number;  // transfers running at once (others queue). Integer 1..=10. Default 4.
}
```

Defaults and limits are exported from `src/lib/types.ts` (`DEFAULT_TRANSFER_SETTINGS`,
`TRANSFER_SETTINGS_LIMITS`) and mirrored as constants in Rust.

| Command | Args | Returns |
|---|---|---|
| `get_settings` | – | `TransferSettings` — current values (defaults on first run). Works while disconnected. |
| `update_settings` | `{ settings: TransferSettings }` | `TransferSettings` — the stored values. Out-of-range or non-integer values are rejected with `InvalidInput` and a message naming the field; nothing is changed. Works while disconnected. |

Semantics:

- **Persistence:** stored as JSON (`settings.json`) in the app config directory
  (`app.path().app_config_dir()`), written atomically (temp file + rename). Loaded at startup; a
  missing, unreadable or invalid file falls back to defaults without failing startup. Unknown
  fields are ignored and missing fields take their default, so the file stays forward compatible.
- **When changes apply:** a transfer snapshots `partSizeMib` and `maxConcurrentParts` when it
  *starts running*; transfers already running keep theirs. `maxConcurrentTransfers` applies
  immediately to the queue: raising it lets queued transfers start at once; lowering it never
  interrupts running transfers, it only stops new ones from starting until the count drops below the limit.
- **Download splitting:** an object is split when its size is greater than the part size
  (Auto keeps today's behavior exactly: threshold 8 MiB, parts 8 MiB, 16 MiB above 1 GiB).
  Part count is `ceil(size / partSize)`.
- **Upload splitting:** S3 requires every non-final part to be at least 5 MiB and at most 10,000
  parts. Uploads therefore use `max(partSize, 5 MiB)`, grown further if needed to stay within
  10,000 parts; a file is multipart when larger than that effective part size. Auto keeps today's behavior.
- **Memory:** a download holds up to `maxConcurrentParts × min(partSize, 16 MiB)` in RAM per running
  transfer: parts up to 16 MiB are held whole and written once, larger parts are streamed to disk in
  1 MiB batches (v0.3.0; before that memory grew with part size). Uploads stream from disk. The UI
  shows this estimate (`DOWNLOAD_BUFFER_CAP_MIB` in `types.ts`) and warns above 1 GiB total
  (`maxConcurrentTransfers × maxConcurrentParts × min(partSize, 16 MiB)`).
- `Transfer.partsTotal` reflects the part size the transfer actually used.

Implementation notes (settled during implementation):

- **Upload Auto** is 8 MiB at every file size; the 16 MiB step above 1 GiB applies to downloads only.
- **Upload part growth** past the 10,000-part limit is by doubling the effective part size (5 → 10 → 20 MiB …),
  not the smallest size that fits.
- `update_settings` requires all three fields. `partSizeMib` must be present as `null` or an integer. Error
  messages start with the field name, e.g. `maxConcurrentParts must be an integer from 1 to 32`.
- A settings file that fails to parse falls back to defaults wholesale; one that parses but has out-of-range
  values keeps its valid fields and resets only the bad ones.
- Queued transfers start in FIFO order. A transfer's run slot is released after its final progress event, so the
  number of transfers reported `running` never exceeds `maxConcurrentTransfers` (except right after lowering it).
- A disk failure while saving returns `Io` and leaves the active settings unchanged.

## v0.3.0 additions

Everything in this section is new in v0.3.0. Where it changes an earlier section, this section wins.

### App settings (extends "Settings")

The settings object stays flat and keeps its three transfer fields. Two fields are added and the
TypeScript type is renamed `AppSettings` (`TransferSettings` remains as an alias).

```ts
type ThemeMode = "system" | "light" | "dark";
interface AppSettings {
  partSizeMib: number | null;
  maxConcurrentParts: number;
  maxConcurrentTransfers: number;
  theme: ThemeMode;                 // default "system"
  checkUpdatesOnStartup: boolean;   // default false
}
```

- `get_settings` / `update_settings` keep their names and semantics. `update_settings` requires all
  five fields and rejects an unknown `theme` or a non-boolean `checkUpdatesOnStartup` with `InvalidInput`.
- A `settings.json` written by v0.2.0 (three fields) loads with the two new fields at their defaults.
- **Theme:** the frontend applies `theme` by setting `data-theme="light" | "dark"` on `<html>`, or
  removing the attribute for `"system"` (then `prefers-color-scheme` decides). It applies instantly
  on change in the Settings dialog (live preview) and reverts if the dialog is cancelled. To avoid a
  flash at startup the frontend mirrors the last saved theme in `localStorage` and applies it before
  first render; the backend value is the source of truth.

### Saved connections

Named connections the user can reuse. Metadata is stored in `connections.json` in the app config
directory (atomic writes, lenient load, same rules as `settings.json`). **Secrets are stored only in
the operating system keychain** (Windows Credential Manager, macOS Keychain, Linux Secret Service),
service name `dev.s3explorer.app`, account = the connection id. Secrets are never written to
`connections.json`, never logged, and never returned to the frontend.

```ts
interface SavedConnection {
  id: string;                    // uuid, assigned by the backend
  name: string;                  // unique, case-insensitive, 1..=64 chars after trimming
  kind: "profile" | "static";
  profile: string | null;        // kind = "profile"
  accessKeyId: string | null;    // kind = "static"
  region: string | null;
  endpoint: string | null;
  forcePathStyle: boolean;
  hasSecret: boolean;            // kind = "static": a secret is present in the keychain
  lastUsedAt: string | null;     // ISO-8601, updated by connect_saved
}

interface SaveConnectionInput {
  id?: string | null;            // present = update that connection, absent = create
  name: string;
  config: ConnectionConfig;      // same shape as `connect`
}
```

| Command | Args | Returns |
|---|---|---|
| `list_saved_connections` | – | `SavedConnection[]` sorted by `lastUsedAt` desc (never-used last), then name. Works while disconnected. |
| `save_connection` | `{ input: SaveConnectionInput }` | `SavedConnection`. For `static`, `secretAccessKey` is written to the keychain. On update, an empty `secretAccessKey` means "keep the stored secret". A `sessionToken` is never saved (temporary credentials are not savable): reject with `InvalidInput` if one is supplied. Duplicate name → `InvalidInput`. |
| `delete_saved_connection` | `{ id }` | `void`. Removes metadata and the keychain entry. Unknown id is a no-op. |
| `connect_saved` | `{ id }` | `ConnectionInfo`. Loads the secret from the keychain and connects exactly like `connect`. `label` is the saved name. Updates `lastUsedAt`. |

- New `ErrorCode` value: `"Keychain"` — the OS keychain is unavailable or refused access. `save_connection`
  fails with it and stores nothing (no half-saved connection). `connect_saved` fails with it, or with
  `InvalidInput` and a clear message if the secret is missing (`hasSecret: false`), so the UI can ask
  the user to re-enter the secret.
- Deleting a saved connection does not disconnect an active session that was started from it.

### Object operations (jobs)

Delete, copy, move and rename for objects and folders. Rename is a move within the same folder. S3
has no rename or move: both are implemented as copy, then delete of the source. These can be long
running, so they run in the background as **jobs**, reported by events like transfers.

```ts
type JobKind = "delete" | "copy" | "move";
type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type ConflictPolicy = "overwrite" | "skip";

interface JobItem {
  from: string;            // source key, or source prefix ending in "/" when isPrefix
  to: string | null;       // destination key / prefix (ending in "/" when isPrefix); null for delete
  isPrefix: boolean;
}

interface JobRequest {
  kind: JobKind;
  srcBucket: string;
  destBucket: string | null;       // null for delete; may equal srcBucket
  items: JobItem[];                // 1..=10,000 items
  onConflict: ConflictPolicy;      // ignored for delete
}

interface JobPreview {
  objects: number;                 // objects that would be affected (prefixes expanded)
  bytes: number;
  conflicts: number;               // destination keys that already exist (copy/move)
  truncated: boolean;              // true when counting stopped at 100,000 objects; numbers are lower bounds
}

interface JobError { key: string; message: string }

interface Job {
  id: string;
  kind: JobKind;
  srcBucket: string;
  destBucket: string | null;
  label: string;                   // short human description, e.g. "Move 3 items to backups/2026/"
  phase: "listing" | "working" | "done";
  totalItems: number;              // objects discovered so far; final once phase != "listing"
  doneItems: number;               // objects fully processed successfully
  skippedItems: number;            // skipped because of onConflict = "skip"
  failedItems: number;
  totalBytes: number;
  doneBytes: number;
  status: JobStatus;
  error: string | null;            // job-level failure (e.g. listing failed)
  errors: JobError[];              // first 50 per-object errors
  startedAt: string;
  finishedAt: string | null;
}
```

| Command | Args | Returns |
|---|---|---|
| `preview_job` | `{ request: JobRequest }` | `JobPreview` — validates the request and counts what it would touch, without changing anything. |
| `start_job` | `{ request: JobRequest }` | `string` (job id). Validates, then runs in the background. |
| `cancel_job` | `{ id }` | `void` — cooperative. Work already done stays done. |
| `remove_job` | `{ id }` | `void` — forget a finished job. `InvalidInput` while queued/running. |
| `list_jobs` | – | `Job[]` |

Event `job:progress`, payload `Job`: at most every 100 ms per job while running, and always on
status or phase change. First event has status `queued`; the last carries `finishedAt`.

**Semantics (data safety — these are requirements, not suggestions):**

- **Keys and prefixes are opaque** and passed through byte for byte (see `.claude/rules/data-safety.md`).
  Prefix items must end with `/`; a prefix of `""` or `"/"` is rejected.
- **Validation (`InvalidInput`, nothing is changed):** empty items; a copy/move whose destination
  equals its source; a prefix copied or moved into itself or a descendant of itself (same bucket,
  `to` starts with `from`); two items that would write the same destination key; `to` missing for
  copy/move or present for delete; an object destination ending in `/`.
- **Prefix expansion** lists every key under `from` (no delimiter, paginated) and maps
  `from + rest` → `to + rest`. The folder marker object is included. An item whose prefix matches
  nothing is reported as a per-item error, not silently ignored.
- **Copy:** `CopyObject` for objects up to 5 GiB; multipart copy (`UploadPartCopy`, parts of 256 MiB up to
  512 MiB grown to stay ≤ 10,000 parts) above that, aborted on failure or cancel. The source's
  storage class, content type and user metadata are preserved. Objects that cannot be read (e.g.
  archived in Glacier and not restored) fail individually with a clear message.
- **Conflicts:** with `skip`, an existing destination key is left untouched, counted in
  `skippedItems`, and **its source is not deleted** even in a move. With `overwrite` it is replaced.
- **Move = copy, then delete the source of each object whose copy succeeded.** A source is deleted
  only after its own copy is confirmed. If a copy fails, that source is never deleted. Sources are
  deleted in batches as the job progresses, not all at the end, so a cancelled move leaves each
  object in exactly one place.
- **Delete:** `DeleteObjects` in batches of 1,000; per-key errors from the response are collected.
  On a versioned bucket this adds delete markers (older versions remain).
- **Final status:** `completed` when every object succeeded or was skipped; `failed` when the job
  could not run or at least one object failed (then `failedItems > 0`, details in `errors`);
  `cancelled` when cancelled. `doneItems + skippedItems + failedItems == totalItems` at the end
  unless cancelled.
- **Concurrency:** up to 16 object operations in flight per job; at most 2 jobs run at once, others
  queue (FIFO). Jobs do not count against `maxConcurrentTransfers`.
- Jobs work across buckets on the current connection, including buckets in different regions.

`delete_folder` is **removed**; the UI uses `start_job` with `kind: "delete"`.

**Details settled during implementation:**

- **Two phases, strictly in order.** The whole listing phase (prefix expansion and, for copy/move, conflict
  detection) finishes before the first object is changed. If expansion shows that two sources map to the same
  destination key, the job fails with a job-level `error` and nothing is changed.
- **Request-time validation** additionally rejects identical `to` values and a destination nested inside another
  item's destination prefix.
- **Duplicate or overlapping sources** (the same key reached through two items) are de-duplicated; each object is
  processed once.
- **A prefix that matches nothing** counts as one item in `totalItems` and `failedItems`, with an error saying
  nothing was found under it.
- **A missing object key:** for delete it counts as done (deleting is idempotent in S3); for copy/move it is a
  per-object failure.
- `phase` is `"done"` in every final status, including `failed` and `cancelled`.
- `label` is written by the backend for display as-is: `Delete N items`, `Copy N items to <dest prefix or bucket>`,
  `Move N items to <dest>`, and for a single-item move within one folder `Rename <old name> to <new name>`.
- `cancel_job` returns `InvalidInput` for an unknown id and is a no-op for a finished job (same as transfers).
- `install_update` is refused while any job is queued or running, as for transfers.
- The frontend sends `onConflict: "skip"` unless the user explicitly chose Overwrite, so an object that appears
  at the destination after the preview is never overwritten silently.

### Updates

The app can check GitHub Releases for a newer version and install it. Installation uses the Tauri
updater plugin, which only installs packages signed with this project's updater key.

```ts
interface UpdateInfo {
  currentVersion: string;          // e.g. "0.3.0"
  available: boolean;
  latestVersion: string | null;    // null when the check could not determine it
  notes: string | null;            // patch notes (markdown) of the latest release
  publishedAt: string | null;      // ISO-8601
  canInstall: boolean;             // a signed update package exists for this platform
  downloadUrl: string;             // release page to open when canInstall is false
}

type UpdatePhase = "downloading" | "installing" | "restarting";
interface UpdateProgress { phase: UpdatePhase; downloadedBytes: number; totalBytes: number | null }
```

| Command | Args | Returns |
|---|---|---|
| `check_for_update` | – | `UpdateInfo`. Works while disconnected. Network failure → `Network` error. |
| `install_update` | – | `void`. Downloads and installs the update found by the last check, emitting `update:progress`, then restarts the app. `InvalidInput` if no installable update is known. Refused with `InvalidInput` while any transfer or job is queued or running (the UI must say so). |

- Source of truth: `https://github.com/yonatand/S3Explorer/releases/latest`. Pre-releases are ignored.
- `check_for_update` first asks the updater plugin (endpoint
  `https://github.com/yonatand/S3Explorer/releases/latest/download/latest.json`). If that manifest is
  missing or has no entry for this platform, it falls back to the GitHub API
  (`/repos/yonatand/S3Explorer/releases/latest`), compares versions, and returns `canInstall: false`
  with `downloadUrl` set, so the user can still be told and download manually.
- Signature verification is mandatory for installation and is never bypassed. The updater public key
  is embedded in `tauri.conf.json`; the private key is never in the repository.
- With `checkUpdatesOnStartup` true the frontend calls `check_for_update` once, a few seconds after
  startup, silently; it only shows a non-blocking notice when an update is available. It never
  installs without the user clicking.
- Event `update:progress`, payload `UpdateProgress`.

### UI text: units

Sizes and speeds are computed in binary units and must be labelled that way: `KiB`, `MiB`, `GiB`,
`MiB/s`.
