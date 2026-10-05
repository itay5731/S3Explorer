# S3 Explorer

Fast, cross-platform desktop S3 explorer. Tauri v2 (Rust) backend + React/TypeScript/Vite frontend.

- **Contract first:** `docs/CONTRACT.md` and `src/lib/types.ts` define every command, type and event. Change them before changing either side.
- Backend: `src-tauri/` — `cargo check` / `cargo build` must pass. Rust structs use `#[serde(rename_all = "camelCase")]`.
- Frontend: `src/` — `npm run build` (tsc + vite) must pass. `src/lib/api.ts` is the only `invoke` call site; `src/lib/mock.ts` backs browser-only dev.
- Dev: `npm run tauri dev`. Release exe: `npm run tauri build`.
- Performance is a feature: virtualize long lists, parallel ranged downloads, no blocking the UI thread.
- Project rules live in `.claude/rules/` (build caching, architecture, scope, data safety, orchestration; `rust.md`/`frontend.md` are path-scoped). Workflows are skills in `.claude/skills/`: `/verify`, `/contract-check`, `/dev`, `/smoke-test`, `/release-build`, `/fanout`.
