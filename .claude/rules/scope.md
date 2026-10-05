# Product scope (v1)

The user defined v1 precisely. Deliver exactly this, do not widen it:

1. Connect with an AWS profile or static credentials (optional custom endpoint for MinIO/R2).
2. List buckets.
3. Browse objects and folders with basic metadata (size, last modified, storage class, etag).
4. Upload objects (multipart for large files).
5. Download objects (parallel ranged parts).
6. Create folders and delete folders (recursive).

7. Settings view with transfer tuning: part size, parallel parts per transfer, simultaneous
   transfers (added on request after v1; see "Settings" in `docs/CONTRACT.md`).

8. (v0.3.0) Delete, rename, copy and move for objects and folders, run as background jobs.
9. (v0.3.0) Light / dark / system theme switch in Settings.
10. (v0.3.0) Saved connections, with secrets in the OS keychain only.
11. (v0.3.0) Check for updates from GitHub Releases and install them (signed packages only).
12. Desktop notifications when a transfer or job finishes while the app is in the background
    (added on request after v0.3.0; see "Desktop notifications" in `docs/CONTRACT.md`).
13. Newest files of the open bucket in the sidebar, found by a bounded scan (added on request after
    v0.3.0; see "Newest files" in `docs/CONTRACT.md`).

Explicitly **not** in scope: bucket creation/deletion, versioning UI (listing or restoring old
versions), presigned URLs, permissions/ACL editing, sync, recursive folder upload/download.
If a task seems to need one of these, stop and ask the user instead of adding it.
