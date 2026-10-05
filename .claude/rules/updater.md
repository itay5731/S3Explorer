# In-app updates and the signing key

The app updates itself with the Tauri updater plugin, which installs only packages signed with this
project's updater key. Signature verification is never bypassed or made optional.

- **Public key:** embedded in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Safe to publish.
- **Private key:** on the owner's machine at `~/.tauri/s3explorer-updater.key` (no password). It must
  NEVER be committed, printed into logs, pasted into chat output, or written anywhere inside the repo.
  Losing it means already-installed copies can no longer be updated in place.
- **CI:** the release workflow signs update packages only when the repository secret
  `TAURI_SIGNING_PRIVATE_KEY` is set (its value is the content of the private key file). Without the
  secret the workflow still builds and publishes normally, just without signed update packages; the
  app then reports new versions and offers the download page instead of installing.
  Only the repository owner can add the secret (GitHub → Settings → Secrets and variables → Actions).
- **Local builds** never produce update packages (`createUpdaterArtifacts` is off by default and is
  switched on by CI), so `npm run tauri build` works without the key.
- The update manifest is `latest.json`, attached to each GitHub Release and fetched from
  `releases/latest/download/latest.json`. Pre-release tags (with a `-`, e.g. `v0.3.0-rc.1`) are
  published as GitHub pre-releases, which `releases/latest` ignores, so they never reach users.
- Update checks must never run in automated tests against the real repository in a way that installs
  anything. Never click "Install and restart" on the owner's machine from an agent.
