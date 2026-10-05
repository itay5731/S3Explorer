# Data safety (lessons from the first code review)

This app deletes cloud data and writes to the local disk with the user's credentials. These rules
exist because each one was a real bug found in review.

- **Never rewrite a server-provided key or prefix.** S3 keys are opaque: `a//`, `/foo/`, keys with
  `\`, `..` or trailing spaces are all legal and distinct. Pass `FolderEntry.prefix` and
  `ObjectEntry.key` through unchanged to navigate, delete, head, download. Normalize only text
  the user typed (new folder names). What the confirmation modal shows must be byte-for-byte what
  is sent to `delete_folder`.
- **S3 names are untrusted when they become local paths.** Sanitize the local file name
  (`\ / : * ? " < > |`, control chars, `.`/`..`, trailing dots and spaces, Windows reserved names)
  before joining it to a directory. The backend also rejects a relative `destPath` or one with `..`.
- **One writer per local file.** Temp files are unique per transfer; an active download to the same
  destination (case-insensitive on Windows) is rejected; multi-downloads de-duplicate colliding names.
- **A transfer must never hang or balloon.** Read timeouts so stalled parts error and retry; stream
  upload parts from disk instead of buffering; verify ranged responses match the requested length
  before buffering; never report Completed without checking received bytes against the expected size.
- **Abort what you start.** Every multipart upload is aborted on failure or cancel; do not make
  Create/Complete cancellable mid-request.
- **Keep a restrictive CSP** in `tauri.conf.json`. Any script injection in the webview otherwise gets
  full IPC: arbitrary local file upload and arbitrary path download.
- **Destructive commands get a regression test** against the local S3 server (`smoke-test` skill)
  that asserts what survived, not only what was deleted.
