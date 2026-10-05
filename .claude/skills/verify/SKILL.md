---
name: verify
description: Run the full quality gate for S3 Explorer (cargo check, clippy, tsc + vite build). Use after any subagent reports completion, before telling the user something works, and before a release build.
---

# Verify gate

Run from the repo root. Stop at the first failure and fix (or route back to the owning agent).

1. Rust (only if nothing else is running cargo right now):
   ```bash
   cd src-tauri && cargo check 2>&1 | tail -30 && cargo clippy --all-targets 2>&1 | tail -40
   ```
   Expected: `Finished` with zero warnings from code under `src-tauri/src`.
2. Frontend:
   ```bash
   npm run build 2>&1 | tail -30
   ```
   Expected: tsc silent, vite prints the `dist/` bundle sizes. Flag any chunk > 600 kB.
3. Contract consistency: run the `contract-check` skill.
4. If both sides changed since the last end-to-end run, run the `dev` skill and click through
   connect → buckets → browse → upload → download → new folder → delete folder.

Report the actual command output for anything that failed. Never summarize a failure as "mostly passing".
