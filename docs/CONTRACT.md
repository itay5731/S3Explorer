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
- Stalled connections (downloads): a response that sends no bytes is cut off by the SDK's stalled-stream protection (about 5 s) or our 30 s idle timeout; both surface as `Network`. The part is retried and **resumes from the bytes already written** (`Range` from the resume offset, still with `If-Match`). An attempt counts as progress only if it delivered at least 64 KiB (or the rest of the part, if smaller); a part fails after 3 consecutive attempts without progress, or when its total budget of `3 + ceil(partLen / 1 MiB)` attempts (at most 1,000) is used up. A response checksum mismatch fails immediately and is not retried. If every byte of a part has arrived and the connection then errors, the part is complete. `transferredBytes` never decreases. Both the single-request and the ranged path flush the file to disk before the final rename.
- Uploads: requests that carry a body (`PutObject`, `UploadPart`) do not use the SDK's read timeout, because it would include the time spent sending the body and break slow links. Each attempt instead has a timeout scaled to its size: `60 s + bodyLen × share / 32 KiB/s`, capped at 6 h, where `share` is `maxConcurrentParts × maxConcurrentTransfers` (the assumed minimum uplink is shared by everything in flight). A request whose server never answers therefore fails (after the SDK's retries) instead of hanging.
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

### Desktop notifications (added after v0.3.0)

`AppSettings` gains one field:

```ts
notifyOnFinish: boolean;   // default true
```

- `update_settings` requires every field of `AppSettings` (see the current list in `src/lib/types.ts`) and
  rejects a non-boolean `notifyOnFinish` with `InvalidInput`. A `settings.json` without the field loads with it at its default.
- With `notifyOnFinish` true the frontend shows an OS notification when a background job finishes
  and when the last active transfer finishes, but only while the app window is not focused. In-app
  toasts are unchanged.
- Notifications go through the Tauri notification plugin (`notification:default` capability).
  `src/lib/api.ts` asks for permission on first use and does nothing if it is denied. There is no
  new command or event.

### Text size and weight (added after v0.3.0)

`AppSettings` gains two fields, both set with sliders in Settings under Appearance:

```ts
textSize: number;     // percent, integer 80 to 150, default 100
textWeight: number;   // font weight of ordinary text, integer 300 to 600, default 400
```

- `update_settings` requires every field of `AppSettings` and rejects a non-integer or out-of-range value with
  `InvalidInput` naming the field. A `settings.json` without the fields, or with a bad value in
  one of them, loads that field at its default.
- **Size** scales the whole interface, not only the letters: the frontend sets the webview's zoom to
  `textSize / 100` (capability `core:webview:allow-set-webview-zoom`), so layout, icons and
  pointer coordinates stay consistent.
- **Weight** is applied as the font weight of ordinary text. Headings and emphasised text keep
  their own, heavier weights.
- Like the theme, both preview live in the Settings dialog and revert if it is cancelled.

### Accent colour (added after v0.3.0)

`AppSettings` gains one field, chosen in Settings under Appearance:

```ts
type AccentColor = "yellow" | "green" | "blue" | "red";
accent: AccentColor;   // default "yellow"
```

- `update_settings` requires every field of `AppSettings` and rejects an unknown `accent` with `InvalidInput`.
  A `settings.json` without the field, or with an unknown value, loads it as `"yellow"`.
- The frontend applies it by setting `data-accent` on `<html>` (always set once settings are loaded; the
  pre-paint script in `public/theme-init.js` sets it only for green, blue and red, since yellow is the CSS default). Buttons,
  selection, focus rings, the start screen's pulses and the logo inside the app follow it; the app
  icon in the taskbar does not.
- It previews live in the Settings dialog like the theme, and is mirrored in `localStorage` so the
  right colour is there before the first render.

### Newest files (added after v0.3.0)

S3 lists keys in name order only, so "what was added last?" needs a scan.

| Command | Args | Returns |
|---|---|---|
| `list_recent` | `{ bucket, prefix }` | `RecentListing` — the most recently modified objects under `prefix` at any depth (no delimiter), newest first. |

```ts
interface RecentListing {
  objects: ObjectEntry[];   // at most 200, newest first
  scanned: number;          // objects looked at
  truncated: boolean;       // true when the scan stopped at the limit before the end of the listing
}
```

- The scan stops after 20,000 objects. `truncated: true` then means newer objects may exist beyond
  what was scanned; the frontend must say so and never present a truncated result as complete.
- Folder markers (keys ending in `/`) are skipped and not counted. Objects without a modification
  time sort last. Paging follows the same rules as every other listing: a repeated continuation
  token is an error, never a silent stop.
- Read-only: it uses `ListObjectsV2`, the permission browsing already needs.
- The frontend shows the newest files of the open bucket in the sidebar, below the bucket list,
  and filters them there by age, file type and a search over the key.

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
- **Copy:** `CopyObject` for objects up to 5 GiB; multipart copy (`UploadPartCopy`, parts of 256 MiB, doubled
  as needed up to S3's 5 GiB part maximum to stay ≤ 10,000 parts) above that, aborted on failure or cancel. The source's
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

**Safety rules added by the backend implementation (all enforced, all tested):**

- **A job can never write into its own sources.** In the same bucket, any destination range that overlaps any
  source range of the same or another item is rejected with `InvalidInput` (e.g. `a/b/` → `a/`, the rotation
  `x/` → `y/` with `y/` → `z/`, swaps, or pasting into a folder that is itself being moved). Without this an
  overwriting move could replace a source and then delete its own destination. Two further guards back it up:
  after expansion the job fails before any change if a destination key equals a source key, and at run time a
  move refuses to delete any key that the same job writes.
- **A source is deleted only after its copy is proven.** The copy response must carry an ETag and a `HeadObject`
  of the destination must show the expected size. The delete of the source is conditional on the ETag that was
  copied, so a source that was overwritten in the meantime is kept (reported as a per-object failure saying the
  copy exists and the original remains).
- **Copies are conditional on the source seen during listing** (`x-amz-copy-source-if-match`): an object that
  changed after listing fails instead of copying something unexpected.
- **`skip` is enforced on the server where possible** with `If-None-Match: *`, so a destination created after the
  listing is still not overwritten. A server that answers NotImplemented falls back to the listing-phase check.
  A server that rejects ETag-conditional deletes gets one retry without the condition for the affected keys.
- **Overlapping sources in copy/move** (an object reachable through two items): the first item in request order
  wins and the object is copied once.
- **Listing-phase errors fail the whole job before any change** (for example a `HeadObject` error other than
  not-found, or a truncated listing without a continuation token).
- **Cancel:** copies already in flight finish and their sources are deleted, so no object is left in both places
  by a cancelled move; a multipart copy stops between parts and is aborted.
- Concurrency inside a job: 16 object copies, 4 parts per multipart copy, 4 `DeleteObjects` batches. Source
  deletes are flushed every 500 ms or 1,000 keys, so `doneItems` of a move can trail the copies briefly.
- `destBucket` on a delete request is rejected. `remove_job` with an unknown id is a no-op.
- Labels: a single item is named (`Delete report.pdf`, `Rename old.txt to new.txt`, `Move a to bucket/q/`);
  several items read `Copy 1,234 items to bucket/prefix/`.
- Not preserved by a copy: ACLs, the checksum algorithm, SSE-C. Tags are carried over (best effort for multipart
  copies). Content headers, user metadata and storage class are carried over explicitly.
- During listing `totalItems` is a running count and becomes exact when the phase changes to `working`.

**Added after the v0.3.0 code review (all enforced, each with a regression test):**

- **A delete is counted only when the server confirms it.** A key counts as deleted only if the `DeleteObjects`
  response lists it under `Deleted`. A key in neither list gets one `HeadObject` (not found → deleted); otherwise
  it is a per-object failure ("The server did not confirm the delete."). An error entry that names no key fails
  its whole batch. The same rule governs the source deletes of a move: an unconfirmed source is reported as
  "the copy exists and the original remains", never as moved.
- **A move needs an ETag for every source.** If the listing has none, the listing phase fetches it with
  `HeadObject`; if there is still none, that object is not moved. Copies do not need one.
- **Listings follow the continuation token**, whatever `IsTruncated` says. A truncated page without a token, or a
  token the server already returned, is an error; a partial listing is never acted on. For `list_objects`,
  `isTruncated` is true exactly when `nextContinuationToken` is non-null.
- **Server-side copies** have a timeout scaled to the object size (`5 min + bytes / 2 MiB/s`, between 15 min and 6 h).
- In development and test builds a panic inside a job or transfer ends it as `failed` and releases its slot; an
  unfinished multipart upload or copy is aborted when its task is dropped. Release builds abort the process on
  panic, as before.

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

### v0.3.0 backend notes (settings, saved connections, updates)

- **Settings file loading** is per field: a field with a wrong type or out-of-range value resets to its own
  default and the others are kept. Text that is not JSON at all resets everything. (Supersedes the earlier
  "fails to parse falls back wholesale" wording.)
- **`hasSecret` when the keychain cannot be read** while listing is reported as `false` rather than failing the
  whole list; connecting then returns the real `Keychain` error.
- **No half-saved connections:** if the keychain write fails nothing is stored; if the metadata write fails the
  keychain change is rolled back (new secret removed, or the previous secret restored).
- **`forcePathStyle`** is stored as the value `connect` actually used.
- **Update progress on Windows** ends with `installing`: the installer takes over, closes the app and restarts
  it. `restarting` is emitted on macOS and Linux only.
- **`check_for_update` when the repository has no releases** returns `available: false`, not an error.
- **A stalled update download** (60 s without data) is abandoned with a `Network` error. Signature verification is unaffected.
- **Opening links:** the app may open only `https://github.com/yonatand/S3Explorer/*` in the browser
  (capability scope). `downloadUrl` is always inside that prefix.
- **Messages the UI relies on:** a missing secret → `InvalidInput` containing the word "secret"; installs
  refused while transfers or file operations run → `InvalidInput` saying so; a package that fails signature
  verification is never installed and reports that plainly.
- **Linux** needs a running Secret Service (gnome-keyring, KWallet) to save or use connections with a secret;
  without one those actions return a `Keychain` error. AWS-profile connections need no keychain.

### UI text: units

Sizes and speeds are computed in binary units and must be labelled that way: `KiB`, `MiB`, `GiB`,
`MiB/s`.

### Window title (added after v0.3.0)

The frontend sets the window title to the connection label while connected and "S3 Explorer" otherwise,
through `getCurrentWindow().setTitle()` (capability `core:window:allow-set-title`). No command.

**`AppSettings` as of the redesign** (every field required by `update_settings`; a missing or invalid field
in `settings.json` loads at its default): `partSizeMib`, `maxConcurrentParts`, `maxConcurrentTransfers`,
`theme`, `checkUpdatesOnStartup`, `notifyOnFinish`, `textSize`, `textWeight`, `accent`. v0.4.0 adds
`confirmCopyMove` below.

## v0.4.0 additions — the buckets update

Everything in this section is new in v0.4.0. Where it changes an earlier section, this section wins.
New `ErrorCode` values: `"Conflict"` (the server-side state changed since it was read) and
`"NotSupported"` (the server does not implement this S3 feature; MinIO, R2, SeaweedFS and others
implement lifecycle and tagging only partly).

### Shared buckets (buckets added by name)

A bucket shared from another AWS account (or another account on an S3-compatible service with the
same sharing model) does not appear in `ListBuckets`. The user adds it by name and the app remembers
it for that connection.

```ts
interface AddedBucket {
  name: string;
  region: string | null;        // discovered with HeadBucket; null when the endpoint is custom
  addedAt: string;              // ISO-8601
}
```

| Command | Args | Returns |
|---|---|---|
| `list_added_buckets` | – | `AddedBucket[]` for the current connection, sorted by name. |
| `add_bucket` | `{ input }` | `AddedBucket`. `input` may be a bare bucket name, an `s3://name/...` URI (the path is ignored), or a bucket ARN `arn:aws:s3:::name`; access point ARNs and aliases are accepted as-is as the bucket value. Verifies with `HeadBucket` (resolving and caching the region, as browsing already does) and then one `ListObjectsV2` with `max-keys=1`. Not found → `NoSuchBucket`; no permission → `AccessDenied` with a message saying the bucket exists but these credentials cannot list it; both leave nothing stored. Already added → returns the existing entry. |
| `remove_added_bucket` | `{ name }` | `void`. Forgets the bucket locally. **Never touches the bucket or its contents.** Unknown name is a no-op. |

- **Storage:** `added-buckets.json` in the app config directory (atomic writes, lenient load), keyed by
  connection identity: a saved connection's id; otherwise `profile:<name>@<endpoint or aws>` or
  `static:<accessKeyId>@<endpoint or aws>`. A connection with no entry has an empty list.
- Added buckets behave like listed buckets everywhere (browse, transfers, jobs, tags, lifecycle). The
  UI shows them in their own sidebar group ("Shared with me") with a remove action, and `list_buckets`
  results that happen to include an added bucket show it once, in the normal list.
- Bucket-level features (lifecycle, bucket tags) on a shared bucket are usually denied: the UI shows
  "You don't have permission for this on this bucket" rather than a generic error, and never retries
  in a loop.

### Tags (buckets and objects)

```ts
interface Tag { key: string; value: string }
```

Limits, enforced by the backend (`InvalidInput` naming the problem) and mirrored live in the UI:
a bucket holds at most 50 tags, an object at most 10; `key` 1..=128 and `value` 0..=256 Unicode
characters; keys unique and case-sensitive; keys may not start with `aws:` (reserved). Allowed
characters are letters, numbers, spaces and `+ - = . _ : / @`.

| Command | Args | Returns |
|---|---|---|
| `get_bucket_tags` | `{ bucket }` | `Tag[]` — `[]` when the bucket has no tag set. |
| `put_bucket_tags` | `{ bucket, tags, expected }` | `Tag[]` (the stored set). **Replaces the whole set.** `expected` is the set the UI loaded; if the bucket's current tags differ from it the command fails with `Conflict` and changes nothing (the message includes nothing sensitive; the UI reloads and shows the current set). An empty `tags` deletes the tag set (`DeleteBucketTagging`). |
| `get_object_tags` | `{ bucket, key }` | `Tag[]` |
| `put_object_tags` | `{ bucket, key, tags, expected }` | `Tag[]` — same replace / `expected` / empty-deletes semantics for one object. |

**Bulk tag editing** is a job (see "Object operations"): `JobKind` gains `"tag"`, and `JobRequest`
gains an optional `tags` field that is required for that kind and rejected for the others:

```ts
type JobKind = "delete" | "copy" | "move" | "tag";
interface TagOperation {
  mode: "merge" | "replace";
  set: Tag[];        // keys to add or update (replace: the complete new set)
  remove: string[];  // merge only: keys to remove
}
// JobRequest: { kind: "tag", srcBucket, destBucket: null, items, onConflict: "skip" (ignored), tags: TagOperation }
```

- `merge` reads each object's tags, applies `set` and `remove`, and writes the result; an object whose
  result would exceed 10 tags is a per-object failure ("would have N tags; the limit is 10") and is left
  unchanged. `replace` writes `set` as the complete tag set of every object (an empty `set` removes all tags).
- Per object: `GetObjectTagging` (merge only) then `PutObjectTagging` (or `DeleteObjectTagging` when
  the result is empty). Counters, phases, cancel and errors as for other jobs; `doneBytes`/`totalBytes`
  stay 0. Up to 16 objects in flight.
- `preview_job` for `kind: "tag"` counts objects and bytes as usual; `conflicts` is 0.
- Objects with tags show them in the details panel (read on selection with `get_object_tags`).

### Lifecycle configuration

The full S3 lifecycle rule model, edited as a whole. S3 stores lifecycle as one document:
`PutBucketLifecycleConfiguration` **replaces every rule**. The app therefore always loads the full
configuration, edits it, and writes the full result back, and it refuses to write over a configuration
that changed since it was loaded.

```ts
type RuleStatus = "Enabled" | "Disabled";
type TransitionStorageClass =
  | "STANDARD_IA" | "ONEZONE_IA" | "INTELLIGENT_TIERING" | "GLACIER_IR" | "GLACIER" | "DEEP_ARCHIVE";

interface LifecycleFilter {
  prefix: string | null;                 // null = no prefix condition
  tags: Tag[];                           // all must match
  objectSizeGreaterThan: number | null;  // bytes
  objectSizeLessThan: number | null;     // bytes
}
// An empty filter (null, [], null, null) applies the rule to the whole bucket.
// Serialization to S3: one condition → Prefix / Tag / ObjectSizeGreaterThan / ObjectSizeLessThan directly;
// several → And { Prefix, Tags, ObjectSizeGreaterThan, ObjectSizeLessThan }; none → Filter {} .
// A legacy rule with a top-level Prefix (no Filter) is read as filter.prefix and written back as a Filter.

interface Transition { days: number | null; date: string | null; storageClass: TransitionStorageClass }
interface Expiration { days: number | null; date: string | null; expiredObjectDeleteMarker: boolean }
interface NoncurrentTransition { noncurrentDays: number; newerNoncurrentVersions: number | null; storageClass: TransitionStorageClass }
interface NoncurrentExpiration { noncurrentDays: number; newerNoncurrentVersions: number | null }

interface LifecycleRule {
  id: string;                                   // 1..=255 chars, unique within the configuration
  status: RuleStatus;
  filter: LifecycleFilter;
  transitions: Transition[];
  expiration: Expiration | null;
  noncurrentVersionTransitions: NoncurrentTransition[];
  noncurrentVersionExpiration: NoncurrentExpiration | null;
  abortIncompleteMultipartUpload: { daysAfterInitiation: number } | null;
}

interface LifecycleConfiguration { rules: LifecycleRule[] }   // at most 1,000 rules

interface LifecycleIssue { ruleIndex: number | null; field: string | null; message: string }
```

| Command | Args | Returns |
|---|---|---|
| `get_lifecycle` | `{ bucket }` | `LifecycleConfiguration \| null` — `null` when the bucket has no configuration. A server that does not implement lifecycle → `NotSupported`. |
| `validate_lifecycle` | `{ config }` | `LifecycleIssue[]` — pure, local, no network; `[]` means valid. The UI calls it live while editing (debounced) and the backend runs the same function before writing. |
| `put_lifecycle` | `{ bucket, config, expected }` | `LifecycleConfiguration \| null` (what is now stored). Validates (any issue → `InvalidInput` with the issues in the message, nothing written). Re-reads the current configuration and compares it with `expected` (the one the UI loaded, or `null`); a difference → `Conflict`, nothing written. `config.rules` empty → `DeleteBucketLifecycle`. |
| `get_bucket_versioning` | `{ bucket }` | `"Enabled" \| "Suspended" \| "Off"` — shown in the editor because noncurrent-version actions only matter with versioning. |

**Validation rules (`validate_lifecycle`, every one unit-tested):** 1..=1,000 rules; ids 1..=255,
unique; every rule has at least one action; per action exactly one of `days` / `date` (integer days;
`date` an ISO-8601 date at midnight UTC); **a transition may use `days` = 0** (AWS allows moving objects
to INTELLIGENT_TIERING, GLACIER_IR, GLACIER or DEEP_ARCHIVE on day 0) while expiration `days` ≥ 1; a rule
uses days for all of its transitions and its expiration, or dates for all of them, never a mix;
transitions within a rule have distinct storage classes and move only "colder" (STANDARD_IA / ONEZONE_IA
/ INTELLIGENT_TIERING → GLACIER_IR → GLACIER → DEEP_ARCHIVE, never back); **only STANDARD_IA and ONEZONE_IA**
need `days` ≥ 30 (INTELLIGENT_TIERING and the archive classes have no minimum); a later transition to
GLACIER_IR / GLACIER / DEEP_ARCHIVE after a STANDARD_IA or ONEZONE_IA transition must be at least 30 days
after it (no such gap is required after INTELLIGENT_TIERING); expiration must come after every transition (days greater, or date later); `expiredObjectDeleteMarker`
cannot be combined with `days`/`date` in the same expiration, and (like `abortIncompleteMultipartUpload`)
cannot be used in a rule whose filter has tags or object-size conditions; `objectSizeGreaterThan` <
`objectSizeLessThan` when both set; filter tags follow the tag limits; a rule with no filter conditions is
allowed (whole bucket) and the editor must say so in words. Noncurrent `noncurrentDays` ≥ 1 and
`newerNoncurrentVersions` 1..=100. Days and sizes are integers.

**UI requirements (the hard part):** rules listed with a one-line plain-language summary each
("Objects under logs/ with tag env=prod move to Glacier after 90 days and are deleted after 365 days");
a rule editor form covering every field above with inline validation from `validate_lifecycle`; enable/
disable, duplicate, delete and reorder rules; the bucket's versioning state shown, with noncurrent actions
explained; a read-only "as JSON" view of the whole configuration; and before saving, a confirmation that
lists what changed (rules added, removed, changed) and, in red, every rule that **deletes data** (any
expiration or noncurrent expiration), because a lifecycle rule can delete a whole bucket's contents
silently a day later. Saving when nothing changed is a no-op. A `Conflict` reloads the configuration and
tells the user someone else changed it.

### Confirmations for copy and move (setting)

`AppSettings` gains `confirmCopyMove: boolean` (default `true`); `update_settings` requires it like the
other fields and a `settings.json` without it loads `true`.

- `true`: paste (and drag-and-drop) shows the Copy/Move confirmation as today.
- `false`: when the preview finds **no conflicts**, the copy or move starts immediately after the preview
  and a toast says what started; when the preview finds conflicts, the dialog is shown exactly as today,
  because choosing Skip or Overwrite can never be skipped. Previews and validation still run every time.
- **The delete confirmation is never affected by any setting.**

### Drag and drop to move or copy (frontend only)

Rows (objects and folders, the whole current selection, or the dragged row if it is not selected) can
be dragged and dropped onto: a folder row in the table, a segment of the path bar (move to that parent),
or a bucket in the sidebar (move to that bucket's root, including added buckets). A drop builds the same
`JobRequest` as paste (`to = targetPrefix + name`, folders with a trailing `/`), runs `preview_job`, and
follows the confirmation setting above. **Holding Ctrl (Option on macOS) copies instead of moving**, and the
mode is shown while dragging: a badge following the pointer reads "Move N items" / "Copy N items" with a
distinct icon, the drop effect/cursor changes, and it updates live as the key is pressed or released.
Dropping onto the current folder, onto one of the dragged items, or into a descendant of a dragged folder
is refused with a message (the backend rejects these too). A drag starts only after a small pointer
movement; Esc cancels. This is internal HTML5/pointer dragging and must not break the existing OS file
drop (upload); verify on the real executable, where Tauri's native drag-drop handling can swallow HTML5
drop events on Windows.

### Taskbar / Start menu icon (bug)

Reported after v0.3.0 on an installed copy launched like a user: the window shows the app icon but the
taskbar and Start menu show the default Tauri icon. The redesign has since replaced the icon again
(white bucket on a yellow tile). Fix for v0.4.0 and verify on the installed release artifact, checking
every size inside the exe's icon resource, the installer's shortcut icon, and Windows' icon cache.

### IAM permissions added in this version

`s3:GetBucketTagging`, `s3:PutBucketTagging` (bucket tags; `PutBucketTagging` also covers deletion),
`s3:GetObjectTagging`, `s3:PutObjectTagging`, `s3:DeleteObjectTagging` (object tags),
`s3:GetLifecycleConfiguration`, `s3:PutLifecycleConfiguration` (lifecycle; `Put` also covers deletion),
`s3:GetBucketVersioning`. Adding a shared bucket needs only `s3:ListBucket` on it.
