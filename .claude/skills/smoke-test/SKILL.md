---
name: smoke-test
description: Integration-test the S3 backend against a local SeaweedFS S3 server (no Docker, no real AWS credentials). Use to validate list/upload/download/folder operations end to end and measure parallel transfer throughput.
---

# Local S3 smoke test (SeaweedFS)

MinIO's download server (dl.min.io) returns 410 Gone since the project was archived, and Docker
is usually not running here. Use the single-binary SeaweedFS server instead. Keep it in the
session scratchpad directory, never in the repo.

## Start SeaweedFS
```bash
SW="$(cygpath -u "$TMP")/claude/s3explorer-seaweed"; mkdir -p "$SW/swdata"
if [ ! -f "$SW/weed.exe" ]; then
  curl -sSL -o "$SW/seaweed.zip" https://github.com/seaweedfs/seaweedfs/releases/latest/download/windows_amd64.zip
  (cd "$SW" && unzip -o -q seaweed.zip)
fi
cat > "$SW/s3.json" <<'JSON'
{"identities":[{"name":"admin","credentials":[{"accessKey":"minioadmin","secretKey":"minioadmin"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON
"$SW/weed.exe" server -dir="$SW/swdata" -s3 -s3.port=8333 -s3.config="$SW/s3.json" -ip=127.0.0.1 -master.port=9333 -volume.port=8080 -filer.port=8888 -volume.max=100 -master.volumeSizeLimitMB=1024
```
Run the last line with `run_in_background: true`. On macOS/Linux use the `darwin_arm64.tar.gz`
or `linux_amd64.tar.gz` release asset and `chmod +x weed`. Ready when
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8333/` returns 403 (signed request required).

Connection for the app or tests: static credentials `minioadmin` / `minioadmin`, region
`us-east-1`, endpoint `http://127.0.0.1:8333`, force path style on.

## Run the backend smoke example
```bash
cd src-tauri && cargo run --example smoke 2>&1 | tail -40
```
Env overrides: `SMOKE_ENDPOINT` (default `http://127.0.0.1:8333`), `SMOKE_ACCESS_KEY` /
`SMOKE_SECRET_KEY` (default `minioadmin`), `SMOKE_DIR` (scratch dir), `SMOKE_BIG_MIB` (default 40).
It creates a bucket and folder, uploads a large random file (multipart path) and a tiny one
(PutObject path), lists with paging, heads, downloads (parallel ranged path) and compares
SHA-256, exercises cancel and a missing-key failure, then deletes the folder with >2,000 keys
and confirms it is empty. Record the reported MiB/s for upload and download. Reference on this
machine: 40 MiB upload ~300 MiB/s, download ~450 MiB/s; 512 MiB upload ~480 MiB/s, download ~650 MiB/s.

## SeaweedFS limitations to know
- Without `-volume.max=100 -master.volumeSizeLimitMB=1024` it runs out of volume slots and returns InternalError on larger runs.
- It normalizes keys: `a//b.txt` is stored as `a/b.txt`, `..` segments are rejected and backslashes are rewritten. Double-slash and
  path-traversal key scenarios therefore cannot be reproduced end to end here; cover them with unit tests (Rust `ops.rs`,
  TS helpers in `src/lib/format.ts`) or against real S3.
- Empty-folder cleanup is asynchronous, so a just-deleted folder can linger in a listing for a moment.
- A 64 MiB download finishes in ~150 ms locally. To test Cancel from the UI, seed a 1 GiB object.

## Driving the real app
Launch the release exe with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` and attach over the
Chrome DevTools Protocol (`http://127.0.0.1:9223/json`). Native file dialogs cannot be driven or stubbed over CDP: call
`window.__TAURI_INTERNALS__.invoke('start_upload' | 'start_download', ...)` from the page and assert on the UI.
Never use SendKeys or other OS-level input automation: keystrokes can land in whatever window the user has focused.

## Clean up
Kill the server (`TaskStop`, or `taskkill //F //IM weed.exe`). Leave the binary cached in the
scratchpad so the next run skips the download. Never commit test data.
