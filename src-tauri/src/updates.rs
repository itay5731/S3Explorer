//! Update checks and installation (contract: "Updates").
//!
//! `check_for_update` asks the Tauri updater plugin first (signed `latest.json` on the latest
//! GitHub release). When that manifest is missing, unreachable or has no entry for this platform,
//! it falls back to the GitHub REST API and reports the release with `canInstall: false` and a
//! download page. `install_update` only installs an update the plugin found, and the plugin
//! verifies the package signature against the public key in `tauri.conf.json` before installing
//! (always on; nothing here can skip it).
//!
//! The pure parts (version comparison, GitHub JSON, URL allow-list, install guard) are free of
//! Tauri and unit-tested; the plugin glue is generic over the runtime so a mock-runtime app can
//! drive it (`examples/updater_check.rs`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, AppResult, ErrorCode};

pub const UPDATE_PROGRESS_EVENT: &str = "update:progress";
/// Signed update manifest (also configured in `tauri.conf.json`, `plugins.updater.endpoints`).
pub const MANIFEST_URL: &str = "https://github.com/yonatand/S3Explorer/releases/latest/download/latest.json";
pub const GITHUB_LATEST_API: &str = "https://api.github.com/repos/yonatand/S3Explorer/releases/latest";
pub const RELEASES_URL: &str = "https://github.com/yonatand/S3Explorer/releases/latest";
/// Only release pages under this prefix are handed to the frontend (the opener scope matches it).
pub const ALLOWED_URL_PREFIX: &str = "https://github.com/yonatand/S3Explorer/";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

pub mod msg {
    pub const NO_UPDATE: &str = "No installable update is known. Check for updates first.";
    pub const TRANSFERS_RUNNING: &str =
        "Transfers are still running. Wait for them to finish or cancel them, then install the update.";
    pub const JOBS_RUNNING: &str =
        "File operations are still running. Wait for them to finish or cancel them, then install the update.";
    pub const ALREADY_INSTALLING: &str = "The update is already being installed.";
    pub const RATE_LIMITED: &str =
        "GitHub is limiting update checks from this network right now. Try again in a few minutes.";
    pub const BAD_SIGNATURE: &str =
        "The downloaded update failed signature verification, so it was not installed.";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub available: bool,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub can_install: bool,
    pub download_url: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    Downloading,
    Installing,
    Restarting,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub phase: UpdatePhase,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

// ---- pure helpers ------------------------------------------------------------------------------

/// Parses a release tag (`v1.2.3`, `1.2.3`, surrounding spaces ok). `None` when malformed.
pub fn parse_tag(tag: &str) -> Option<Version> {
    let t = tag.trim();
    let t = t.strip_prefix(['v', 'V']).unwrap_or(t);
    Version::parse(t).ok()
}

/// `url` if it is a page of this project on github.com, otherwise the fixed releases page.
pub fn allowed_download_url(url: Option<&str>) -> String {
    match url {
        Some(u)
            if u.starts_with(ALLOWED_URL_PREFIX)
                && !u.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') =>
        {
            u.to_string()
        }
        _ => RELEASES_URL.to_string(),
    }
}

/// The subset of the GitHub "release" object we use.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GithubRelease {
    #[serde(default)]
    pub tag_name: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub html_url: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
}

pub fn parse_github_release(json: &[u8]) -> AppResult<GithubRelease> {
    serde_json::from_slice(json)
        .map_err(|_| AppError::new(ErrorCode::Network, "GitHub returned an unexpected response to the update check."))
}

fn no_update(current: &Version) -> UpdateInfo {
    UpdateInfo {
        current_version: current.to_string(),
        available: false,
        latest_version: None,
        notes: None,
        published_at: None,
        can_install: false,
        download_url: RELEASES_URL.to_string(),
    }
}

/// Turns the GitHub "latest release" into an `UpdateInfo` (never installable: there is no signed
/// package for this platform, otherwise the plugin would have found it). Drafts, pre-releases and
/// malformed tags are never offered.
pub fn evaluate_github_release(rel: &GithubRelease, current: &Version) -> UpdateInfo {
    if rel.draft || rel.prerelease {
        return no_update(current);
    }
    let Some(latest) = parse_tag(&rel.tag_name) else { return no_update(current) };
    if !latest.pre.is_empty() {
        return no_update(current);
    }
    UpdateInfo {
        current_version: current.to_string(),
        available: latest > *current,
        latest_version: Some(latest.to_string()),
        notes: rel.body.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string),
        published_at: rel.published_at.clone(),
        can_install: false,
        download_url: allowed_download_url(rel.html_url.as_deref()),
    }
}

/// Why installing must wait, if anything is still running.
pub fn install_blocker(transfers_active: bool, jobs_active: bool) -> Option<AppError> {
    if transfers_active {
        Some(AppError::invalid(msg::TRANSFERS_RUNNING))
    } else if jobs_active {
        Some(AppError::invalid(msg::JOBS_RUNNING))
    } else {
        None
    }
}

// ---- GitHub fallback ---------------------------------------------------------------------------

/// The plugin and reqwest use rustls with the `ring` provider; make sure one is installed
/// before building a client (the updater plugin does the same).
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

fn network_error(e: &reqwest::Error) -> AppError {
    let what = if e.is_timeout() {
        "the request timed out".to_string()
    } else if e.is_connect() {
        "could not connect".to_string()
    } else {
        "the request failed".to_string()
    };
    AppError::new(ErrorCode::Network, format!("Couldn't reach GitHub to check for updates: {what}."))
}

/// `GET {api_url}` (GitHub "latest release"), HTTPS only, 10 s timeout, no auth.
pub async fn github_latest(api_url: &str, current: &Version) -> AppResult<UpdateInfo> {
    ensure_crypto_provider();
    let client = reqwest::Client::builder()
        .user_agent(format!("S3Explorer/{current} (+https://github.com/yonatand/S3Explorer)"))
        .timeout(HTTP_TIMEOUT)
        .https_only(true)
        .build()
        .map_err(|e| AppError::new(ErrorCode::Unknown, format!("Could not start the update check: {e}")))?;
    let res = client
        .get(api_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| network_error(&e))?;
    let status = res.status().as_u16();
    match status {
        200 => {}
        // No published release at all.
        404 => return Ok(no_update(current)),
        403 | 429 => return Err(AppError::new(ErrorCode::Network, msg::RATE_LIMITED)),
        s => {
            return Err(AppError::new(
                ErrorCode::Network,
                format!("GitHub returned HTTP {s} while checking for updates. Try again later."),
            ))
        }
    }
    let body = res.bytes().await.map_err(|e| network_error(&e))?;
    Ok(evaluate_github_release(&parse_github_release(&body)?, current))
}

// ---- plugin glue -------------------------------------------------------------------------------

/// Where to look (overridable only by test code; the app always uses [`Sources::default`]).
#[derive(Debug, Clone)]
pub struct Sources {
    /// `None` = the endpoints from `tauri.conf.json`.
    pub manifest: Option<Vec<Url>>,
    pub github_api: String,
}

impl Default for Sources {
    fn default() -> Self {
        Self { manifest: None, github_api: GITHUB_LATEST_API.to_string() }
    }
}

/// Managed state: the update found by the last check (installable) and an install-in-progress flag.
#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<Update>>,
    installing: std::sync::atomic::AtomicBool,
}

impl UpdaterState {
    fn set_pending(&self, u: Option<Update>) {
        *self.pending.lock().unwrap_or_else(|p| p.into_inner()) = u;
    }
    fn pending(&self) -> Option<Update> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

fn rfc3339(d: &tauri_plugin_updater::Update) -> Option<String> {
    let dt = d.date?;
    chrono::DateTime::from_timestamp(dt.unix_timestamp(), dt.nanosecond())
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Outcome of asking the updater plugin.
enum PluginCheck {
    /// A newer, installable release.
    Available(Box<Update>),
    /// The manifest has an entry for this platform and it is not newer.
    UpToDate { latest: Version },
    /// Missing manifest, no entry for this platform, unreachable, ...: use the GitHub fallback.
    Unusable,
}

async fn plugin_check<R: Runtime>(app: &AppHandle<R>, sources: &Sources) -> PluginCheck {
    ensure_crypto_provider();
    let seen: Arc<Mutex<Option<Version>>> = Arc::default();
    let seen_cb = seen.clone();
    let mut builder = app.updater_builder().timeout(HTTP_TIMEOUT).version_comparator(move |current, release| {
        *seen_cb.lock().unwrap_or_else(|p| p.into_inner()) = Some(release.version.clone());
        // Pre-releases are never offered, even if a manifest announced one.
        release.version.pre.is_empty() && release.version > current
    });
    if let Some(eps) = &sources.manifest {
        builder = match builder.endpoints(eps.clone()) {
            Ok(b) => b,
            Err(_) => return PluginCheck::Unusable,
        };
    }
    let Ok(updater) = builder.build() else { return PluginCheck::Unusable };
    match updater.check().await {
        Ok(Some(update)) => PluginCheck::Available(Box::new(update)),
        Ok(None) => match seen.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            Some(latest) => PluginCheck::UpToDate { latest },
            None => PluginCheck::Unusable,
        },
        Err(_) => PluginCheck::Unusable,
    }
}

/// `check_for_update`, with injectable sources (the command passes [`Sources::default`]).
pub async fn check<R: Runtime>(app: &AppHandle<R>, state: &UpdaterState, sources: &Sources) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.clone();
    match plugin_check(app, sources).await {
        PluginCheck::Available(update) => {
            let info = UpdateInfo {
                current_version: current.to_string(),
                available: true,
                latest_version: Some(update.version.clone()),
                notes: update.body.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string),
                published_at: rfc3339(&update),
                can_install: true,
                download_url: RELEASES_URL.to_string(),
            };
            state.set_pending(Some(*update));
            Ok(info)
        }
        PluginCheck::UpToDate { latest } => {
            state.set_pending(None);
            Ok(UpdateInfo { latest_version: Some(latest.to_string()), ..no_update(&current) })
        }
        PluginCheck::Unusable => {
            state.set_pending(None);
            github_latest(&sources.github_api, &current).await
        }
    }
}

/// Maps an updater plugin error from download/verify/install to a user-readable `AppError`.
fn install_error(e: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => AppError::new(ErrorCode::Unknown, msg::BAD_SIGNATURE),
        E::Reqwest(_) | E::Network(_) => {
            AppError::new(ErrorCode::Network, "The update could not be downloaded. Check your connection and try again.")
        }
        E::Io(io) => AppError::new(ErrorCode::Io, format!("The update could not be installed: {io}")),
        other => AppError::new(ErrorCode::Unknown, format!("The update could not be installed: {other}")),
    }
}

/// Clears the installing flag on every exit path.
struct InstallingGuard<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for InstallingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// `install_update`: downloads (progress throttled to 100 ms), verifies the signature (inside the
/// plugin, before anything is installed), installs, then restarts via `restart`.
/// `busy` reports whether transfers / jobs are active; it is checked before the download and again
/// right before installing.
///
/// On Windows the plugin launches the installer and exits the app from inside `install`, so the
/// last event seen there is `installing`; the installer restarts the app.
pub async fn install(
    state: &UpdaterState,
    busy: impl Fn() -> (bool, bool),
    emit: impl Fn(UpdateProgress),
    restart: impl FnOnce(),
) -> AppResult<()> {
    let Some(update) = state.pending() else { return Err(AppError::invalid(msg::NO_UPDATE)) };
    let (t, j) = busy();
    if let Some(e) = install_blocker(t, j) {
        return Err(e);
    }
    if state.installing.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err(AppError::invalid(msg::ALREADY_INSTALLING));
    }
    let _guard = InstallingGuard(&state.installing);

    // Shared by the chunk and finish callbacks (atomics keep the future `Send`).
    let downloaded = AtomicU64::new(0);
    let total: Mutex<Option<u64>> = Mutex::new(None);
    let last = Mutex::new(Instant::now());
    let snapshot = || UpdateProgress {
        phase: UpdatePhase::Downloading,
        downloaded_bytes: downloaded.load(Ordering::SeqCst),
        total_bytes: *total.lock().unwrap_or_else(|p| p.into_inner()),
    };
    emit(snapshot());
    // `download` verifies the signature against the configured public key after the last chunk
    // and fails (nothing is installed) when it does not match.
    let bytes = update
        .download(
            |chunk, len| {
                downloaded.fetch_add(chunk as u64, Ordering::SeqCst);
                *total.lock().unwrap_or_else(|p| p.into_inner()) = len;
                let mut last = last.lock().unwrap_or_else(|p| p.into_inner());
                if last.elapsed() >= Duration::from_millis(100) {
                    *last = Instant::now();
                    emit(snapshot());
                }
            },
            || emit(snapshot()),
        )
        .await
        .map_err(install_error)?;
    let size = bytes.len() as u64;

    let (t, j) = busy();
    if let Some(e) = install_blocker(t, j) {
        return Err(e);
    }
    emit(UpdateProgress { phase: UpdatePhase::Installing, downloaded_bytes: size, total_bytes: Some(size) });
    let to_install = update.clone();
    tokio::task::spawn_blocking(move || to_install.install(bytes)).await?.map_err(install_error)?;
    emit(UpdateProgress { phase: UpdatePhase::Restarting, downloaded_bytes: size, total_bytes: Some(size) });
    restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).expect("version")
    }

    fn rel(tag: &str) -> GithubRelease {
        GithubRelease {
            tag_name: tag.into(),
            body: Some("## Changes\n- things\n".into()),
            html_url: Some(format!("https://github.com/yonatand/S3Explorer/releases/tag/{tag}")),
            published_at: Some("2026-09-30T12:00:00Z".into()),
            draft: false,
            prerelease: false,
        }
    }

    #[test]
    fn tag_parsing() {
        assert_eq!(parse_tag("v0.3.0"), Some(v("0.3.0")));
        assert_eq!(parse_tag("0.3.0"), Some(v("0.3.0")));
        assert_eq!(parse_tag(" V1.2.3 "), Some(v("1.2.3")));
        assert_eq!(parse_tag("v0.3.0-rc.1"), Some(v("0.3.0-rc.1")));
        for bad in ["", "v", "latest", "v1.2", "1.2.3.4", "vv1.2.3", "release-1.2.3", "v01.2.3"] {
            assert_eq!(parse_tag(bad), None, "{bad}");
        }
    }

    #[test]
    fn version_comparison() {
        let cur = v("0.2.0");
        let check = |tag: &str| evaluate_github_release(&rel(tag), &cur);
        // Equal.
        let eq = check("v0.2.0");
        assert!(!eq.available);
        assert_eq!(eq.latest_version.as_deref(), Some("0.2.0"));
        // Older.
        assert!(!check("v0.1.9").available);
        // Newer, with and without the v prefix.
        for tag in ["v0.3.0", "0.3.0", "v0.10.0", "v1.0.0"] {
            let i = check(tag);
            assert!(i.available, "{tag}");
            assert!(!i.can_install);
            assert_eq!(i.current_version, "0.2.0");
        }
        // Semver, not string, comparison: 0.10.0 > 0.9.0.
        assert!(evaluate_github_release(&rel("v0.10.0"), &v("0.9.0")).available);
        // Pre-release tags are never offered, even if newer.
        let pre = check("v0.3.0-rc.1");
        assert!(!pre.available);
        assert_eq!(pre.latest_version, None);
        // Releases flagged pre-release / draft are never offered.
        assert!(!evaluate_github_release(&GithubRelease { prerelease: true, ..rel("v0.3.0") }, &cur).available);
        assert!(!evaluate_github_release(&GithubRelease { draft: true, ..rel("v0.3.0") }, &cur).available);
        // Malformed tag: no update, not an error.
        let bad = check("nightly");
        assert!(!bad.available);
        assert_eq!(bad.latest_version, None);
        assert_eq!(bad.download_url, RELEASES_URL);
        // A pre-release current version updates to its final release.
        assert!(evaluate_github_release(&rel("v0.3.0"), &v("0.3.0-rc.1")).available);
    }

    #[test]
    fn github_json_parsing() {
        let json = br####"{
            "url": "https://api.github.com/repos/yonatand/S3Explorer/releases/1",
            "html_url": "https://github.com/yonatand/S3Explorer/releases/tag/v0.3.0",
            "tag_name": "v0.3.0",
            "name": "S3 Explorer 0.3.0",
            "draft": false,
            "prerelease": false,
            "published_at": "2026-10-01T09:30:00Z",
            "assets": [{"name": "x.msi", "browser_download_url": "https://example.com/x.msi"}],
            "body": "### Added\r\n- Saved connections\r\n"
        }"####;
        let r = parse_github_release(json).expect("parse");
        let i = evaluate_github_release(&r, &v("0.2.0"));
        assert_eq!(
            i,
            UpdateInfo {
                current_version: "0.2.0".into(),
                available: true,
                latest_version: Some("0.3.0".into()),
                notes: Some("### Added\r\n- Saved connections".into()),
                published_at: Some("2026-10-01T09:30:00Z".into()),
                can_install: false,
                download_url: "https://github.com/yonatand/S3Explorer/releases/tag/v0.3.0".into(),
            }
        );
        // Serialized for the frontend in camelCase.
        let js = serde_json::to_value(&i).expect("ser");
        for k in ["currentVersion", "available", "latestVersion", "notes", "publishedAt", "canInstall", "downloadUrl"] {
            assert!(js.get(k).is_some(), "{k}");
        }
        // Missing optional fields and null body.
        let r = parse_github_release(br#"{"tag_name": "v0.2.1", "body": null}"#).expect("parse");
        let i = evaluate_github_release(&r, &v("0.2.0"));
        assert!(i.available);
        assert_eq!(i.notes, None);
        assert_eq!(i.published_at, None);
        assert_eq!(i.download_url, RELEASES_URL);
        // Not JSON / wrong shape.
        assert_eq!(parse_github_release(b"<html>").expect_err("html").code, ErrorCode::Network);
        assert_eq!(parse_github_release(b"[1,2]").expect_err("array").code, ErrorCode::Network);
    }

    #[test]
    fn download_url_allow_list() {
        let ok = "https://github.com/yonatand/S3Explorer/releases/tag/v0.3.0";
        assert_eq!(allowed_download_url(Some(ok)), ok);
        for bad in [
            None,
            Some(""),
            Some("http://github.com/yonatand/S3Explorer/releases/tag/v0.3.0"),
            Some("https://github.com/yonatand/S3Explorer"),
            Some("https://github.com/yonatand/S3ExplorerEvil/releases"),
            Some("https://github.com/yonatand/s3explorer/releases/tag/v0.3.0"),
            Some("https://github.com.evil.com/yonatand/S3Explorer/x"),
            Some("https://evil.com/https://github.com/yonatand/S3Explorer/"),
            Some("javascript:alert(1)//https://github.com/yonatand/S3Explorer/"),
            Some("https://github.com/yonatand/S3Explorer/ x"),
            Some("https://github.com/yonatand/S3Explorer/\\..\\x"),
        ] {
            assert_eq!(allowed_download_url(bad), RELEASES_URL, "{bad:?}");
        }
        // A release whose html_url points elsewhere still gets the fixed releases page.
        let r = GithubRelease { html_url: Some("https://evil.example/download".into()), ..rel("v9.0.0") };
        assert_eq!(evaluate_github_release(&r, &v("0.2.0")).download_url, RELEASES_URL);
    }

    #[test]
    fn install_guard() {
        assert!(install_blocker(false, false).is_none());
        let t = install_blocker(true, false).expect("transfers");
        assert_eq!(t.code, ErrorCode::InvalidInput);
        assert!(t.message.contains("Transfers") && t.message.contains("running"), "{}", t.message);
        let j = install_blocker(false, true).expect("jobs");
        assert_eq!(j.code, ErrorCode::InvalidInput);
        assert!(j.message.contains("operations") && j.message.contains("running"), "{}", j.message);
        assert_eq!(install_blocker(true, true).expect("both").message, msg::TRANSFERS_RUNNING);
    }

    #[tokio::test]
    async fn install_without_known_update_is_refused() {
        let state = UpdaterState::default();
        let events = Mutex::new(Vec::new());
        let e = install(&state, || (false, false), |p| events.lock().expect("lock").push(p), || {})
            .await
            .expect_err("no update");
        assert_eq!(e.code, ErrorCode::InvalidInput);
        assert_eq!(e.message, msg::NO_UPDATE);
        assert!(events.lock().expect("lock").is_empty());
    }

    #[test]
    fn progress_serializes_camel_case() {
        let p = UpdateProgress { phase: UpdatePhase::Downloading, downloaded_bytes: 5, total_bytes: None };
        assert_eq!(
            serde_json::to_value(p).expect("ser"),
            serde_json::json!({"phase": "downloading", "downloadedBytes": 5, "totalBytes": null})
        );
    }
}
