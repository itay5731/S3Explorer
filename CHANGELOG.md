# Changelog

Patch notes for every release. Versions are tagged `vMAJOR.MINOR.PATCH`.
The section for a version becomes the text of its GitHub Release.

## [Unreleased]

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
