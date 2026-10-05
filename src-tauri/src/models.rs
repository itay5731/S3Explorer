//! Wire types. Mirrors `src/lib/types.ts` exactly (camelCase JSON).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub region: Option<String>,
    pub has_credentials: bool,
}

/// Connection parameters from the UI. `Debug` is implemented by hand so the secret access key
/// and session token can never end up in a log or panic message.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectionConfig {
    #[serde(rename_all = "camelCase")]
    Profile {
        profile: String,
        #[serde(default)]
        region: Option<String>,
        #[serde(default)]
        endpoint: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Static {
        access_key_id: String,
        secret_access_key: String,
        #[serde(default)]
        session_token: Option<String>,
        region: String,
        #[serde(default)]
        endpoint: Option<String>,
        #[serde(default)]
        force_path_style: Option<bool>,
    },
}

impl std::fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Profile { profile, region, endpoint } => f
                .debug_struct("Profile")
                .field("profile", profile)
                .field("region", region)
                .field("endpoint", endpoint)
                .finish(),
            Self::Static { access_key_id, secret_access_key: _, session_token, region, endpoint, force_path_style } => f
                .debug_struct("Static")
                .field("access_key_id", access_key_id)
                .field("secret_access_key", &"<redacted>")
                .field("session_token", &session_token.as_ref().map(|_| "<redacted>"))
                .field("region", region)
                .field("endpoint", endpoint)
                .field("force_path_style", force_path_style)
                .finish(),
        }
    }
}

// ---- Saved connections ---------------------------------------------------------------------

/// Longest saved-connection name, in characters after trimming (mirror `SAVED_CONNECTION_NAME_MAX`).
pub const SAVED_CONNECTION_NAME_MAX: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SavedConnectionKind {
    Profile,
    Static,
}

/// A saved connection as returned to the frontend. Never carries secret material.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub kind: SavedConnectionKind,
    pub profile: Option<String>,
    pub access_key_id: Option<String>,
    pub region: Option<String>,
    pub endpoint: Option<String>,
    pub force_path_style: bool,
    pub has_secret: bool,
    pub last_used_at: Option<String>,
}

/// `save_connection` argument. `config` may carry a secret, so `Debug` goes through
/// [`ConnectionConfig`]'s redacting implementation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub config: ConnectionConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub label: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub can_list_buckets: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub name: String,
    pub creation_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub prefix: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEntry {
    pub key: String,
    pub name: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPage {
    pub folders: Vec<FolderEntry>,
    pub objects: Vec<ObjectEntry>,
    pub next_continuation_token: Option<String>,
    pub is_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMeta {
    pub key: String,
    pub name: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
    pub content_type: Option<String>,
    pub metadata: HashMap<String, String>,
    pub version_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferKind {
    Download,
    Upload,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl TransferStatus {
    pub fn is_active(self) -> bool {
        matches!(self, TransferStatus::Queued | TransferStatus::Running)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub kind: TransferKind,
    pub bucket: String,
    pub key: String,
    pub local_path: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub parts_total: u32,
    pub parts_done: u32,
    pub bytes_per_sec: u64,
    pub status: TransferStatus,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

pub const TRANSFER_PROGRESS_EVENT: &str = "transfer:progress";

/// Inclusive limits for the transfer fields of [`AppSettings`] (mirror `TRANSFER_SETTINGS_LIMITS` in `types.ts`).
pub const PART_SIZE_MIB_MIN: u32 = 1;
pub const PART_SIZE_MIB_MAX: u32 = 256;
pub const MAX_CONCURRENT_PARTS_MIN: u32 = 1;
pub const MAX_CONCURRENT_PARTS_MAX: u32 = 32;
pub const MAX_CONCURRENT_TRANSFERS_MIN: u32 = 1;
pub const MAX_CONCURRENT_TRANSFERS_MAX: u32 = 10;
/// Defaults (mirror `DEFAULT_APP_SETTINGS` in `types.ts`).
pub const DEFAULT_MAX_CONCURRENT_PARTS: u32 = 8;
pub const DEFAULT_MAX_CONCURRENT_TRANSFERS: u32 = 4;

/// UI color theme. `System` follows the OS (`prefers-color-scheme`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemeMode {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "system" => Some(Self::System),
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }
}

/// User settings (flat object, `AppSettings` in `types.ts`). `part_size_mib: None` means Auto.
///
/// Parsing goes through [`AppSettings::from_json_lenient`] (the on-disk file) or
/// [`AppSettings::from_json_strict`] (the `update_settings` argument); range checks are done by
/// [`AppSettings::validate`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub part_size_mib: Option<u32>,
    #[serde(default = "default_max_concurrent_parts")]
    pub max_concurrent_parts: u32,
    #[serde(default = "default_max_concurrent_transfers")]
    pub max_concurrent_transfers: u32,
    #[serde(default)]
    pub theme: ThemeMode,
    #[serde(default)]
    pub check_updates_on_startup: bool,
}

/// v0.2.0 name of the settings type; the transfer code only reads the transfer fields.
pub type TransferSettings = AppSettings;

fn default_max_concurrent_parts() -> u32 {
    DEFAULT_MAX_CONCURRENT_PARTS
}

fn default_max_concurrent_transfers() -> u32 {
    DEFAULT_MAX_CONCURRENT_TRANSFERS
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            part_size_mib: None,
            max_concurrent_parts: DEFAULT_MAX_CONCURRENT_PARTS,
            max_concurrent_transfers: DEFAULT_MAX_CONCURRENT_TRANSFERS,
            theme: ThemeMode::System,
            check_updates_on_startup: false,
        }
    }
}

fn part_size_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "partSizeMib must be an integer from {PART_SIZE_MIB_MIN} to {PART_SIZE_MIB_MAX}, or null for Auto"
    ))
}

fn parts_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "maxConcurrentParts must be an integer from {MAX_CONCURRENT_PARTS_MIN} to {MAX_CONCURRENT_PARTS_MAX}"
    ))
}

fn transfers_error() -> crate::error::AppError {
    crate::error::AppError::invalid(format!(
        "maxConcurrentTransfers must be an integer from {MAX_CONCURRENT_TRANSFERS_MIN} to {MAX_CONCURRENT_TRANSFERS_MAX}"
    ))
}

fn theme_error() -> crate::error::AppError {
    crate::error::AppError::invalid(r#"theme must be "system", "light" or "dark""#)
}

fn check_updates_error() -> crate::error::AppError {
    crate::error::AppError::invalid("checkUpdatesOnStartup must be true or false")
}

fn part_size_ok(v: Option<u32>) -> bool {
    v.is_none_or(|v| (PART_SIZE_MIB_MIN..=PART_SIZE_MIB_MAX).contains(&v))
}

fn parts_ok(v: u32) -> bool {
    (MAX_CONCURRENT_PARTS_MIN..=MAX_CONCURRENT_PARTS_MAX).contains(&v)
}

fn transfers_ok(v: u32) -> bool {
    (MAX_CONCURRENT_TRANSFERS_MIN..=MAX_CONCURRENT_TRANSFERS_MAX).contains(&v)
}

/// A JSON value as a `u32`, only if it is a non-negative integer that fits.
fn json_u32(v: &serde_json::Value) -> Option<u32> {
    v.as_u64().and_then(|n| u32::try_from(n).ok())
}

impl AppSettings {
    /// Rejects (`InvalidInput`, naming the field and its range) the first out-of-range field.
    /// `theme` and `checkUpdatesOnStartup` are valid by construction.
    pub fn validate(&self) -> crate::error::AppResult<()> {
        if !part_size_ok(self.part_size_mib) {
            return Err(part_size_error());
        }
        if !parts_ok(self.max_concurrent_parts) {
            return Err(parts_error());
        }
        if !transfers_ok(self.max_concurrent_transfers) {
            return Err(transfers_error());
        }
        Ok(())
    }

    /// Replaces each out-of-range field with its default.
    pub fn sanitized(self) -> Self {
        let d = Self::default();
        Self {
            part_size_mib: if part_size_ok(self.part_size_mib) { self.part_size_mib } else { d.part_size_mib },
            max_concurrent_parts: if parts_ok(self.max_concurrent_parts) {
                self.max_concurrent_parts
            } else {
                d.max_concurrent_parts
            },
            max_concurrent_transfers: if transfers_ok(self.max_concurrent_transfers) {
                self.max_concurrent_transfers
            } else {
                d.max_concurrent_transfers
            },
            ..self
        }
    }

    /// Lenient parse of the on-disk file: never fails. A value that is not an object yields the
    /// defaults; each field that is missing, of the wrong type, unknown (`theme`) or out of range
    /// takes its default on its own, so one bad field never resets the others. Unknown fields are
    /// ignored (forward compatible; a v0.2.0 file with three fields loads with the new ones at
    /// their defaults).
    pub fn from_json_lenient(v: &serde_json::Value) -> Self {
        let d = Self::default();
        let Some(obj) = v.as_object() else { return d };
        let part_size_mib = match obj.get("partSizeMib") {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => json_u32(v).filter(|n| part_size_ok(Some(*n))),
        };
        Self {
            part_size_mib,
            max_concurrent_parts: obj
                .get("maxConcurrentParts")
                .and_then(json_u32)
                .filter(|n| parts_ok(*n))
                .unwrap_or(d.max_concurrent_parts),
            max_concurrent_transfers: obj
                .get("maxConcurrentTransfers")
                .and_then(json_u32)
                .filter(|n| transfers_ok(*n))
                .unwrap_or(d.max_concurrent_transfers),
            theme: obj.get("theme").and_then(serde_json::Value::as_str).and_then(ThemeMode::parse).unwrap_or(d.theme),
            check_updates_on_startup: obj
                .get("checkUpdatesOnStartup")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(d.check_updates_on_startup),
        }
    }

    /// Strict parse of the `update_settings` argument: all five fields must be present. Transfer
    /// fields must be in-range integers (`partSizeMib` may be `null`); `theme` one of the three
    /// modes; `checkUpdatesOnStartup` a boolean. Anything else is `InvalidInput` naming the field.
    /// Unknown fields are ignored.
    pub fn from_json_strict(v: &serde_json::Value) -> crate::error::AppResult<Self> {
        let obj = v.as_object().ok_or_else(|| crate::error::AppError::invalid("settings must be an object"))?;
        let int = |name: &str, err: fn() -> crate::error::AppError| -> crate::error::AppResult<u32> {
            obj.get(name).and_then(json_u32).ok_or_else(err)
        };
        let part_size_mib = match obj.get("partSizeMib") {
            Some(serde_json::Value::Null) => None,
            Some(_) => Some(int("partSizeMib", part_size_error)?),
            None => return Err(part_size_error()),
        };
        let s = Self {
            part_size_mib,
            max_concurrent_parts: int("maxConcurrentParts", parts_error)?,
            max_concurrent_transfers: int("maxConcurrentTransfers", transfers_error)?,
            theme: obj
                .get("theme")
                .and_then(serde_json::Value::as_str)
                .and_then(ThemeMode::parse)
                .ok_or_else(theme_error)?,
            check_updates_on_startup: obj
                .get("checkUpdatesOnStartup")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(check_updates_error)?,
        };
        s.validate()?;
        Ok(s)
    }
}

// ---- Object operations (jobs) --------------------------------------------------------------

pub const JOB_PROGRESS_EVENT: &str = "job:progress";
/// Most items one job request may contain (mirror `JOB_MAX_ITEMS` in `types.ts`).
pub const JOB_MAX_ITEMS: usize = 10_000;
/// `preview_job` stops counting at this many objects (`truncated: true`).
pub const JOB_PREVIEW_CAP: u64 = 100_000;
/// `Job.errors` keeps the first this-many per-object errors.
pub const JOB_MAX_ERRORS: usize = 50;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Delete,
    Copy,
    Move,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn is_active(self) -> bool {
        matches!(self, JobStatus::Queued | JobStatus::Running)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    Overwrite,
    /// The default when the field is missing: never overwrite silently.
    #[default]
    Skip,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobPhase {
    Listing,
    Working,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobItem {
    pub from: String,
    #[serde(default)]
    pub to: Option<String>,
    pub is_prefix: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub kind: JobKind,
    pub src_bucket: String,
    #[serde(default)]
    pub dest_bucket: Option<String>,
    pub items: Vec<JobItem>,
    #[serde(default)]
    pub on_conflict: ConflictPolicy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobPreview {
    pub objects: u64,
    pub bytes: u64,
    pub conflicts: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    pub key: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: JobKind,
    pub src_bucket: String,
    pub dest_bucket: Option<String>,
    pub label: String,
    pub phase: JobPhase,
    pub total_items: u64,
    pub done_items: u64,
    pub skipped_items: u64,
    pub failed_items: u64,
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub status: JobStatus,
    pub error: Option<String>,
    pub errors: Vec<JobError>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// Current time as ISO-8601 UTC with millisecond precision.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Formats an S3 timestamp as ISO-8601 UTC.
pub fn fmt_dt(dt: Option<&aws_smithy_types::DateTime>) -> Option<String> {
    dt.and_then(|d| d.fmt(aws_smithy_types::date_time::Format::DateTime).ok())
}

/// Strips the surrounding quotes S3 puts around ETags.
pub fn clean_etag(etag: Option<&str>) -> Option<String> {
    etag.map(|e| e.trim_matches('"').to_string())
}

/// Last path segment of a key or prefix ("a/b/c/" -> "c", "a/b.txt" -> "b.txt").
pub fn last_segment(path: &str) -> String {
    // Strip exactly one trailing '/' (a folder prefix); "a//" is the folder named "" inside "a/".
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_config_json() {
        let c: ConnectionConfig = serde_json::from_str(
            r#"{"kind":"static","accessKeyId":"a","secretAccessKey":"b","region":"us-east-1","endpoint":"http://x","forcePathStyle":false}"#,
        )
        .expect("parse static");
        assert!(matches!(c, ConnectionConfig::Static { force_path_style: Some(false), .. }));
        let p: ConnectionConfig =
            serde_json::from_str(r#"{"kind":"profile","profile":"dev"}"#).expect("parse profile");
        assert!(matches!(p, ConnectionConfig::Profile { region: None, endpoint: None, .. }));
    }

    #[test]
    fn transfer_json() {
        let t = Transfer {
            id: "x".into(),
            kind: TransferKind::Download,
            bucket: "b".into(),
            key: "k".into(),
            local_path: "p".into(),
            total_bytes: 1,
            transferred_bytes: 0,
            parts_total: 1,
            parts_done: 0,
            bytes_per_sec: 0,
            status: TransferStatus::Queued,
            error: None,
            started_at: now_iso(),
            finished_at: None,
        };
        let v = serde_json::to_value(&t).expect("ser");
        assert_eq!(v["kind"], "download");
        assert_eq!(v["status"], "queued");
        assert!(v.get("localPath").is_some());
        assert!(v.get("bytesPerSec").is_some());
        let e = serde_json::to_value(crate::error::AppError::not_connected()).expect("ser");
        assert_eq!(e["code"], "NotConnected");
    }

    #[test]
    fn job_json() {
        let r: JobRequest = serde_json::from_str(
            r#"{"kind":"move","srcBucket":"a","destBucket":"b","items":[{"from":"x/","to":"y/","isPrefix":true}],"onConflict":"overwrite"}"#,
        )
        .expect("parse request");
        assert_eq!(r.kind, JobKind::Move);
        assert_eq!(r.dest_bucket.as_deref(), Some("b"));
        assert_eq!(r.on_conflict, ConflictPolicy::Overwrite);
        assert!(r.items[0].is_prefix);
        let d: JobRequest = serde_json::from_str(
            r#"{"kind":"delete","srcBucket":"a","destBucket":null,"items":[{"from":"k","to":null,"isPrefix":false}]}"#,
        )
        .expect("parse delete");
        assert_eq!(d.on_conflict, ConflictPolicy::Skip, "missing onConflict defaults to skip");
        assert!(d.dest_bucket.is_none() && d.items[0].to.is_none());
        let j = Job {
            id: "i".into(),
            kind: JobKind::Copy,
            src_bucket: "a".into(),
            dest_bucket: None,
            label: "l".into(),
            phase: JobPhase::Listing,
            total_items: 0,
            done_items: 0,
            skipped_items: 0,
            failed_items: 0,
            total_bytes: 0,
            done_bytes: 0,
            status: JobStatus::Queued,
            error: None,
            errors: vec![JobError { key: "k".into(), message: "m".into() }],
            started_at: now_iso(),
            finished_at: None,
        };
        let v = serde_json::to_value(&j).expect("ser");
        for f in [
            "id", "kind", "srcBucket", "destBucket", "label", "phase", "totalItems", "doneItems", "skippedItems",
            "failedItems", "totalBytes", "doneBytes", "status", "error", "errors", "startedAt", "finishedAt",
        ] {
            assert!(v.get(f).is_some(), "missing {f}");
        }
        assert_eq!(v.as_object().map(|o| o.len()), Some(17));
        assert_eq!(v["kind"], "copy");
        assert_eq!(v["phase"], "listing");
        assert_eq!(v["status"], "queued");
        assert_eq!(v["destBucket"], serde_json::Value::Null);
        let p = serde_json::to_value(JobPreview { objects: 1, bytes: 2, conflicts: 3, truncated: true }).expect("ser");
        assert_eq!(p, serde_json::json!({"objects":1,"bytes":2,"conflicts":3,"truncated":true}));
        for (k, s) in [(JobPhase::Working, "working"), (JobPhase::Done, "done")] {
            assert_eq!(serde_json::to_value(k).expect("ser"), s);
        }
        for (k, s) in [(JobStatus::Completed, "completed"), (JobStatus::Failed, "failed"), (JobStatus::Cancelled, "cancelled"), (JobStatus::Running, "running")] {
            assert_eq!(serde_json::to_value(k).expect("ser"), s);
        }
        assert_eq!(serde_json::to_value(JobKind::Delete).expect("ser"), "delete");
        assert_eq!(serde_json::to_value(ConflictPolicy::Skip).expect("ser"), "skip");
    }

    #[test]
    fn segments() {
        assert_eq!(last_segment("a/b/c/"), "c");
        assert_eq!(last_segment("a/b.txt"), "b.txt");
        assert_eq!(last_segment("top"), "top");
        assert_eq!(last_segment("a//"), "");
        assert_eq!(last_segment("/"), "");
        assert_eq!(last_segment("/foo/"), "foo");
    }
}
