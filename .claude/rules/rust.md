---
paths:
  - "src-tauri/**"
---

# Rust backend rules

- Tauri 2.12, aws-sdk-s3 1.x, tokio. Deps are in `src-tauri/Cargo.toml`; crates are fetched.
- Every bridge struct/enum: `#[derive(Serialize, Deserialize)]` + `#[serde(rename_all = "camelCase")]`.
  `ConnectionConfig` is `#[serde(tag = "kind", rename_all = "camelCase")]`.
- Every command: `async`, returns `Result<T, AppError>`. No `unwrap()`/`expect()` on runtime
  fallible paths; map SDK errors to `ErrorCode` in `error.rs`.
- Never block the runtime: file IO through `tokio::fs` or `spawn_blocking`; positional writes
  for parallel downloads (`seek_write` on Windows, `write_at` on Unix).
- Keep S3 logic in plain modules that take an `aws_sdk_s3::Client` and a progress sink trait.
  The `AppHandle` dependency stays in the command layer so logic is testable without Tauri.
- Progress events: `transfer:progress`, throttled to 100 ms per transfer, always on status change.
- Validation order: `cargo check` → `cargo clippy` → (only if needed) `cargo build`.
- Windows release builds hide the console (`windows_subsystem = "windows"` in `main.rs`). Keep it.
