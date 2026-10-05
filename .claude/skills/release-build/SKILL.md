---
name: release-build
description: Produce the optimized, distributable S3 Explorer executable and installers (Tauri release build) and report where they landed. Use when asked for an exe, a build, a release, or installers for Windows/macOS/Linux.
---

# Release build

Run the `verify` skill first. Then, with no other cargo process running:

```bash
npm run tauri build 2>&1 | tail -40
```

This runs `npm run build` (frontend) and `cargo build --release` (LTO, `opt-level=3`, stripped,
`panic=abort`, see `src-tauri/Cargo.toml`). It uses the separate `release` target profile, so it
leaves the dev cache intact. Expect several minutes cold, well under a minute warm.

## Where the artifacts are
- Bare executable: `src-tauri/target/release/s3explorer.exe` (Windows) /
  `src-tauri/target/release/s3explorer` (macOS, Linux). This single file is the app.
- Installers: `src-tauri/target/release/bundle/` → `msi/` and `nsis/` on Windows, `dmg/` and
  `macos/` on macOS, `deb/`, `rpm/` and `appimage/` on Linux.

Report the exe path and size (`ls -la`). Launch it once to confirm it opens.

## Cross-platform note
Tauri does not cross-compile: each OS builds its own binary. Build locally for the current OS.
For the others, `.github/workflows/release.yml` builds Windows x64, macOS arm64 + x64 and Linux x64
on GitHub runners and uploads the bare executable plus installers as artifacts. It runs on a
manual dispatch or a `v*` tag push, so it needs the repo pushed to GitHub first. Keep its Rust
version in sync with `src-tauri/rust-toolchain.toml`. With `--target <triple>` the output moves to
`src-tauri/target/<triple>/release/`.
