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
2. Re-read `README.md` top to bottom against what is actually shipping and edit it if anything is
   stale. Do this on every version, including patch releases. Check at least: the feature list and
   the "does not do" list, the download-splitting table and concurrency numbers, the status table
   under "Should you trust it?" (version named there, what has and has not been tested), build and
   run commands, toolchain requirements, executable size, and screenshots that no longer match the
   UI.
   Also re-derive the "IAM permissions" section from the code: list every S3 call the backend makes
   (`grep -rhoE ".(list_|head_|get_|put_|create_|upload_|complete_|abort_|delete_|copy_)[a-z_]*()" src-tauri/src | sort -u`)
   and make sure the table, both example policies and the notes cover exactly those calls. If nothing needs changing, say so explicitly in the release summary to the user.
3. Bump the three version files. Steps 1 to 3 go in one commit: `Release vX.Y.Z`.
4. Create an annotated tag on that commit: `git tag -a vX.Y.Z -m "vX.Y.Z: <one-line summary>"`.
5. Push the commit and the tag. The tag triggers `.github/workflows/release.yml`, which builds the
   Windows, macOS and Linux executables and publishes a GitHub Release with the patch notes and
   the files attached.
6. Check the run finished green and the Release page shows the notes and all platform files.

To publish a Release for a tag that predates its notes, run the workflow manually with the `tag` input.

Never move or delete a pushed **version** tag (`vX.Y.Z`); fix forward with a new PATCH version.

**Release candidates are temporary.** Use a tag like `vX.Y.Z-rc.1` only to test a change to the release pipeline
itself (it is published as a pre-release, which `releases/latest` and the in-app updater ignore). As soon as it
has answered its question, delete it: `git push origin :refs/tags/vX.Y.Z-rc.1` and `git tag -d vX.Y.Z-rc.1`.
GitHub then keeps the release as a hidden draft that only the owner can delete (Releases page), so tell the
user it is there. Do not leave a release candidate published next to the real release.

History: `v0.1.0` = first working app (list, browse, upload, download, folders). It was tagged before the
release job existed, so its Release has to be published by a manual workflow run with `tag: v0.1.0`.
