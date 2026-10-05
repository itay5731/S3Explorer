# Architecture and conventions

- **Tauri v2 desktop app.** Rust backend in `src-tauri/`, React 19 + TypeScript + Vite frontend
  in `src/`. One native executable per OS; the UI runs in the OS webview (WebView2 / WebKit).
- **Contract first.** `docs/CONTRACT.md` is the spec for every command, type and event.
  `src/lib/types.ts` is its TypeScript mirror. Change the contract before changing either side.
  The orchestrator (main session) owns contract changes, not subagents.
- **Serialization.** Every Rust struct/enum crossing the bridge uses
  `#[serde(rename_all = "camelCase")]`. Command args are snake_case in Rust and camelCase in JS.
  Errors are `AppError { code, message }`.
- **Single invoke site.** `src/lib/api.ts` is the only file that calls Tauri `invoke`/`listen`.
  `src/lib/mock.ts` backs it when `window.__TAURI_INTERNALS__` is absent, so plain `npm run dev`
  in a browser works for UI development.
- **Transfers are backend-owned.** Downloads/uploads run on the Rust side with parallel ranged
  GETs / multipart parts and report through the `transfer:progress` event. The frontend only
  starts, cancels and displays them.
- **Performance is a feature.** Virtualize long lists, never block the UI thread, keep progress
  events from re-rendering the object table, stream file IO on the Rust side.
- **Credentials.** Real AWS profiles in `~/.aws` belong to the user. Never use them in automated
  tests. Test against a local SeaweedFS S3 server (see the `smoke-test` skill); MinIO downloads are gone.
