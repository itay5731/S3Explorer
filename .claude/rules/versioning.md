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

**Never move or delete a pushed tag.** No exceptions as a practice; fix forward with a new PATCH version.

**A tag marks a version, nothing else.** Do not create a tag to try something out, and in particular do not
create a tag to test the release pipeline. A release-candidate tag is only legitimate when it is a real
candidate: its own commit, expected to differ from the final release. A tag on the same commit as the release
it precedes is not a candidate, it is a mistake.

If a change to the release pipeline needs testing before a real release, do not reach for a tag. Either ask the
user to run the workflow manually (a manual run without a tag builds every platform and publishes nothing), or
release normally and fix forward with a patch version if the pipeline misbehaves.

History of this rule: on 2026-10-05 `v0.3.0-rc.1` was pushed on the same commit as `v0.3.0` purely to check that
signed update packages were produced. The user called it out. It was deleted as a one-off because no commits
separated it from the release; creating it was the error, not keeping it.

History: `v0.1.0` = first working app (list, browse, upload, download, folders). It was tagged before the
release job existed, so its Release has to be published by a manual workflow run with `tag: v0.1.0`.
