# Build caching and speed

Incremental builds are the single biggest speed lever in this repo. A cold Tauri + aws-sdk build
takes several minutes; a warm `cargo check` takes seconds. Protect the caches.

## Never do
- `cargo clean`, deleting `src-tauri/target/`, `node_modules/`, or `node_modules/.vite/`.
- Re-running `npm install` unless `package.json` changed. Re-running `cargo fetch` (crates are already fetched).
- Running two cargo processes against `src-tauri/target/` at once. Cargo takes a lock on the
  target dir, so the second one just blocks. Only one agent owns Rust compilation at a time.
- Catting or grepping inside `src-tauri/target/`, `node_modules/`, `dist/`, `src-tauri/gen/`,
  `Cargo.lock`, or `package-lock.json`. They are huge and never the answer.

## Prefer
- `cargo check` to validate Rust. `cargo build` only when you need to run something.
  `cargo clippy` after check passes. `[profile.dev] opt-level = 1` is already set, keep it.
- `npm run build` (tsc + vite) to validate the frontend, not a dev server.
- `npm run dev` alone (browser + mock backend) for UI iteration. It needs no Rust compile.
- `npm run tauri dev` only for end-to-end checks. The first run compiles everything once, then
  Rust edits rebuild incrementally and frontend edits hot-reload.
- `npm run tauri build` (release, LTO, strip) only when producing a deliverable executable. It
  is a separate `release` profile cache, so it does not invalidate the dev cache.

## Context caching (for Claude)
- Everything worth knowing about the stack, scope and conventions lives in `CLAUDE.md`,
  `docs/CONTRACT.md` and `.claude/rules/`. Read those instead of re-deriving from source.
- Subagents get these rules automatically. Do not paste their contents into prompts; point at
  the files.
