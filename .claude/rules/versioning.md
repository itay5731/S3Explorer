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

Patch notes live in `CHANGELOG.md`. Add user-facing changes under `## [Unreleased]` as they land,
written for users (what they can now do, what was fixed), not as commit summaries.

Release procedure (orchestrator only, after the `verify` gate passes):
1. In `CHANGELOG.md`, rename `## [Unreleased]` content into a new `## [X.Y.Z] - YYYY-MM-DD` section and
   leave an empty `## [Unreleased]` above it. The heading must be exactly `## [X.Y.Z]` plus the date:
   the release job extracts that section as the GitHub Release text and fails if it is missing.
2. Bump the three version files, in the same commit: `Release vX.Y.Z`.
3. Create an annotated tag on that commit: `git tag -a vX.Y.Z -m "vX.Y.Z: <one-line summary>"`.
4. Push the commit and the tag. The tag triggers `.github/workflows/release.yml`, which builds the
   Windows, macOS and Linux executables and publishes a GitHub Release with the patch notes and
   the files attached.
5. Check the run finished green and the Release page shows the notes and all platform files.

To publish a Release for a tag that predates its notes, run the workflow manually with the `tag` input.

Never move or delete a pushed tag; fix forward with a new PATCH version.

History: `v0.1.0` = first working app (list, browse, upload, download, folders). It was tagged before the
release job existed, so its Release has to be published by a manual workflow run with `tag: v0.1.0`.
