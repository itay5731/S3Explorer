---
name: dev
description: Launch S3 Explorer for a live check, either the full Tauri desktop app or the browser-only mock UI. Use when asked to run, start, try, or screenshot the app.
---

# Run the app

Two modes. Pick the cheapest one that answers the question.

## Browser mock mode (UI only, no Rust compile)
```bash
npm run dev
```
Open http://localhost:1420 with the Chrome tools in a NEW tab (`tabs_create_mcp`). Without
Tauri the frontend routes to `src/lib/mock.ts`: fake buckets, a 5,000-object folder, simulated
transfers. Use it for layout, interaction and performance (scroll the big folder) checks.
Check `read_console_messages` for errors. Close the tab and kill the dev server when done.

## Full desktop app (end to end against real S3-compatible storage)
```bash
npm run tauri dev
```
First run compiles the Rust side once (minutes), later runs are incremental. The window opens
by itself. To test without touching the user's AWS account, start SeaweedFS first (see the
`smoke-test` skill) and connect with static credentials + endpoint `http://127.0.0.1:8333`.

Do not run two `npm run tauri dev` or any other cargo process at the same time.
Stop the process with Ctrl-C / `TaskStop`, never by deleting build output.
