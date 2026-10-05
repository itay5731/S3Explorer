//! Live checks for `check_for_update` / `install_update`, driven through a mock-runtime Tauri app
//! with the real updater plugin and the real public key from `tauri.conf.json`.
//!
//! 1. Real repository (read-only): the plugin's `latest.json` endpoint, then the GitHub API
//!    fallback. Nothing is downloaded or installed.
//! 2. A local HTTP server serving a hand-written `latest.json` (newer version, FAKE signature) and
//!    a garbage "package". The plugin must report `available: true, canInstall: true`; an install
//!    attempt must FAIL signature verification. Installing is impossible: the package is garbage,
//!    the signature check runs before any install step, and the restart hook panics if reached.
//!
//! The endpoint override is a parameter of `updates::check` used only here; the app always uses
//! the endpoints from `tauri.conf.json`.
//!
//! Run: `cargo run --example updater_check`

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use s3explorer_lib::error::ErrorCode;
use s3explorer_lib::updates::{self, Sources, UpdatePhase, UpdateProgress, UpdaterState};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn check(cond: bool, what: &str) -> Res<()> {
    if cond {
        println!("  ok  {what}");
        Ok(())
    } else {
        Err(format!("FAILED: {what}").into())
    }
}

/// The updater section of the real `tauri.conf.json`.
fn real_updater_config() -> serde_json::Value {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json is JSON");
    conf["plugins"]["updater"].clone()
}

fn mock_app(version: &str) -> tauri::App<tauri::test::MockRuntime> {
    let mut ctx = mock_context(noop_assets());
    ctx.config_mut().plugins.0.insert("updater".into(), real_updater_config());
    ctx.package_info_mut().version = version.parse().expect("version");
    mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(ctx).expect("mock app")
}

/// A syntactically valid minisign signature (right key id, prehashed algorithm) whose signature
/// bytes are junk, so verification reaches the actual Ed25519 check and fails there.
fn fake_signature(pubkey_b64: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let pub_text = String::from_utf8(b64.decode(pubkey_b64).expect("pubkey b64")).expect("pubkey utf8");
    let key_line = pub_text.lines().nth(1).expect("key line");
    let key = b64.decode(key_line).expect("key b64");
    let mut bin1 = vec![b'E', b'D'];
    bin1.extend_from_slice(&key[2..10]);
    bin1.extend_from_slice(&[0x5a; 64]);
    let sig = format!(
        "untrusted comment: signature from tauri secret key\n{}\ntrusted comment: timestamp:1700000000\tfile:fake.zip\n{}\n",
        b64.encode(&bin1),
        b64.encode([0x33u8; 64])
    );
    b64.encode(sig)
}

/// Minimal HTTP/1.1 server on a free port: `/latest.json` -> `manifest(port)`, `/pkg` -> garbage
/// bytes (counted in `pkg_hits`), anything else -> 404.
async fn serve(manifest: impl FnOnce(u16) -> String, pkg_hits: Arc<AtomicUsize>) -> Res<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let manifest = manifest(port);
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let manifest = manifest.clone();
            let pkg_hits = pkg_hits.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, ctype, body): (&str, &str, Vec<u8>) = match path.as_str() {
                    "/latest.json" => ("200 OK", "application/json", manifest.into_bytes()),
                    "/pkg" => {
                        pkg_hits.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", "application/octet-stream", vec![0xAB; 300_000])
                    }
                    _ => ("404 Not Found", "text/plain", b"not found".to_vec()),
                };
                let head = format!(
                    "HTTP/1.1 {status}
Content-Type: {ctype}
Content-Length: {}
Connection: close

",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    Ok(port)
}

fn main() {
    // The mock app must be built on the main thread; async work runs on Tauri's runtime.
    let app = mock_app("0.2.0");
    let result = tauri::async_runtime::block_on(async move { run(app.handle(), app.handle()).await });
    match result {
        Ok(()) => println!("UPDATER CHECKS PASSED"),
        Err(e) => {
            eprintln!("{e}");
            eprintln!("UPDATER CHECKS FAILED");
            std::process::exit(1)
        }
    }
}

async fn run(
    real: &tauri::AppHandle<tauri::test::MockRuntime>,
    local: &tauri::AppHandle<tauri::test::MockRuntime>,
) -> Res<()> {
    println!("1. real repository (read-only), running version 0.2.0");
    let state = UpdaterState::default();
    let info = updates::check(real, &state, &Sources::default()).await?;
    println!("  {info:?}");
    check(info.current_version == "0.2.0", "currentVersion filled")?;
    check(!info.available, "v0.2.0 is the latest release: available false")?;
    check(info.latest_version.as_deref() == Some("0.2.0"), "latestVersion 0.2.0 (from the GitHub API fallback)")?;
    check(!info.can_install, "canInstall false (no latest.json)")?;
    check(info.download_url.starts_with(updates::ALLOWED_URL_PREFIX), "downloadUrl on the allow-list")?;
    let e = updates::install(&state, || (false, false), |_| {}, || panic!("must not restart"))
        .await
        .expect_err("nothing installable");
    check(e.code == ErrorCode::InvalidInput && e.message == updates::msg::NO_UPDATE, "install refused: no update")?;

    println!("2. local manifest with a newer version and a FAKE signature");
    let pubkey = real_updater_config()["pubkey"].as_str().expect("pubkey").to_string();
    let hits = Arc::new(AtomicUsize::new(0));
    let manifest_for = |port: u16| {
        let platform = serde_json::json!({ "url": format!("http://127.0.0.1:{port}/pkg"), "signature": fake_signature(&pubkey) });
        serde_json::json!({
            "version": "99.0.0",
            "notes": "Fake release for the updater check",
            "pub_date": "2026-10-01T09:30:00Z",
            "platforms": {
                "windows-x86_64": platform, "windows-x86_64-nsis": platform, "windows-x86_64-msi": platform,
                "darwin-aarch64": platform, "darwin-x86_64": platform,
                "linux-x86_64": platform, "linux-x86_64-appimage": platform, "linux-x86_64-deb": platform
            }
        })
        .to_string()
    };
    let port = serve(manifest_for, hits.clone()).await?;
    let endpoint: Url = format!("http://127.0.0.1:{port}/latest.json").parse()?;
    let sources = Sources { manifest: Some(vec![endpoint]), ..Sources::default() };

    let state = UpdaterState::default();
    let info = updates::check(local, &state, &sources).await?;
    println!("  {info:?}");
    check(info.available && info.can_install, "plugin path: available true, canInstall true")?;
    check(info.latest_version.as_deref() == Some("99.0.0"), "latestVersion from the manifest")?;
    check(info.notes.as_deref() == Some("Fake release for the updater check"), "notes from the manifest")?;
    check(info.published_at.as_deref() == Some("2026-10-01T09:30:00Z"), "publishedAt from pub_date")?;

    // Guard: refused while a transfer / a job is active, before any download.
    let e = updates::install(&state, || (true, false), |_| {}, || panic!("must not restart")).await.expect_err("busy");
    check(e.code == ErrorCode::InvalidInput && e.message.contains("Transfers"), "refused while transfers run")?;
    let e = updates::install(&state, || (false, true), |_| {}, || panic!("must not restart")).await.expect_err("busy");
    check(e.code == ErrorCode::InvalidInput && e.message.contains("operations"), "refused while jobs run")?;
    check(hits.load(Ordering::SeqCst) == 0, "nothing downloaded while refused")?;

    // Install attempt: must fail signature verification; never installs, never restarts.
    let events: Arc<Mutex<Vec<UpdateProgress>>> = Arc::default();
    let ev = events.clone();
    let e = updates::install(&state, || (false, false), move |p| ev.lock().expect("lock").push(p), || {
        panic!("restart reached: install must have failed")
    })
    .await
    .expect_err("fake signature must be rejected");
    println!("  install error: {:?} {}", e.code, e.message);
    check(e.message == updates::msg::BAD_SIGNATURE, "install failed signature verification")?;
    check(hits.load(Ordering::SeqCst) == 1, "the (garbage) package was downloaded once")?;
    let phases: Vec<UpdatePhase> = events.lock().expect("lock").iter().map(|p| p.phase).collect();
    println!("  phases: {phases:?}");
    check(phases.iter().all(|p| *p == UpdatePhase::Downloading), "never reached installing/restarting")?;
    let last = events.lock().expect("lock").last().cloned();
    check(last.is_some_and(|p| p.downloaded_bytes == 300_000), "download progress reported")?;

    // A manifest that is not newer: plugin says up to date (no fallback needed).
    let older = serde_json::json!({
        "version": "0.1.0", "platforms": { "windows-x86_64": { "url": "http://127.0.0.1:1/x", "signature": "x" },
        "linux-x86_64": { "url": "http://127.0.0.1:1/x", "signature": "x" },
        "darwin-aarch64": { "url": "http://127.0.0.1:1/x", "signature": "x" },
        "darwin-x86_64": { "url": "http://127.0.0.1:1/x", "signature": "x" } }
    })
    .to_string();
    let p2 = serve(move |_| older, Arc::default()).await?;
    let sources = Sources { manifest: Some(vec![format!("http://127.0.0.1:{p2}/latest.json").parse()?]), ..Sources::default() };
    let info = updates::check(local, &state, &sources).await?;
    check(!info.available && info.latest_version.as_deref() == Some("0.1.0"), "older manifest: not available")?;
    let e = updates::install(&state, || (false, false), |_| {}, || panic!("must not restart")).await.expect_err("none");
    check(e.message == updates::msg::NO_UPDATE, "a later check clears the pending update")?;
    Ok(())
}
