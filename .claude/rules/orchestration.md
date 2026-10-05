# Orchestration (how the main session runs subagents)

The main session is the orchestrator and manager. Implementation work goes to Opus subagents.

- **Disjoint ownership.** Every agent gets an explicit list of paths it owns and a list it must
  not touch. Backend agents own `src-tauri/`; frontend agents own `src/`, `index.html`,
  `package.json`, `vite.config.ts`, `tsconfig*.json`, `public/`. Nobody but the orchestrator
  edits `docs/CONTRACT.md`, `src/lib/types.ts`, `CLAUDE.md` or `.claude/`.
- **One Rust compiler at a time.** Only one agent may run cargo at once (target-dir lock).
- **Point at files, do not paste.** Prompts reference `docs/CONTRACT.md` and the rules; the
  agent reads them. Keeps prompts short and the contract authoritative.
- **Define done.** Every prompt states the verification the agent must run before reporting
  (`cargo check`/`clippy`, `npm run build`, browser click-through with the Chrome tools, MinIO
  smoke test). Agents report: files touched, verification output, deviations from the contract.
- **Trust but verify.** After an agent reports, the orchestrator re-runs the gate itself
  (see the `verify` skill) before telling the user anything is done.
- **Report honestly.** If verification failed or was skipped, say so with the output.
- **Parallelize when independent.** Backend and frontend run concurrently against the
  contract. Integration (running `npm run tauri dev`, release build) happens after both report.
- **Scratch files** go in the session scratchpad directory, never in the repo.
