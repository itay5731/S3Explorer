# Changelog

Patch notes for every release. Versions are tagged `vMAJOR.MINOR.PATCH`.
The section for a version becomes the text of its GitHub Release.

## [Unreleased]

## [0.2.0] - 2026-10-05

Settings. You can now tune how transfers run instead of living with fixed numbers.

### New

- **Settings dialog**, opened with the gear button on the connect screen or in the top bar. It works before you connect.
- **Part size**: Auto, or a custom size from 1 to 256 MiB. Auto is what the app did before: 8 MiB parts, and 16 MiB for downloads over 1 GiB.
- **Parallel parts per transfer**: 1 to 32 (default 8).
- **Simultaneous transfers**: 1 to 10 (default 4). The rest wait in a queue.
- **Live impact summary** while you edit: total connections, estimated peak download memory, and how many parts a 1 GiB file would be split into. It warns you when the memory estimate gets large.
- Settings are saved on your machine and survive restarts. A missing or damaged settings file falls back to defaults instead of breaking startup.

### How changes apply

- Part size and parallel parts apply to transfers that start after you save. Transfers already running keep the values they started with.
- The simultaneous-transfers limit applies to the queue immediately. Raising it starts queued transfers right away. Lowering it never interrupts a running transfer.
- Uploads always use parts of at least 5 MiB, because S3 requires it. A smaller custom size still applies to downloads.

### Changed

- Queued transfers now start strictly in the order they were added.
- An object is downloaded in a single request when it is no larger than one part.

### Fixed

- The transfers panel could briefly show one more running transfer than the limit while one finished and the next started.

## [0.1.0] - 2026-10-05

The first working version. Vibe coded, so I won't have to pay for an S3 explorer. :)

### What you can do

- **Connect** with an AWS profile from `~/.aws` or with access keys. Add a custom endpoint to use MinIO, Cloudflare R2, SeaweedFS, LocalStack and other S3-compatible storage.
- **List buckets**, including ones in other regions.
- **Browse folders and objects** with size, last modified, storage class, ETag, content type and user metadata. The table stays smooth with thousands of rows and loads more as you scroll.
- **Download in parallel parts.** Objects over 8 MiB are split into 8 MiB byte ranges (16 MiB for objects over 1 GiB) and fetched up to 8 parts at a time.
- **Upload** by button or drag and drop, with multipart upload for files over 8 MiB.
- **Create folders** and **delete folders** recursively, with a confirmation that shows the exact prefix.
- **Transfers panel** with live speed, parts done, time remaining, cancel, and "show in folder". Up to 4 transfers run at once and the rest queue.
- Sort, filter, multi-select, right-click menu, keyboard navigation, dark and light themes.

### Built to be careful with your data

- A download fails instead of mixing two versions if the object changes midway, and received bytes are checked against the expected size.
- File names from S3 are sanitized before they become local paths, so a hostile key can't write outside the folder you chose.
- Two downloads can't write to the same file at the same time.
- Stalled connections time out and the affected part is retried.
- Cancelled or failed multipart uploads are aborted, so they don't linger and cost you storage.
- Your secret key is never written to disk by the app.

### Known limitations

- Not yet tested against real AWS S3, only against a local S3-compatible server.
- macOS and Linux builds are produced by CI and have not been tried by a human.
- No deleting or renaming of single objects, no copy or move, no bucket creation, no versioning or presigned URLs.
- Part size and concurrency are fixed. Settings for them are coming in the next version.
- Dropping a folder onto the window does not upload it recursively.
