---
name: fanout
description: Template for the orchestrator to spawn parallel Opus implementation agents (backend, frontend, review) with disjoint file ownership and a defined verification gate. Use when a feature touches both src-tauri and src, or when work can be split across agents.
---

# Fan out work to Opus agents

Before spawning, the orchestrator does the contract work itself: update `docs/CONTRACT.md` and
`src/lib/types.ts`, then spawn. Agents never edit those files.

Spawn each agent with `Agent` (`subagent_type: general-purpose`, `model: opus`,
`run_in_background: true`), all in one message so they run concurrently. Every prompt contains
these sections:

1. **Role and goal** in one paragraph.
2. **Read first**: `docs/CONTRACT.md`, `src/lib/types.ts`, and the rules under `.claude/rules/`
   that apply (they load automatically, but say which matter).
3. **Own / do not touch**: explicit path lists. Standard split:
   - backend → owns `src-tauri/**` (except `tauri.conf.json` bundle/icon sections)
   - frontend → owns `src/**`, `index.html`, `package.json` (deps only), `vite.config.ts`,
     `tsconfig*.json`, `public/**`
   - review → owns nothing; reports findings only
4. **Scope**: numbered list of exactly what to build. Point at `.claude/rules/scope.md`.
5. **Definition of done**: the commands they must run and have pass before reporting
   (`cargo check`/`clippy` or `npm run build`; browser click-through via Chrome tools for UI;
   MinIO smoke test for backend). Remind them: one cargo process at a time.
6. **Report back format**: files touched, verification output, deviations from the contract,
   anything the other side must know.

After all agents report: run the `verify` skill yourself, then `contract-check`, then integrate
(`dev` skill end to end). Only then report to the user, honestly, with what was and was not verified.

For a bug fix in one layer, skip the fan-out and spawn a single agent with the same template.
