# Versioning

Semantic versioning, written `vMAJOR.MINOR.PATCH` (for example `v0.2.0`).

- **PATCH**: bug fixes and internal changes with no new user-facing capability.
- **MINOR**: a new user-facing feature or a backward-compatible contract addition.
- **MAJOR**: a breaking change (removed/renamed command, incompatible settings file, changed behavior users rely on).
  While the major version is 0, breaking changes bump MINOR.

The version number (without the `v`) lives in three files and must be identical in all of them:
`package.json` (`version`), `src-tauri/Cargo.toml` (`[package] version`), `src-tauri/tauri.conf.json`
(`version`). After changing them run `cargo check` so `src-tauri/Cargo.lock` picks up the new
version, and `npm install --package-lock-only` so `package-lock.json` does too.

Release procedure (orchestrator only, after the `verify` gate passes):
1. Bump the three files in one commit: `Release vX.Y.Z`.
2. Create an annotated tag on that commit: `git tag -a vX.Y.Z -m "vX.Y.Z: <one-line summary>"`.
3. Push the commit and the tag. Pushing a `v*` tag triggers `.github/workflows/release.yml`,
   which builds the Windows, macOS and Linux executables.

Never move or delete a pushed tag; fix forward with a new PATCH version.

History: `v0.1.0` = first working app (list, browse, upload, download, folders).
